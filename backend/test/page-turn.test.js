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

// `isSpread` / `isRtl` are the reader's own, not a restatement of them: the
// whole point of the mode list gaining a fifth entry is that these two answers
// stopped being readable off a single `===`.
const predicates = (state) => lift(
  '  // Two questions the modes get asked all over this file',
  '  async function open(images, meta, rule, container',
  ['isSpread', 'isRtl'],
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
  for (const mode of ['ltr', 'rtl', 'vertical']) {
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

test('a manga spread puts the earlier page on the right', () => {
  // The bug this test was written to find. "Double page" used to carry no
  // direction at all, so the only mode that draws two pages could not be the
  // mode that reverses them, and the reverse in showPage was unreachable: a
  // manga in double page laid out 4|5 left to right, which is the two pages of
  // the spread in the wrong order on every single turn.
  const rtl = reader(10, { mode: 'spread-rtl' });
  assert.deepEqual(rtl.frame(() => rtl.turn.showPage(2)), ['p3.jpg', 'p2.jpg']);
  const ltr = reader(10, { mode: 'spread' });
  assert.deepEqual(ltr.frame(() => ltr.turn.showPage(2)), ['p2.jpg', 'p3.jpg']);
});

test('reversing a spread moves the pages, not the reader', () => {
  // The page *number* still counts up in a manga, or the counter, the scrubber
  // and the saved progress would all run backwards.
  const r = reader(10, { mode: 'spread-rtl' });
  r.frame(() => r.turn.showPage(0));
  assert.equal(r.state.page, 0);
  r.frame(() => r.turn.next());
  assert.equal(r.state.page, 2, 'forward in a manga is still forward through the file');
  assert.deepEqual(r.shown.at(-1), ['p3.jpg', 'p2.jpg']);
});

test('a manga spread pairs and breaks like any other', () => {
  const r = reader(10, { mode: 'spread-rtl', breakFirst: true });
  assert.deepEqual(r.turn.spreadIndices(0), [0]);
  assert.equal(r.turn.pageStart(2), 1);
  // One page has no order to reverse, and the cover must not be dropped by the
  // reversal on its way through.
  assert.deepEqual(r.frame(() => r.turn.showPage(0)), ['p0.jpg']);
});

test('a single page is drawn the same way whichever direction it is read', () => {
  for (const mode of ['rtl', 'ltr']) {
    const r = reader(10, { mode });
    assert.deepEqual(r.frame(() => r.turn.showPage(1)), ['p1.jpg'], mode);
  }
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

test('the reading direction decides which side is forward', () => {
  // In a manga the next page is the one to the *left* — that is what
  // right-to-left means — so the right-hand zone goes back, and the reader gets
  // this from the mode rather than from a setting nobody would find. Get it
  // backwards and every tap takes you a page further from where you were going.
  assert.equal(zones({ mode: 'rtl' }).tapForwardRight(), false);
  assert.equal(zones({ mode: 'ltr' }).tapForwardRight(), true);
  assert.equal(zones({ mode: 'vertical' }).tapForwardRight(), true);
});

test('the preference swaps the sides rather than replacing them', () => {
  // So someone who has decided right-is-next keeps it in both directions,
  // instead of it silently flipping back when they open a western comic.
  const inv = { invertTap: true, tapZones: 'sides' };
  assert.equal(zones({ mode: 'rtl', prefs: inv }).tapForwardRight(), true);
  assert.equal(zones({ mode: 'ltr', prefs: inv }).tapForwardRight(), false);
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
  assert.deepEqual(options, ['vertical', 'ltr', 'rtl', 'spread', 'spread-rtl']);

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
    const p = predicates({ mode });
    // Not an assertion about which answer is right — the tests above do that —
    // but that both questions have a real answer for every mode on the menu.
    assert.equal(typeof p.isSpread(), 'boolean');
    assert.equal(typeof p.isRtl(), 'boolean');
  }
  assert.deepEqual(
    options.filter((m) => predicates({ mode: m }).isSpread()), ['spread', 'spread-rtl']);
  assert.deepEqual(
    options.filter((m) => predicates({ mode: m }).isRtl()), ['rtl', 'spread-rtl']);
});

test('no mode is compared against by hand where a predicate exists', () => {
  // The bug was one `=== 'spread'` that did not know about a second spread
  // mode. There are ten of these branches; they all have to go through the
  // predicates or the next mode reintroduces it somewhere else in the file.
  const strays = [...rjs.matchAll(/state\.mode [!=]== '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(strays)].sort(), ['rtl', 'spread', 'spread-rtl', 'vertical'],
    'a direction or pairing test is being made without the predicates');
  // 'vertical' is nobody's business but its own — it is neither paired nor
  // directional. Every mention of the other three is one of the four halves of
  // the two predicates, and a fifth would be a branch that has escaped them.
  assert.equal(strays.filter((m) => m !== 'vertical').length, 4);
});

test('the two turn zones never overlap', () => {
  // onTapZones is `x < turn` on one side and `x > 1 - turn` on the other; a
  // width over a half would make the middle of the screen belong to both, and
  // whichever branch is written first would silently win the whole screen.
  for (const z of ['sides', 'edges', 'off']) {
    assert.ok(zones({ prefs: { tapZones: z } }).tapTurnWidth() <= 0.5, `${z} zones meet`);
  }
});
