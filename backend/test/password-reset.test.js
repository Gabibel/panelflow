// Forgetting a password, and getting the account back.
//
// The flow has to hold two things at once: it is the only way back into an
// account, and it is a way *into* an account for anyone who can guess at it. So
// the tests below are as much about what it refuses as about what it does — a
// link that works twice, works after an hour, or works while the old session
// keeps running is a flow that gave the account away politely.
//
// Mail is read from src/mail.js's outbox rather than from an inbox: with no
// provider key configured — which is the case on a developer's machine and in
// CI — that is where a message goes instead of out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown } from '../test-support/harness.js';
import { outbox } from '../src/mail.js';

after(shutdown);

/** The reset token out of the most recent mail sent to `email`, or null. */
function linkFor(email) {
  const mail = [...outbox].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
  return mail?.text.match(/#reset=([\w-]+)/)?.[1] ?? null;
}

const forgot = (email) => api('POST', '/api/auth/forgot', { email });
const reset = (token, password) => api('POST', '/api/auth/reset', { token, password });
const login = (email, password) => api('POST', '/api/auth/login', { email, password });

test('a forgotten password comes back as a link, and the new one works', async () => {
  const u = await newUser();

  const asked = await forgot(u.email);
  assert.equal(asked.status, 200);

  const token = linkFor(u.email);
  assert.ok(token, 'a mail with a link was produced');
  assert.ok(token.length >= 40, 'the token is a real secret, not a counter');

  const done = await reset(token, 'brand-new-password');
  assert.equal(done.status, 200);
  // Deliberately no token in the answer: the new password has to be typed once,
  // and that is what proves it is the one the user meant to set.
  assert.equal(done.body.token, undefined);

  assert.equal((await login(u.email, 'brand-new-password')).status, 200);
  assert.equal((await login(u.email, 'password123')).status, 401, 'the old one is gone');
});

test('the link works once', async () => {
  const u = await newUser();
  await forgot(u.email);
  const token = linkFor(u.email);

  assert.equal((await reset(token, 'first-new-password')).status, 200);

  const again = await reset(token, 'second-new-password');
  assert.equal(again.status, 400);
  assert.equal((await login(u.email, 'second-new-password')).status, 401,
    'the second attempt changed nothing');
  assert.equal((await login(u.email, 'first-new-password')).status, 200);
});

test('two clicks arriving together: one wins, the other is told the link is dead', async () => {
  const u = await newUser();
  await forgot(u.email);
  const token = linkFor(u.email);

  // The claim is one UPDATE with `used_at IS NULL` in its WHERE, so the race is
  // settled by the database rather than by whichever handler read first.
  const both = await Promise.all([reset(token, 'racer-one-pass'), reset(token, 'racer-two-pass')]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 400]);
});

test('asking again retires the link that was sent before', async () => {
  const u = await newUser();
  await forgot(u.email);
  const first = linkFor(u.email);
  await forgot(u.email);
  const second = linkFor(u.email);
  assert.notEqual(first, second);

  // "Nothing arrived, let me click again" must not leave a trail of working
  // keys — the ones the user never sees are the ones nobody notices being used.
  assert.equal((await reset(first, 'password-via-old')).status, 400);
  assert.equal((await reset(second, 'password-via-new')).status, 200);
});

test('the reset ends every session the account already had', async () => {
  const u = await newUser();
  assert.equal((await api('GET', '/api/me', undefined, u.token)).status, 200);

  await forgot(u.email);
  await reset(linkFor(u.email), 'a-completely-new-one');

  // The point of the whole exercise: a password is changed because someone else
  // may know it, and the session that someone else is holding has thirty days
  // left on it.
  const after = await api('GET', '/api/me', undefined, u.token);
  assert.equal(after.status, 401);
  assert.match(after.body.error, /sign in again/);

  const fresh = await login(u.email, 'a-completely-new-one');
  assert.equal((await api('GET', '/api/me', undefined, fresh.body.token)).status, 200,
    'the token issued after the change is not caught by it');
});

test('a token nobody issued is refused, in every shape', async () => {
  for (const junk of [undefined, '', 'not-a-token', 'x'.repeat(64), '../../etc/passwd']) {
    const r = await reset(junk, 'password12345');
    assert.equal(r.status, 400, String(junk));
  }
});

test('a link cannot be spent on a password too short to be one', async () => {
  const u = await newUser();
  await forgot(u.email);
  const token = linkFor(u.email);

  assert.equal((await reset(token, 'short')).status, 400);
  // And the link survives the mistake: refusing the password must not also burn
  // the only way back in.
  assert.equal((await reset(token, 'long-enough-now')).status, 200);
});

test('an unknown address is answered exactly like a known one', async () => {
  const u = await newUser();
  const known = await forgot(u.email);
  const unknown = await forgot(`nobody-${Date.now()}@test.dev`);

  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.body, unknown.body);
  // And no mail was produced for the address with no account behind it.
  assert.equal(linkFor(`nobody-${Date.now()}@test.dev`), null);
});

test('an address is asked about a few times an hour, not a few times a second', async () => {
  const email = `flood-${Date.now()}@test.dev`;
  await api('POST', '/api/auth/register', { email, password: 'password123' });

  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await forgot(email)).status);

  // This limit is keyed on the address being *asked about*, not on the caller,
  // which is the only way it can stop a mail flood aimed at someone else's
  // inbox from a hundred machines at once.
  assert.ok(codes.includes(429), `expected a refusal in ${codes.join(',')}`);
  assert.equal(codes[0], 200, 'the first one goes through');
});

test('a refusal says when to come back', async () => {
  const email = `retry-${Date.now()}@test.dev`;
  await api('POST', '/api/auth/register', { email, password: 'password123' });
  let last;
  for (let i = 0; i < 6; i++) last = await forgot(email);
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0, 'Retry-After is a number of seconds');
});

test('the mail says what it is, and carries nothing else', async () => {
  const u = await newUser();
  await forgot(u.email);
  const mail = [...outbox].reverse().find((m) => m.to === u.email);

  assert.match(mail.subject, /password/i);
  assert.match(mail.text, /expires in 60 minutes/);
  assert.match(mail.text, /ignore this/, 'someone who did not ask is told to do nothing');
  assert.ok(!/\$2[aby]\$/.test(mail.text), 'no password hash rides along');
});
