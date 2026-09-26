// The origin that holds the web app's token, and what may run on it.
//
// The QA pass of September 2026 found a chain nobody had put together: the
// phone's in-app browser let any site write a library entry, the API took a
// `javascript:` address for it, and the web shelf rendered that address as a
// link — on an origin with no Content-Security-Policy, where the account's
// token sits in localStorage. The cover proxy on the same origin served SVG,
// which is a document that runs script. And `?api=` on the web app's own
// address sent every request, token included, wherever a link said.
//
// Each link of that chain is closed on its own below, so that no single fix
// has to hold the whole of it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, addEntry, newUser, shutdown, base } from '../test-support/harness.js';
import { isHttpUrl } from '../src/http-url.js';

after(shutdown);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOSTILE = ['javascript:alert(document.domain)', 'JAVASCRIPT:void(0)', 'data:text/html,<script>x</script>',
  'vbscript:x', 'file:///etc/passwd', 'ftp://example.test/a'];

test('only http and https are addresses', () => {
  for (const ok of ['https://scan.test/manga/x', 'http://scan.test/a?b=1#c']) assert.equal(isHttpUrl(ok), true, ok);
  for (const bad of [...HOSTILE, '', null, 42, { href: 'https://x.test' }, '//x.test/a', '/relative']) {
    assert.equal(isHttpUrl(bad), false, String(bad));
  }
});

test('the library refuses a series, a cover or a chapter that is not an http(s) address', async () => {
  const u = await newUser();
  for (const bad of HOSTILE) {
    const r = await api('POST', '/api/library', {
      title: 'X', sourceDomain: 'scan.test', sourceUrl: bad,
    }, u.token);
    assert.equal(r.status, 400, `sourceUrl ${bad} was stored`);
    assert.equal(r.body.code, 'bad_url');
    const c = await api('POST', '/api/library', {
      title: 'X', sourceDomain: 'scan.test', sourceUrl: 'https://scan.test/manga/ok', coverUrl: bad,
    }, u.token);
    assert.equal(c.status, 400, `coverUrl ${bad} was stored`);
  }
  const e = await addEntry(u.token);
  assert.equal((await api('PUT', `/api/library/${e.id}`, { coverUrl: HOSTILE[0] }, u.token)).status, 400);
  assert.equal((await api('PUT', `/api/progress/${e.id}`, { chapterUrl: HOSTILE[0] }, u.token)).status, 400);
  assert.equal((await api('POST', '/api/history', {
    libraryId: e.id, chapterUrl: HOSTILE[0], chapterLabel: 'Ch. 1', pages: 1, seconds: 10,
  }, u.token)).status, 400);
  // And clearing a cover is still allowed: null is not an address.
  assert.equal((await api('PUT', `/api/library/${e.id}`, { coverUrl: null }, u.token)).status, 200);
});

test('a backup carrying a hostile address restores everything else and not that', async () => {
  const u = await newUser();
  const r = await api('POST', '/api/import/panelflow', {
    app: 'panelflow', version: 1,
    library: [
      { title: 'Good', sourceDomain: 'scan.test', sourceUrl: 'https://scan.test/manga/good',
        coverUrl: 'javascript:x', progress: { chapterUrl: 'javascript:y', chapterLabel: 'Ch. 1' } },
      { title: 'Bad', sourceDomain: 'scan.test', sourceUrl: 'javascript:alert(1)' },
    ],
  }, u.token);
  assert.ok(r.status < 400, `restore refused: ${r.status} ${JSON.stringify(r.body)}`);
  const lib = (await api('GET', '/api/library', undefined, u.token)).body;
  assert.deepEqual(lib.map((e) => e.title), ['Good']);
  assert.equal(lib[0].coverUrl, null, 'the hostile cover was dropped, the series kept');
  assert.equal((await api('GET', '/api/progress', undefined, u.token)).body.length, 0);
});

test('the web app is served with a policy that only runs its own files', async () => {
  const res = await fetch(`${base}/`);
  const csp = res.headers.get('content-security-policy') || '';
  for (const rule of ["script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
    "default-src 'self'"]) {
    assert.ok(csp.includes(rule), `missing ${rule} in ${csp}`);
  }
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-powered-by'), null);
  // The legal pages are pages of the same origin, and get the same policy.
  const legal = await fetch(`${base}/confidentialite.html`);
  assert.match(legal.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
});

test('the policy fits the page: no inline script and no third-party code in web/', () => {
  // A strict policy is only possible because of this, so it is held here.
  for (const page of ['index.html', 'confidentialite.html', 'conditions.html', 'mentions-legales.html']) {
    const html = readFileSync(join(root, 'web', page), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${page} has an inline script`);
    assert.doesNotMatch(html, /<script[^>]*src="(https?:)?\/\//i, `${page} loads a script from elsewhere`);
    assert.doesNotMatch(html, /\son[a-z]+="/i, `${page} has an inline event handler`);
  }
});

test('the web app honours ?api= only from a loopback page towards a loopback server', () => {
  const src = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const start = src.indexOf('const LOOPBACK =');
  const end = src.indexOf('})();', start) + 5;
  assert.ok(start !== -1 && end > start, 'the API choice is not where this test expects it');
  const pick = (href) => new Function('location', 'URLSearchParams', 'URL',
    `${src.slice(start, end)}; return API;`)(new URL(href), URLSearchParams, URL);
  assert.equal(pick('https://panelflow-backend.vercel.app/?api=https://attacker.example'), '');
  assert.equal(pick('https://panelflow-backend.vercel.app/'), '');
  assert.equal(pick('http://localhost:5173/?api=https://attacker.example'), '');
  assert.equal(pick('http://localhost:5173/?api=http://localhost:8787/'), 'http://localhost:8787');
});

test('every link the web shelf draws from library data goes through safeHref', () => {
  const src = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const sinks = [...src.matchAll(/\.href = ([^;]+);/g)].map((m) => m[1].trim());
  const fromData = sinks.filter((s) => /Url|target\.url|chapterUrl|sourceUrl/.test(s));
  assert.ok(fromData.length >= 5, `only found ${fromData.length} data links`);
  for (const s of fromData) assert.match(s, /^safeHref\(/, `a data link bypasses safeHref: ${s}`);
});

// Last in the file: it replaces global fetch for the cover proxy's outbound call.
test('the cover proxy serves pictures, never a document, and confines what it serves', async () => {
  const realFetch = globalThis.fetch;
  const kind = { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>' };
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(base)) return realFetch(url, init);
    return new Response(kind.body, { status: 200, headers: { 'content-type': kind.type } });
  };
  after(() => { globalThis.fetch = realFetch; });

  // A literal public address: checked as written, never looked up.
  const cover = (name) => realFetch(`${base}/api/cover?url=${encodeURIComponent(`http://93.184.216.34/${name}`)}`);
  const svg = await cover('a.svg');
  assert.equal(svg.status, 502, 'an SVG was relayed from the origin that holds the token');

  Object.assign(kind, { type: 'text/html', body: '<script>x</script>' });
  assert.equal((await cover('b.png')).status, 502);

  Object.assign(kind, { type: 'image/png; charset=binary', body: 'PNGDATA' });
  const png = await cover('c.png');
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
  assert.match(png.headers.get('content-security-policy') || '', /sandbox/);
});
