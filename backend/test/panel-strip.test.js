// Which <img> elements are pages of the chapter, and where their address is.
//
// Three live sites, three ways of losing most of a chapter, all fixed here:
//   sushiscan.net   9 pages in src, 11 in data-src, and the reader took 9
//   mangas-origines 33 pages rendered at height 0, of which the rect test kept 2
//   natomanga       25 pages with a src that had not decoded when we looked
//
// Same lifting trick as auto-open.test.js: detect.js is a browser IIFE with no
// exports, so each helper is pulled out of the shipping source and run here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

const lift = (startMark, endMark, params, exported) => {
  const from = src.indexOf(startMark);
  const to = src.indexOf(endMark);
  assert.ok(from !== -1 && to > from, `${startMark.trim()} is not where this test expects it`);
  return new Function(...params, `${src.slice(from, to)}\nreturn ${exported};`);
};

const RULES = { heuristics: { minImageWidth: 300, minGalleryImages: 3 } };
const HERE = { href: 'https://c.sushiscan.net/blue-lock-chapitre-345/' };

/** An <img> as these helpers read one. `rect` defaults to the natural size. */
const img = ({
  src: source = '', natural = [800, 1200], rect = null, complete = true, attrs = {},
} = {}) => ({
  src: source,
  currentSrc: '',
  complete,
  naturalWidth: natural[0],
  naturalHeight: natural[1],
  width: natural[0],
  height: natural[1],
  getBoundingClientRect: () => ({
    width: rect ? rect[0] : natural[0],
    height: rect ? rect[1] : natural[1],
  }),
  getAttribute: (name) => attrs[name] ?? null,
});

// --- lazySrc ---------------------------------------------------------------

const lazySrc = lift(
  "  // Where a page's address is", '  async function stableImageSrc',
  ['location'], 'lazySrc')(HERE);

test('a loaded panel is read from src, as before', () => {
  assert.equal(lazySrc(img({ src: 'https://c.sushiscan.net/u/BLChap345-01.webp' })),
    'https://c.sushiscan.net/u/BLChap345-01.webp');
});

test('a lazy panel is read from the attribute holding its address', () => {
  const real = 'https://c.sushiscan.net/wp-content/uploads97/BLChap345-10.webp';
  assert.equal(lazySrc(img({ attrs: { 'data-src': real } })), real);
  assert.equal(lazySrc(img({ attrs: { 'data-original': '/uploads/12.jpg' } })),
    'https://c.sushiscan.net/uploads/12.jpg', 'a relative address resolves against the page');
});

test('the placeholder a lazy loader parks in src is not mistaken for a page', () => {
  const real = 'https://c.sushiscan.net/u/11.webp';
  const got = lazySrc(img({ attrs: { 'data-src': 'data:image/gif;base64,R0lGOD', 'data-lazy-src': real } }));
  assert.equal(got, real);
});

test('srcset alone is enough, descriptor and all', () => {
  const set = 'https://c.sushiscan.net/u/9.webp 800w, https://c.sushiscan.net/u/9-big.webp 1600w';
  assert.equal(lazySrc(img({ attrs: { srcset: set } })), 'https://c.sushiscan.net/u/9.webp');
});

test('an <img> with no address anywhere gives nothing back', () => {
  assert.equal(lazySrc(img()), '');
});

// --- sizedImage ------------------------------------------------------------

const sizedImage = lift(
  '  /** An image big enough', '  // --- is this page actually a chapter?',
  ['rules', 'lazySrc'], 'sizedImage')(RULES, lazySrc);

test('a page the site has not loaded yet is judged on the room made for it', () => {
  // mangas-origines: pages 3 to 33 have a src, a box 800px wide, and a rendered
  // height of 0 until you scroll to them. Asking those for a decoded height is
  // how the site ended up with two candidates, no gallery and no pill at all.
  const pending = { src: 'https://mangas-origines.fr/p/page_0003.webp', natural: [0, 0], complete: false };
  assert.equal(sizedImage(img({ ...pending, rect: [800, 0] })), true);
  assert.equal(sizedImage(img({ ...pending, rect: [120, 0] })), false, 'a thumbnail-wide box is not a page');
  assert.equal(sizedImage(img({ natural: [0, 0], rect: [800, 0] })), false, 'and it needs an address');
});

test('a panel the site has flattened to nothing is still a panel', () => {
  // mangas-origines: .ori-planche-attente gives the <img> a rendered height of
  // 0 while the image itself is decoded at 690x5000.
  assert.equal(sizedImage(img({ natural: [690, 5000], rect: [800, 0] })), true);
});

test('an image with no box at all stays out', () => {
  // Both dimensions collapsed is display:none, and that still means no.
  assert.equal(sizedImage(img({ natural: [690, 5000], rect: [0, 0] })), false);
});

test('an icon is not a page', () => {
  assert.equal(sizedImage(img({ natural: [64, 64] })), false);
  assert.equal(sizedImage(img({ natural: [800, 90] })), false, 'a banner is not a page either');
});

// --- currentStrip ----------------------------------------------------------

const build = lift(
  '  // The strip as it is now', '  /** How many panels',
  ['sizedImage', 'lazySrc', 'galleryImages'], 'currentStrip');
/** currentStrip with a stubbed detection pass — null means "found nothing new". */
const stripWith = (fresh = null) => build(sizedImage, lazySrc, () => fresh);
const currentStrip = stripWith();

const container = (imgs) => ({ querySelectorAll: () => imgs });

test('the strip is counted at open time, not at detection time', () => {
  // natomanga: every panel has a src from the start, and three of them had
  // decoded when detection fired. Opening on that snapshot gave 3 pages of 25.
  const loaded = [img(), img(), img()];
  const pending = Array.from({ length: 22 },
    (_, i) => img({ src: `https://natomanga.test/${i}.jpg`, natural: [0, 0], complete: false }));
  const gallery = { container: container([...loaded, ...pending]), images: loaded };
  assert.equal(currentStrip(gallery).images.length, 25);
});

test('a page whose address is still in data-src is one of ours', () => {
  const loaded = Array.from({ length: 9 }, () => img());
  const lazy = Array.from({ length: 11 }, (_, i) => img({
    natural: [0, 0], complete: false, attrs: { 'data-src': `https://c.sushiscan.net/u/${i}.webp` },
  }));
  const gallery = { container: container([...loaded, ...lazy]), images: loaded };
  assert.equal(currentStrip(gallery).images.length, 20);
});

test('an icon that has finished loading inside the strip is left out', () => {
  const pages = Array.from({ length: 4 }, () => img());
  const icon = img({ src: 'https://x.test/logo.png', natural: [48, 48] });
  const gallery = { container: container([...pages, icon]), images: pages };
  assert.deepEqual(currentStrip(gallery).images, pages);
});

test('a container swapped out under us keeps the chapter we already had', () => {
  // Re-reading must never cost panels: fewer than detection found means the
  // page has moved on, and the snapshot is the better of the two answers.
  const pages = Array.from({ length: 6 }, () => img());
  const gallery = { container: container([img()]), images: pages };
  assert.equal(currentStrip(gallery).images.length, 6);
  assert.equal(currentStrip({ images: pages }).images.length, 6, 'no container falls back too');
});

test('the wrong container is dropped for the one that has the chapter', () => {
  // The natomanga failure as it actually was: detection ran while the chapter
  // had no decoded size, the biggest cluster of images on the page was the
  // "you may also like" carousel, and the reader opened on seven covers of
  // other people's series. A second look, once the page has decoded, finds the
  // strip — and it wins because it is bigger, not because it is newer.
  const covers = Array.from({ length: 7 }, () => img({ src: 'https://nato.test/cover.webp' }));
  const carousel = { container: container(covers), images: covers };
  const pages = Array.from({ length: 13 }, () => img({ src: 'https://nato.test/1139/0.webp' }));
  const strip = { container: container(pages), images: pages };
  const got = stripWith(strip)(carousel);
  assert.equal(got.images.length, 13);
  assert.equal(got.container, strip.container, 'the reader has to be told where it is reading');
});

test('a second look that finds less than detection did is ignored', () => {
  const pages = Array.from({ length: 20 }, () => img());
  const gallery = { container: container(pages), images: pages };
  const covers = Array.from({ length: 7 }, () => img());
  const got = stripWith({ container: container(covers), images: covers })(gallery);
  assert.equal(got.images.length, 20);
});
