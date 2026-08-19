// Registering a browser for push, and handing the watcher's findings to it.
import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import { sendPush, vapidKeys } from '../push.js';

export const pushRouter = Router();

// The public half of the VAPID pair. The browser needs it at subscribe time —
// it is baked into the subscription, which is why changing the pair invalidates
// every subscription ever handed out and is not something to do twice.
//
// A null key, 200, when the server has no pair. This route is a question and
// not an action: "is push on offer here, and with what key?", asked by every
// page load before the bell is drawn. A deployment without VAPID keys is not
// broken, it simply does not offer push, and answering 503 made every visit to
// such a deployment print a failed request in the console — a red line about a
// feature the page had already decided, silently and correctly, not to show.
// The browser logs that itself, from the network layer, so no amount of
// catching on the client could ever quiet it.
//
// `/test` below keeps its 503, because that one is an action: the reader
// pressed a button and nothing is going to happen, and they are owed the
// reason.
pushRouter.get('/key', (_req, res) => {
  const keys = vapidKeys();
  res.json({ key: keys ? keys.publicKey : null });
});

pushRouter.post('/subscribe', wrap(async (req, res) => {
  const endpoint = String(req.body?.endpoint ?? '');
  const p256dh = String(req.body?.keys?.p256dh ?? '');
  const auth = String(req.body?.keys?.auth ?? '');
  if (!/^https:\/\//i.test(endpoint) || !p256dh || !auth) {
    return res.status(400).json({ error: 'a push subscription needs an https endpoint and both keys' });
  }
  // ON CONFLICT on the endpoint rather than a plain insert: the browser hands
  // back the same endpoint every time it is asked, so this route is called
  // again on every visit and must be idempotent.
  await db.prepare(`
    INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
      p256dh = excluded.p256dh, auth = excluded.auth
  `).run(endpoint, req.user.id, p256dh, auth);
  res.json({ ok: true });
}));

// Not DELETE-with-a-body: `navigator.sendBeacon` and a service worker's
// `pushsubscriptionchange` can both only POST, and this has to work from both.
pushRouter.post('/unsubscribe', wrap(async (req, res) => {
  const endpoint = String(req.body?.endpoint ?? '');
  const r = await db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?')
    .run(req.user.id, endpoint);
  res.json({ removed: r.changes });
}));

/**
 * Hand one payload to every one of these subscriptions and record what came
 * back. Shared by the watcher and the test route on purpose: a test that took
 * its own path through the encryption would prove that path works, which is not
 * the question anyone is asking.
 *
 * @param {Array<object>} subs rows from `push_subs`
 * @param {string} payload the JSON the service worker will read
 * @param {object} keys the VAPID pair
 * @param {Map} [tokens] one signature per push-service origin, across a whole run
 * @returns {Promise<{sent:number, dropped:number, failed:number}>} `dropped` is
 *   a subscription the push service has forgotten for good, and its row is gone
 *   by the time this returns; `failed` is one worth trying again another day.
 */
async function deliver(subs, payload, keys, tokens = new Map()) {
  const out = { sent: 0, dropped: 0, failed: 0 };
  for (const sub of subs) {
    const r = await sendPush(sub, payload, keys, tokens);
    if (r.ok) {
      out.sent++;
      await db.prepare('UPDATE push_subs SET last_ok = datetime(\'now\') WHERE endpoint = ?')
        .run(sub.endpoint);
    } else if (r.gone) {
      out.dropped++;
      await db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
    } else {
      out.failed++;
    }
  }
  return out;
}

// A notification the reader asked for, sent to their own browsers and nobody
// else's. Everything between the VAPID signature and the service worker's
// `push` handler only ever runs when a watcher finds a chapter — which is at
// most once a day, on a schedule, for a series that happened to update. That is
// no way to find out that the keys are wrong, and a wrong key derivation fails
// silently: the push service accepts the body and the browser drops it. This is
// the same path, on demand.
pushRouter.post('/test', wrap(async (req, res) => {
  const keys = vapidKeys();
  if (!keys) return res.status(503).json({ error: 'push is not configured on this server' });

  const subs = await db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(req.user.id);
  // Not an empty success: a reader pressing this wants to know whether the
  // notification arrives, and "sent 0 of 0" answers a different question than
  // the one they asked.
  if (!subs.length) {
    return res.status(409).json({ error: 'this account has no browser registered for push' });
  }

  const payload = JSON.stringify({
    title: 'PanelFlow',
    body: 'Push is working. A new chapter will arrive like this.',
    url: '/',
    // Its own tag: a test must not replace an unread chapter alert, and two
    // tests in a row should not stack two banners either.
    tag: 'panelflow-test',
  });
  res.json({ ...(await deliver(subs, payload, keys)), subscriptions: subs.length });
}));

// --- what the watcher sends ------------------------------------------------

/** One notification's worth of text for a user's new chapters. */
export function newsPayload(items) {
  if (items.length === 1) {
    const [it] = items;
    return {
      title: it.title,
      body: `Chapter ${it.chapter} is out`,
      url: it.sourceUrl,
      tag: `panelflow-${it.libraryId}`,
    };
  }
  return {
    title: `${items.length} new chapters`,
    // Four titles and a count: a notification that lists twelve series is
    // truncated by the platform anyway, and the app has the full list.
    body: items.slice(0, 4).map((i) => i.title).join(', ')
      + (items.length > 4 ? `, and ${items.length - 4} more` : ''),
    url: '/',
    // One tag for the digest, so a second run replaces the first rather than
    // stacking a second banner saying almost the same thing.
    tag: 'panelflow-news',
  };
}

/**
 * Push what a watcher run found, one notification per account.
 *
 * Nothing here retries. A push that fails is not lost news: the `news` row it
 * came from is still there, and the next client to wake up drains it the way it
 * always did. Push is the faster path, not the only one.
 *
 * @param {Map<string, Array<{title:string, chapter:string, sourceUrl:string, libraryId:string}>>} byUser
 * @returns {Promise<{sent:number, dropped:number}>}
 */
export async function pushNews(byUser) {
  const keys = vapidKeys();
  const out = { sent: 0, dropped: 0 };
  if (!keys || !byUser.size) return out;

  // One VAPID token per push-service origin for the whole run, rather than one
  // signature per subscription: a library of any size lands on two or three
  // origins, and ES256 is not free.
  const tokens = new Map();
  for (const [userId, items] of byUser) {
    const subs = await db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);
    if (!subs.length) continue;
    const r = await deliver(subs, JSON.stringify(newsPayload(items)), keys, tokens);
    out.sent += r.sent;
    out.dropped += r.dropped;
  }
  return out;
}
