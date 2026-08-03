// The integrated search the mobile app uses instead of an address bar.
//
// Two things are being pinned here. The parser, because DuckDuckGo's no-JS page
// is scraped with regexes and a silent parse failure looks exactly like "no
// results" — the failure mode a user would report as "search is broken" and
// nobody could reproduce. And the route's spending: every compatibility check
// costs a server-side page fetch, so the cap on how many run is a real budget,
// not a style choice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown } from '../test-support/harness.js';
import { parseResults, scanQuery } from '../src/routes/search.js';

after(shutdown);

/** One DuckDuckGo hit, wrapped in the redirect their markup really uses. */
const hit = (url, title) =>
  `<div class="result results_links"><h2 class="result__title">
     <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc">${title}</a>
   </h2></div>`;

const resultsPage = (hits) => `<html><body>${hits.join('\n')}</body></html>`;

// --- the parser ------------------------------------------------------------

test('results come back unwrapped from the redirect', () => {
  const r = parseResults(resultsPage([
    hit('https://scan-test.io/manga/ao-no-hako', 'Ao no Hako - ScanTest'),
    hit('https://www.other-scan.test/lecture/blue-box', 'Blue Box'),
  ]));
  assert.equal(r.length, 2);
  assert.equal(r[0].url, 'https://scan-test.io/manga/ao-no-hako');
  assert.equal(r[0].domain, 'scan-test.io');
  // The domain is what the user actually reads before tapping, so www is noise.
  assert.equal(r[1].domain, 'other-scan.test');
});

test('titles arrive as text, not as markup', () => {
  const r = parseResults(resultsPage([
    `<a class="result__a" href="https://a.test/x"><b>Ao</b> no Hako &amp; Blue Box &#39;VF&#39;</a>`,
  ]));
  assert.equal(r[0].title, 'Ao no Hako & Blue Box \'VF\'');
});

test('the same page listed twice is one result', () => {
  const url = 'https://scan-test.io/manga/ao-no-hako';
  const r = parseResults(resultsPage([hit(url, 'First'), hit(url, 'Second')]));
  assert.equal(r.length, 1);
  assert.equal(r[0].title, 'First');
});

test('a result count is capped so one query cannot become a page of links', () => {
  const many = Array.from({ length: 40 }, (_, i) => hit(`https://s${i}.test/x`, `Hit ${i}`));
  assert.equal(parseResults(resultsPage(many)).length, 20);
});

test('markup that is not a results page yields nothing rather than junk', () => {
  // A block page, a redirect interstitial or a layout change all land here.
  // Returning [] is right; returning half-parsed garbage is not.
  for (const html of ['', '<html><body>blocked</body></html>', null, '<a href="/x">plain link</a>']) {
    assert.deepEqual(parseResults(html), []);
  }
});

test('non-http hrefs are dropped, protocol-relative ones are kept', () => {
  const r = parseResults(`
    <a class="result__a" href="javascript:alert(1)">bad</a>
    <a class="result__a" href="/settings">relative</a>
    <a class="result__a" href="//scan-test.io/manga/x">protocol-relative</a>`);
  assert.deepEqual(r.map((x) => x.url), ['https://scan-test.io/manga/x']);
});

test('the scan query asks for somewhere to read, not an encyclopedia entry', () => {
  assert.equal(scanQuery('Ao no Hako'), 'Ao no Hako scan lecture en ligne chapitre');
});

// --- the route -------------------------------------------------------------

const realFetch = globalThis.fetch;
/**
 * Intercepts only the outbound page fetches. The harness talks to the test
 * server over the same global `fetch`, so localhost has to pass through or
 * every request in this file would be answered by the stub.
 */
function stubFetch(handler) {
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.href ?? input);
    if (url.includes('localhost')) return realFetch(input, init);
    seen.push(url);
    const body = handler(url);
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  return seen;
}

test('search needs an account', async () => {
  const r = await api('GET', '/api/search?q=ao+no+hako');
  assert.equal(r.status, 401);
});

test('an empty query returns an error, never a directory of sites', async () => {
  const u = await newUser();
  assert.equal((await api('GET', '/api/search?q=', undefined, u.token)).status, 400);
  assert.equal((await api('GET', '/api/search?q=%20%20', undefined, u.token)).status, 400);
  assert.equal((await api('GET', '/api/search', undefined, u.token)).status, 400);
  const long = await api('GET', `/api/search?q=${'x'.repeat(201)}`, undefined, u.token);
  assert.equal(long.status, 400);
});

test('scans=1 biases the query and the caller is told what was actually searched', async () => {
  const u = await newUser();
  const seen = stubFetch(() => resultsPage([hit('https://scan-test.io/manga/x', 'X')]));
  try {
    const r = await api('GET', '/api/search?q=ao+no+hako&scans=1', undefined, u.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.query, scanQuery('ao no hako'));
    assert.ok(seen[0].startsWith('https://html.duckduckgo.com/html/?q='));
    assert.ok(seen[0].includes(encodeURIComponent('lecture en ligne')));
    assert.equal(r.body.results.length, 1);
    // Without check=1 nothing beyond the results page is fetched.
    assert.equal(seen.length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('check=1 judges the top hits and stops there', async () => {
  const u = await newUser();
  const chapter = `<html><body>
    <a href="/manga/x/chapitre-12">Chapitre suivant</a>
    ${Array.from({ length: 10 }, (_, i) => `<img src="https://cdn.test/x/${i}.jpg">`).join('')}
    </body></html>`;
  const seen = stubFetch((url) =>
    url.includes('duckduckgo')
      ? resultsPage(Array.from({ length: 8 }, (_, i) =>
        hit(`https://s${i}.test/manga/x/chapitre-11`, `Hit ${i}`)))
      : chapter);
  try {
    const r = await api('GET', '/api/search?q=x&check=1', undefined, u.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 8);
    // One results page + five checks: the sixth hit onward is unjudged, which
    // is what keeps a single search from costing eight outbound fetches.
    assert.equal(seen.length, 6);
    assert.equal(r.body.results[0].compat.verdict, 'ready');
    assert.equal(r.body.results[0].compat.imageCount, 10);
    assert.equal(r.body.results[0].compat.chapterLabel, 'Ch. 11');
    assert.equal(r.body.results[5].compat, undefined);
  } finally { globalThis.fetch = realFetch; }
});

test('a hit that cannot be fetched is unknown, not unsupported', async () => {
  // Cloudflare answers the server and not the phone, all the time. Reporting
  // "unlikely" here would steer the user away from sites that work for them.
  const u = await newUser();
  stubFetch((url) => (url.includes('duckduckgo')
    ? resultsPage([hit('https://walled.test/manga/x/chapitre-1', 'Walled')])
    : undefined));
  try {
    const r = await api('GET', '/api/search?q=x&check=1', undefined, u.token);
    assert.equal(r.body.results[0].compat.verdict, 'unknown');
    assert.match(r.body.results[0].compat.reason, /could not be fetched/);
  } finally { globalThis.fetch = realFetch; }
});

test('a search engine that is down is a 502, not a crash', async () => {
  const u = await newUser();
  globalThis.fetch = async (input, init) => {
    const url = String(input?.href ?? input);
    if (url.includes('localhost')) return realFetch(input, init);
    throw new Error('network down');
  };
  try {
    const r = await api('GET', '/api/search?q=x', undefined, u.token);
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'search unavailable');
  } finally { globalThis.fetch = realFetch; }
});
