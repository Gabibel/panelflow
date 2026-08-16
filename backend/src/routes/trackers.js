import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import {
  SERVICES, authorizeUrl, exchangeCode, freshToken, missingConfig, readState,
  storeTokens, whoami,
} from '../tracker-oauth.js';
import {
  canPush, listLinks, myEntry, pushAll, saveLink, searchTracker,
} from '../tracker-push.js';

// OAuth proxy for external trackers. Client secrets stay server-side; the
// client opens `authorizeUrl`, the tracker redirects to our /callback which
// exchanges the code and stores tokens for the authenticated user. The
// handshake itself, and everything about keeping a token alive afterwards,
// lives in ../tracker-oauth.js.
//
// Configure via env: PANELFLOW_<SERVICE>_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI

export const trackersRouter = Router();

trackersRouter.get('/', wrap(async (req, res) => {
  const rows = await db.prepare(
    'SELECT service, remote_user, expires_at FROM trackers WHERE user_id = ?',
  ).all(req.user.id);
  res.json(rows.map((r) => ({
    service: r.service,
    remoteUser: r.remote_user,
    expiresAt: r.expires_at,
    // Whether progress reaches this service at all. Kitsu connects and then
    // does nothing, and a client that cannot tell has no way to say so.
    canPush: canPush(r.service),
  })));
}));

// What the client needs to draw the tracker screen before anything is
// connected: which services this deployment has credentials for.
trackersRouter.get('/services', (_req, res) => {
  res.json(Object.keys(SERVICES).map((service) => ({
    service,
    canPush: canPush(service),
    // Two different noes: `oauth` false means no authorisation page exists to
    // send anyone to, ever; configured false with oauth true only means this
    // deployment has no credentials yet. A client that sees one number cannot
    // tell "ask your administrator" from "this will never work".
    oauth: !!SERVICES[service].authorize,
    configured: !!SERVICES[service].authorize && !missingConfig(service),
  })));
});

trackersRouter.post('/:service/connect', (req, res) => {
  const service = req.params.service;
  const svc = SERVICES[service];
  if (!svc) return res.status(404).json({ error: 'unknown service' });
  if (!svc.authorize) {
    return res.status(501).json({ error: `${service} needs your password rather than an authorisation page, which PanelFlow does not ask for` });
  }
  const missing = missingConfig(service);
  if (missing) return res.status(501).json({ error: `service not configured: set ${missing}` });
  res.json({ authorizeUrl: authorizeUrl(service, req.user.id) });
});

// The page the tracker sends the browser back to. It is read by a person in a
// popup window, so it says what happened in a sentence and closes itself.
const page = (title, detail, ok) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PanelFlow</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; background: #14161c; color: #e7e9ee; }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; color: ${ok ? '#7ee0a8' : '#ff9a8b'}; }
  p { margin: 0; color: #a8adbb; }
</style>
<main><h1>${title}</h1><p>${detail}</p></main>
${ok ? '<script>setTimeout(() => window.close(), 1500);</script>' : ''}`;

const escape = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Mounted OUTSIDE requireAuth (see index.js). The tracker sends the user's
// browser here on a plain redirect, with no Authorization header — behind auth
// this route answered 401 every time and no OAuth flow could ever complete.
export const trackerCallback = async (req, res) => {
  const service = req.params.service;
  if (!SERVICES[service]) return res.status(404).json({ error: 'unknown service' });
  // The tracker reports a refusal by redirecting here with an error instead of
  // a code — the user pressing "deny" is the common one, and it is not a fault.
  if (req.query.error) {
    return res.status(400).send(page('Not connected',
      escape(req.query.error_description ?? req.query.error), false));
  }
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send(page('Not connected', 'The tracker sent no authorisation code.', false));
  const claims = readState(state, service);
  if (!claims) return res.status(400).send(page('Not connected', 'That sign-in took too long. Start it again from PanelFlow.', false));
  try {
    const tok = await exchangeCode(service, code, claims.v);
    await storeTokens(claims.sub, service, tok, await whoami(service, tok.access_token));
    res.send(page('Connected', `${service} is linked to your PanelFlow account.`, true));
  } catch (err) {
    res.status(err.status ?? 502).send(page('Not connected', escape(err.message), false));
  }
};

// --- pushing progress out ---------------------------------------------------
// Connecting a tracker *is* the opt-in: keeping someone's list current is what
// a tracker is for, and there is nowhere else a per-user preference could live
// that the user has not already answered by connecting. Disconnecting stops it,
// and one series at a time is muted with PUT .../link/:libraryId.

/** A usable token, or an answer explaining which half is missing. */
async function tokenFor(req, res) {
  const service = req.params.service;
  if (!SERVICES[service]) { res.status(404).json({ error: 'unknown service' }); return null; }
  if (!canPush(service)) {
    res.status(501).json({ error: `pushing progress to ${service} is not implemented` });
    return null;
  }
  // freshToken, not the stored column: a MAL token lasts an hour, and reading
  // access_token directly works until the user closes their laptop.
  const token = await freshToken(req.user.id, service);
  if (!token) {
    const row = await db.prepare('SELECT 1 FROM trackers WHERE user_id = ? AND service = ?')
      .get(req.user.id, service);
    res.status(row ? 401 : 404).json({
      error: row ? 'the connection to this tracker has expired — connect it again' : 'not connected',
    });
    return null;
  }
  return token;
}

// Registered before `/:service` so neither "links" nor a nested path is read as
// a service name.
trackersRouter.get('/links', wrap(async (req, res) => {
  res.json(await listLinks(req.user.id));
}));

// What the reader's own tracker accounts already hold for one series, so the
// library sheet can open filled in instead of blank.
//
// Every connected service is asked at once and one failing is not an error:
// this answer decorates a form that works without it, so a tracker that is
// down, rate-limited or newly expired costs a prefill, never the addition. The
// reason travels with the service so the sheet can say "AniList did not
// answer" rather than silently showing nothing.
//
// Registered before `/:service`, like /links, so "entry" is not read as a
// service name.
trackersRouter.get('/entry', wrap(async (req, res) => {
  const title = String(req.query.title ?? '').trim();
  if (title.length < 2) return res.status(400).json({ error: 'title required' });

  const rows = await db.prepare('SELECT service FROM trackers WHERE user_id = ?').all(req.user.id);
  const services = rows.map((r) => r.service).filter(canPush);
  const found = await Promise.all(services.map(async (service) => {
    try {
      const token = await freshToken(req.user.id, service);
      if (!token) return { service, error: 'the connection to this tracker has expired' };
      const entry = await myEntry(service, token, title);
      return entry ?? { service, found: false };
    } catch (err) {
      return { service, error: String(err.message) };
    }
  }));

  res.json({
    title,
    connected: services,
    // Only the services that had it. The others are still reported, above, as
    // connected — "your accounts do not have this one" and "you have connected
    // nothing" are different sentences and the sheet says both.
    entries: found.filter((e) => e.remoteId),
    errors: found.filter((e) => e.error),
  });
}));

// The catalogue, so a series the matcher was not sure about can be picked by
// the one person who knows which it is.
trackersRouter.get('/:service/search', wrap(async (req, res) => {
  const token = await tokenFor(req, res);
  if (!token) return;
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'q required' });
  try {
    res.json(await searchTracker(req.params.service, token, q));
  } catch (err) {
    res.status(502).json({ error: String(err.message) });
  }
}));

// Link, relink, or mute one entry. `state: 'muted'` is how a series is kept off
// a tracker without disconnecting the whole account.
trackersRouter.put('/:service/link/:libraryId', wrap(async (req, res) => {
  const service = req.params.service;
  if (!canPush(service)) return res.status(404).json({ error: 'unknown service' });
  const lib = await db.prepare('SELECT id, title FROM library WHERE id = ? AND user_id = ?')
    .get(req.params.libraryId, req.user.id);
  if (!lib) return res.status(404).json({ error: 'library entry not found' });
  const { remoteId, remoteTitle, state } = req.body ?? {};
  const next = state ?? (remoteId ? 'linked' : 'muted');
  if (!['linked', 'unmatched', 'muted'].includes(next)) {
    return res.status(400).json({ error: 'state must be linked, unmatched or muted' });
  }
  if (next === 'linked' && !remoteId) return res.status(400).json({ error: 'remoteId required' });
  const row = await saveLink(req.user.id, lib.id, service, {
    remoteId: next === 'linked' ? String(remoteId) : null,
    remoteTitle: remoteTitle ?? null,
    state: next,
  });
  res.json({
    libraryId: row.library_id,
    service: row.service,
    remoteId: row.remote_id,
    remoteTitle: row.remote_title,
    state: row.state,
    lastChapter: row.last_chapter,
  });
}));

// Forget what we decided, so the next push resolves the title again. The way
// back from a wrong `unmatched` when the user would rather retry than search.
trackersRouter.delete('/:service/link/:libraryId', wrap(async (req, res) => {
  const info = await db.prepare(
    'DELETE FROM tracker_links WHERE user_id = ? AND library_id = ? AND service = ?',
  ).run(req.user.id, req.params.libraryId, req.params.service);
  if (info.changes === 0) return res.status(404).json({ error: 'not linked' });
  res.status(204).end();
}));

// Backfill after connecting: everything with a bookmark, oldest work first.
// Bounded by a deadline, so a large library answers with what is left rather
// than with a gateway timeout.
trackersRouter.post('/:service/push', wrap(async (req, res) => {
  const token = await tokenFor(req, res);
  if (!token) return;
  res.json(await pushAll(req.user.id, req.params.service, token));
}));

trackersRouter.delete('/:service', wrap(async (req, res) => {
  const info = await db.prepare('DELETE FROM trackers WHERE user_id = ? AND service = ?')
    .run(req.user.id, req.params.service);
  if (info.changes === 0) return res.status(404).json({ error: 'not connected' });
  // The links go with the token. Keeping them would mean reconnecting silently
  // resumes pushing to whatever was matched months ago, including the mutes —
  // and a stale remote id is worse than a search.
  await db.prepare('DELETE FROM tracker_links WHERE user_id = ? AND service = ?')
    .run(req.user.id, req.params.service);
  res.status(204).end();
}));
