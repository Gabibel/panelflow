// Tracker tokens are sealed in the database (launch review, October 2026).
//
// An AniList or MyAnimeList token is that account. The table used to hold
// them in clear, so a copy of the database was a key to every connected
// tracker account. What is checked here: a token never reaches a row in
// clear, a row from before sealing keeps working and gets sealed by the
// nightly run, and a row that was tampered with, or sealed under another
// secret, reads as "not connected" rather than as something else.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newUser, shutdown } from '../test-support/harness.js';
import { db } from '../src/db.js';
import { seal, open, isSealed } from '../src/sealed.js';
import { storeTokens, freshToken, sealLegacyTokens } from '../src/tracker-oauth.js';

after(shutdown);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const row = (userId, service) =>
  db.prepare('SELECT access_token, refresh_token FROM trackers WHERE user_id = ? AND service = ?').get(userId, service);

test('a sealed value opens to what was sealed, and never shows it', () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.the-account.signature';
  const sealed = seal(token);
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes('the-account'), 'the sealed value carries the token in clear');
  assert.equal(open(sealed), token);
  // A nonce of its own each time: two rows holding the same token cannot be
  // told to be the same by comparing them.
  assert.notEqual(seal(token), sealed);
  assert.equal(seal(null), null);
  assert.equal(open(null), null);
});

test('a value from before sealing reads as it is', () => {
  assert.equal(open('eyJ.legacy.token'), 'eyJ.legacy.token');
});

test('an edited value does not open to something else, it does not open', () => {
  const sealed = seal('token');
  const [nonce, tag, body] = sealed.slice(4).split('.');
  const flipped = Buffer.from(body, 'base64url');
  flipped[0] ^= 1;
  assert.equal(open(`pf1:${nonce}.${tag}.${flipped.toString('base64url')}`), null);
  assert.equal(open('pf1:not-even-three-parts'), null);
});

test('a value sealed under another secret reads as no token', () => {
  const before = process.env.PANELFLOW_DATA_KEY;
  try {
    process.env.PANELFLOW_DATA_KEY = 'the-secret-before-a-rotation';
    const sealed = seal('token');
    process.env.PANELFLOW_DATA_KEY = 'the-secret-after-it';
    assert.equal(open(sealed), null);
  } finally {
    if (before === undefined) delete process.env.PANELFLOW_DATA_KEY;
    else process.env.PANELFLOW_DATA_KEY = before;
  }
});

test('connecting a tracker writes neither token in clear', async () => {
  const u = await newUser();
  await storeTokens(u.id, 'anilist', { access_token: 'ani-access', refresh_token: 'ani-refresh', expires_in: 3600 }, 'reader');
  const r = await row(u.id, 'anilist');
  assert.ok(isSealed(r.access_token) && isSealed(r.refresh_token));
  assert.ok(!JSON.stringify(r).includes('ani-access') && !JSON.stringify(r).includes('ani-refresh'));
  assert.equal(await freshToken(u.id, 'anilist'), 'ani-access');
});

test('a connection from before sealing keeps working, and the nightly run seals it', async () => {
  const u = await newUser();
  await db.prepare(`INSERT INTO trackers (user_id, service, access_token, refresh_token, expires_at)
                    VALUES (?, 'anilist', 'old-access', 'old-refresh', datetime('now', '+30 days'))`).run(u.id);
  assert.equal(await freshToken(u.id, 'anilist'), 'old-access');

  assert.ok(await sealLegacyTokens() >= 1);
  const r = await row(u.id, 'anilist');
  assert.ok(isSealed(r.access_token) && isSealed(r.refresh_token), 'the nightly run left a token in clear');
  assert.equal(await freshToken(u.id, 'anilist'), 'old-access', 'sealing changed what the token is');
  // Run again, it finds nothing left to do and changes nothing.
  const sealedOnce = r.access_token;
  await sealLegacyTokens();
  assert.equal((await row(u.id, 'anilist')).access_token, sealedOnce);
});

test('a connection without a refresh token is sealed without inventing one', async () => {
  const u = await newUser();
  await db.prepare(`INSERT INTO trackers (user_id, service, access_token) VALUES (?, 'mal', 'lonely-access')`).run(u.id);
  await sealLegacyTokens();
  const r = await row(u.id, 'mal');
  assert.ok(isSealed(r.access_token));
  assert.equal(r.refresh_token, null);
});

test('the nightly run is where the old rows get sealed', () => {
  const watch = readFileSync(join(root, 'backend', 'src', 'routes', 'watch.js'), 'utf8');
  assert.match(watch, /import \{ sealLegacyTokens \} from '\.\.\/tracker-oauth\.js'/);
  assert.match(watch, /Promise\.all\(\[[^\]]*sealLegacyTokens\(\)[^\]]*\]\)/);
});
