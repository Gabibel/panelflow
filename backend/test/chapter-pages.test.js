// The panels of a chapter the page never puts in the DOM.
//
// MangaDex shows one page at a time. Three <img> live in the reader — the one
// being read and two preloads with no box yet — so the strip every other site
// hands over does not exist here, detection was right to refuse it, and one of
// the biggest manga sites in the world opened no reader at all.
//
// The panels are one call away, in the same public API the site's own front end
// uses, so a domain rule may name that call the way `chapterApi` already names
// the chapter list. This file is about the three properties that keeps safe:
// the URL that gets fetched is built from the rules file and never from the
// page, an answer that is not the shape we expect yields no chapter rather than
// a broken one, and the panels come back in the order they were published.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageApiUrl, pagesFromApi } from '../src/panelflow-core.js';
import { resolveSite } from '../src/site-rules.js';
import { bootCore, json } from '../test-support/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const RULES = JSON.parse(read('shared', 'detection-rules.json'));

const CHAPTER = 'https://mangadex.org/chapter/3bde6546-e07c-4aca-9bb2-76764ba95ebe';
const site = (host) => resolveSite({ host, rules: RULES });

/** The shape /at-home/server/{id} answers with, shortened. */
const atHome = (over = {}) => ({
  result: 'ok',
  baseUrl: 'https://uploads.mangadex.org',
  chapter: { hash: 'b9d0a5', data: ['1-a.png', '2-b.png', '3-c.png'], dataSaver: ['1-s.jpg'] },
  ...over,
});

// --- what gets asked --------------------------------------------------------

test('a chapter page asks the site for its own page list', () => {
  assert.equal(
    pageApiUrl(CHAPTER, site('mangadex.org')),
    'https://api.mangadex.org/at-home/server/3bde6546-e07c-4aca-9bb2-76764ba95ebe',
  );
  // Keyed with a wildcard, so the subdomains come along.
  assert.ok(pageApiUrl(CHAPTER.replace('mangadex.org', 'www.mangadex.org'), site('www.mangadex.org')));
});

test('a page that is not a chapter asks nothing', () => {
  const title = 'https://mangadex.org/title/d1a9fdeb-f713-407f-960c-8326b586e6fd/vagabond';
  assert.equal(pageApiUrl(title, site('mangadex.org')), null);
  assert.equal(pageApiUrl(CHAPTER, site('sushiscan.fr')), null, 'no rule, no call');
  assert.equal(pageApiUrl(CHAPTER, null), null);
});

// --- what comes back --------------------------------------------------------

test('the panels are built out of the answer, in the order it lists them', () => {
  assert.deepEqual(pagesFromApi(JSON.stringify(atHome()), site('mangadex.org')), [
    'https://uploads.mangadex.org/data/b9d0a5/1-a.png',
    'https://uploads.mangadex.org/data/b9d0a5/2-b.png',
    'https://uploads.mangadex.org/data/b9d0a5/3-c.png',
  ]);
});

test('an answer that is not the shape we expect is no chapter, not half of one', () => {
  const md = site('mangadex.org');
  // A chapter missing panels, with nothing on screen to say so, is worse than
  // a chapter that declines to open: the reader would look complete.
  assert.deepEqual(pagesFromApi('<html>rate limited</html>', md), []);
  assert.deepEqual(pagesFromApi(JSON.stringify({ result: 'error' }), md), []);
  assert.deepEqual(pagesFromApi(JSON.stringify(atHome({ baseUrl: undefined })), md), []);
  assert.deepEqual(pagesFromApi(JSON.stringify(atHome({ chapter: { hash: 'x' } })), md), []);
  assert.deepEqual(pagesFromApi('', md), []);
  assert.deepEqual(pagesFromApi(JSON.stringify(atHome()), site('sushiscan.fr')), [],
    'a site with no rule reads nothing out of anything');
});

test('a filename that is not one is dropped, and a scheme that is not http kills the lot', () => {
  const md = site('mangadex.org');
  const holes = atHome({ chapter: { hash: 'b9d0a5', data: ['1-a.png', null, 42, '', '2-b.png'] } });
  assert.deepEqual(pagesFromApi(JSON.stringify(holes), md), [
    'https://uploads.mangadex.org/data/b9d0a5/1-a.png',
    'https://uploads.mangadex.org/data/b9d0a5/2-b.png',
  ]);
  // The template is ours, `baseUrl` is the remote answer's, and an <img src> is
  // not a place to let an arbitrary scheme land.
  assert.deepEqual(pagesFromApi(JSON.stringify(atHome({ baseUrl: 'javascript:alert(1)' })), md), []);
});

test('a trailing slash on the base does not double up', () => {
  const pages = pagesFromApi(JSON.stringify(atHome({ baseUrl: 'https://up.mangadex.test/' })),
    site('mangadex.org'));
  assert.equal(pages[0], 'https://up.mangadex.test/data/b9d0a5/1-a.png');
});

test('a rule written wrong costs its own site, and nothing else', () => {
  // The rules file is fetched from the server and updated without a release.
  assert.equal(pageApiUrl(CHAPTER, { pageApi: { from: '([', url: 'https://x.test/$1' } }), null);
  assert.deepEqual(pagesFromApi('{}', { pageApi: { page: '{base}/{file}' } }), []);
});

// --- who makes the call -----------------------------------------------------

test('the shell resolves the URL itself and never fetches one it was handed', async () => {
  const { hub, calls } = bootCore({
    storage: { rulesCache: { rules: RULES, fetchedAt: Date.now() } },
    fetch: async () => json(atHome()),
  });
  const { pages } = await hub({ type: 'chapterPages', url: CHAPTER });
  assert.equal(pages.length, 3);
  assert.deepEqual(calls.map((c) => c.url),
    ['https://api.mangadex.org/at-home/server/3bde6546-e07c-4aca-9bb2-76764ba95ebe']);

  // The content script sends the address it is on; a page that talks its way
  // into that message still cannot choose what gets fetched, because the URL
  // is built out of the rules file on this side.
  calls.length = 0;
  const evil = await hub({ type: 'chapterPages', url: 'https://mangadex.org.evil.test/chapter/x' });
  assert.deepEqual(evil.pages, []);
  assert.deepEqual(calls, []);
});

test('a site with nothing to say leaves the page to the DOM', async () => {
  const { hub, calls } = bootCore({
    storage: { rulesCache: { rules: RULES, fetchedAt: Date.now() } },
    fetch: async () => json({ result: 'error' }, 404),
  });
  assert.deepEqual((await hub({ type: 'chapterPages', url: 'https://sushiscan.fr/x/ch-1/' })).pages, []);
  assert.deepEqual(calls, [], 'a site with no pageApi rule is not asked anything');
  // And an API that refuses is an empty chapter, not an error thrown at a hub
  // whose caller is a content script with nowhere to put it.
  assert.deepEqual((await hub({ type: 'chapterPages', url: CHAPTER })).pages, []);
});

// --- the wiring -------------------------------------------------------------

test('the extension worker loads the rules layer the core reads', () => {
  // `PanelFlowSites` is read at call time, so its absence is not a crash: it is
  // chapterApi and pageApi quietly answering "this site has nothing", which is
  // the shape of bug that survives for months.
  const bg = read('extension', 'background.js');
  const imports = bg.slice(bg.indexOf('importScripts('), bg.indexOf('const { createCore'));
  assert.match(imports, /shared\/site-rules\.js/, 'the service worker never loads site-rules.js');
  assert.ok(imports.indexOf('site-rules.js') < imports.indexOf('panelflow-core.js'));
});

test('the content script asks the shell, and opens what comes back', () => {
  const detect = read('extension', 'content', 'detect.js');
  assert.match(detect, /type:\s*'chapterPages'/, 'detect.js never asks for the page list');
  // It sends where it is, not what to fetch — the same rule trackerConnectTab
  // follows, and the reason the message is worth having at all.
  assert.match(detect, /'chapterPages',\s*url:\s*location\.href/);
  assert.match(detect, /if \(detection\.pages\)/, 'openReader ignores an API page list');
});
