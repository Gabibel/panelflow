// Getting — and keeping — permission to write to a tracker.
//
// Three services, three dialects of the same handshake, and the differences are
// not cosmetic:
//
//   * AniList takes a JSON body at the token endpoint and hands back a token
//     good for a year. There is no usable refresh: when it finally expires the
//     honest answer is to ask the user to connect again.
//   * MyAnimeList takes a form-encoded body, insists on PKCE, and its access
//     token lasts an hour. Without refresh a connection made at breakfast is
//     dead by lunch, so refresh is not optional there — it is the feature.
//   * Kitsu has no authorize page at all; it wants the user's password. That is
//     implemented nowhere here, on purpose (see below).
//
// The client secret never leaves this process. The client opens `authorizeUrl`,
// the tracker redirects the browser to /api/trackers/:service/callback, and the
// exchange happens here.
import crypto from 'node:crypto';
import { db } from './db.js';
import { signOAuthState, readOAuthState } from './auth.js';

const TIMEOUT_MS = 10000;

export const SERVICES = {
  anilist: {
    authorize: 'https://anilist.co/api/v2/oauth/authorize',
    token: 'https://anilist.co/api/v2/oauth/token',
    form: false,
    pkce: false,
    // AniList's token is valid for a year and its refresh grant is not
    // something the API documents working. Reconnecting once a year is a
    // smaller lie than a refresh path nobody has ever seen succeed.
    refreshable: false,
  },
  mal: {
    authorize: 'https://myanimelist.net/v1/oauth2/authorize',
    token: 'https://myanimelist.net/v1/oauth2/token',
    form: true,
    // MAL requires code_challenge and supports only the `plain` method, so the
    // challenge *is* the verifier. See makeVerifier for why that costs nothing
    // here.
    pkce: true,
    refreshable: true,
  },
  kitsu: {
    // Kitsu authenticates with the user's own Kitsu password (a resource-owner
    // grant). PanelFlow does not ask for it: this server would then hold, in
    // memory and in whatever logged the request, the password to an account it
    // has no other business with — and Kitsu is also the one service progress
    // cannot be pushed to, so the trade buys nothing. Connecting it answers 501.
    authorize: null,
    token: 'https://kitsu.io/api/oauth/token',
    form: true,
    pkce: false,
    refreshable: true,
  },
};

export const cfg = (service, key) => process.env[`PANELFLOW_${service.toUpperCase()}_${key}`];

/** Both halves of the configuration, or the name of the one that is missing. */
export function missingConfig(service) {
  const upper = service.toUpperCase();
  for (const key of ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI']) {
    if (!cfg(service, key)) return `PANELFLOW_${upper}_${key}`;
  }
  return null;
}

/**
 * A PKCE verifier, carried in the signed `state` rather than in a table.
 *
 * That is not the textbook placement — PKCE exists so that an attacker who
 * intercepts the redirect cannot use the code, and a verifier travelling in the
 * same redirect is no obstacle to them. It is honest here because PanelFlow is
 * a confidential client: the code is worthless without the client secret, which
 * never leaves this process, and MAL's requirement is met either way. What it
 * buys is a lambda with nowhere to keep a per-flow secret between two requests.
 */
const makeVerifier = () => crypto.randomBytes(48).toString('base64url');

export function authorizeUrl(service, userId) {
  const svc = SERVICES[service];
  const verifier = svc.pkce ? makeVerifier() : null;
  const url = new URL(svc.authorize);
  url.searchParams.set('client_id', cfg(service, 'CLIENT_ID'));
  url.searchParams.set('redirect_uri', cfg(service, 'REDIRECT_URI'));
  url.searchParams.set('response_type', 'code');
  if (verifier) {
    url.searchParams.set('code_challenge', verifier);
    url.searchParams.set('code_challenge_method', 'plain');
  }
  // `state` carries the user id, signed, so the callback can attach the tokens
  // to an account without a bearer token it will never be given.
  url.searchParams.set('state', signOAuthState(userId, service, verifier ? { v: verifier } : {}));
  return url.toString();
}

async function post(url, { form, body, headers = {} }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        ...headers,
      },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!resp.ok) {
      // The tracker's own words when it has any: "invalid_grant" tells the user
      // their code went stale, and `502` alone tells them nothing.
      const said = parsed?.error_description || parsed?.error || parsed?.hint;
      const err = new Error(said ? `${service_of(url)}: ${said}` : `${service_of(url)} answered ${resp.status}`);
      err.status = 502;
      throw err;
    }
    if (!parsed?.access_token) {
      throw Object.assign(new Error(`${service_of(url)} returned no access token`), { status: 502 });
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

const service_of = (url) => { try { return new URL(url).host; } catch { return 'the tracker'; } };

/** The authorization code, traded for tokens. Throws with a `status`. */
export function exchangeCode(service, code, verifier) {
  const svc = SERVICES[service];
  const body = {
    grant_type: 'authorization_code',
    client_id: cfg(service, 'CLIENT_ID'),
    client_secret: cfg(service, 'CLIENT_SECRET'),
    redirect_uri: cfg(service, 'REDIRECT_URI'),
    code,
  };
  if (svc.pkce) body.code_verifier = verifier ?? '';
  return post(svc.token, { form: svc.form, body });
}

/** Reads the `state` the tracker handed back: who it was, and their verifier. */
export function readState(state, service) {
  return readOAuthState(state, service, { full: true });
}

// --- storing, and keeping fresh ---------------------------------------------

/**
 * Tokens in, one row out. `expires_in` is seconds from now; a service that does
 * not say gets a year, which is AniList's actual answer and a safe floor for
 * anything else — an over-long expiry costs one failed push and a refresh, and
 * an over-short one logs the user out of a connection that still works.
 */
export async function storeTokens(userId, service, tok, remoteUser) {
  await db.prepare(`
    INSERT INTO trackers (user_id, service, access_token, refresh_token, expires_at, remote_user)
    VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'), ?)
    ON CONFLICT (user_id, service) DO UPDATE SET
      access_token = excluded.access_token,
      -- A refresh response often omits the refresh token, meaning "keep the one
      -- you have". Taking it literally would disconnect the account an hour
      -- later, which is exactly the failure refreshing exists to prevent.
      refresh_token = COALESCE(excluded.refresh_token, trackers.refresh_token),
      expires_at = excluded.expires_at,
      remote_user = COALESCE(excluded.remote_user, trackers.remote_user)
  `).run(userId, service, tok.access_token, tok.refresh_token ?? null,
    Math.max(60, Number(tok.expires_in) || 31536000), remoteUser ?? null);
}

// Refreshed this far ahead of the deadline. A push that starts inside the last
// minute of a token's life finishes outside it.
const EARLY_SECONDS = 300;

/**
 * The access token to use right now, refreshed if it is about to run out, or
 * null if the connection needs the user's attention again.
 *
 * Everything that talks to a tracker goes through this rather than reading
 * `access_token` — a MAL token lasts an hour, so any path that reads the column
 * directly works until the user closes their laptop and then never again.
 */
export async function freshToken(userId, service) {
  const row = await db.prepare(`
    SELECT access_token, refresh_token,
           (expires_at IS NOT NULL AND expires_at < datetime('now', '+${EARLY_SECONDS} seconds')) AS stale
    FROM trackers WHERE user_id = ? AND service = ?
  `).get(userId, service);
  if (!row) return null;
  if (!row.stale) return row.access_token;

  const svc = SERVICES[service];
  if (!svc?.refreshable || !row.refresh_token) return null;
  let tok;
  try {
    tok = await post(svc.token, {
      form: svc.form,
      body: {
        grant_type: 'refresh_token',
        client_id: cfg(service, 'CLIENT_ID'),
        client_secret: cfg(service, 'CLIENT_SECRET'),
        refresh_token: row.refresh_token,
      },
    });
  } catch {
    // A refresh token the service has revoked is not an error to raise at
    // whoever happened to turn a page — it is a connection that has ended, and
    // the caller's "not connected" is the truthful thing to say.
    return null;
  }
  await storeTokens(userId, service, tok);
  return tok.access_token;
}

// --- who this is ------------------------------------------------------------

const WHOAMI = {
  anilist: async (token) => {
    const resp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: '{ Viewer { id name } }' }),
    });
    const body = await resp.json();
    return body?.data?.Viewer?.name ?? null;
  },
  mal: async (token) => {
    const resp = await fetch('https://api.myanimelist.net/v2/users/@me?fields=name', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await resp.json())?.name ?? null;
  },
};

/**
 * The account name, for the client to show next to "connected". Best effort by
 * design: a connection that works is not worth refusing because the service was
 * slow to say whose it is.
 */
export async function whoami(service, token) {
  try {
    return (await WHOAMI[service]?.(token)) ?? null;
  } catch {
    return null;
  }
}
