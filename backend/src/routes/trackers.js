import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import { signOAuthState, readOAuthState } from '../auth.js';

// OAuth proxy for external trackers. Client secrets stay server-side; the
// client opens `authorizeUrl`, the tracker redirects to our /callback which
// exchanges the code and stores tokens for the authenticated user.
// Configure via env: PANELFLOW_<SERVICE>_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI

const SERVICES = {
  anilist: {
    authorize: 'https://anilist.co/api/v2/oauth/authorize',
    token: 'https://anilist.co/api/v2/oauth/token',
  },
  mal: {
    authorize: 'https://myanimelist.net/v1/oauth2/authorize',
    token: 'https://myanimelist.net/v1/oauth2/token',
  },
  kitsu: {
    authorize: null, // Kitsu uses resource-owner password grant; handled via /connect body
    token: 'https://kitsu.io/api/oauth/token',
  },
};

const cfg = (service, key) =>
  process.env[`PANELFLOW_${service.toUpperCase()}_${key}`];

export const trackersRouter = Router();

trackersRouter.get('/', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT service, remote_user, expires_at FROM trackers WHERE user_id = ?')
    .all(req.user.id);
  res.json(rows.map((r) => ({ service: r.service, remoteUser: r.remote_user, expiresAt: r.expires_at })));
}));

trackersRouter.post('/:service/connect', (req, res) => {
  const service = req.params.service;
  const svc = SERVICES[service];
  if (!svc) return res.status(404).json({ error: 'unknown service' });
  const clientId = cfg(service, 'CLIENT_ID');
  if (!clientId) {
    return res.status(501).json({ error: `service not configured: set PANELFLOW_${service.toUpperCase()}_CLIENT_ID` });
  }
  if (!svc.authorize) {
    return res.status(501).json({ error: 'this service uses direct credential grant; not yet implemented' });
  }
  const redirectUri = cfg(service, 'REDIRECT_URI');
  const url = new URL(svc.authorize);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri ?? '');
  url.searchParams.set('response_type', 'code');
  // `state` carries the user id, signed, so the callback can associate tokens
  // without a bearer token it will never be given.
  url.searchParams.set('state', signOAuthState(req.user.id, service));
  res.json({ authorizeUrl: url.toString() });
});

// Mounted OUTSIDE requireAuth (see index.js). The tracker sends the user's
// browser here on a plain redirect, with no Authorization header — behind auth
// this route answered 401 every time and no OAuth flow could ever complete.
export const trackerCallback = async (req, res) => {
  const service = req.params.service;
  const svc = SERVICES[service];
  if (!svc) return res.status(404).json({ error: 'unknown service' });
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).json({ error: 'code and state required' });
  const userId = readOAuthState(state, service);
  if (!userId) return res.status(400).json({ error: 'invalid or expired state' });
  try {
    const resp = await fetch(svc.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: cfg(service, 'CLIENT_ID'),
        client_secret: cfg(service, 'CLIENT_SECRET'),
        redirect_uri: cfg(service, 'REDIRECT_URI'),
        code,
      }),
    });
    if (!resp.ok) throw new Error(`token exchange failed: ${resp.status}`);
    const tok = await resp.json();
    await db.prepare(`
      INSERT INTO trackers (user_id, service, access_token, refresh_token, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'))
      ON CONFLICT (user_id, service) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at
    `).run(userId, service, tok.access_token, tok.refresh_token ?? null, tok.expires_in ?? 31536000);
    res.send('<html><body>Tracker connected. You can close this window.</body></html>');
  } catch (err) {
    res.status(502).json({ error: String(err.message) });
  }
};

trackersRouter.delete('/:service', wrap(async (req, res) => {
  const info = await db.prepare('DELETE FROM trackers WHERE user_id = ? AND service = ?')
    .run(req.user.id, req.params.service);
  if (info.changes === 0) return res.status(404).json({ error: 'not connected' });
  res.status(204).end();
}));
