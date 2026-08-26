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
