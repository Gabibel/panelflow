// Which image ends up on the card, when the page does not say.
//
// og:image answers for most sites and this file is about the rest: coverGuess()
// falls back to sniffing the <img> of the page, and it was sniffing `src`. A
// lazy-loading theme parks a transparent gif there and keeps the address in
// data-src — the same fault that cost sushiscan readers their panels — but a
// cover is worse than a panel when it goes wrong. A panel is missing for one
// chapter; a cover is written into the library once, on the way in, and then
// shown on every card, in the migration list and in all three exports.
//
// coverGuess() is also run against a *fetched* series page (fetchSeriesInfo
// parses one with DOMParser), where nothing is loaded and nothing is decoded,
// so the attributes are all there is.
//
// Lifted out of the shipping detect.js the same way panel-strip.test.js does
// it: the file is a browser IIFE with no exports, so each helper is pulled from
// the source rather than restated here.
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

const HERE = { href: 'https://sushiscan.fr/manga/blue-box/' };

const lazySrc = lift(
  "  // Where a page's address is", '  async function stableImageSrc',
  ['location'], 'lazySrc')(HERE);
const absolute = lift(
  '  const absolute = (src) => {', '  // Which language the scan is in',
  ['location'], 'absolute')(HERE);
const coverGuess = lift(
  '  function coverGuess(root = document)', '  const absolute = (src) => {',
  ['document', 'lazySrc', 'absolute'], 'coverGuess')({}, lazySrc, absolute);

const SPACER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** An <img> as coverGuess reads one. */
const img = ({ src: source = '', natural = [0, 0], cls = '', alt = '', attrs = {} } = {}) => ({
  src: source,
  currentSrc: '',
  className: cls,
  alt,
  naturalWidth: natural[0],
  naturalHeight: natural[1],
  width: natural[0],
  height: natural[1],
  getAttribute: (name) => attrs[name] ?? null,
});

/** A document as coverGuess reads one: a meta tag it may not have, and images. */
const page = ({ og = null, imgs = [] } = {}) => ({
  querySelector: () => (og ? { content: og } : null),
  querySelectorAll: () => imgs,
});

test('the page saying so still wins, and nothing else is looked at', () => {
  const url = 'https://sushiscan.fr/wp-content/uploads/blue-box.jpg';
  assert.equal(coverGuess(page({ og: url, imgs: [img({ src: SPACER })] })), url);
});

test('a cover parked behind a spacer is the cover, not the spacer', () => {
  // The whole point of the file. This used to hand back the transparent gif,
  // which is what a blank card in the library is made of.
  const real = 'https://sushiscan.fr/wp-content/uploads/blue-box-cover.jpg';
  const got = coverGuess(page({
    imgs: [img({ src: SPACER, cls: 'wp-post-image', natural: [1, 1], attrs: { 'data-src': real } })],
  }));
  assert.equal(got, real);
});

test('an element named like a cover with no address behind it is not one', () => {
  // It used to win on its class alone and end the search. Now it stands aside
  // for whatever else the page has — here, the portrait below it.
  const real = 'https://sushiscan.fr/wp-content/uploads/tome-1.jpg';
  const got = coverGuess(page({
    imgs: [
      img({ src: SPACER, cls: 'wp-post-image', natural: [1, 1] }),
      img({ src: real, natural: [400, 600] }),
    ],
  }));
  assert.equal(got, real);
});

test('the tallest portrait is still the last resort, and it reads the same way', () => {
  const real = 'https://sushiscan.fr/wp-content/uploads/tall.jpg';
  const got = coverGuess(page({
    imgs: [
      img({ src: 'https://sushiscan.fr/banner.jpg', natural: [900, 200] }),
      img({ src: SPACER, natural: [400, 600], attrs: { 'data-src': real } }),
    ],
  }));
  assert.equal(got, real);
});

test('a relative address is resolved against the page it was found on', () => {
  const got = coverGuess(page({
    imgs: [img({ cls: 'cover', natural: [400, 600], attrs: { 'data-src': '/uploads/bb.jpg' } })],
  }));
  assert.equal(got, 'https://sushiscan.fr/uploads/bb.jpg');
});

test('a page nobody ever displayed still has a cover', () => {
  // fetchSeriesInfo() parses a fetched page with DOMParser: no layout, no
  // decoding, no dimensions on anything. The size check has to read that as
  // "not measured yet" rather than "too small", or every series added from a
  // chapter page comes into the library blank.
  const real = 'https://sushiscan.fr/wp-content/uploads/blue-box.jpg';
  const got = coverGuess(page({
    imgs: [img({ cls: 'wp-post-image', natural: [0, 0], attrs: { 'data-src': real } })],
  }));
  assert.equal(got, real);
});

test('a page with no cover anywhere says so', () => {
  assert.equal(coverGuess(page()), null);
  assert.equal(coverGuess(page({ imgs: [img({ src: SPACER, natural: [1, 1] })] })), null,
    'and a page of spacers has no cover, rather than a cover made of one');
});

test('a cover the site really did inline is kept', () => {
  // The line between a spacer and an inlined image is length, here as in
  // lazySrc(): under half a kilobyte it is furniture.
  const inlined = `data:image/png;base64,${'A'.repeat(900)}`;
  assert.equal(coverGuess(page({ imgs: [img({ src: inlined, cls: 'cover', natural: [400, 600] })] })),
    inlined);
});
