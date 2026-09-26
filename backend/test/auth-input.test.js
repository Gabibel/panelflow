// What an account can be made of, and how a refusal is named.
//
// The QA pass of September 2026 signed up with " reader@x.test" beside
// "reader@x.test" and got two accounts, sent an object as the address and got
// a 500, signed up as "not-an-email", used a 100-byte password of which bcrypt
// read 72, and watched a form sent with a typo spend the sign-up allowance of
// everyone behind the same address. Every refusal came back as an English
// sentence the clients put on screen as it was.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, addEntry, shutdown, base } from '../test-support/harness.js';
import { callerIp, networkOf, bucketKey } from '../src/rate-limit.js';
import { codeFor } from '../src/error-codes.js';
import { db } from '../src/db.js';

after(shutdown);

const unique = (name) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.dev`;
const register = (body, headers = {}) => fetch(`${base}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('an address that is not one is refused, whatever shape it arrives in', async () => {
  for (const email of ['not-an-email', '', '   ', 'a@b', { $gt: '' }, ['x@y.test'], 42, null]) {
    const r = await register({ email, password: 'password123' });
    assert.equal(r.status, 400, `${JSON.stringify(email)} → ${r.status}`);
    assert.equal(r.body.code, 'bad_email');
  }
});

test('a password is at least 8 characters and at most what bcrypt reads', async () => {
  const short = await register({ email: unique('short'), password: 'seven77' });
  assert.equal(short.status, 400);
  assert.equal(short.body.code, 'weak_password');
  // 37 × "é" is 74 bytes: bcrypt would have read 72 of them and ignored the rest.
  const long = await register({ email: unique('long'), password: 'é'.repeat(37) });
  assert.equal(long.status, 400);
  assert.equal(long.body.code, 'password_too_long');
  const object = await register({ email: unique('obj'), password: { length: 12 } });
  assert.equal(object.status, 400);
});

test('an address is kept trimmed and lower-case, so one person is one account', async () => {
  const raw = unique('Reader').replace('reader', 'Reader');
  const first = await register({ email: `  ${raw.toUpperCase()}  `, password: 'password123' });
  assert.equal(first.status, 201);
  assert.equal(first.body.user.email, raw.toLowerCase());
  const again = await register({ email: raw.toLowerCase(), password: 'password123' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'email_taken');
  const login = await api('POST', '/api/auth/login', { email: ` ${raw} `, password: 'password123' });
  assert.equal(login.status, 200);
  // And an object where the address should be is a wrong sign-in, not a crash.
  const odd = await api('POST', '/api/auth/login', { email: { $ne: null }, password: { $ne: null } });
  assert.equal(odd.status, 401);
  assert.equal(odd.body.code, 'invalid_credentials');
});

test('a form refused as invalid does not spend the sign-up allowance', async () => {
  const ip = '198.51.100.77';
  for (let i = 0; i < 5; i++) await register({ email: 'nope', password: 'password123' }, { 'x-forwarded-for': ip });
  const bucket = bucketKey(`register:${ip}`);
  const counted = () => db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').get(bucket);
  assert.equal(await counted(), undefined, 'five typos were counted as five sign-ups');
  await register({ email: unique('valid'), password: 'password123' }, { 'x-forwarded-for': ip });
  assert.equal(Number((await counted()).count), 1);
});

test('x-forwarded-for is the caller only behind a proxy that writes it', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '10.9.8.7' } };
  const was = process.env.PANELFLOW_TRUST_PROXY;
  try {
    process.env.PANELFLOW_TRUST_PROXY = '0';
    delete process.env.VERCEL;
    assert.equal(callerIp(req), '10.9.8.7', 'a client chose the bucket it is counted in');
    process.env.PANELFLOW_TRUST_PROXY = '1';
    assert.equal(callerIp(req), '203.0.113.9');
  } finally {
    process.env.PANELFLOW_TRUST_PROXY = was;
  }
});

test('an IPv6 subscriber is counted as one network, not eighteen quintillion addresses', () => {
  assert.equal(networkOf('2001:db8:85a3:12:8a2e:370:7334:1'), '2001:db8:85a3:12::/64');
  assert.equal(networkOf('2001:db8:85a3:12:ffff::9'), '2001:db8:85a3:12::/64');
  assert.equal(networkOf('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(networkOf('203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf('::ffff:198.51.100.2'), '198.51.100.2');
});

test('a library entry has bounds', async () => {
  const u = await newUser();
  const post = (over) => api('POST', '/api/library', {
    title: 'Blue Box', sourceDomain: 'scan.test', sourceUrl: `https://scan.test/manga/${Math.random()}`, ...over,
  }, u.token);
  for (const over of [{ title: 'x'.repeat(301) }, { note: 'x'.repeat(10001) }, { tags: 'not-a-list' },
    { tags: Array.from({ length: 101 }, (_, i) => `t${i}`) }, { tags: [{ nested: true }] }, { title: { a: 1 } },
    { lastKnownChapter: '9'.repeat(65) }]) {
    const r = await post(over);
    assert.equal(r.status, 400, `${JSON.stringify(over).slice(0, 60)} → ${r.status}`);
  }
  assert.equal((await post({ title: 'x'.repeat(301) })).body.code, 'too_long');
  assert.equal((await post({ note: 'a real note', tags: ['romance'] })).status, 201);
  const e = await addEntry(u.token);
  assert.equal((await api('PUT', `/api/library/${e.id}`, { note: 'x'.repeat(10001) }, u.token)).status, 400);
});

test('every refusal on the wire carries a code a client can translate', async () => {
  const wrong = await api('POST', '/api/auth/login', { email: unique('nobody'), password: 'password123' });
  assert.equal(wrong.body.code, 'invalid_credentials');
  const u = await newUser();
  const missing = await api('PUT', '/api/library/does-not-exist', { note: 'x' }, u.token);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'not_found');
  const anon = await api('GET', '/api/library', undefined, null);
  assert.equal(anon.status, 401);
  assert.equal(anon.body.code, 'session_ended');
  // The overlaps a first match could get wrong.
  assert.equal(codeFor('too many redirects', 502), 'site_unreachable');
  assert.equal(codeFor('too many sign-in attempts, try again later', 429), 'rate_limited');
  assert.equal(codeFor('push is not configured on this server', 503), 'push_unavailable');
  assert.equal(codeFor('something nobody wrote down', 418), 'bad_request');
});
