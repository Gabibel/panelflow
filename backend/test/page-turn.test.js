// Turning the page: which page comes next, and which side of the screen asks
// for it.
//
// This is the reader's innermost loop and it is entirely arithmetic, which is
// exactly the kind of code that is wrong by one and never crashes. A spread
// that pairs from the wrong parity shows every page twice; a tap zone that maps
// the wrong way reads a manga backwards. Neither raises anything — you just get
// a worse reader — so nothing but a test is going to catch it.
//
// The functions are lifted out of extension/content/reader.js rather than
// copied, and the DOM they touch is replaced with a stub that records what they
// asked for. What comes out is the real turn, run for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rjs = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');

const lift = (from, to, names, inject) => {
  const a = rjs.indexOf(from);
  const b = rjs.indexOf(to);
  assert.ok(a !== -1 && b > a, `${from.trim()} is not where this test expects it`);
  const keys = Object.keys(inject);
  return new Function(...keys, `${rjs.slice(a, b)}
    return { ${names.join(', ')} };`)(...keys.map((k) => inject[k]));
};

// `isSpread` is the reader's own, not a restatement of it. There used to be a
// second predicate beside it, `isRtl`, and the two right-to-left modes it
// answered for are gone — which is why this list is one name long now.
const predicates = (state) => lift(
  '  // The one question the modes get asked all over this file',
  '  async function open(images, meta, rule, container',
  ['isSpread'],
  { state },
);

/**
 * A reader on `pages` pages, with the turn logic wired to a stub screen.
 * `.shown` is what ended up in the frame, newest turn last.
 */
function reader(pages, over = {}) {
  const state = {
    mode: 'ltr', breakFirst: false, page: 0, novel: false,
    images: Array.from({ length: pages }, (_, i) => `p${i}.jpg`),
    prefs: { autoNext: false, tapZones: 'sides', invertTap: false },
    nav: null, chromeVisible: true, chapters: [], meta: {},
    ...over,
  };
  const shown = [];
  const wrap = {
    set innerHTML(_v) { /* cleared before each frame */ },
    appendChild(img) { shown[shown.length - 1].push(img.src); },
  };
  const doc = { createElement: () => ({ src: null }) };
  const turn = lift(
    '  // Spread pairing honours "break 1st page"',
    '  function onTapZones(e) {',
    ['spreadIndices', 'pageStart', 'showPage', 'step', 'next', 'prev'],
    {
      state,
      ...predicates(state),
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      $: () => wrap,
      document: doc,
      applyTransform() {}, updateCounter() {}, preload() {}, saveProgress() {},
      gotoChapter(url) { state.went = url; },
      // R4 gave the end of a chapter a second source of a next chapter — the
      // site's own list, read newest first — and a panel to show when there is
      // none. Both are tested in reader-end.test.js; here they only need to be
      // reachable without throwing, so the turn under test is the real one.
      isHere: (url) => url === state.meta.chapterUrl,
    },
  );
  const frame = (fn) => { shown.push([]); fn(); return shown[shown.length - 1]; };
  return { state, turn, shown, frame };
}

// --- pairing ----------------------------------------------------------------

test('spreads pair from page zero when nothing is broken out', () => {
  const { turn } = reader(10, { mode: 'spread' });
  assert.deepEqual(turn.spreadIndices(0), [0, 1]);
  assert.deepEqual(turn.spreadIndices(2), [2, 3]);
  // Landing mid-pair snaps back to the pair's start rather than inventing a
  // third pairing — otherwise every page after it shows twice.
  assert.equal(turn.pageStart(0), 0);
  assert.equal(turn.pageStart(3), 2);
  assert.equal(turn.pageStart(7), 6);
});

test('a cover page stands alone and shifts every pair behind it', () => {
  // This is the whole point of "break 1st page": a book printed with a single
  // cover has 1+2 facing, not 0+1, and a reader that ignores it shows every
  // spread as two halves of different sheets.
  const { turn } = reader(10, { mode: 'spread', breakFirst: true });
  assert.deepEqual(turn.spreadIndices(0), [0], 'the cover took a partner');
  assert.deepEqual(turn.spreadIndices(1), [1, 2]);
  assert.deepEqual(turn.spreadIndices(3), [3, 4]);
  assert.equal(turn.pageStart(0), 0);
  assert.equal(turn.pageStart(1), 1);
  assert.equal(turn.pageStart(2), 1, 'page 2 belongs to the pair that starts at 1');
  assert.equal(turn.pageStart(4), 3);
});

test('pairing is not applied to a mode that has no pairs', () => {
  for (const mode of ['ltr', 'spread', 'vertical']) {
    const { turn } = reader(10, { mode, breakFirst: true });
    assert.equal(turn.pageStart(5), 5, `${mode} snapped a page it should not have`);
  }
});

// --- stepping ---------------------------------------------------------------

test('a spread turns two pages at a time, and the cover turns one', () => {
  const r = reader(10, { mode: 'spread', breakFirst: true });
  assert.deepEqual(r.frame(() => r.turn.showPage(0)), ['p0.jpg']);
  assert.deepEqual(r.frame(() => r.turn.next()), ['p1.jpg', 'p2.jpg']);
  assert.deepEqual(r.frame(() => r.turn.next()), ['p3.jpg', 'p4.jpg']);
  assert.deepEqual(r.frame(() => r.turn.prev()), ['p1.jpg', 'p2.jpg'], 'back is not symmetrical');
  assert.deepEqual(r.frame(() => r.turn.prev()), ['p0.jpg']);
});

test('the first page cannot be turned off the front of the chapter', () => {
  const r = reader(10);
  r.frame(() => r.turn.showPage(0));
  r.frame(() => r.turn.prev());
  assert.equal(r.state.page, 0, 'the reader walked off page zero');
});

test('a chapter with an odd number of pages ends on a half spread, not a crash', () => {
  const r = reader(5, { mode: 'spread' });
  r.frame(() => r.turn.showPage(0));
  r.frame(() => r.turn.next());
  const last = r.frame(() => r.turn.next());
  assert.deepEqual(last, ['p4.jpg'], 'a pair was drawn off the end of the chapter');
  assert.equal(r.state.page, 4);
});

test('the end of the chapter is the end unless the next one is known', () => {
  const alone = reader(4);
  alone.frame(() => alone.turn.showPage(3));
  alone.frame(() => alone.turn.next());
  assert.equal(alone.state.page, 3, 'it turned past the last page');
  assert.equal(alone.state.went, undefined);

  // Auto-next only fires with both the preference and a next chapter: turning
  // the last page of the last chapter must not navigate to undefined.
  const armed = reader(4, { prefs: { autoNext: true, tapZones: 'sides', invertTap: false } });
  armed.state.nav = { nextUrl: 'https://x.test/c/5' };
  armed.frame(() => armed.turn.showPage(3));
  armed.turn.next();
  assert.equal(armed.state.went, 'https://x.test/c/5');

  const noNext = reader(4, { prefs: { autoNext: true, tapZones: 'sides', invertTap: false } });
  noNext.frame(() => noNext.turn.showPage(3));
  noNext.turn.next();
  assert.equal(noNext.state.went, undefined, 'it navigated to a chapter it does not have');
});

// The three tests that used to live here pinned `spread-rtl`: a double page
// drawn right to left, for manga. That mode and its single-page twin are gone
// (see shared/prefs.js), so what they pinned no longer exists. `a spread pairs
// and breaks` below keeps the half that does — pairing, and the lone cover.

test('a spread pairs and breaks the same way whatever comes before it', () => {
  const r = reader(10, { mode: 'spread', breakFirst: true });
  assert.deepEqual(r.turn.spreadIndices(0), [0]);
  assert.equal(r.turn.pageStart(2), 1);
  // One page has no pair, and the cover must not be dropped on its way through.
  assert.deepEqual(r.frame(() => r.turn.showPage(0)), ['p0.jpg']);
});

test('single-page mode draws one page and only one', () => {
  // This used to run over `['rtl', 'ltr']`, to say that direction changed
  // nothing about drawing a lone page. There is one single-page mode now, so
  // what is left to pin is that it does not pair — which is the mistake the
  // spread arithmetic next door could make here.
  const r = reader(10, { mode: 'ltr' });
  assert.deepEqual(r.frame(() => r.turn.showPage(1)), ['p1.jpg']);
});

// --- which side is forward --------------------------------------------------

const zones = (over) => {
  const state = { mode: 'ltr', prefs: { tapZones: 'sides', invertTap: false }, ...over };
  return lift(
    '  /** The fraction of the width, on each side, that turns the page. */',
    '  let zoneTimer = 0;',
    ['tapTurnWidth', 'tapForwardRight'],
    { state, ...predicates(state), TAP_LAYOUTS: { sides: 0.33, edges: 0.18, off: 0 } },
  );
};

test('right is forward, in every mode', () => {
  // The mode used to have a say in this: two of the five were right-to-left and
  // flipped which zone advanced. They are gone, so there is one answer and one
  // place that can change it — the preference below. Get this backwards and
  // every tap takes you a page further from where you were going.
  for (const mode of ['ltr', 'spread', 'vertical']) {
    assert.equal(zones({ mode }).tapForwardRight(), true, mode);
  }
});

test('the preference is the only thing that swaps the sides', () => {
  // Which is what the two removed modes were really for: somebody who reads
  // manga and expects the right edge to advance sets this once, and it holds
  // wherever they read — instead of being implied by a mode they also had to
  // pick per series.
  const inv = { invertTap: true, tapZones: 'sides' };
  for (const mode of ['ltr', 'spread', 'vertical']) {
    assert.equal(zones({ mode, prefs: inv }).tapForwardRight(), false, mode);
  }
});

test('turning tap zones off leaves no zone that turns a page', () => {
  assert.equal(zones({ prefs: { tapZones: 'off' } }).tapTurnWidth(), 0);
  assert.equal(zones({ prefs: { tapZones: 'edges' } }).tapTurnWidth(), 0.18);
  // A width read back from storage that no longer exists falls to the default
  // rather than to undefined, which would compare false and kill every tap.
  assert.equal(zones({ prefs: { tapZones: 'nonsense' } }).tapTurnWidth(), 0.33);
  assert.equal(zones({ prefs: {} }).tapTurnWidth(), 0.33);
});

// --- the modes themselves ---------------------------------------------------

test('every mode offered can be chosen, announced, and asked about', () => {
  // Three lists have to agree and none of them imports the others: the <option>
  // values, the toast that says which mode you just switched to, and the two
  // predicates every branch in the file goes through. A mode added to one is a
  // reader that silently behaves as "long strip" — the fallthrough — while the
  // menu says otherwise.
  const menu = rjs.slice(rjs.indexOf('<select class="pf-mode">'));
  const options = [...menu.slice(0, menu.indexOf('</select>'))
    .matchAll(/<option value="([a-z-]+)">/g)].map((m) => m[1]);
  assert.deepEqual(options, ['vertical', 'ltr', 'spread']);

  // The announcement is a message key now, so there are two ways to lose it:
  // no entry in the table, or an entry naming a key no locale defines. Chrome
  // answers a missing key with an empty string, which would flash a blank box.
  const modeToast = lift(
    '  const modeToast = (mode) =>', '  const state = {',
    ['modeToast'], {}).modeToast;
  for (const mode of options) {
    const key = modeToast(mode);
    assert.ok(key, `${mode} announces nothing`);
    assert.ok(MESSAGES[key], `${mode} announces ${key}, which is in no locale file`);
    // Not an assertion about which answer is right — the tests above do that —
    // but that the question has a real answer for every mode on the menu.
    assert.equal(typeof predicates({ mode }).isSpread(), 'boolean');
  }
  assert.deepEqual(
    options.filter((m) => predicates({ mode: m }).isSpread()), ['spread']);
});

test('no mode is compared against by hand where a predicate exists', () => {
  // The bug was one `=== 'spread'` that did not know about a second spread
  // mode. There are ten of these branches; they all have to go through the
  // predicates or the next mode reintroduces it somewhere else in the file.
  const strays = [...rjs.matchAll(/state\.mode [!=]== '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(strays)].sort(), ['spread', 'vertical'],
    'a pairing test is being made without the predicate');
  // 'vertical' is nobody's business but its own — it is not paired. The single
  // mention of 'spread' is `isSpread` itself, and a second would be a branch
  // that has escaped it.
  assert.equal(strays.filter((m) => m !== 'vertical').length, 1);
});

test('the two turn zones never overlap', () => {
  // onTapZones is `x < turn` on one side and `x > 1 - turn` on the other; a
  // width over a half would make the middle of the screen belong to both, and
  // whichever branch is written first would silently win the whole screen.
  for (const z of ['sides', 'edges', 'off']) {
    assert.ok(zones({ prefs: { tapZones: z } }).tapTurnWidth() <= 0.5, `${z} zones meet`);
  }
});
