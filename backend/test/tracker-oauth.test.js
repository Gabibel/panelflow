// The OAuth handshake, and staying connected afterwards.
//
// Three services, three dialects, and the differences are the whole reason this
// file exists: AniList wants JSON and lasts a year, MAL wants a form and lasts
// an hour, and code that treats them the same works against exactly one of them.
// The tests that matter most are the ones about the second request — the token
// a user got at breakfast being no good at lunch is the failure nobody sees in
// a manual test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, addEntry, newUser, shutdown, base } from '../test-support/harness.js';
import { db } from '../src/db.js';

after(() => { globalThis.fetch = realFetch; shutdown(); });

const realFetch = globalThis.fetch;
let outbound = null;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.startsWith(base)) return realFetch(input, init);
  if (!outbound) throw new Error(`unexpected outbound fetch: ${url}`);
  return outbound(url, init);
};

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

function configure(service) {
  const env = {
    CLIENT_ID: 'test-client',
    CLIENT_SECRET: 'test-secret',
    REDIRECT_URI: `https://panelflow.test/api/trackers/${service}/callback`,
  };
  for (const [k, v] of Object.entries(env)) process.env[`PANELFLOW_${service.toUpperCase()}_${k}`] = v;
  return () => {
    for (const k of Object.keys(env)) delete process.env[`PANELFLOW_${service.toUpperCase()}_${k}`];
  };
}

/** Walk the user through /connect and hand the callback whatever the tracker would. */
async function connectFlow(service, token, { tokenResponse, whoName = 'reader' }) {
  const calls = { token: [], whoami: [] };
  outbound = async (url, init) => {
    if (url.includes('oauth')) {
      calls.token.push({ url, headers: init.headers, body: init.body });
      return json(tokenResponse);
    }
    calls.whoami.push(url);
    if (url.includes('anilist')) return json({ data: { Viewer: { id: 7, name: whoName } } });
    return json({ id: 7, name: whoName });
  };
  const connect = await api('POST', `/api/trackers/${service}/connect`, {}, token);
  assert.equal(connect.status, 200, JSON.stringify(connect.body));
  const url = new URL(connect.body.authorizeUrl);
  const back = await api('GET',
    `/api/trackers/${service}/callback?code=the-code&state=${url.searchParams.get('state')}`);
  return { calls, back, challenge: url.searchParams.get('code_challenge') };
}

test('AniList: the code is traded as JSON, and the account name comes back with it', async () => {
  const u = await newUser();
  const done = configure('anilist');
  try {
    const { calls, back } = await connectFlow('anilist', u.token, {
      tokenResponse: { access_token: 'ani-tok', refresh_token: 'ani-ref', expires_in: 31536000 },
      whoName: 'gabibel',
    });
    assert.equal(back.status, 200);
    assert.match(String(back.body), /Connected/);

    assert.equal(calls.token.length, 1);
    const sent = calls.token[0];
    assert.equal(sent.url, 'https://anilist.co/api/v2/oauth/token');
    assert.match(sent.headers['Content-Type'], /application\/json/);
    const body = JSON.parse(sent.body);
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.code, 'the-code');
    assert.equal(body.client_secret, 'test-secret');

    const list = (await api('GET', '/api/trackers', undefined, u.token)).body;
    assert.deepEqual(list.map((t) => t.service), ['anilist']);
    // Shown next to "connected" — without it the screen can only say that some
    // account somewhere is linked.
    assert.equal(list[0].remoteUser, 'gabibel');
    assert.equal(list[0].canPush, true);
  } finally {
    done();
  }
});

test('MAL: the code is traded as a form, and the PKCE verifier goes back with it', async () => {
  const u = await newUser();
  const done = configure('mal');
  try {
    const { calls, back, challenge } = await connectFlow('mal', u.token, {
      tokenResponse: { access_token: 'mal-tok', refresh_token: 'mal-ref', expires_in: 3600 },
    });
    assert.equal(back.status, 200);
    const sent = calls.token[0];
    // MAL answers a JSON body with 400 invalid_request. This assertion is the
    // whole difference between the two services at this endpoint.
    assert.match(sent.headers['Content-Type'], /x-www-form-urlencoded/);
    const form = new URLSearchParams(sent.body);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code'), 'the-code');
    assert.equal(form.get('code_verifier'), challenge, 'plain PKCE: the verifier is the challenge');
  } finally {
    done();
  }
});

test('a tracker the user refused says so instead of failing', async () => {
  const u = await newUser();
  const done = configure('anilist');
  try {
    const r = await api('GET',
      '/api/trackers/anilist/callback?error=access_denied&error_description=The+user+said+no');
    assert.equal(r.status, 400);
    assert.match(String(r.body), /The user said no/);
    assert.deepEqual((await api('GET', '/api/trackers', undefined, u.token)).body, []);
  } finally {
    done();
  }
});

test('a token exchange the tracker refuses is reported in its own words', async () => {
  const u = await newUser();
  const done = configure('anilist');
  try {
    outbound = async () => json({ error: 'invalid_grant', error_description: 'Code expired' }, 400);
    const connect = await api('POST', '/api/trackers/anilist/connect', {}, u.token);
    const state = new URL(connect.body.authorizeUrl).searchParams.get('state');
    const back = await api('GET', `/api/trackers/anilist/callback?code=old&state=${state}`);
    assert.equal(back.status, 502);
    assert.match(String(back.body), /Code expired/);
    assert.deepEqual((await api('GET', '/api/trackers', undefined, u.token)).body, []);
  } finally {
    done();
  }
});

test('a service too slow to say whose account it is still connects', async () => {
  const u = await newUser();
  const done = configure('anilist');
  try {
    outbound = async (url) => {
      if (url.includes('oauth')) return json({ access_token: 'tok', expires_in: 31536000 });
      throw new Error('graphql is down');
    };
    const connect = await api('POST', '/api/trackers/anilist/connect', {}, u.token);
    const state = new URL(connect.body.authorizeUrl).searchParams.get('state');
    const back = await api('GET', `/api/trackers/anilist/callback?code=c&state=${state}`);
    assert.equal(back.status, 200, 'a working connection is not refused over a missing name');
    const list = (await api('GET', '/api/trackers', undefined, u.token)).body;
    assert.equal(list[0].remoteUser, null);
  } finally {
    done();
  }
});

// --- staying connected ------------------------------------------------------

/** A connection whose token has `ttl` seconds left — negative for already dead. */
async function connected(userId, service, { access = 'old-tok', refresh = 'ref', ttl = -60 } = {}) {
  // The modifier is built here rather than concatenated in SQL: '+' || -60 gives
  // '+-60 seconds', which SQLite answers with NULL rather than an error, and a
  // NULL expiry reads as a token that never goes stale.
  await db.prepare(`
    INSERT INTO trackers (user_id, service, access_token, refresh_token, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', ?))
    ON CONFLICT (user_id, service) DO UPDATE SET
      access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at
  `).run(userId, service, access, refresh, `${ttl} seconds`);
}

const trackerRow = (userId, service) =>
  db.prepare('SELECT * FROM trackers WHERE user_id = ? AND service = ?').get(userId, service);

test('a MAL token about to run out is refreshed before it is used', async () => {
  const u = await newUser();
  const done = configure('mal');
  try {
    await connected(u.id, 'mal');
    const seen = [];
    outbound = async (url, init) => {
      if (url.includes('oauth')) {
        seen.push(new URLSearchParams(init.body));
        return json({ access_token: 'new-tok', refresh_token: 'new-ref', expires_in: 3600 });
      }
      // The search that follows must carry the *new* token, not the dead one.
      assert.equal(init.headers.Authorization, 'Bearer new-tok');
      return json({ data: [] });
    };
    const r = await api('GET', '/api/trackers/mal/search?q=blue+lock', undefined, u.token);
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].get('grant_type'), 'refresh_token');
    assert.equal(seen[0].get('refresh_token'), 'ref');

    const row = await trackerRow(u.id, 'mal');
    assert.equal(row.access_token, 'new-tok');
    assert.equal(row.refresh_token, 'new-ref');
  } finally {
    done();
  }
});

test('a refresh that returns no new refresh token keeps the one we have', async () => {
  const u = await newUser();
  const done = configure('mal');
  try {
    await connected(u.id, 'mal', { refresh: 'the-only-one' });
    outbound = async (url) => (url.includes('oauth')
      // Taking the omission literally would blank the column and disconnect the
      // account an hour later — the exact failure refreshing exists to prevent.
      ? json({ access_token: 'fresh', expires_in: 3600 })
      : json({ data: [] }));
    await api('GET', '/api/trackers/mal/search?q=blue+lock', undefined, u.token);
    const row = await trackerRow(u.id, 'mal');
    assert.equal(row.access_token, 'fresh');
    assert.equal(row.refresh_token, 'the-only-one');
  } finally {
    done();
  }
});

test('a refresh the tracker refuses reads as "connect it again", not as a crash', async () => {
  const u = await newUser();
  const done = configure('mal');
  try {
    await connected(u.id, 'mal');
    outbound = async () => json({ error: 'invalid_grant' }, 400);
    const r = await api('GET', '/api/trackers/mal/search?q=blue+lock', undefined, u.token);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /connect it again/);
    // The row stays: deleting it would take the user's other links with it, and
    // a revoked token is not evidence the user wanted the tracker gone.
    assert.ok(await trackerRow(u.id, 'mal'));
  } finally {
    done();
  }
});

test('AniList does not pretend to refresh — an expired one asks to be redone', async () => {
  const u = await newUser();
  const done = configure('anilist');
  try {
    await connected(u.id, 'anilist');
    outbound = async (url) => { throw new Error(`nothing should be called: ${url}`); };
    const r = await api('GET', '/api/trackers/anilist/search?q=blue+lock', undefined, u.token);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /connect it again/);
  } finally {
    done();
  }
});

test('turning a page with a dead connection still saves the bookmark', async () => {
  const u = await newUser();
  const done = configure('mal');
  try {
    const entry = await addEntry(u.token, { title: 'Blue Lock' });
    await connected(u.id, 'mal');
    outbound = async () => json({ error: 'invalid_grant' }, 400);

    const r = await api('PUT', `/api/progress/${entry.id}`, {
      chapterUrl: 'https://x.test/blue-lock/12', chapterLabel: 'Chapitre 12', page: 3,
    }, u.token);
    assert.equal(r.status, 200, 'the reader must not lose their place over a tracker');
    assert.equal(r.body.chapterLabel, 'Chapitre 12');
    assert.equal(r.body.trackers[0].ok, false);
    assert.match(r.body.trackers[0].error, /expired/);
  } finally {
    done();
  }
});

test('/services says what this deployment can actually connect', async () => {
  const u = await newUser();
  const done = configure('anilist');
  try {
    const r = await api('GET', '/api/trackers/services', undefined, u.token);
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.map((s) => [s.service, s]));
    assert.equal(by.anilist.configured, true);
    assert.equal(by.anilist.canPush, true);
    // No credentials in the environment: the client draws it greyed out rather
    // than offering a button that answers 501.
    assert.equal(by.mal.configured, false);
    // Kitsu has no authorize page and nothing to push, configured or not.
    assert.equal(by.kitsu.configured, false);
    assert.equal(by.kitsu.canPush, false);
  } finally {
    done();
  }
});
