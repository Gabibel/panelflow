import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { api, base, newUser, shutdown } from '../test-support/harness.js';

after(shutdown);

test('register rejects incomplete credentials', async () => {
  const cases = [
    [{}, 'empty body'],
    [{ email: 'x@y.test' }, 'no password'],
    [{ password: 'password123' }, 'no email'],
    [{ email: 'x@y.test', password: 'short' }, 'password under 8 chars'],
    [{ email: 'x@y.test', password: '' }, 'empty password'],
    [{ email: '', password: 'password123' }, 'empty email'],
  ];
  for (const [body, label] of cases) {
    const r = await api('POST', '/api/auth/register', body);
    assert.equal(r.status, 400, label);
  }
  // Exactly 8 is the documented minimum, so it must be accepted.
  const ok = await api('POST', '/api/auth/register', { email: 'eight@y.test', password: '12345678' });
  assert.equal(ok.status, 201);
});

test('a request to a non-existent method does not take the server down', async () => {
  const resp = await fetch(new URL('/api/auth/register', base)); // GET, not POST
  assert.equal(resp.status, 404);
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);
});

test('email uniqueness ignores case', async () => {
  let r = await api('POST', '/api/auth/register', { email: 'Case@Test.dev', password: 'password123' });
  assert.equal(r.status, 201);
  r = await api('POST', '/api/auth/register', { email: 'case@test.dev', password: 'password123' });
  assert.equal(r.status, 409, 'CASE@test.dev is the same account');
  r = await api('POST', '/api/auth/register', { email: 'CASE@TEST.DEV', password: 'password123' });
  assert.equal(r.status, 409);
});

test('login matches email case-insensitively', async () => {
  await api('POST', '/api/auth/register', { email: 'Login@Test.dev', password: 'password123' });
  const r = await api('POST', '/api/auth/login', { email: 'LOGIN@test.DEV', password: 'password123' });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
});

test('login failures are indistinguishable', async () => {
  await api('POST', '/api/auth/register', { email: 'known@test.dev', password: 'password123' });
  const wrongPass = await api('POST', '/api/auth/login', { email: 'known@test.dev', password: 'nope12345' });
  const unknown = await api('POST', '/api/auth/login', { email: 'ghost@test.dev', password: 'password123' });
  const empty = await api('POST', '/api/auth/login', {});
  assert.equal(wrongPass.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(empty.status, 401);
  assert.equal(wrongPass.body.error, unknown.body.error, 'must not reveal whether the account exists');
});

test('no response ever carries the password hash', async () => {
  const reg = await api('POST', '/api/auth/register', { email: 'leak@test.dev', password: 'password123' });
  const log = await api('POST', '/api/auth/login', { email: 'leak@test.dev', password: 'password123' });
  const me = await api('GET', '/api/me', undefined, log.body.token);
  for (const r of [reg, log, me]) {
    const json = JSON.stringify(r.body);
    assert.ok(!/password_hash|passwordHash|\$2[aby]\$/.test(json), json);
  }
});

test('/api/me returns the caller identity', async () => {
  const u = await newUser();
  const r = await api('GET', '/api/me', undefined, u.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, u.id);
  assert.equal(r.body.email, u.email);
  assert.equal(r.body.tier, 'free');
});

test('bearer token handling', async () => {
  const u = await newUser();

  // No header.
  let r = await api('GET', '/api/me');
  assert.equal(r.status, 401);
  assert.match(r.body.error, /missing bearer token/);

  // Header present but not a Bearer scheme.
  const basic = await fetch(`${base}/api/me`, { headers: { Authorization: `Basic ${u.token}` } });
  assert.equal(basic.status, 401);

  // Structurally invalid token.
  r = await api('GET', '/api/me', undefined, 'not.a.jwt');
  assert.equal(r.status, 401);
  assert.match(r.body.error, /invalid token/);

  // Valid shape, wrong signing key — the whole point of the secret.
  const forged = jwt.sign({ sub: u.id }, 'not-the-test-secret');
  r = await api('GET', '/api/me', undefined, forged);
  assert.equal(r.status, 401);
  assert.match(r.body.error, /invalid token/);

  // Correctly signed but for a user that does not exist.
  const orphan = jwt.sign({ sub: '00000000-0000-4000-8000-000000000000' }, 'test-secret');
  r = await api('GET', '/api/me', undefined, orphan);
  assert.equal(r.status, 401);
  assert.match(r.body.error, /unknown user/);

  // Correctly signed but already expired.
  const expired = jwt.sign({ sub: u.id }, 'test-secret', { expiresIn: '-1s' });
  r = await api('GET', '/api/me', undefined, expired);
  assert.equal(r.status, 401);
});

test('every protected route rejects an anonymous caller', async () => {
  const routes = [
    ['GET', '/api/me'],
    ['GET', '/api/library'],
    ['POST', '/api/library'],
    ['PUT', '/api/library/whatever'],
    ['DELETE', '/api/library/whatever'],
    ['GET', '/api/progress'],
    ['GET', '/api/progress/continue'],
    ['PUT', '/api/progress/whatever'],
    ['GET', '/api/trackers'],
    ['POST', '/api/trackers/anilist/connect'],
    ['DELETE', '/api/trackers/anilist'],
    ['GET', '/api/meta/scrape?url=https://example.com'],
    ['POST', '/api/meta/check'],
  ];
  for (const [method, path] of routes) {
    const r = await api(method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
    assert.equal(r.status, 401, `${method} ${path} must require auth`);
  }
});

test('public routes stay public', async () => {
  for (const path of ['/api/health', '/api/rules']) {
    const r = await api('GET', path);
    assert.equal(r.status, 200, path);
  }
  // The cover proxy is deliberately unauthenticated (an <img> cannot send a
  // header) — it must answer on its own terms, not with a 401.
  const cover = await api('GET', '/api/cover?url=http://127.0.0.1/x.png');
  assert.equal(cover.status, 400);
});

test('token from register works immediately', async () => {
  const r = await api('POST', '/api/auth/register', { email: 'instant@test.dev', password: 'password123' });
  const me = await api('GET', '/api/me', undefined, r.body.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.email, 'instant@test.dev');
});

test('two sign-ups racing for the same address: one wins, the other is told why', async () => {
  const email = `race-${Date.now()}@y.test`;
  const both = await Promise.all([
    api('POST', '/api/auth/register', { email, password: 'password123' }),
    api('POST', '/api/auth/register', { email, password: 'password123' }),
  ]);
  const codes = both.map((r) => r.status).sort();
  // The existence check and the insert are two round trips, so both requests
  // can pass the check. Whichever loses at the UNIQUE index must be told the
  // address is taken — not handed a 500, and above all not left hanging: the
  // handler was unwrapped, and Express 4 answers a rejected promise with
  // nothing at all.
  assert.deepEqual(codes, [201, 409]);
  const login = await api('POST', '/api/auth/login', { email, password: 'password123' });
  assert.equal(login.status, 200, 'exactly one account exists and it works');
});
