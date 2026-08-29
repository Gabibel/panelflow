// How long the reader is allowed to drive the page underneath it.
//
// Most readers load their pages as you scroll, so the overlay opens on the
// first few and the harvester scrolls the hidden document to make the rest
// arrive. That means the scroll lock comes off and the page moves under the
// reader for as long as the harvest runs, which is fine while panels are still
// showing up and is nothing but cost once they have stopped.
//
// It used to stop only at the bottom of the document. On a sushiscan volume —
// 188 panels, every one of them already in the DOM when the reader opened —
// that was a quarter of a million pixels at 720px per tick: nearly two minutes
// of a page scrolling under somebody who was trying to read it, for no new
// panel. Now it stops when it stops producing, wherever it has got to.
//
// The timer body is lifted out of the shipping reader.js and stepped by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');

const from = src.indexOf("    // Drive the page's lazy loading");
const to = src.indexOf('    state.harvestRestoreY = startY;');
assert.ok(from !== -1 && to > from, 'the harvest loop is not where this test expects it');

const INNER_HEIGHT = 800;

/**
 * The loop, wired to a clock the test turns.
 *
 * `setInterval` hands back its callback instead of scheduling it, so a tick is
 * a function call and the whole run is a for loop.
 */
function harvest({ scrollHeight = 250000, startY = 0 } = {}) {
  const state = { root: {}, images: ['a', 'b', 'c'] };
  const stops = [];
  const scrolls = [];
  const locked = [];
  const box = {};
  const document = {
    documentElement: {
      scrollHeight,
      classList: { remove: () => locked.push(false), add: () => locked.push(true) },
    },
  };
  new Function('document', 'state', 'scrollY', 'innerHeight', 'window', 'setInterval',
    'stopHarvest', 'box', `${src.slice(from, to)}\nreturn box;`)(
    document, state, startY, INNER_HEIGHT,
    { scrollTo: (_x, y) => scrolls.push(y) },
    (fn) => { box.tick = fn; return 7; },
    (y) => stops.push(y), box);

  return {
    state,
    stops,
    scrolls,
    locked,
    /** Runs ticks until the loop stops, or gives up. Returns the tick count. */
    run(onTick = () => {}, limit = 400) {
      for (let i = 1; i <= limit; i++) {
        box.tick();
        if (stops.length) return i;
        onTick(i, state);
      }
      return limit;
    },
  };
}

test('a chapter that is already whole is not scrolled through to the end', () => {
  // The volume case: nothing new will ever arrive, because it is all here.
  const h = harvest();
  const ticks = h.run();
  assert.equal(ticks, 13, 'twelve idle ticks and the one that gives up');
  // The point of the number: five seconds and ten thousand pixels, not two
  // minutes and a quarter of a million.
  assert.ok(h.scrolls[h.scrolls.length - 1] < 10000, `scrolled ${h.scrolls.at(-1)}px`);
  assert.deepEqual(h.stops, [0], 'and it puts the page back where it was');
});

test('a page that keeps producing is followed for as long as it does', () => {
  // mangas-origines and natomanga: the panels arrive because of the scrolling,
  // and a harvester that gave up on a timer would take the chapter with it.
  const h = harvest();
  const ticks = h.run((i, state) => {
    if (i % 10 === 0) state.images.push(`page-${i}`);
  }, 200);
  assert.equal(ticks, 200, 'it should still be going');
  assert.equal(h.stops.length, 0);
});

test('a panel that arrives late resets the patience, it does not spend it', () => {
  const h = harvest();
  const ticks = h.run((i, state) => { if (i === 12) state.images.push('late'); });
  assert.equal(ticks, 26, 'twelve, the tick that resets, and twelve more');
});

test('the bottom of the document still ends it, on the old count', () => {
  // Reached on the second tick here. Sitting at the bottom is given five more
  // so a panel that was still decoding can land, which is the rule this loop
  // always had and the one this change leaves alone.
  const h = harvest({ scrollHeight: 2 * INNER_HEIGHT });
  assert.equal(h.run(), 7);
});

test('the reader closing under it takes the harvest with it', () => {
  const h = harvest();
  h.state.root = null;
  h.run();
  // stopHarvest() with no argument: the page is nobody's to restore by then.
  assert.deepEqual(h.stops, [undefined]);
});

test('the page is unlocked to be scrolled at all', () => {
  // Not an implementation detail: the scroll lock is what keeps the document
  // still under the overlay, and the harvest cannot do its job with it on. It
  // is the reason this loop has to end rather than merely be bounded.
  assert.deepEqual(harvest().locked, [false]);
});

// --- what the harvest lets in ----------------------------------------------
//
// The other half of the same job: which of the <img> the observer sees is a
// page worth appending to an open reader.
//
// This used to read `src` and measure what the browser had decoded from it.
// detect.js was fixed in the same week for exactly that — a lazy-loading theme
// parks a transparent gif in `src` and keeps the address in data-src, so the
// decoded size answers for a 1x1 pixel — but the reader kept its own copy of
// both questions, and the copy had not heard about the spacer. Every panel
// that arrived behind one was dropped on the doorstep of a reader the user was
// already looking at.
//
// So the harvest now asks detect.js, and these tests wire the two files
// together the way the browser does: the real lazySrc() and sizedImage(),
// lifted out of the shipping detector, put on the window the lifted `track`
// reads. If the two ever disagree again, they disagree here first.

const detectSrc = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

const liftDetect = (startMark, endMark, params, exported) => {
  const a = detectSrc.indexOf(startMark);
  const b = detectSrc.indexOf(endMark);
  assert.ok(a !== -1 && b > a, `${startMark.trim()} is not where this test expects it`);
  return new Function(...params, `${detectSrc.slice(a, b)}\nreturn ${exported};`);
};

const HERE = { href: 'https://sushiscan.fr/bleach-chapitre-686/' };
const RULES = { heuristics: { minImageWidth: 300, minGalleryImages: 3 } };

const lazySrc = liftDetect(
  "  // Where a page's address is", '  async function stableImageSrc',
  ['location'], 'lazySrc')(HERE);
const sizedImage = liftDetect(
  '  /** An image big enough', '  // --- is this page actually a chapter?',
  ['rules', 'lazySrc'], 'sizedImage')(RULES, lazySrc);

const DETECT = { lazySrc, sizedImage };

const trackFrom = src.indexOf('    const container = state.container;');
const trackTo = src.indexOf('    state.harvestObserver = new MutationObserver(');
assert.ok(trackFrom !== -1 && trackTo > trackFrom, 'the harvest tracker is not where this test expects it');

/** `track` from the shipping reader, with the detector on the window or not. */
function tracker({ images = [], detect = DETECT } = {}) {
  const state = { root: {}, container: {}, images: [...images] };
  const grown = [];
  const track = new Function('state', 'document', 'window', 'onImagesGrown',
    `${src.slice(trackFrom, trackTo)}\nreturn track;`)(
    state, { contains: () => true }, { __panelflowDetect: detect },
    (s) => grown.push(s));
  return { state, grown, track };
}

const SPACER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** An <img> as the harvest reads one. A spacer decodes at 1x1, like the real one. */
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
  waiting: [],
  addEventListener(_type, fn) { this.waiting.push(fn); },
});

test('a panel arriving behind a spacer is harvested, not measured on the spacer', () => {
  // The sushiscan report, one door further in than where it was fixed. The
  // element is complete and decoded — at 1x1, because that is the gif — so it
  // reaches the size gate immediately, and the gate used to throw it away.
  const real = 'https://c.sushiscan.net/u/BLChap686-11.webp';
  const h = tracker();
  h.track(img({ src: SPACER, natural: [1, 1], rect: [800, 1200], attrs: { 'data-src': real } }));
  assert.deepEqual(h.state.images, [real]);
  assert.deepEqual(h.grown, [real], 'and the open reader is told about it');
});

test('the spacer itself is never what gets appended', () => {
  // Belt and braces on the same case: whatever happens, a transparent pixel is
  // not a page of anything and must not end up in the strip.
  const h = tracker();
  h.track(img({ src: SPACER, natural: [1, 1], rect: [800, 1200] }));
  assert.deepEqual(h.state.images, [], 'a spacer with nothing behind it is not a panel');
});

test('one page behind two elements is one panel', () => {
  // Dedup is on the address, which is the whole reason it has to be the same
  // address the strip already holds: a reader that re-renders its <img> would
  // otherwise hand back every page it had already shown.
  const real = 'https://c.sushiscan.net/u/BLChap686-11.webp';
  const h = tracker({ images: [real] });
  h.track(img({ src: SPACER, natural: [1, 1], rect: [800, 1200], attrs: { 'data-src': real } }));
  h.track(img({ src: real }));
  assert.deepEqual(h.state.images, [real]);
});

test('an icon that turns up in the container is still refused', () => {
  // What the size gate is for, and what must survive the change.
  const h = tracker();
  h.track(img({ src: 'https://sushiscan.fr/wp/next.png', natural: [24, 24] }));
  h.track(img({ src: 'https://sushiscan.fr/wp/banner.jpg', natural: [728, 90] }));
  assert.deepEqual(h.state.images, []);
});

test('a lazy panel counts on the room the page made for it', () => {
  // mangas-origines, on a theme that also spaces: the box is panel-wide and
  // flat, because the height arrives with the image. Judging that on the
  // height it has not got yet is how whole chapters used to go missing, so
  // detect.js asks the width alone when the address is not what was decoded —
  // and the harvest now inherits that rather than restating it.
  const real = 'https://mangas-origines.fr/p/page_0031.webp';
  const h = tracker();
  h.track(img({ src: SPACER, natural: [1, 1], rect: [800, 0], attrs: { 'data-src': real } }));
  assert.deepEqual(h.state.images, [real]);

  const narrow = tracker();
  narrow.track(img({ src: SPACER, natural: [1, 1], rect: [120, 0], attrs: { 'data-src': real } }));
  assert.deepEqual(narrow.state.images, [], 'a thumbnail-wide box is not a page');
});

test('a panel with nothing decoded yet is waited for, not thrown away', () => {
  // No spacer, no decoded size: the element is simply not there yet. It gets a
  // load listener, and the same gate runs when the image arrives.
  const pending = img({
    src: 'https://natomanga.com/p/12.webp', natural: [0, 0], rect: [800, 1200], complete: false,
  });
  const h = tracker();
  h.track(pending);
  assert.equal(h.state.images.length, 0);
  assert.equal(pending.waiting.length, 1, 'it is waiting on the load, not dropped');

  Object.assign(pending, { complete: true, naturalWidth: 800, naturalHeight: 1200 });
  pending.waiting[0]();
  assert.deepEqual(h.state.images, ['https://natomanga.com/p/12.webp']);
});

test('a reader with no detector beside it falls back on the old reading', () => {
  // The four clients all load detect.js first, so this is the belt: the reader
  // must keep working on its own rather than harvest nothing at all.
  const h = tracker({ detect: undefined });
  h.track(img({ src: 'https://c.sushiscan.net/u/1.webp' }));
  h.track(img({ src: 'https://sushiscan.fr/wp/next.png', natural: [24, 24] }));
  assert.deepEqual(h.state.images, ['https://c.sushiscan.net/u/1.webp']);
});
