// Which chapters the wheel is allowed to offer.
//
// A chapter page that has no <select> falls back to the chapter-ish links on
// the page, and until now every one of them qualified. That holds on a reader
// that links nothing but its own chapters, and breaks on an index-style site:
// MangaNato lists other series down the side, so the wheel for One Piece 1139
// read 1141, 1140, 1139, then 165, 150, 89, 63, 48, 28, 13, 9 — other people's
// chapters, sorted in among ours, each one a click away from the wrong manga.
//
// Same lifting trick as chapter-labels.test.js: detect.js is a browser IIFE
// with no exports, so the branch is pulled out of the shipping source and run
// here against a stub DOM. The rule under test is the one that ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seriesKey } from '../src/series-match.js';
import { chapterNumber } from '../src/site-rules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

// Branches 1 and 2 of chapterNav, closed off just before branch 3.
const from = src.indexOf('  const CHAPTERISH');
const to = src.indexOf('    // 3. Numeric-ID selects');
assert.ok(from !== -1 && to > from, 'the link branch is not where this test expects it');
const build = new Function('document', 'location', 'window', 'chapterNumber',
  `${src.slice(from, to)}\n  return options;\n}\nreturn chapterNav();`);

/** An <a> as chapterNav reads one: host/pathname/search/href/textContent. */
const anchor = (href, text) => {
  const u = new URL(href);
  return { host: u.host, pathname: u.pathname, search: u.search, href, textContent: text };
};

const wheel = (here, links, { match = true } = {}) => {
  const anchors = links.map(([href, text]) => anchor(href, text || ''));
  const document = { querySelectorAll: (sel) => (sel === 'a[href]' ? anchors : []) };
  const url = new URL(here);
  const location = { href: here, host: url.host, pathname: url.pathname, search: url.search };
  // PanelFlowMatch is a content-script global; when it is missing the branch
  // has to keep working, so that case is a parameter here too.
  // chapterNumber is the shared rule (shared/site-rules.js), which detect.js
  // reaches through a global; the real one goes in so this tests what ships.
  return build(document, location, match ? { PanelFlowMatch: { seriesKey } } : {}, chapterNumber);
};

const NATO = 'https://www.natomanga.com/manga/one-piece/chapter-1139';

test('the wheel offers this series and no other', () => {
  const options = wheel(NATO, [
    ['https://www.natomanga.com/manga/one-piece/chapter-1141', 'Chapter 1141'],
    ['https://www.natomanga.com/manga/one-piece/chapter-1140', 'Chapter 1140'],
    ['https://www.natomanga.com/manga/one-piece/chapter-1139', 'Chapter 1139'],
    ['https://www.natomanga.com/manga/martial-peak/chapter-165', 'Chapter 165'],
    ['https://www.natomanga.com/manga/tales-of-demons-and-gods/chapter-48', 'Chapter 48'],
    ['https://www.natomanga.com/manga/solo-leveling/chapter-13', 'Chapter 13'],
  ]);
  assert.deepEqual(options.map((o) => o.n), [1141, 1140, 1139]);
});

test('a site whose chapters are the only links on the page is unaffected', () => {
  // The common case, and the one the branch was written for: prev/next arrows
  // and nothing else. Filtering must not cost it anything.
  const options = wheel('https://sushiscan.fr/kagurabachi-chapitre-125/', [
    ['https://sushiscan.fr/kagurabachi-chapitre-126/', 'Next'],
    ['https://sushiscan.fr/kagurabachi-chapitre-124/', 'Prev'],
  ]);
  assert.deepEqual(options.map((o) => o.label), ['Ch. 126', 'Ch. 124']);
});

test('an unkeyable page keeps every chapter link it can find', () => {
  // seriesKey hands back the whole URL when it finds no slug to reduce to.
  // Filtering on that matches nothing, and an empty wheel is worse than a
  // mixed one — you can ignore a wrong row, you cannot click a missing one.
  const here = 'https://reader.test/chapter-12';
  assert.ok(!seriesKey(here).includes('|'), 'this URL was supposed to be unkeyable');
  const options = wheel(here, [
    ['https://reader.test/chapter-13', 'Chapter 13'],
    ['https://reader.test/chapter-11', 'Chapter 11'],
  ]);
  assert.deepEqual(options.map((o) => o.n), [13, 11]);
});

test('with the matcher missing, the wheel still fills', () => {
  // Content scripts load in order and this one is a global, not an import: a
  // wheel that empties itself because a sibling script has not run yet would
  // be a worse failure than the one being fixed.
  const options = wheel(NATO, [
    ['https://www.natomanga.com/manga/one-piece/chapter-1140', 'Chapter 1140'],
    ['https://www.natomanga.com/manga/martial-peak/chapter-165', 'Chapter 165'],
  ], { match: false });
  assert.deepEqual(options.map((o) => o.n), [1140, 165]);
});
