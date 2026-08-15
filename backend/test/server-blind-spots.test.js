// Two ways the server used to be wrong about a page it had just fetched.
//
// 1. An anti-bot wall answers 200. "Just a moment…" was read as the title of a
//    series, and the wall's total absence of chapter numbers was read as "this
//    series has none" — so a walled site quietly reset what we knew about it.
// 2. MangaDex builds its page in the browser. The server gets a 6 kB shell: the
//    <meta> tags are in it, the chapter list is not. One of the biggest manga
//    sites in the world, and PanelFlow never announced a single chapter on it
//    and never said why. A domain rule may now name the site's own API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { challengePage, chapterApiUrl, maxChapterInApi } from '../src/panelflow-core.js';
import { resolveSite } from '../src/site-rules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES = JSON.parse(readFileSync(join(root, 'shared', 'detection-rules.json'), 'utf8'));

// --- the wall ---------------------------------------------------------------

const page = (title, body = '') =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;

test('a Cloudflare interstitial is not a page', () => {
  assert.equal(challengePage(page('Just a moment...')), true);
  assert.equal(challengePage(page('Attention Required! | Cloudflare')), true);
  // The new-style challenge says nothing recognisable in its title, and is
  // given away by the script it loads instead.
  assert.equal(
    challengePage(page('example', '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>')),
    true,
  );
  assert.equal(challengePage(page('x', 'window._cf_chl_opt={cvId:"3"}')), true);
});

test('the other doormen are recognised too', () => {
  assert.equal(challengePage(page('DDoS-Guard')), true);
  assert.equal(challengePage(page('x', '<img src="https://check.ddos-guard.net/check.js">')), true);
  assert.equal(challengePage(page('Sucuri WebSite Firewall - Access Denied')), true);
});

test('a real series page is never mistaken for a wall', () => {
  // The whole risk of this check is here: these words turn up in manga, and a
  // page that is refused for containing dialogue is a series that stops being
  // followed. Only the <title> is read for human wording.
  const chapter = page(
    'Kagurabachi Chapitre 125 - Sushi Scan',
    '<p>Just a moment, I have to check your browser — access denied!</p>'
    + '<a href="/kagurabachi-chapitre-125/">Chapitre 125</a>',
  );
  assert.equal(challengePage(chapter), false);
  assert.equal(challengePage(''), false, 'nothing at all is not a wall either');
  assert.equal(challengePage(null), false);
});

test('the server refuses to read anything off a wall', () => {
  // The guard has to sit in the fetch, not in each of the three callers: the
  // scrape, the /check pass and the watcher all read the same body.
  const src = readFileSync(join(root, 'backend', 'src', 'routes', 'meta.js'), 'utf8');
  assert.match(src, /challengePage\(html\)/, 'the 200-with-a-wall case is unguarded');
  assert.match(src, /function theRealPage/);
  // Both ways out of fetchPageMeta that carry a curl body go through it.
  assert.equal((src.match(/theRealPage\(await curlFetch/g) || []).length, 2);
});

// --- the site that builds itself in the browser -----------------------------

const MANGADEX = 'https://mangadex.org/title/d1a9fdeb-f713-407f-960c-8326b586e6fd/vagabond';
const site = (host, html = '') => resolveSite({ host, rules: RULES, html });

test('MangaDex is asked its own API for the chapter the page does not carry', () => {
  assert.equal(
    chapterApiUrl(MANGADEX, site('mangadex.org')),
    'https://api.mangadex.org/manga/d1a9fdeb-f713-407f-960c-8326b586e6fd/aggregate',
  );
  // The rule is keyed with a wildcard, so the subdomains come along.
  assert.ok(chapterApiUrl(MANGADEX.replace('mangadex.org', 'www.mangadex.org'), site('www.mangadex.org')));
});

test('a URL the rule does not recognise asks nothing', () => {
  // A MangaDex *chapter* URL carries no title id, and inventing an API call
  // out of it would be a request to a uuid that is not the series.
  assert.equal(chapterApiUrl('https://mangadex.org/chapter/0754c218-0240-4752-a688-5e7d9bc74b55', site('mangadex.org')), null);
  assert.equal(chapterApiUrl(MANGADEX, site('sushiscan.fr')), null, 'a site with no rule asks no API');
  assert.equal(chapterApiUrl(MANGADEX, null), null);
});

test('the chapter is the highest one in the API answer, not the first', () => {
  // Shortened shape of /manga/{id}/aggregate: volumes, each with its chapters
  // keyed by number, and no ordering that can be relied on.
  const aggregate = JSON.stringify({
    result: 'ok',
    volumes: {
      37: { volume: '37', chapters: { 320: { chapter: '320' }, 319: { chapter: '319' } } },
      38: { volume: '38', chapters: { 327: { chapter: '327' }, 326.5: { chapter: '326.5' } } },
    },
  });
  assert.equal(maxChapterInApi(aggregate, site('mangadex.org')), 327);
});

test('a long-running series is not capped the way page markup is', () => {
  // maxChapterIn stops at 10000 because page furniture — view counts, prices,
  // timestamps — outbids a chapter number. An answer from the site's own
  // chapter endpoint has none of that in it, and One Piece will get there.
  const feed = JSON.stringify({ volumes: { 1: { chapters: { 10450: { chapter: '10450' } } } } });
  assert.equal(maxChapterInApi(feed, site('mangadex.org')), 10450);
});

test('an API that answers with nothing useful yields nothing, not a guess', () => {
  assert.equal(maxChapterInApi('{"result":"ok","volumes":{}}', site('mangadex.org')), null);
  assert.equal(maxChapterInApi('', site('mangadex.org')), null);
  assert.equal(maxChapterInApi('{"chapter":"7"}', site('sushiscan.fr')), null, 'no rule, no reading');
});

test('a rule written wrong costs its own site, and nothing else', () => {
  // The rules file is fetched from the server and updated without a release:
  // a bad regex in it must degrade to "no API" rather than throw inside the
  // watcher and take the whole run down with it.
  const broken = { chapterApi: { from: '([', url: 'https://x.test/$1', pick: '"chapter":"(\\d+)"' } };
  assert.equal(chapterApiUrl(MANGADEX, broken), null);
  assert.equal(maxChapterInApi('{"chapter":"9"}', { chapterApi: { pick: '([' } }), null);
});

test('the watcher and the check both go through the API-aware reader', () => {
  const watch = readFileSync(join(root, 'backend', 'src', 'routes', 'watch.js'), 'utf8');
  const meta = readFileSync(join(root, 'backend', 'src', 'routes', 'meta.js'), 'utf8');
  assert.ok(!/maxChapterIn\(page\.html\)/.test(watch), 'the watcher still reads markup only');
  assert.match(watch, /latestChapterOf/);
  // The three places a chapter number is read off a fetched page.
  assert.equal((meta.match(/latestChapterOf\(/g) || []).length, 3);
});
