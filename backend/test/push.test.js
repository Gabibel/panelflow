// Web Push, from subscribing to the byte the browser decrypts.
//
// The encryption here is the one part of PanelFlow that cannot be checked by
// looking at it. A wrong key derivation does not throw, does not log, and does
// not come back as an error status: the push service accepts the body happily
// and the browser drops it in silence. So this file plays the browser — it
// keeps a real P-256 key pair, hands the public half over as a subscription,
// and decrypts whatever the watcher sends. If the derivation is wrong the
// decryption fails here rather than in someone's Chrome six weeks from now.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync,
  randomBytes, verify,
} from 'node:crypto';
import { api, newUser, addEntry, shutdown, base } from '../test-support/harness.js';
import { runWatch } from '../src/routes/watch.js';
import { db } from '../src/db.js';

after(shutdown);

// --- the browser's half -----------------------------------------------------

const ua = createECDH('prime256v1');
ua.generateKeys();
const authSecret = randomBytes(16);
const KEYS = { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') };

const ENDPOINT = 'https://push.test/fcm/send/abc123';

/** What a browser does with the body: the reverse of src/push.js. */
function decrypt(body) {
  const salt = body.subarray(0, 16);
  const idLen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLen);
  const sealed = body.subarray(21 + idLen);

  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  // The trailing byte is the record delimiter, not payload.
  assert.equal(plain[plain.length - 1], 0x02, 'the last-record delimiter is missing');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

/** What a push service does with the Authorization header. */
function checkVapid(header, endpoint, publicKey) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header || '');
  assert.ok(m, `not a VAPID header: ${header}`);
  assert.equal(m[2], publicKey, 'the key the token is verified against is not the one advertised');

  const [h, p, sig] = m[1].split('.');
  const point = Buffer.from(publicKey, 'base64url');
  const key = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    },
  });
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sig, 'base64url'));
  assert.ok(ok, 'the VAPID signature does not verify');

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  assert.equal(claims.aud, new URL(endpoint).origin, 'aud must be the push service, not the endpoint');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), 'the token is already expired');
  assert.ok(claims.sub, 'a push service may refuse a token with no contact');
}

// --- the push service -------------------------------------------------------

const realFetch = globalThis.fetch;
/** Every push this run made. `reply` decides what the service answers. */
let pushes = [];
let reply = () => new Response(null, { status: 201 });

globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(base)) return realFetch(url, init);
  pushes.push({ url: href, headers: init.headers, body: Buffer.from(init.body) });
  return reply(href);
};
after(() => { globalThis.fetch = realFetch; });

// --- the server's half ------------------------------------------------------

let vapidPublic = null;

function configure() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  vapidPublic = Buffer.concat([
    Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  process.env.PANELFLOW_VAPID_PUBLIC_KEY = vapidPublic;
  process.env.PANELFLOW_VAPID_PRIVATE_KEY = privateKey.export({ format: 'jwk' }).d;
  process.env.PANELFLOW_VAPID_SUBJECT = 'mailto:test@panelflow.invalid';
}

const page = (n) => `<a href="/manga/x/chapter-${n}">Chapter ${n}</a>`;

/** One watcher pass with the network replaced by a lookup table. */
const run = (pages) => runWatch({
  pacingMs: 0,
  fetch: async (url) => {
    const html = pages[url];
    if (html === undefined) throw new Error('unreachable');
    return html;
  },
});

const subscribe = (token, endpoint = ENDPOINT) =>
  api('POST', '/api/push/subscribe', { endpoint, keys: KEYS }, token);

// --- unconfigured -----------------------------------------------------------
// First in the file: every test below turns push on, and there is no turning it
// back off for one test without leaving the others depending on the order.

test('a server with no keys says so instead of pretending', async () => {
  const u = await newUser();
  // 200 and a null key, not 503. Asking whether push is on offer is a question
  // every page load puts before it draws anything, and a deployment that does
  // not offer it is not failing — it is answering. A 503 here made the browser
  // print a failed request in the console on every visit, about a feature the
  // page had already decided not to show; the network layer logs that itself,
  // so the client's own try/catch could never have quieted it.
  const r = await api('GET', '/api/push/key', undefined, u.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.key, null);

  // And the watcher still works. Push is the fast path, not the only one: the
  // news row is written either way, and a client draining it is what has always
  // produced the notification.
  const url = 'https://unconfigured.test/manga/a';
  await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '10' });
  await subscribe(u.token, 'https://push.test/nope');

  // A registered browser and no keys to sign for it: the missing keys are the
  // answer, not "you have no browser registered".
  // And /test keeps its 503, because that one is an action: a button was
  // pressed, nothing is going to happen, and the reason is owed.
  const t = await api('POST', '/api/push/test', {}, u.token);
  assert.equal(t.status, 503);
  assert.equal(pushes.length, 0, 'a test push was attempted with no key to sign it');

  const s = await run({ [url]: page(11) });
  assert.equal(s.news, 1);
  assert.equal(s.pushed, 0);
  assert.equal(pushes.length, 0, 'a push was attempted with no key to sign it');
  assert.equal((await api('GET', '/api/news', undefined, u.token)).body.length, 1);
});

test('the page reads a null key as "no push here" and stops there', () => {
  // The other half of the same fix, and the reason the 503 could go: nothing
  // downstream of this may run on a null key. `pushManager.subscribe` with a
  // null applicationServerKey throws, and the bell would be drawn for a server
  // that cannot sign anything.
  //
  // Source-level because there is no page here to run: what is being checked is
  // that web/app.js gives up between asking and registering, not that some
  // stand-in of it does.
  const src = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  const a = src.indexOf('async function setupPush() {');
  const b = src.indexOf('function paintPush(', a);
  assert.ok(a !== -1 && b > a, 'web/app.js no longer sets push up where this test looks');
  const body = src.slice(a, b);

  const asked = body.indexOf("api('/push/key')");
  const gaveUp = body.search(/if \(!key\) return;/);
  const registered = body.indexOf('serviceWorker.register');
  assert.ok(asked !== -1, 'the page no longer asks for the key');
  assert.ok(gaveUp !== -1, 'a server with no keys now gets a subscription attempt');
  assert.ok(gaveUp > asked && gaveUp < registered,
    'the page registers a worker before it knows whether push is on offer');
});

// --- registering ------------------------------------------------------------

test('the key is handed out once it exists, and a subscription sticks to it', async () => {
  configure();
  const u = await newUser();
  const key = await api('GET', '/api/push/key', undefined, u.token);
  assert.equal(key.status, 200);
  assert.equal(key.body.key, vapidPublic);

  assert.equal((await subscribe(u.token)).status, 200);
  // The browser hands back the same endpoint on every visit, so this route is
  // called again on every page load and must not pile up rows.
  assert.equal((await subscribe(u.token)).status, 200);
  const rows = await db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(u.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, ENDPOINT);
  assert.equal(rows[0].p256dh, KEYS.p256dh);
});

test('half a subscription is refused', async () => {
  const u = await newUser();
  for (const body of [
    { endpoint: ENDPOINT },
    { endpoint: ENDPOINT, keys: { p256dh: KEYS.p256dh } },
    { endpoint: 'http://push.test/insecure', keys: KEYS },
    {},
  ]) {
    const r = await api('POST', '/api/push/subscribe', body, u.token);
    assert.equal(r.status, 400, `accepted ${JSON.stringify(body)}`);
  }
});

test('the push endpoints are behind a login', async () => {
  for (const [method, path] of [['GET', '/api/push/key'], ['POST', '/api/push/subscribe'], ['POST', '/api/push/unsubscribe'], ['POST', '/api/push/test']]) {
    const r = await api(method, path, method === 'GET' ? undefined : {}, null);
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

// --- sending ----------------------------------------------------------------

test('what the watcher finds reaches the browser, and only the browser can read it', async () => {
  pushes = [];
  const u = await newUser();
  await subscribe(u.token, 'https://push.test/one');
  const url = 'https://sending.test/manga/solo';
  await addEntry(u.token, { title: 'Solo Leveling', sourceUrl: url, lastKnownChapter: '178' });

  const s = await run({ [url]: page(179) });
  assert.equal(s.news, 1);
  assert.equal(s.pushed, 1);
  assert.equal(pushes.length, 1);

  const [sent] = pushes;
  assert.equal(sent.url, 'https://push.test/one');
  assert.equal(sent.headers['Content-Encoding'], 'aes128gcm');
  checkVapid(sent.headers.Authorization, sent.url, vapidPublic);
  // The service saw an opaque blob; only the key pair this test holds opens it.
  const payload = decrypt(sent.body);
  assert.equal(payload.title, 'Solo Leveling');
  assert.match(payload.body, /179/);
  assert.equal(payload.url, url);
});

test('a chapter already announced is not announced again', async () => {
  pushes = [];
  const u = await newUser();
  await subscribe(u.token, 'https://push.test/repeat');
  const url = 'https://repeat.test/manga/a';
  await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '4' });

  await run({ [url]: page(5) });
  assert.equal(pushes.length, 1);
  // The site has published nothing since. The second run must be silent — this
  // is the difference between a notification and a daily reminder.
  await run({ [url]: page(5) });
  assert.equal(pushes.length, 1);
});

test('four series that all updated overnight are one notification, not four', async () => {
  pushes = [];
  const u = await newUser();
  await subscribe(u.token, 'https://push.test/digest');
  const pages = {};
  for (let i = 0; i < 5; i++) {
    const url = `https://digest.test/manga/${i}`;
    await addEntry(u.token, { title: `Digest ${i}`, sourceUrl: url, lastKnownChapter: '1' });
    pages[url] = page(2);
  }

  const s = await run(pages);
  assert.equal(s.news, 5);
  assert.equal(pushes.length, 1, 'one banner per account per run, not one per series');
  const payload = decrypt(pushes[0].body);
  assert.match(payload.title, /^5 new chapters$/);
  assert.match(payload.body, /and 1 more/);
  // The digest cannot deep-link to one series, so it opens the library.
  assert.equal(payload.url, '/');
});

test("one account never gets another account's news", async () => {
  pushes = [];
  const mine = await newUser();
  const theirs = await newUser();
  await subscribe(mine.token, 'https://push.test/mine');
  await subscribe(theirs.token, 'https://push.test/theirs');
  const url = 'https://shared.test/manga/onepiece';
  await addEntry(mine.token, { sourceUrl: url, lastKnownChapter: '1100' });
  await addEntry(theirs.token, { sourceUrl: url, lastKnownChapter: '1105' });

  // One fetch, one new chapter for one of them: 1101 is behind where the other
  // account already was.
  await run({ [url]: page(1101) });
  assert.deepEqual(pushes.map((p) => p.url), ['https://push.test/mine']);
});

// --- proving it works without waiting for a chapter -------------------------

test('a reader can send themselves the notification the watcher would have sent', async () => {
  pushes = [];
  const u = await newUser();
  await subscribe(u.token, 'https://push.test/selftest');

  const r = await api('POST', '/api/push/test', {}, u.token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { sent: 1, dropped: 0, failed: 0, subscriptions: 1 });
  assert.equal(pushes.length, 1);

  // The point of the route is that it exercises the real path, so the same
  // things have to be true of it as of a chapter alert: a signature the service
  // will accept, and a body only this browser can open.
  const [sent] = pushes;
  assert.equal(sent.headers['Content-Encoding'], 'aes128gcm');
  checkVapid(sent.headers.Authorization, sent.url, vapidPublic);
  const payload = decrypt(sent.body);
  assert.match(payload.title, /PanelFlow/);
  // Its own tag: a test must not silently replace an unread chapter alert.
  assert.equal(payload.tag, 'panelflow-test');
  assert.notEqual(payload.tag, 'panelflow-news');
});

test('the test push goes to your own browsers and stops there', async () => {
  pushes = [];
  const mine = await newUser();
  const theirs = await newUser();
  await subscribe(mine.token, 'https://push.test/mine-test');
  await subscribe(mine.token, 'https://push.test/my-phone');
  await subscribe(theirs.token, 'https://push.test/theirs-test');

  const r = await api('POST', '/api/push/test', {}, mine.token);
  assert.equal(r.body.subscriptions, 2, 'every browser this account registered gets it');
  assert.deepEqual(pushes.map((p) => p.url).sort(),
    ['https://push.test/mine-test', 'https://push.test/my-phone']);
});

test('an account with no browser registered is told that, not sent nothing', async () => {
  pushes = [];
  const u = await newUser();
  const r = await api('POST', '/api/push/test', {}, u.token);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no browser/);
  assert.equal(pushes.length, 0);
});

test('a test push clears out a subscription the browser has thrown away', async () => {
  pushes = [];
  const u = await newUser();
  await subscribe(u.token, 'https://push.test/stale');

  reply = () => new Response(null, { status: 410 });
  const gone = await api('POST', '/api/push/test', {}, u.token);
  assert.deepEqual(gone.body, { sent: 0, dropped: 1, failed: 0, subscriptions: 1 });
  assert.equal((await db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(u.id)).length, 0,
    'a subscription the browser dropped is not worth keeping, whoever noticed');

  // And a service merely having a bad afternoon keeps its row, so a failed test
  // does not cost the reader the registration they would need tomorrow.
  await subscribe(u.token, 'https://push.test/flaky');
  reply = () => new Response(null, { status: 500 });
  const down = await api('POST', '/api/push/test', {}, u.token);
  assert.deepEqual(down.body, { sent: 0, dropped: 0, failed: 1, subscriptions: 1 });
  assert.equal((await db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(u.id)).length, 1);
  reply = () => new Response(null, { status: 201 });
});

// --- subscriptions that stop working ----------------------------------------

test('a subscription the push service has forgotten is dropped, a service that is merely down is not', async () => {
  pushes = [];
  const u = await newUser();
  await subscribe(u.token, 'https://push.test/gone');
  const url = 'https://gone.test/manga/a';
  await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '1' });

  reply = () => new Response(null, { status: 500 });
  const down = await run({ [url]: page(2) });
  assert.equal(down.dropped, 0);
  assert.equal((await db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(u.id)).length, 1,
    'a push service having a bad afternoon is not a reason to forget the reader');

  // 410 is the browser saying the subscription is dead for good — permission
  // revoked, or site data cleared. Keeping it means a failing request forever.
  reply = () => new Response(null, { status: 410 });
  const gone = await run({ [url]: page(3) });
  assert.equal(gone.dropped, 1);
  assert.equal((await db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(u.id)).length, 0);
  reply = () => new Response(null, { status: 201 });
});

test("unsubscribing removes your own registration and nobody else's", async () => {
  const mine = await newUser();
  const theirs = await newUser();
  await subscribe(mine.token, 'https://push.test/leaving');
  await subscribe(theirs.token, 'https://push.test/staying');

  const wrongOwner = await api('POST', '/api/push/unsubscribe', { endpoint: 'https://push.test/staying' }, mine.token);
  assert.equal(wrongOwner.body.removed, 0);

  const own = await api('POST', '/api/push/unsubscribe', { endpoint: 'https://push.test/leaving' }, mine.token);
  assert.equal(own.body.removed, 1);
  assert.equal((await db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(theirs.id)).length, 1);
});
