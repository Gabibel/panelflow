// Deleting an account: the right to erasure, as a route.
//
// The privacy page (web/confidentialite.html) says: "La suppression est
// immédiate et définitive : elle efface le compte et tout ce qui y est
// rattaché, sans exception ni délai." This file is what makes that sentence a
// checked claim rather than a hopeful one. Every table that carries a user_id
// is looked at after the deletion, and every one has to be empty.
//
// The other half is who may do it. A session is a token on a device, and this
// is the one action a stranger holding that device must not be able to take —
// so the password is asked again, and guessing it here is charged against the
// same allowance as guessing it at sign-in.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, addEntry, newUser, shutdown } from '../test-support/harness.js';
import { db } from '../src/db.js';

after(shutdown);

/** How many rows in `table` still name this user. */
const rows = (table, userId) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
  .get(userId).then((r) => Number(r.n));

/** An account with something in every table an account can reach. */
async function furnished() {
  const u = await newUser();
  const e = await addEntry(u.token);
  await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: 'https://example-manga-site.test/c/1', chapterLabel: 'Chapitre 1',
  }, u.token);
  await api('POST', '/api/history', {
    libraryId: e.id, chapterUrl: 'https://example-manga-site.test/c/1', pages: 3, seconds: 40,
  }, u.token);
  await api('PUT', '/api/prefs', { theme: 'dark' }, u.token);
  await api('POST', '/api/categories', { name: 'Coups de cœur' }, u.token);
  await db.prepare('INSERT INTO trackers (user_id, service, access_token) VALUES (?, ?, ?)')
    .run(u.id, 'anilist', 'tok');
  await db.prepare(
    'INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)',
  ).run(`https://push.test/${u.id}`, u.id, 'k', 'a');
  return { ...u, entry: e };
}

test('the account and everything attached to it are gone, at once', async () => {
  const u = await furnished();
  // The furniture is really there, or the assertions below prove nothing.
  for (const table of ['library', 'progress', 'history', 'prefs', 'categories', 'trackers', 'push_subs']) {
    assert.ok(await rows(table, u.id) > 0, `${table} was not furnished — the test would pass on an empty account`);
  }

  const r = await api('DELETE', '/api/auth/me', { password: 'password123' }, u.token);
  assert.equal(r.status, 204);

  // Every table that names a user. If a new one is added to db.js without ON
  // DELETE CASCADE, add it here and watch this fail.
  for (const table of [
    'library', 'progress', 'history', 'prefs', 'categories', 'news',
    'trackers', 'tracker_links', 'push_subs', 'password_resets', 'email_changes',
  ]) {
    assert.equal(await rows(table, u.id), 0, `${table} still holds rows for the deleted account`);
  }
  const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(u.id);
  assert.equal(user, undefined, 'the users row itself survived');
});

test('every session dies with the account', async () => {
  const u = await newUser();
  await api('DELETE', '/api/auth/me', { password: 'password123' }, u.token);
  // The token is still a validly signed token. What it names no longer exists.
  assert.equal((await api('GET', '/api/me', undefined, u.token)).status, 401);
  assert.equal((await api('GET', '/api/library', undefined, u.token)).status, 401);
});

test('the address can be registered again afterwards', async () => {
  // "Definitive" is about the data, not the person: nothing is kept that would
  // stop the same address from starting over.
  const u = await newUser();
  await api('DELETE', '/api/auth/me', { password: 'password123' }, u.token);
  const again = await api('POST', '/api/auth/register', { email: u.email, password: 'password123' });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.user.id, u.id, 'a fresh account, not the old one back');
});

test('the wrong password deletes nothing', async () => {
  const u = await furnished();
  const r = await api('DELETE', '/api/auth/me', { password: 'not-it' }, u.token);
  // 403, not 401: a 401 is what every client reads as "session expired", and
  // a mistyped password must not sign anyone out.
  assert.equal(r.status, 403);
  assert.equal(await rows('library', u.id), 1);
  assert.ok(await db.prepare('SELECT id FROM users WHERE id = ?').get(u.id));
  // And the session still works: a wrong guess is refused, not punished.
  assert.equal((await api('GET', '/api/me', undefined, u.token)).status, 200);
});

test('no password at all is the wrong password', async () => {
  const u = await newUser();
  assert.equal((await api('DELETE', '/api/auth/me', {}, u.token)).status, 403);
  assert.equal((await api('DELETE', '/api/auth/me', undefined, u.token)).status, 403);
  assert.ok(await db.prepare('SELECT id FROM users WHERE id = ?').get(u.id));
});

test('without a session there is nothing to delete', async () => {
  assert.equal((await api('DELETE', '/api/auth/me', { password: 'password123' })).status, 401);
});

test('guessing the password here is charged like guessing it at sign-in', async () => {
  // Wrong tries on this route spend the account's sign-in allowance
  // (LIMITS.loginAccount, ten per quarter hour in production and here — it is
  // one of the limits the harness leaves at its real value). Once spent, even
  // the right password is refused before it is looked at.
  const u = await newUser();
  let locked = null;
  for (let i = 0; i < 30 && locked === null; i++) {
    const r = await api('DELETE', '/api/auth/me', { password: `wrong-${i}` }, u.token);
    if (r.status === 429) locked = i;
  }
  assert.ok(locked !== null, 'thirty wrong passwords and never a 429');
  const r = await api('DELETE', '/api/auth/me', { password: 'password123' }, u.token);
  assert.equal(r.status, 429, 'the right password went through while the account was locked');
  assert.ok(await db.prepare('SELECT id FROM users WHERE id = ?').get(u.id), 'the account was deleted while locked');
  // And the same lock is visible at the front door: it is one allowance.
  assert.equal((await api('POST', '/api/auth/login', { email: u.email, password: 'password123' })).status, 429);
});
