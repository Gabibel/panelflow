// Changing the account's address: asked with the password, applied by a link.
//
// The address is how an account is recovered, so it is protected by both
// proofs the account has: the password (a device left signed in must not be
// able to point recovery elsewhere) and a link sent to the *new* inbox
// (nothing is applied until the person asking has shown they can read it).
// Every test here is one of the ways that could go wrong: a typo that must
// change nothing, an address somebody else has, a link that is dead or spent,
// a wrong password that must not sign anyone out.
//
// Mail is read from src/mail.js's outbox, as password-reset.test.js does.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown } from '../test-support/harness.js';
import { outbox } from '../src/mail.js';
import { db } from '../src/db.js';

after(shutdown);

const linkTo = (email) => {
  const mail = [...outbox].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
  return mail?.text.match(/#confirm-email=([\w-]+)/)?.[1] ?? null;
};
let seq = 0;
const fresh = () => `moved${Date.now()}-${seq++}@test.dev`;

test('the address changes only once the new inbox has clicked', async () => {
  const u = await newUser();
  const next = fresh();
  const r = await api('POST', '/api/auth/email', { password: 'password123', email: next }, u.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Asked, not applied: the old address still signs in, the new one does not.
  assert.equal((await api('POST', '/api/auth/login', { email: u.email, password: 'password123' })).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { email: next, password: 'password123' })).status, 401);

  // The mail went to the new address, and names the old one.
  const token = linkTo(next);
  assert.ok(token, 'no confirmation link reached the new address');
  const mail = [...outbox].reverse().find((m) => m.to === next);
  assert.ok(mail.text.includes(u.email), 'the mail does not say which account is moving');

  const done = await api('POST', '/api/auth/email/confirm', { token });
  assert.equal(done.status, 200);
  assert.equal(done.body.email, next);
  assert.equal((await api('POST', '/api/auth/login', { email: next, password: 'password123' })).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { email: u.email, password: 'password123' })).status, 401);
  // The session that asked is still good: the password did not change.
  assert.equal((await api('GET', '/api/me', undefined, u.token)).body.email, next);
});

test('the link works once', async () => {
  const u = await newUser();
  const next = fresh();
  await api('POST', '/api/auth/email', { password: 'password123', email: next }, u.token);
  const token = linkTo(next);
  assert.equal((await api('POST', '/api/auth/email/confirm', { token })).status, 200);
  assert.equal((await api('POST', '/api/auth/email/confirm', { token })).status, 400);
});

test('asking again replaces the earlier link', async () => {
  const u = await newUser();
  const first = fresh();
  await api('POST', '/api/auth/email', { password: 'password123', email: first }, u.token);
  const stale = linkTo(first);
  const second = fresh();
  await api('POST', '/api/auth/email', { password: 'password123', email: second }, u.token);
  assert.equal((await api('POST', '/api/auth/email/confirm', { token: stale })).status, 400, 'the first link still worked');
  assert.equal((await api('POST', '/api/auth/email/confirm', { token: linkTo(second) })).status, 200);
});

test('the wrong password asks nothing, sends nothing, and keeps the session', async () => {
  const u = await newUser();
  const next = fresh();
  const before = outbox.length;
  const r = await api('POST', '/api/auth/email', { password: 'nope', email: next }, u.token);
  assert.equal(r.status, 403, '401 would sign the reader out for a typo');
  assert.equal(outbox.length, before, 'a mail went out anyway');
  assert.equal((await api('GET', '/api/me', undefined, u.token)).status, 200);
});

test('an address somebody else has is refused before any mail', async () => {
  const other = await newUser();
  const u = await newUser();
  const before = outbox.length;
  const r = await api('POST', '/api/auth/email', { password: 'password123', email: other.email }, u.token);
  assert.equal(r.status, 409);
  assert.equal(outbox.length, before);
});

test('an address taken between asking and clicking is refused at the click', async () => {
  const u = await newUser();
  const next = fresh();
  await api('POST', '/api/auth/email', { password: 'password123', email: next }, u.token);
  const token = linkTo(next);
  // Somebody registers that address in the meantime.
  assert.equal((await api('POST', '/api/auth/register', { email: next, password: 'password123' })).status, 201);
  assert.equal((await api('POST', '/api/auth/email/confirm', { token })).status, 409);
  assert.equal((await api('GET', '/api/me', undefined, u.token)).body.email, u.email, 'the address moved anyway');
});

test('not an address, or the same address, is refused up front', async () => {
  const u = await newUser();
  assert.equal((await api('POST', '/api/auth/email', { password: 'password123', email: 'nope' }, u.token)).status, 400);
  assert.equal((await api('POST', '/api/auth/email', { password: 'password123', email: u.email }, u.token)).status, 400);
  assert.equal((await api('POST', '/api/auth/email', { password: 'password123', email: '' }, u.token)).status, 400);
});

test('it takes a session to ask, and none to confirm', async () => {
  assert.equal((await api('POST', '/api/auth/email', { password: 'password123', email: fresh() })).status, 401);
  assert.equal((await api('POST', '/api/auth/email/confirm', { token: 'not-a-token' })).status, 400);
});

test('a pending change dies with the account', async () => {
  const u = await newUser();
  await api('POST', '/api/auth/email', { password: 'password123', email: fresh() }, u.token);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM email_changes WHERE user_id = ?').get(u.id)).n), 1);
  await api('DELETE', '/api/auth/me', { password: 'password123' }, u.token);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM email_changes WHERE user_id = ?').get(u.id)).n), 0);
});
