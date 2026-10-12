// Secrets the server keeps on someone else's behalf, sealed before they reach
// the database.
//
// The tracker tokens are the one thing in the database that is a key to
// somewhere else: an AniList or MyAnimeList access token is that account,
// able to rewrite its list, for as long as the service honours it (a year,
// for AniList). They sat in the `trackers` table in clear until the launch
// review of October 2026, so anything that could read a copy of the database
// (a leaked Turso token, a backup left lying about) could act on every
// connected tracker account at once. Sealed, a copy of the table is a list of
// ciphertexts; the key lives in the server's environment, which is a
// different place to break into.
//
// AES-256-GCM: authenticated, so a value edited in the table does not decrypt
// to something else, it fails. Each value gets its own random nonce. The key is
// derived (HKDF-SHA-256) from PANELFLOW_DATA_KEY when it is set, otherwise from
// the session secret that a deployed server cannot boot without (see auth.js),
// under a label of its own, the way pseudonym.js derives its keys: no new
// secret is needed to deploy this, and the derived key is never a valid
// session key or a valid pseudonym.
//
// Rotating that secret makes the sealed tokens unreadable. That reads as "not
// connected" (see tracker-oauth.js freshToken) and the reader connects again:
// the same result as a revoked token, and a secret that may have leaked takes
// the tracker tokens with it, which is what a rotation is for.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// What a sealed value starts with. No AniList or MAL token starts with it (both
// are JWTs, "eyJ…"), so a value without it is one written before sealing
// existed, read as it is and sealed again the next time it is written.
const PREFIX = 'pf1:';

// Read at call time, like pseudonym.js, so that a test setting the secret first
// is honoured.
function key() {
  const base = process.env.PANELFLOW_DATA_KEY || process.env.PANELFLOW_JWT_SECRET || 'dev-secret-change-me';
  return Buffer.from(hkdfSync('sha256', base, 'panelflow', 'panelflow:sealed:v1', 32));
}

/** Whether `value` is a sealed one (and not a value from before sealing). */
export const isSealed = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/** `value` sealed for the database; null and undefined stay null. */
export function seal(value) {
  if (value === null || value === undefined) return null;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [nonce, tag, body].map((b) => b.toString('base64url')).join('.');
}

/**
 * What `stored` was sealed from. A value written before sealing comes back as
 * it is; one that does not open (another key, an edited row) comes back as
 * null, which every caller already reads as "no token".
 */
export function open(stored) {
  if (stored === null || stored === undefined) return null;
  if (!isSealed(stored)) return String(stored);
  try {
    const [nonce, tag, body] = stored.slice(PREFIX.length).split('.').map((s) => Buffer.from(s, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key(), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
