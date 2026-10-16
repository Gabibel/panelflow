// A session the server stopped accepting signs the device out, and says so.
//
// Tokens expire after thirty days and a password change retires them
// (backend/src/auth.js), and no client noticed: the popup, the options page
// and the phone went on saying "Signed in as ..." while every request was
// refused, the sync stopped without a word, and "Sync now" answered "Synced"
// (seen on the real Android app, QA 2026-10-16). The server marks those
// refusals `session_ended` or `unknown_user` (src/error-codes.js), and
// shared/panelflow-core.js signs out on those codes and on nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore, json, entryFixture } from '../test-support/core.js';

const signedIn = (extra = {}) => ({
  authToken: 'tok-1',
  authUser: { id: 'u1', email: 'reader@test.dev' },
  categories: [{ id: 'cat:1', name: 'Weekly' }],
  accountPrefs: { theme: 'dark' },
  accountReads: { x: 1 },
  library: [entryFixture({ remoteId: 'r1' })],
  ...extra,
});

/** A backend that refuses everything the way requireAuth does. */
const refusing = (error = 'invalid token') => async () => json({ error, code: 'session_ended' }, 401);

test('a refused session signs the device out, keeps the library, and notes why', async () => {
  const { core, storage } = bootCore({ storage: signedIn(), fetch: refusing() });
  await assert.rejects(core.pullLibrary(), /invalid token/);
  const s = storage();
  assert.equal(s.authToken, null);
  assert.equal(s.authUser, null);
  // An expired session is still the reader's library: signing back in resumes
  // it (endSession, 'expired'). Only the account's reads go, as on sign-out.
  assert.deepEqual(s.categories, [{ id: 'cat:1', name: 'Weekly' }]);
  assert.equal(s.library.length, 1, 'the library is this device\'s and stays');
  assert.deepEqual(s.accountReads, {});
  assert.equal(s.sessionEnded.reason, 'expired');
  assert.ok(s.sessionEnded.at);
  const account = await core.getAccount();
  assert.equal(account.authUser, null);
  assert.equal(account.sessionEnded.reason, 'expired');
});

test('a route\'s own refusal is not the session ending', async () => {
  // A tracker that is not connected, a wrong password: the request failed,
  // the session is fine.
  const { core, storage } = bootCore({
    storage: signedIn(),
    fetch: async () => json({ error: 'connect that tracker first, in Trackers' }, 401),
  });
  await assert.rejects(core.pullLibrary());
  assert.equal(storage().authToken, 'tok-1');
  assert.equal(storage().sessionEnded, undefined);
});

test('a token replaced while its request was out is not undone by the answer', async () => {
  // A request goes out with the old token, the reader signs in again while it
  // is out, and the old token's refusal comes back.
  let release;
  const gate = new Promise((r) => { release = r; });
  let signInDone = false;
  const boot = bootCore({
    storage: signedIn(),
    fetch: async (url) => {
      if (String(url).endsWith('/api/auth/login')) {
        signInDone = true;
        return json({ token: 'tok-2', user: { id: 'u1', email: 'reader@test.dev' } });
      }
      await gate;
      return json({ error: 'invalid token', code: 'session_ended' }, 401);
    },
  });
  const pending = boot.core.pullLibrary().catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  await boot.core.authenticate('login', 'reader@test.dev', 'password123');
  assert.ok(signInDone);
  release();
  await pending;
  const s = boot.storage();
  assert.equal(s.authToken, 'tok-2', 'the new session was signed out by the old one\'s refusal');
  assert.equal(s.sessionEnded, null);
});

test('"Sync now" over an ended session fails instead of saying it synced', async () => {
  const { hub, storage } = bootCore({ storage: signedIn(), fetch: refusing('password changed, sign in again') });
  const r = await hub({ type: 'syncNow' });
  assert.ok(r.error, `syncNow answered ${JSON.stringify(r)}`);
  assert.equal(r.ok, false);
  assert.equal(r.signedOut, true);
  assert.equal(storage().authToken, null);
});

test('signing in, or out on purpose, clears the note', async () => {
  const { core, storage } = bootCore({
    storage: { sessionEnded: { reason: 'expired', at: '2026-10-16T10:00:00.000Z' } },
    fetch: async () => json({ token: 'tok-3', user: { id: 'u1', email: 'reader@test.dev' } }),
  });
  await core.authenticate('login', 'reader@test.dev', 'password123');
  assert.equal(storage().sessionEnded, null);
  await core.logout();
  assert.equal(storage().sessionEnded, null, 'signing out on purpose is not a session that ended');
});

test('"Sync now" after an earlier request ended the session still says it did not sync', async () => {
  // The older shell pulls first (pullNow), and that pull is where the refusal
  // lands; syncAll then found no token and returned, and the hub said ok.
  const { hub, storage } = bootCore({ storage: signedIn(), fetch: refusing() });
  const pulled = await hub({ type: 'pullNow' });
  assert.ok(pulled.error);
  const r = await hub({ type: 'syncNow' });
  assert.equal(r.ok, false, `syncNow answered ${JSON.stringify(r)}`);
  assert.equal(r.signedOut, true);
  assert.equal(storage().authToken, null);
});

test('the statistics read that meets an ended session shows this device\'s figures', async () => {
  const { core, storage } = bootCore({ storage: signedIn(), fetch: refusing() });
  const stats = await core.getStats();
  assert.ok(stats && !stats.error, `getStats answered ${JSON.stringify(stats)}`);
  assert.equal(storage().authToken, null);
});
