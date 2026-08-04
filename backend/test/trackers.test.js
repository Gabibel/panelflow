import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown } from '../test-support/harness.js';

after(shutdown);

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
    assert.match(r.body.error, /not configured|not yet implemented/);
  }
});

test('a configured service hands back an authorize url', async () => {
  const u = await newUser();
  process.env.PANELFLOW_ANILIST_CLIENT_ID = 'test-client';
  process.env.PANELFLOW_ANILIST_REDIRECT_URI = 'https://panelflow.test/api/trackers/anilist/callback';
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
    delete process.env.PANELFLOW_ANILIST_CLIENT_ID;
    delete process.env.PANELFLOW_ANILIST_REDIRECT_URI;
  }
});

test('kitsu says so rather than pretending', async () => {
  const u = await newUser();
  process.env.PANELFLOW_KITSU_CLIENT_ID = 'test-client';
  try {
    const r = await api('POST', '/api/trackers/kitsu/connect', {}, u.token);
    assert.equal(r.status, 501);
    assert.match(r.body.error, /not yet implemented/);
  } finally {
    delete process.env.PANELFLOW_KITSU_CLIENT_ID;
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
  assert.match(r.body.error, /invalid or expired state/);
});

test('a state signed for one service does not work on another', async () => {
  const u = await newUser();
  process.env.PANELFLOW_ANILIST_CLIENT_ID = 'test-client';
  try {
    const { body } = await api('POST', '/api/trackers/anilist/connect', {}, u.token);
    const state = new URL(body.authorizeUrl).searchParams.get('state');
    const r = await api('GET', `/api/trackers/mal/callback?code=abc&state=${state}`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /invalid or expired state/);
  } finally {
    delete process.env.PANELFLOW_ANILIST_CLIENT_ID;
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
