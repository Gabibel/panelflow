// The pages of a chapter the reader loads without leaving the page.
//
// The reader fetches the next chapter's markup and asks shared/compat.js for
// its pages. It used to be handed `images`: the first sixty pictures of the
// page, whatever they were. The QA campaign of October 2026 measured what
// that did on real sites (qa-sim/runs/real-sites/):
//
//   asurascans   the series cover added to every chapter as a page
//   rizzfables   224 -> 10 images, one of them the default avatar
//   mangaread    60 images for a 40-page chapter: stickers, covers (and the cap)
//   manhuaplus   8 images, every one a cover of another series
//
// and every chapter past sixty pages cut at sixty (H11). `pages` is the answer
// now: the chapter in full, filed the way the pages on screen are filed, or
// nothing at all, in which case the reader loads the chapter the old way.
//
// The addresses below are the real ones the campaign recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, stripPages } from '../src/compat.js';

const page = (imgs) => `<html><head><title>Chapter</title></head><body>
  <a href="/c/prev">Previous chapter</a><a href="/c/next">Next chapter</a>
  ${imgs.map((src) => `<img src="${src}">`).join('\n  ')}
</body></html>`;

const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i + 1));

test('asurascans: the next chapter is its own folder, and the cover is not a page', () => {
  const like = range(3, (i) => `https://cdn.asurascans.com/asura-images/chapters/war-of-extinction/7/74718${i}.webp`);
  const pages = range(32, (i) => `https://cdn.asurascans.com/asura-images/chapters/war-of-extinction/8/7472${String(i).padStart(2, '0')}.webp`);
  const cover = 'https://cdn.asurascans.com/asura-images/covers/war-of-extinction.f60b25-400.webp';
  assert.deepEqual(stripPages([cover, ...pages], like), pages);
});

test('manhuaplus: covers of other series are not a chapter, so there is no answer', () => {
  // The pages are drawn by a script; the markup holds only the sidebar. An
  // empty answer is what sends the reader to load the chapter the old way.
  const like = ['https://cdn.manhuaplus.cc/2025/06/10/10-58-15-3543184222439567.webp'];
  const covers = ['masters-of-lightning-knives', 'reincarnation-of-the-hero-party-s-grand-mage',
    'the-extra-s-academy-survival-guide', 'rebirth-of-the-ultimate-master', 'a-big-shot-actually',
    'six', 'seven', 'eight'].map((s) => `https://manhuaplus.org/uploads/covers/${s}.jpg`);
  assert.deepEqual(stripPages(covers, like), []);
});

test('rizzfables: pages filed under another upload date are pages, the avatar is not', () => {
  const like = ['https://cdn.55779955.xyz/file/roraor/wp-content/uploads/2025/08/12/70b5-01-962c.webp'];
  const pages = range(8, (i) => `https://cdn.55779955.xyz/file/roraor/wp-content/uploads/2025/07/29/a1${i}-0${i}-bb.webp`);
  const noise = [
    'https://rizzfables.com/assets/images/default_pfp_mewo.webp',
    'https://cdn.rizzfables.com/wp-content/uploads/2024/11/banner-final.webp',
  ];
  assert.deepEqual(stripPages([noise[0], ...pages, noise[1]], like), pages);
});

test('mangaread: forty pages come back as forty, without the stickers and covers around them', () => {
  const base = 'https://www.mangaread.org/wp-content/uploads/WP-manga/data/manga_654903b79f415';
  const like = [`${base}/fda03534d7087acfe3524d5ea72df3ff/0.jpg`];
  const pages = range(40, (i) => `${base}/0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e/${i - 1}.jpg`);
  const noise = [
    ...range(10, (i) => `https://www.mangaread.org/wp-content/uploads/2023/05/series-${i}-193x278.jpg`),
    ...range(10, (i) => `https://www.mangaread.org/wp-content/plugins/wpdiscuz/assets/sticker-${i}.png`),
  ];
  const r = analyze(page([...noise.slice(0, 5), ...pages, ...noise.slice(5)]),
    'https://www.mangaread.org/manga/i-killed-an-academy-player/chapter-139/', { like });
  assert.deepEqual(r.pages, pages);
  assert.ok(r.images.length <= 60, 'the preview stays a preview');
});

test('a chapter of eighty pages arrives as eighty (H11)', () => {
  const like = ['https://img.test/long/1/1.png'];
  const pages = range(80, (i) => `https://img.test/long/2/${i}.png`);
  const r = analyze(page(pages), 'https://scan.test/manga/long/chapter-2', { like });
  assert.equal(r.pages.length, 80);
  assert.deepEqual(r.pages, pages, 'in order, every one');
});

test('a chapter filed in the very folder of the one on screen keeps every page, whatever it is called', () => {
  // Some sites put a whole series in one folder, chapter number in the name.
  // In that folder a file is a page even if a scanlator called it "cover".
  const like = ['https://img.test/series/blue-box/108-01.jpg'];
  const pages = ['https://img.test/series/blue-box/109-00-cover.jpg',
    ...range(5, (i) => `https://img.test/series/blue-box/109-0${i}.jpg`)];
  assert.deepEqual(stripPages(pages, like), pages);
});

test('with no page on screen to compare with, the biggest folder of real files wins', () => {
  // The reader's own pages were blob: addresses (scan-manga), which say
  // nothing about where a site files its pages.
  const pages = range(12, (i) => `https://cdn.test/ch/55/${i}.webp`);
  const noise = [
    ...range(4, (i) => `https://cdn.test/uploads/2024/01/cover-${i}-110x150.jpg`),
    ...range(13, (i) => `https://cdn.test/static/thumb-${i}.jpg`),
  ];
  assert.deepEqual(stripPages([...noise, ...pages], []), pages);
});

test('too few pages is no answer at all', () => {
  const like = ['https://img.test/a/1/1.png'];
  assert.deepEqual(stripPages(['https://img.test/a/2/1.png', 'https://img.test/a/2/2.png'], like), []);
});

test('the analyser hands `pages` over even when the caller says nothing of the page on screen', () => {
  const pages = range(6, (i) => `https://cdn.test/ch/9/${i}.webp`);
  const r = analyze(page(pages), 'https://scan.test/manga/x/chapter-9');
  assert.deepEqual(r.pages, pages);
});
