// The web app signs out when the session is refused, and only then.
//
// `unwrap` (web/app.js) used to sign out on any 401 while signed in. The
// tracker routes answer 401 too when a tracker connection has expired
// (routes/trackers.js tokenFor) or MyAnimeList refuses its token
// (routes/import.js): "Send everything to AniList" or "Import from
// MyAnimeList" dropped the reader to the sign-in screen with "session
// expired", the PanelFlow session being fine. Every refusal now carries a code
// (src/error-codes.js), and only the session's own, `session_ended` and
// `unknown_user`, signs out.
//
// Lifted out of the shipping file, like the other web tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'web', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('async function unwrap(res, path) {');
const b = src.indexOf('\n}\n', a);
assert.ok(a !== -1 && b > a, 'unwrap is not where this test expects it');

// The two sentences this test needs from the catalogue; any other key comes
// back as itself, which unwrap reads as "no translation".
const SAID = { err_tracker_expired: 'The connection to this tracker has expired. Connect it again.' };

/** unwrap, signed in, over one answer; what it threw and why it signed out. */
async function answer(status, body) {
  const signOuts = [];
  const unwrap = new Function('user', 'signOut', 't', `${src.slice(a, b + 2)}\nreturn unwrap;`)(
    { email: 'reader@test.dev' }, (why) => { signOuts.push(why); }, (key) => SAID[key] ?? key);
  const res = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const error = await unwrap(res, '/trackers/anilist/push').then(() => null, (e) => e);
  return { signOuts, error };
}

test('a refused session signs the web app out, saying why', async () => {
  const ended = await answer(401, { error: 'invalid token', code: 'session_ended' });
  assert.deepEqual(ended.signOuts, ['sessionExpired']);
  assert.equal(ended.error.message, 'webSessionExpired');
  const gone = await answer(401, { error: 'unknown user', code: 'unknown_user' });
  assert.deepEqual(gone.signOuts, ['err_unknown_user']);
});

test('a tracker connection that expired is said as such, and the reader stays signed in', async () => {
  const r = await answer(401, { error: 'the connection to this tracker has expired', code: 'tracker_expired' });
  assert.deepEqual(r.signOuts, [], 'a tracker\'s 401 signed the reader out of PanelFlow');
  assert.equal(r.error.message, SAID.err_tracker_expired);
  assert.equal(r.error.pfSaid, 'the connection to this tracker has expired');
  assert.equal(r.error.pfStatus, 401);
  // A 401 with no code at all (a proxy, an older server) is not the session.
  const bare = await answer(401, {});
  assert.deepEqual(bare.signOuts, []);
});
