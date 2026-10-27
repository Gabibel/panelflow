// PanelFlow Premium on the server: who has it, and who gets to say so.
//
// The rule every test below holds the server to: the answer is RevenueCat's,
// asked by this server with its own key. A client says "look again", never
// "I paid", and a webhook names whom to look at, never what to write.
//
// RevenueCat is played by a local server (the suite may not leave this
// machine, test-support/no-network.js) that answers GET /v1/subscribers/{id}
// from a table the tests fill in, and writes down every call it gets.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { api, base, newUser, shutdown } from '../test-support/harness.js';
import { premiumUntilFrom, premiumActive, accountsInEvent, FOREVER } from '../src/premium.js';

const SECRET = 'sk_test_not_a_real_key';
const HOOK = 'Bearer hook-test-value';

const customers = new Map();
const calls = [];
let failing = false;
const rc = http.createServer((req, res) => {
  const id = decodeURIComponent(req.url.replace(/^\/v1\/subscribers\//, ''));
  calls.push({ method: req.method, id, auth: req.headers.authorization });
  if (failing) { res.writeHead(500); return res.end('{}'); }
  if (req.method === 'DELETE') { customers.delete(id); res.writeHead(200); return res.end('{}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ subscriber: { entitlements: customers.get(id) ?? {} } }));
});
rc.listen(0);
await once(rc, 'listening');

after(async () => {
  rc.close();
  await shutdown();
});

const configure = () => {
  process.env.REVENUECAT_SECRET_KEY = SECRET;
  process.env.REVENUECAT_WEBHOOK_AUTH = HOOK;
  process.env.PANELFLOW_REVENUECAT_API = `http://127.0.0.1:${rc.address().port}`;
};
const unconfigure = () => {
  delete process.env.REVENUECAT_SECRET_KEY;
  delete process.env.REVENUECAT_WEBHOOK_AUTH;
  delete process.env.PANELFLOW_REVENUECAT_API;
};

beforeEach(() => {
  customers.clear();
  calls.length = 0;
  failing = false;
  configure();
});

const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString();
const premium = (expires, grace = null) => ({
  premium: { expires_date: expires, grace_period_expires_date: grace, product_identifier: 'panelflow_premium_monthly' },
});

async function hook(event, auth = HOOK) {
  const resp = await fetch(`${base}/api/premium/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ api_version: '1.0', event }),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

// --- reading RevenueCat's answer ---------------------------------------------

test('the entitlement counts until the later of its expiry and its grace period', () => {
  const soon = '2026-11-01T10:00:00.000Z';
  const grace = '2026-11-17T10:00:00.000Z';
  assert.equal(premiumUntilFrom({ entitlements: premium(soon) }), soon);
  assert.equal(premiumUntilFrom({ entitlements: premium(soon, grace) }), grace,
    'a card Apple is still retrying keeps the subscriber served');
  assert.equal(premiumUntilFrom({ entitlements: premium(null) }), FOREVER, 'a lifetime grant');
  assert.equal(premiumUntilFrom({ entitlements: {} }), null);
  assert.equal(premiumUntilFrom({ entitlements: { other: premium(soon).premium } }), null,
    'only the Premium entitlement is read');
  assert.equal(premiumUntilFrom(null), null);
});

test('premium is a moment in the future, and nothing else', () => {
  assert.equal(premiumActive(inDays(1)), true);
  assert.equal(premiumActive(inDays(-1)), false, 'a lapsed subscription ends on its own');
  assert.equal(premiumActive(null), false);
  assert.equal(premiumActive('soon'), false);
});

test('a webhook event names accounts, and only account-shaped ids', () => {
  const a = '0b5c1a52-1d55-4f0e-9f5e-3d1f1f6f8c01';
  const b = '9a0e2f0d-5b8f-4b49-8a59-0f8b3b9c5e02';
  assert.deepEqual(accountsInEvent({ type: 'RENEWAL', app_user_id: a, original_app_user_id: '$RCAnonymousID:abc', aliases: [a, '$RCAnonymousID:abc'] }), [a]);
  assert.deepEqual(accountsInEvent({ type: 'TRANSFER', transferred_from: [a], transferred_to: [b] }), [a, b]);
  assert.deepEqual(accountsInEvent({ type: 'RENEWAL', app_user_id: '../../v1/projects' }), []);
  assert.equal(accountsInEvent({ type: 'RENEWAL', aliases: Array.from({ length: 50 }, () => crypto.randomUUID()) }).length, 10);
  assert.deepEqual(accountsInEvent(null), []);
});

// --- the account's own answer ------------------------------------------------

test('a new account is not Premium, and says so everywhere it is described', async () => {
  const u = await newUser();
  const me = await api('GET', '/api/me', undefined, u.token);
  assert.deepEqual(me.body.premium, { active: false, until: null });
  const p = await api('GET', '/api/premium', undefined, u.token);
  assert.equal(p.status, 200);
  assert.equal(p.body.active, false);
  assert.equal(p.body.available, true);
});

test('a server without the RevenueCat key sells nothing and checks nothing', async () => {
  unconfigure();
  const u = await newUser();
  const p = await api('GET', '/api/premium', undefined, u.token);
  assert.equal(p.body.available, false);
  const r = await api('POST', '/api/premium/refresh', undefined, u.token);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'premium_unavailable');
  const h = await hook({ type: 'RENEWAL', app_user_id: crypto.randomUUID() });
  assert.equal(h.status, 503);
  assert.equal(calls.length, 0);
});

test('after a purchase the server asks RevenueCat, with its own key', async () => {
  const u = await newUser();
  const until = inDays(30);
  customers.set(u.id, premium(until));

  const r = await api('POST', '/api/premium/refresh', undefined, u.token);
  assert.equal(r.status, 200);
  assert.deepEqual({ active: r.body.active, until: r.body.until }, { active: true, until });
  assert.deepEqual(calls.map((c) => [c.method, c.id, c.auth]), [['GET', u.id, `Bearer ${SECRET}`]]);

  const me = await api('GET', '/api/me', undefined, u.token);
  assert.equal(me.body.premium.active, true, 'every later request knows it');
});

test('what the phone says about itself is not read', async () => {
  const u = await newUser();
  const r = await api('POST', '/api/premium/refresh', { active: true, until: inDays(365) }, u.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.active, false, 'RevenueCat has no entitlement for this account');
});

test('an expired subscription stops counting at the next look', async () => {
  const u = await newUser();
  customers.set(u.id, premium(inDays(30)));
  await api('POST', '/api/premium/refresh', undefined, u.token);
  customers.set(u.id, premium(inDays(-2)));
  const r = await api('POST', '/api/premium/refresh', undefined, u.token);
  assert.equal(r.body.active, false);
  const me = await api('GET', '/api/me', undefined, u.token);
  assert.equal(me.body.premium.active, false);
});

test('RevenueCat being down is an error, not a verdict', async () => {
  const u = await newUser();
  customers.set(u.id, premium(inDays(30)));
  await api('POST', '/api/premium/refresh', undefined, u.token);
  failing = true;
  const r = await api('POST', '/api/premium/refresh', undefined, u.token);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'premium_unavailable');
  failing = false;
  const me = await api('GET', '/api/me', undefined, u.token);
  assert.equal(me.body.premium.active, true, 'an outage takes nobody\'s subscription away');
});

test('looking again is counted per account', async () => {
  const u = await newUser();
  let last;
  for (let i = 0; i < 21; i++) last = await api('POST', '/api/premium/refresh', undefined, u.token);
  assert.equal(last.status, 429);
  assert.equal(calls.length, 20);
});

test('the refresh needs a session', async () => {
  const r = await api('POST', '/api/premium/refresh', undefined, null);
  assert.equal(r.status, 401);
});

// --- the webhook -------------------------------------------------------------

test('a webhook without the shared value is refused, and asks nothing', async () => {
  const u = await newUser();
  customers.set(u.id, premium(inDays(30)));
  for (const auth of [null, 'Bearer wrong', `${HOOK}x`, SECRET]) {
    const h = await hook({ type: 'INITIAL_PURCHASE', app_user_id: u.id }, auth);
    assert.equal(h.status, 401, String(auth));
  }
  assert.equal(calls.length, 0);
  const me = await api('GET', '/api/me', undefined, u.token);
  assert.equal(me.body.premium.active, false);
});

test('a webhook makes the server look again, and believes only the look', async () => {
  const u = await newUser();
  const until = inDays(365);
  customers.set(u.id, premium(until));
  // The event claims a different expiry: it is not read.
  const h = await hook({ type: 'INITIAL_PURCHASE', app_user_id: u.id, expiration_at_ms: Date.now() + 10 * 365 * 86400_000 });
  assert.equal(h.status, 200);
  const me = await api('GET', '/api/me', undefined, u.token);
  assert.deepEqual(me.body.premium, { active: true, until });
});

test('a webhook about someone who is not an account here asks RevenueCat nothing', async () => {
  // Asking about an unknown id creates a customer under it on RevenueCat's side.
  const h = await hook({ type: 'RENEWAL', app_user_id: crypto.randomUUID(), aliases: ['$RCAnonymousID:x'] });
  assert.equal(h.status, 200);
  assert.equal(calls.length, 0);
});

test('a transfer looks at both accounts', async () => {
  const from = await newUser();
  const to = await newUser();
  customers.set(from.id, premium(inDays(30)));
  await api('POST', '/api/premium/refresh', undefined, from.token);
  customers.delete(from.id);
  customers.set(to.id, premium(inDays(30)));
  const h = await hook({ type: 'TRANSFER', transferred_from: [from.id], transferred_to: [to.id] });
  assert.equal(h.status, 200);
  assert.equal((await api('GET', '/api/me', undefined, from.token)).body.premium.active, false);
  assert.equal((await api('GET', '/api/me', undefined, to.token)).body.premium.active, true);
});

test('a look that fails asks RevenueCat to send the event again', async () => {
  const u = await newUser();
  failing = true;
  const h = await hook({ type: 'RENEWAL', app_user_id: u.id });
  assert.equal(h.status, 500);
});

// --- the rest of the account ------------------------------------------------

test('the export says until when Premium counts', async () => {
  const u = await newUser();
  const until = inDays(30);
  customers.set(u.id, premium(until));
  await api('POST', '/api/premium/refresh', undefined, u.token);
  const x = await api('GET', '/api/export', undefined, u.token);
  assert.equal(x.status, 200);
  assert.equal(x.body.account.premiumUntil, until);
});

test('deleting the account forgets the RevenueCat customer too', async () => {
  const u = await newUser();
  const r = await api('DELETE', '/api/auth/me', { password: 'password123' }, u.token);
  assert.equal(r.status, 204);
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => [c.id, c.auth]), [[u.id, `Bearer ${SECRET}`]]);
});

test('the key never goes to an address that is not https', async () => {
  const u = await newUser();
  // A typo in the environment is no address at all: nothing is sent, in
  // clear or otherwise, and the check fails as if RevenueCat were down.
  process.env.PANELFLOW_REVENUECAT_API = 'http://example.test';
  const r = await api('POST', '/api/premium/refresh', undefined, u.token);
  assert.equal(r.status, 502);
  assert.equal(calls.length, 0);
});
