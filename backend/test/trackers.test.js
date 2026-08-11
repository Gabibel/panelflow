import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown } from '../test-support/harness.js';

after(shutdown);

// All three halves, because /connect refuses to build a URL it knows the
// callback cannot finish: a redirect_uri the tracker never sees agreed, or a
// missing secret, both fail after the user has already said yes.
function configure(service, over = {}) {
  const env = {
    CLIENT_ID: 'test-client',
    CLIENT_SECRET: 'test-secret',
    REDIRECT_URI: `https://panelflow.test/api/trackers/${service}/callback`,
    ...over,
  };
  for (const [k, v] of Object.entries(env)) process.env[`PANELFLOW_${service.toUpperCase()}_${k}`] = v;
  return () => {
    for (const k of Object.keys(env)) delete process.env[`PANELFLOW_${service.toUpperCase()}_${k}`];
  };
}

test('a fresh account has no connected tracker', async () => {
  const u = await newUser();
  const r = await api('GET', '/api/trackers', undefined, u.token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('an unknown service is 404, a known but unconfigured one is 501', async () => {
  const u = await newUser();
  assert.equal((await api('POST', '/api/trackers/mangaupdates/connect', {}, u.token)).status, 404);
  assert.equal((await api('GET', '/api/trackers/mangaupdates/callback?code=x&state=y', undefined, u.token)).status, 404);

  for (const service of ['anilist', 'mal', 'kitsu']) {
    const r = await api('POST', `/api/trackers/${service}/connect`, {}, u.token);
    assert.equal(r.status, 501, service);
    assert.match(r.body.error, /not configured|password/);
  }
});

test('a configured service hands back an authorize url', async () => {
  const u = await newUser();
  const done = configure('anilist');
  try {
    const r = await api('POST', '/api/trackers/anilist/connect', {}, u.token);
    assert.equal(r.status, 200);
    const url = new URL(r.body.authorizeUrl);
    assert.equal(url.origin + url.pathname, 'https://anilist.co/api/v2/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'test-client');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://panelflow.test/api/trackers/anilist/callback');
    // `state` is how the callback knows whose account to attach tokens to, and
    // it is the *only* thing identifying the user there — so it is signed, not
    // the bare id anyone could have typed.
    const state = url.searchParams.get('state');
    assert.ok(state && state !== u.id, 'state must not be the raw user id');
    assert.equal(state.split('.').length, 3, 'state should be a signed token');
    // The secret must never leave the server.
    assert.ok(!r.body.authorizeUrl.includes('client_secret'));
  } finally {
    done();
  }
});

test('kitsu says so rather than pretending', async () => {
  const u = await newUser();
  // Configured or not: Kitsu authenticates with the user's own password, which
  // this server declines to handle, so the answer never depends on env vars.
  const done = configure('kitsu');
  try {
    const r = await api('POST', '/api/trackers/kitsu/connect', {}, u.token);
    assert.equal(r.status, 501);
    assert.match(r.body.error, /password/);
  } finally {
    done();
  }
});

test('a half-configured service refuses before sending the user anywhere', async () => {
  const u = await newUser();
  const done = configure('anilist', { CLIENT_SECRET: '' });
  try {
    const r = await api('POST', '/api/trackers/anilist/connect', {}, u.token);
    assert.equal(r.status, 501);
    assert.match(r.body.error, /PANELFLOW_ANILIST_CLIENT_SECRET/);
  } finally {
    done();
  }
});

test('MAL is sent a PKCE challenge, and the verifier comes back in the state', async () => {
  const u = await newUser();
  const done = configure('mal');
  try {
    const { body } = await api('POST', '/api/trackers/mal/connect', {}, u.token);
    const url = new URL(body.authorizeUrl);
    // MAL rejects an authorize call with no challenge outright, and supports
    // only the plain method — so the challenge is the verifier.
    const challenge = url.searchParams.get('code_challenge');
    assert.equal(url.searchParams.get('code_challenge_method'), 'plain');
    assert.ok(challenge && challenge.length >= 43 && challenge.length <= 128, 'RFC 7636 length');
    // It has to survive the round trip, and there is nowhere in a lambda to
    // keep it — so it rides inside the signed state and comes back with it.
    const claims = JSON.parse(Buffer.from(url.searchParams.get('state').split('.')[1], 'base64url'));
    assert.equal(claims.v, challenge);
    assert.equal(claims.sub, u.id);
  } finally {
    done();
  }
});

test('AniList is sent no challenge — it does not take one', async () => {
  const u = await newUser();
  const done = configure('anilist');
  try {
    const { body } = await api('POST', '/api/trackers/anilist/connect', {}, u.token);
    assert.equal(new URL(body.authorizeUrl).searchParams.get('code_challenge'), null);
  } finally {
    done();
  }
});

test('the callback needs both code and state', async () => {
  const u = await newUser();
  for (const qs of ['', '?code=abc', '?state=xyz']) {
    const r = await api('GET', `/api/trackers/anilist/callback${qs}`, undefined, u.token);
    assert.equal(r.status, 400, qs || '(no query)');
  }
});

test('the callback is reachable without a bearer token', async () => {
  // The tracker redirects the user's *browser* here, so there is no
  // Authorization header to send. Behind requireAuth this answered 401 every
  // time and no OAuth flow could ever finish.
  const r = await api('GET', '/api/trackers/anilist/callback');
  assert.notEqual(r.status, 401);
  assert.equal(r.status, 400, 'it should complain about the missing code, not about auth');
});

test('the callback refuses a state it did not sign', async () => {
  const u = await newUser();
  // The whole point of signing it: a bare user id would let anyone attach their
  // tracker tokens to somebody else's account.
  const r = await api('GET', `/api/trackers/anilist/callback?code=abc&state=${u.id}`);
  assert.equal(r.status, 400);
  // The callback answers a page, not JSON: a person is looking at it.
  assert.match(String(r.body), /Not connected/);
});

test('a state signed for one service does not work on another', async () => {
  const u = await newUser();
  const done = configure('anilist');
  try {
    const { body } = await api('POST', '/api/trackers/anilist/connect', {}, u.token);
    const state = new URL(body.authorizeUrl).searchParams.get('state');
    const r = await api('GET', `/api/trackers/mal/callback?code=abc&state=${state}`);
    assert.equal(r.status, 400);
    assert.match(String(r.body), /Not connected/);
  } finally {
    done();
  }
});

test('disconnecting a service that was never connected is 404', async () => {
  const u = await newUser();
  const r = await api('DELETE', '/api/trackers/anilist', undefined, u.token);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /not connected/);
});

// The callback is the deliberate exception, covered above.
test('tracker routes require auth', async () => {
  assert.equal((await api('GET', '/api/trackers')).status, 401);
  assert.equal((await api('POST', '/api/trackers/anilist/connect', {})).status, 401);
  assert.equal((await api('DELETE', '/api/trackers/anilist')).status, 401);
});
