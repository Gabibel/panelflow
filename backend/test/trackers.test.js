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
    // `state` is how the callback knows whose account to attach tokens to.
    assert.equal(url.searchParams.get('state'), u.id);
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

test('disconnecting a service that was never connected is 404', async () => {
  const u = await newUser();
  const r = await api('DELETE', '/api/trackers/anilist', undefined, u.token);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /not connected/);
});

test('tracker routes require auth', async () => {
  assert.equal((await api('GET', '/api/trackers')).status, 401);
  assert.equal((await api('POST', '/api/trackers/anilist/connect', {})).status, 401);
  assert.equal((await api('DELETE', '/api/trackers/anilist')).status, 401);
});
