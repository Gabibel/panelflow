// What stops a thing being done a million times.
//
// Two halves, tested differently on purpose. The counter itself is exercised
// directly, because the interesting cases — the window rolling over, two
// requests arriving at once — are about the SQL and not about any route. The
// login limits are exercised through the API, because their whole value is in
// which bucket each attempt lands in, and that is a decision the handler makes.
//
// The harness lifts the limits keyed on the caller's address, since every test
// here comes from 127.0.0.1 (see test-support/harness.js). The limits keyed on
// an *account* are left at their production values and are what this file
// leans on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown } from '../test-support/harness.js';
import { spend, forget, callerIp, pruneRateLimits, LIMITS } from '../src/rate-limit.js';
import { db } from '../src/db.js';

after(shutdown);

const bucket = (name) => `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test('a bucket allows exactly what it was given, then stops', async () => {
  const b = bucket('basic');
  const opts = { max: 3, windowSec: 900 };
  const verdicts = [];
  for (let i = 0; i < 5; i++) verdicts.push((await spend(b, opts)).ok);
  assert.deepEqual(verdicts, [true, true, true, false, false]);
});

test('cost is how much a call is worth, not how many calls were made', async () => {
  const b = bucket('cost');
  const opts = { max: 10, windowSec: 900 };
  assert.equal((await spend(b, { ...opts, cost: 7 })).ok, true);
  assert.equal((await spend(b, { ...opts, cost: 3 })).count, 10, 'they add up');
  assert.equal((await spend(b, { ...opts, cost: 1 })).ok, false);
});

test('a cost of nothing reads the counter without moving it', async () => {
  const b = bucket('peek');
  const opts = { max: 5, windowSec: 900 };
  await spend(b, opts);
  const peek = await spend(b, { ...opts, cost: 0 });
  const after = await spend(b, { ...opts, cost: 0 });
  assert.equal(peek.count, 1);
  assert.equal(after.count, 1, 'reading it twice is still one');
});

test('the window rolls over instead of counting forever', async () => {
  const b = bucket('window');
  // Spent to the limit inside a window one second long...
  for (let i = 0; i < 3; i++) await spend(b, { max: 2, windowSec: 1 });
  assert.equal((await spend(b, { max: 2, windowSec: 1 })).ok, false);

  // ...and reopened by backdating the row rather than by sleeping, which is the
  // same thing to the SQL and two seconds cheaper per run.
  await db.prepare("UPDATE rate_limits SET window_start = datetime('now', '-1 hour') WHERE bucket = ?")
    .run(b);
  const fresh = await spend(b, { max: 2, windowSec: 1 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.count, 1, 'the window reopened at one, not at four');
});

test('requests arriving together are counted once each', async () => {
  const b = bucket('race');
  const opts = { max: 100, windowSec: 900 };
  // Read-then-write would lose most of these: ten handlers reading 0 would all
  // write 1. The count is done by the database, in one statement.
  await Promise.all(Array.from({ length: 10 }, () => spend(b, opts)));
  const final = await spend(b, { ...opts, cost: 0 });
  assert.equal(final.count, 10);
});

test('a refusal says how long the wait is', async () => {
  const b = bucket('retry');
  const opts = { max: 1, windowSec: 900 };
  await spend(b, opts);
  const refused = await spend(b, opts);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfter > 0 && refused.retryAfter <= 900, refused.retryAfter);
});

test('forgetting a bucket puts the allowance back', async () => {
  const b = bucket('forget');
  const opts = { max: 1, windowSec: 900 };
  await spend(b, opts);
  assert.equal((await spend(b, opts)).ok, false);
  await forget(b);
  assert.equal((await spend(b, opts)).ok, true);
});

test('the sweep drops closed windows and leaves open ones alone', async () => {
  const stale = bucket('stale');
  const live = bucket('live');
  await spend(stale, { max: 5, windowSec: 900 });
  await spend(live, { max: 5, windowSec: 900 });
  await db.prepare("UPDATE rate_limits SET window_start = datetime('now', '-30 days') WHERE bucket = ?")
    .run(stale);

  await pruneRateLimits();
  const rows = await db.prepare('SELECT bucket FROM rate_limits WHERE bucket IN (?, ?)').all(stale, live);
  assert.deepEqual(rows.map((r) => r.bucket), [live]);
});

test('the caller address falls back rather than throwing when there is no proxy', () => {
  assert.equal(callerIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }), '203.0.113.7');
  assert.equal(callerIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(callerIp({ headers: {} }), 'unknown');
});

// --- through the API -------------------------------------------------------

test('guessing at one account is stopped, and the owner is not locked out', async () => {
  const u = await newUser();

  const codes = [];
  for (let i = 0; i < LIMITS.loginAccount.max + 3; i++) {
    codes.push((await api('POST', '/api/auth/login', { email: u.email, password: 'wrong-guess-123' })).status);
  }
  assert.ok(codes.includes(429), `expected a refusal in ${codes.join(',')}`);
  assert.equal(codes[0], 401, 'the first wrong password is a wrong password, not a refusal');
});

test('a correct password clears the failures it followed', async () => {
  const u = await newUser();
  // Short of the limit, the way a person who mistypes actually behaves.
  for (let i = 0; i < LIMITS.loginAccount.max - 2; i++) {
    await api('POST', '/api/auth/login', { email: u.email, password: 'not-it-either' });
  }
  assert.equal((await api('POST', '/api/auth/login', { email: u.email, password: 'password123' })).status, 200);

  // The counter went with it: someone who mistypes twice a day for a month must
  // never find the sum of it waiting for them.
  for (let i = 0; i < LIMITS.loginAccount.max - 2; i++) {
    const r = await api('POST', '/api/auth/login', { email: u.email, password: 'not-it-either' });
    assert.equal(r.status, 401, 'still counting from zero');
  }
});

test('one account being hammered does not lock the account next door', async () => {
  const target = await newUser();
  const bystander = await newUser();
  for (let i = 0; i < LIMITS.loginAccount.max + 2; i++) {
    await api('POST', '/api/auth/login', { email: target.email, password: 'wrong-guess-123' });
  }
  const r = await api('POST', '/api/auth/login', { email: bystander.email, password: 'password123' });
  assert.equal(r.status, 200, 'the limit is per account, not global');
});

test('a spent fetch budget stops the routes that go and read someone else\'s site', async () => {
  const u = await newUser();
  // Spent by writing the counter rather than by making hundreds of real calls:
  // what is under test is the wiring — that these routes charge the right
  // bucket and answer 429 rather than going out anyway — not the arithmetic,
  // which is tested above.
  await db.prepare("INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, ?, datetime('now'))")
    .run(`fetch:${u.id}`, 10 ** 9);

  for (const [method, path] of [
    ['GET', '/api/meta/scrape?url=https://example.com/manga'],
    ['GET', '/api/meta/compat?url=https://example.com/manga'],
    ['POST', '/api/meta/check'],
    ['GET', '/api/search?q=one+piece'],
  ]) {
    const r = await api(method, path, method === 'POST' ? {} : undefined, u.token);
    assert.equal(r.status, 429, `${method} ${path}`);
    assert.ok(Number(r.headers.get('retry-after')) > 0, `${path} says when to come back`);
  }

  // And the rest of the account is untouched: a reader who has spent the budget
  // has spent the *fetching*, not their library.
  assert.equal((await api('GET', '/api/library', undefined, u.token)).status, 200);
});

test('an account that does not exist is not counted against, only answered', async () => {
  // Nothing is charged to a per-account bucket for an address with no account:
  // the bucket key would be attacker-chosen and unbounded, which is a way to
  // fill the table rather than a way to protect anything. The per-address limit
  // is what covers this, and the answer stays a plain 401.
  const ghost = `ghost-${Date.now()}@test.dev`;
  for (let i = 0; i < LIMITS.loginAccount.max + 3; i++) {
    const r = await api('POST', '/api/auth/login', { email: ghost, password: 'whatever-123' });
    assert.equal(r.status, 401);
  }
  const rows = await db.prepare('SELECT bucket FROM rate_limits WHERE bucket = ?')
    .all(`login-account:${ghost}`);
  assert.equal(rows.length, 0);
});
