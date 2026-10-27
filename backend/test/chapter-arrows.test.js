// The reader's two arrows, previous and next chapter, on a site that gives no
// link of its own for either.
//
// asurascans' chapter pages carry no "previous" or "next" link the detector
// can read, so `state.nav` came back empty and both arrows stayed hidden: the
// chapter picker in the middle was the only way to move one chapter on (iPhone,
// October 2026). The picker's own list (the site's links, topped up with the
// chapters worked out from the address) knows both neighbours, so the arrows
// are filled from it when the page said nothing.
//
// As in chapter-wheel-ui.test.js, the function is lifted out of
// extension/content/reader.js rather than copied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/series-match.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rjs = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');

function lift(name) {
  const at = rjs.indexOf(`function ${name}(`);
  assert.ok(at !== -1, `${name} is not in reader.js`);
  const from = rjs.lastIndexOf('\n', at) + 1;
  const to = rjs.indexOf('\n  }\n', from) + 4;
  return rjs.slice(from, to);
}

const sameUrl = (a, b) => !!a && !!b && a.replace(/\/$/, '') === b.replace(/\/$/, '');
const navFromList = new Function('sameUrl', 'window',
  `${lift('navFromList')}\nreturn navFromList;`)(sameUrl, globalThis);

const URL = (n) => `https://asurascans.test/comics/sss-5b2c91aa/chapter/${n}`;
// Newest first, as mergeChapters orders it.
const LIST = [300, 4, 3, 2, 1].map((n) => ({ n, label: `Ch. ${n}`, url: URL(n) }));

test('a page with no links of its own gets both arrows from the chapter list', () => {
  const nav = navFromList(null, LIST, URL(3), 'Chapter 3');
  assert.equal(nav.prevUrl, URL(2));
  assert.equal(nav.nextUrl, URL(4));
});

test('the site\'s own links are kept when it gave them', () => {
  const nav = navFromList({ prevUrl: 'https://site.test/own-prev', nextUrl: null, options: [] },
    LIST, URL(3), 'Chapter 3');
  assert.equal(nav.prevUrl, 'https://site.test/own-prev');
  assert.equal(nav.nextUrl, URL(4), 'only the missing one is filled');
});

test('the first and the newest chapter have one arrow each', () => {
  assert.equal(navFromList(null, LIST, URL(1), 'Chapter 1').prevUrl, null);
  assert.equal(navFromList(null, LIST, URL(300), 'Chapter 300').nextUrl, null);
});

test('found by its number when the address is spelt differently', () => {
  const nav = navFromList(null, LIST, 'https://asurascans.test/comics/sss-5b2c91aa/chapter/3?ref=home', 'Chapter 3');
  assert.equal(nav.nextUrl, URL(4));
});

test('a chapter the list does not know leaves the arrows as they were', () => {
  assert.deepEqual(navFromList(null, LIST, URL(150), 'Chapter 150'), { prevUrl: null, nextUrl: null });
});

test('the list is put to use once it is built', () => {
  const load = lift('loadChapters');
  assert.match(load, /state\.nav = navFromList\(state\.nav, state\.chapters/);
  assert.match(load, /syncChapterNav\(\);/);
});
