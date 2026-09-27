// Turning a chapter in place, backwards as well as forwards.
//
// The reader swaps a chapter's pages without leaving the page
// (loadChapterInPlace). Going forward worked; going back did not: the index of
// the new chapter was looked up with `isHere`, which also accepts the chapter
// being left — and the list is newest first, so on the way back the chapter
// being left came up first. Chapter 9 was drawn under the name "Ch. 10", saved
// and synced under that name, ⏮ pointed at the chapter on screen and ⏭ skipped
// one. Three testers found it independently (QA reports of September 2026).
//
// And a series the reader has not added stopped after one chapter in place:
// the derived list ends at the chapter being read, so the swap had nowhere to
// go next. The fetched page's own "next" link is read now.
//
// The e2e file walks both in a real Chromium; this is the cheap guard that
// runs on a clone without one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rjs = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');

const between = (from, to) => {
  const a = rjs.indexOf(from);
  const b = rjs.indexOf(to, a);
  assert.ok(a !== -1 && b > a, `${from.trim()} is not where this test expects it`);
  return rjs.slice(a, b);
};

test('the chapter arrived at is found by its own address, not by "here"', () => {
  const swap = between('  async function loadChapterInPlace(url) {', '  async function gotoChapter(url) {');
  assert.match(swap, /state\.chapters\.findIndex\(\(c\) => sameUrl\(c\.url, url\)\)/);
  assert.doesNotMatch(swap, /findIndex\(\(c\) => isHere\(c\.url\)\)/,
    'isHere also accepts the chapter being left, which comes first on the way back');
});

test('after the swap the wheel, the slider and the list are asked again', () => {
  const swap = between('  async function loadChapterInPlace(url) {', '  async function gotoChapter(url) {');
  assert.match(swap, /\$\('\.pf-scrub'\)\.max = pageTotal\(\)/, 'the slider keeps the old chapter\'s length');
  assert.match(swap, /loadChapters\(\);\s*return true;/, 'the wheel keeps marking the chapter opened first');
  // The neighbours the fetched page links to fill a list that ends here.
  assert.match(swap, /around\?\.next/);
  assert.match(swap, /around\?\.prev/);
});

test('a chapter number is read from the path, never from the port', () => {
  const src = between('  function urlChapterNumber(href) {', '  /** Below this it is not a chapter');
  const urlChapterNumber = new Function('location', `${src}; return urlChapterNumber;`)(
    { href: 'http://mangakakalot.gg:43512/manga/blue-box/chapter-9/' },
  );
  assert.equal(urlChapterNumber('http://mangakakalot.gg:43512/manga/blue-box/chapter-11/'), 11);
  assert.equal(urlChapterNumber('https://scan-vf.net/one_piece/chapitre-1194'), 1194);
  assert.equal(urlChapterNumber('https://example.test/read/ch_12.5/'), 12.5);
  // No word before it: the last number of the path, not the first.
  assert.equal(urlChapterNumber('https://example.test/2024/series-7/88'), 88);
  assert.equal(urlChapterNumber('https://example.test/about/'), null);
});
