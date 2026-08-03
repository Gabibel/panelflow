import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, base, newUser, shutdown } from '../test-support/harness.js';

after(shutdown);

// The server fetches URLs the client hands it, so the guard on which hosts it
// will talk to is the whole security story of these two routes.
const BLOCKED = [
  'http://localhost/',
  'http://localhost:8787/x',
  'http://127.0.0.1/',
  'http://127.1.2.3/',
  'http://10.0.0.1/',
  'http://192.168.1.1/',
  'http://172.16.0.1/',
  'http://172.20.10.1/',
  'http://172.31.255.255/',
  'http://169.254.169.254/latest/meta-data/', // cloud metadata endpoint
  'http://0.0.0.0/',
  'http://[::1]/',
];

const MALFORMED = [
  'not-a-url',
  '',
  'ftp://example.com/x',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/html,<h1>x</h1>',
];

test('scrape refuses private hosts', async () => {
  const u = await newUser();
  for (const url of BLOCKED) {
    const r = await api('GET', `/api/meta/scrape?url=${encodeURIComponent(url)}`, undefined, u.token);
    assert.equal(r.status, 400, url);
  }
});

test('scrape refuses non-http schemes and junk', async () => {
  const u = await newUser();
  for (const url of MALFORMED) {
    const r = await api('GET', `/api/meta/scrape?url=${encodeURIComponent(url)}`, undefined, u.token);
    assert.equal(r.status, 400, JSON.stringify(url));
  }
  const missing = await api('GET', '/api/meta/scrape', undefined, u.token);
  assert.equal(missing.status, 400);
});

test('scrape requires a signed-in caller', async () => {
  const r = await api('GET', '/api/meta/scrape?url=https://example.com/');
  assert.equal(r.status, 401);
});

test('the cover proxy applies the same host guard', async () => {
  for (const url of [...BLOCKED, ...MALFORMED]) {
    const r = await api('GET', `/api/cover?url=${encodeURIComponent(url)}`);
    assert.equal(r.status, 400, url);
  }
  assert.equal((await api('GET', '/api/cover')).status, 400);
});

test('the cover proxy stays public', async () => {
  // 400 (bad url) rather than 401 proves the route is not behind requireAuth —
  // an <img> tag cannot send an Authorization header.
  const r = await api('GET', '/api/cover?url=http://127.0.0.1/a.png');
  assert.equal(r.status, 400);
});

test('a hostile ref parameter cannot redirect the proxy', async () => {
  // `ref` only ever influences an outgoing Referer header, never the target.
  const r = await api('GET', '/api/cover?url=http://127.0.0.1/a.png&ref=https://evil.test/');
  assert.equal(r.status, 400, 'the url guard still decides');
});

test('check answers with a list and leaves unreachable sites alone', async () => {
  const u = await newUser();
  const r = await api('POST', '/api/meta/check', {}, u.token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [], 'an empty library checks to an empty result');
});

test('CORS lets the extension call the API cross-origin', async () => {
  const preflight = await fetch(`${base}/api/library`, {
    method: 'OPTIONS',
    headers: { Origin: 'chrome-extension://chcgnjlaohkhmiploddjddakhfmhilea' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);
});

test('the rules endpoint serves the shared detection config', async () => {
  const r = await api('GET', '/api/rules');
  assert.equal(r.status, 200);
  assert.ok(Number.isInteger(r.body.version));
  assert.ok(r.body.heuristics.minGalleryImages >= 1);
  assert.ok(Array.isArray(r.body.heuristics.navTextPatterns));
  // The false-positive fix: a bare "next" is a carousel arrow, not chapter nav.
  assert.ok(!r.body.heuristics.navTextPatterns.includes('next'));
  assert.ok(!r.body.heuristics.navTextPatterns.includes('prev'));
  assert.ok(r.body.heuristics.navTextPatterns.includes('next chapter'));
  assert.match(r.headers.get('cache-control'), /max-age/);
});

test('the web app is served from the same origin', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<html/i);
  for (const asset of ['/app.js', '/styles.css']) {
    const a = await fetch(base + asset);
    assert.equal(a.status, 200, asset);
  }
});
