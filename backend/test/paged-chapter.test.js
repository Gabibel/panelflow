// Chapters that are spread over one address per page.
//
// The older readers put a single panel on screen and a page selector under it.
// There is no strip and no API, so the pages have to be walked — and the first
// thing that has to be right is *which list is the page list*. Every one of
// these sites shows three selectors that look identical from the outside: the
// series, the chapter, and the page, all of them numbers whose values are URLs.
// Pick the wrong one and the reader opens fourteen chapters instead of fourteen
// pages, which is a worse failure than not opening at all.
//
// Lifted out of extension/content/detect.js rather than restated, with a DOM
// small enough to read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const djs = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

const lift = (names, inject) => {
  const from = '  /** A label that names a page rather than a chapter';
  const to = '  // A chapter whose panels are not on the page at all.';
  const a = djs.indexOf(from);
  const b = djs.indexOf(to);
  assert.ok(a !== -1 && b > a, 'the page walk is not where this test expects it');
  const keys = Object.keys(inject);
  return new Function(...keys, `${djs.slice(a, b)}
    return { ${names.join(', ')} };`)(...keys.map((k) => inject[k]));
};

/** A `<select>` of `[label, value]` pairs, as the lifted code reads them. */
const select = (pairs) => ({
  options: pairs.map(([textContent, value]) => ({ textContent, value })),
});

/** The three selectors lelscans and its family put on every chapter page. */
const SERIES = select([['One Piece', 'https://lel.test/scan-one-piece']]);
const CHAPTERS = select([
  ['1192', 'https://lel.test/scan-one-piece/1192'],
  ['1191', 'https://lel.test/scan-one-piece/1191'],
  ['1190', 'https://lel.test/scan-one-piece/1190'],
  ['1189', 'https://lel.test/scan-one-piece/1189'],
]);
const PAGES = select([
  ['p. 1', 'https://lel.test/scan-one-piece/1192/1'],
  ['p. 2', 'https://lel.test/scan-one-piece/1192/2'],
  ['p. 3', 'https://lel.test/scan-one-piece/1192/3'],
  ['p. 4', 'https://lel.test/scan-one-piece/1192/4'],
]);

const walk = (selects, href) => lift(['pagedChapter', 'panelIn', 'dirOf'], {
  rules: { heuristics: { minGalleryImages: 3 } },
  document: { querySelectorAll: () => selects, images: [] },
  location: { href },
  sizedImage: () => false,
  lazySrc: () => null,
  console,
});

test('the page list is the one that lives under the address being read', () => {
  const { pagedChapter } = walk([SERIES, CHAPTERS, PAGES], 'https://lel.test/scan-one-piece/1192');
  const found = pagedChapter();
  assert.ok(found, 'no page list was found on a page that has one');
  assert.equal(found.urls.length, 4);
  assert.deepEqual(found.urls, PAGES.options.map((o) => o.value));
});

test('the chapter list is never mistaken for it, in either order', () => {
  // Both lists are numbers with URL values, both sit under the series address.
  // The page list is the deeper of the two, and that is the whole rule — so it
  // has to hold whichever order the page happens to declare them in.
  for (const order of [[CHAPTERS, PAGES], [PAGES, CHAPTERS]]) {
    const { pagedChapter } = walk(order, 'https://lel.test/scan-one-piece/1192');
    assert.equal(pagedChapter().urls[0], 'https://lel.test/scan-one-piece/1192/1');
  }
});

test('a page already deeper in the chapter still finds its own list', () => {
  // Somebody who opened page three and then pressed the pill: the address is
  // `/1192/3`, and the list still belongs to it.
  const { pagedChapter } = walk([CHAPTERS, PAGES], 'https://lel.test/scan-one-piece/1192/3');
  assert.equal(pagedChapter().urls.length, 4);
});

test('a chapter list on its own is not a chapter spread over pages', () => {
  // The common failure this guards: a site with one selector, of chapters.
  // Walking it would open the first page of fourteen different chapters.
  const { pagedChapter } = walk([SERIES, CHAPTERS], 'https://lel.test/scan-one-piece/1192');
  assert.equal(pagedChapter(), null);
});

test('two pages are not a chapter', () => {
  const short = select([
    ['p. 1', 'https://lel.test/scan-one-piece/1192/1'],
    ['p. 2', 'https://lel.test/scan-one-piece/1192/2'],
  ]);
  const { pagedChapter } = walk([short], 'https://lel.test/scan-one-piece/1192');
  assert.equal(pagedChapter(), null);
});

// --- picking the panel out of a page that was fetched, not rendered ---------

/** A parsed document, as `panelIn` reads one: images with attributes only. */
const doc = (images) => ({
  images: images.map((attrs) => ({ getAttribute: (name) => attrs[name] ?? null })),
});

test('the panel is the image filed with the rest of the chapter', () => {
  // No layout to measure on a document that was never rendered, so the folder
  // is the signal: a chapter keeps its pages together, and the panel we can
  // already see says which folder that is.
  const { panelIn } = walk([PAGES], 'https://lel.test/scan-one-piece/1192');
  const page = doc([
    { src: '/mangas/one-piece/thumb_cover.jpg' },
    { src: '/mangas/one-piece/1192/02.jpg', width: '100%' },
    { src: '/mangas/kingdom/thumb_cover.jpg' },
  ]);
  assert.equal(
    panelIn(page, 'https://lel.test/scan-one-piece/1192/2', 'https://lel.test/mangas/one-piece/1192/'),
    'https://lel.test/mangas/one-piece/1192/02.jpg',
  );
});

test('with no folder to go on, the biggest declared box wins', () => {
  const { panelIn } = walk([PAGES], 'https://lel.test/scan-one-piece/1192');
  const page = doc([
    { src: '/logo.png', width: '120', height: '40' },
    { src: '/reader/page-2.jpg', width: '900', height: '1300' },
  ]);
  assert.equal(
    panelIn(page, 'https://lel.test/c/2', null),
    'https://lel.test/reader/page-2.jpg',
  );
});

test('and failing that, anything not named like furniture', () => {
  // Sites that declare no sizes at all. "thumb", "logo", "avatar" are what the
  // page calls its own decoration, and it is the only thing left to read.
  const { panelIn } = walk([PAGES], 'https://lel.test/scan-one-piece/1192');
  const page = doc([
    { src: '/img/site-logo.png' },
    { src: '/img/user-avatar.png' },
    { src: '/img/0002.jpg' },
  ]);
  assert.equal(panelIn(page, 'https://lel.test/c/2', null), 'https://lel.test/img/0002.jpg');
});

test('a page with nothing on it costs one panel, not the chapter', () => {
  const { panelIn } = walk([PAGES], 'https://lel.test/scan-one-piece/1192');
  assert.equal(panelIn(doc([]), 'https://lel.test/c/2', null), null);
});
