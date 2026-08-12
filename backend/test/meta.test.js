import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('the chapter heuristic is the shared one, not a second copy', () => {
  // It lived here verbatim as well as in shared/panelflow-core.js. Two copies
  // of a regex set this fiddly drift, and then the server and the extension
  // disagree about what the latest chapter is on the same page.
  const src = readFileSync(new URL('../src/routes/meta.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ maxChapterIn \} from '\.\.\/panelflow-core\.js'/);
  assert.ok(!/function maxChapterIn/.test(src), 'meta.js must not define its own');
});

test('the options page patches settings instead of replacing them', () => {
  // The form knows backendUrl and whitelist; settings also holds
  // checkIntervalMin. A raw set() drops every key the form cannot see.
  const src = readFileSync(new URL('../../extension/options/options.js', import.meta.url), 'utf8');
  assert.match(src, /type: 'setSettings'/);
  assert.ok(!/storage\.local\.set\(\{\s*settings/.test(src), 'that write is not a patch');
});

// --- conditional fetching ---------------------------------------------------
// Last in the file: it replaces global fetch, and everything above it makes
// real requests to the harness server.

test('a page fetched twice is asked for conditionally, and "not modified" is taken at its word', async () => {
  const { fetchPageMeta } = await import('../src/routes/meta.js');
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, init);
    seen.push(init.headers);
    if (init.headers['If-None-Match'] === '"abc"') return new Response(null, { status: 304 });
    return new Response('<a href="/c/12">Chapter 12</a>', {
      status: 200,
      headers: { etag: '"abc"', 'last-modified': 'Mon, 04 Aug 2026 09:00:00 GMT' },
    });
  };
  after(() => { globalThis.fetch = realFetch; });

  const first = await fetchPageMeta('https://cond.example/manga/a');
  assert.equal(first.unchanged, false);
  assert.match(first.html, /Chapter 12/);
  assert.equal(first.etag, '"abc"');
  assert.equal(first.lastModified, 'Mon, 04 Aug 2026 09:00:00 GMT');
  assert.ok(!('If-None-Match' in seen[0]), 'nothing was known yet to ask about');

  const again = await fetchPageMeta('https://cond.example/manga/a', {
    etag: first.etag, lastModified: first.lastModified,
  });
  assert.equal(seen[1]['If-None-Match'], '"abc"');
  assert.equal(seen[1]['If-Modified-Since'], 'Mon, 04 Aug 2026 09:00:00 GMT');
  assert.equal(again.unchanged, true);
  // A 304 has no body to hand back, and the validators survive it — they are
  // what produced it, and dropping them would make the next request full again.
  assert.equal(again.html, null);
  assert.equal(again.etag, '"abc"');
});
