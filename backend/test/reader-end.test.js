// R4: what a series remembers, and how a chapter ends.
//
// Two changes with one thing in common — both are about not being thrown out.
//
// The first is Mihon's preference hierarchy: a global default, overridden for
// one series, and the override asked for rather than guessed. Two series read
// the same evening, one right to left and one a webtoon, used to mean flipping
// the mode by hand at every chapter boundary.
//
// The second is the end of the chapter. Until now, turning the last page of a
// chapter with no known next one did nothing at all in paged mode, and in
// vertical mode there was no ending to reach — `endOfChapter` was called from
// `step()` only, so the way most people read had no end. Either way the reader
// was eventually handed back to the scan site, at the exact moment they were
// deciding whether to read another one.
//
// What the panel is allowed to contain is a design rule and not a detail
// (redesign.md, §2.3): navigation and nothing else. No rating prompt, no
// tracker nudge, no "turn on notifications". One test below is what keeps it
// that way, because the end of a chapter is the moment a reader is most
// willing to say yes to something — which is exactly why it may not ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const rjs = read('extension/content/reader.js');

const lift = (from, to, names, inject) => {
  const a = rjs.indexOf(from);
  const b = rjs.indexOf(to);
  assert.ok(a !== -1 && b > a, `${from.trim()} is not where this test expects it`);
  const keys = Object.keys(inject);
  return new Function(...keys, `${rjs.slice(a, b)}
    return { ${names.join(', ')} };`)(...keys.map((k) => inject[k]));
};

// The two constants the series code is driven by, read from the file rather
// than restated: a cap only this test knows about caps nothing.
const SERIES_KEYS = JSON.parse(rjs.match(/const SERIES_KEYS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
const SERIES_LIMIT = Number(rjs.match(/const SERIES_LIMIT = (\d+);/)[1]);
const DEFAULT_PREFS = { stripWidth: 100, textWidth: 680, brightness: 100 };

/** A storage that answers synchronously and keeps what it was given. */
function storage(seed = {}) {
  const store = { ...seed };
  return {
    store,
    chrome: {
      storage: {
        local: {
          get(keys, cb) { cb(Object.fromEntries([].concat(keys).map((k) => [k, store[k]]))); },
          set(patch, cb) { Object.assign(store, patch); cb?.(); },
        },
      },
      runtime: { sendMessage(msg) { store.sent = [...(store.sent || []), msg]; } },
    },
  };
}

/** The per-series half of the reader, wired to a storage and a stub panel. */
function series(over = {}) {
  const { store, chrome } = storage(over.stored || {});
  const flashed = [];
  const state = {
    mode: 'vertical', novel: false, rule: {},
    meta: { sourceUrl: 'https://scan.test/berserk' },
    globalPrefs: { ...DEFAULT_PREFS },
    prefs: { ...DEFAULT_PREFS },
    seriesPrefs: null, seriesAll: {},
    root: { querySelectorAll: () => [] },
    ...over.state,
  };
  const api = lift(
    '  // --- what one series remembers for itself',
    '  function buildPrefsPanel() {',
    ['seriesPick', 'seriesSnapshot', 'saveSeriesPrefs', 'toggleSeriesPrefs', 'syncPrefsInputs'],
    {
      state, chrome, t, SERIES_KEYS, SERIES_LIMIT, DEFAULT_PREFS,
      flash: (msg) => flashed.push(msg),
      applyPrefs() {}, stopAutoplay() {}, render() { state.rendered = true; },
      $: () => ({ set value(v) { state.selectValue = v; } }),
    },
  );
  return { state, store, api, flashed };
}

// --- the hierarchy ----------------------------------------------------------

test('a width kept for one series never becomes the width every series opens at', () => {
  // The bug this was written against: writing `readerPrefs: state.prefs` while
  // an override is live launders the override into the defaults on the very
  // next drag of any slider, and there is no undo for that.
  const s = series();
  s.state.prefs.stripWidth = 60;
  s.api.toggleSeriesPrefs(true);

  assert.equal(s.store.readerSeries['https://scan.test/berserk'].stripWidth, 60);
  assert.equal(s.store.readerPrefs, undefined, 'the settings were written while an override was on');
  assert.equal(s.state.globalPrefs.stripWidth, 100, 'the override reached the global settings');
  assert.deepEqual(s.flashed, [t('readerSeriesOn')]);
});

test('the record holds the mode and the widths, and nothing else', () => {
  const s = series();
  Object.assign(s.state.prefs, { stripWidth: 55, textWidth: 500, brightness: 40 });
  s.state.mode = 'rtl';
  const rec = s.api.seriesSnapshot();
  assert.deepEqual(Object.keys(rec).sort(), ['mode', ...SERIES_KEYS].sort());
  // Brightness is about the room, not the book. A series that remembered it
  // would undo the reader's own dimming every time they opened it at night.
  assert.equal(rec.brightness, undefined);
});

test('reading a record back takes only what a series may override', () => {
  // A record written by a future version, or hand-edited, cannot smuggle a
  // brightness or a tap layout into the live preferences by sitting in storage.
  const s = series();
  assert.deepEqual(s.api.seriesPick({ stripWidth: 70, brightness: 5, tapZones: 'off', at: 1 }),
    { stripWidth: 70 });
  assert.deepEqual(s.api.seriesPick(null), {});
});

test('turning the switch off puts this chapter back on the global settings at once', () => {
  // Not next time. A switch whose effect only shows on the next chapter is a
  // switch you cannot tell you pressed.
  const s = series({ stored: { readerPrefs: { stripWidth: 100 }, readerMode: 'ltr' } });
  s.state.seriesPrefs = { mode: 'rtl', stripWidth: 45, textWidth: 680 };
  s.state.prefs.stripWidth = 45;
  s.state.mode = 'rtl';

  s.api.toggleSeriesPrefs(false);

  assert.equal(s.state.prefs.stripWidth, 100, 'the series width survived the switch being turned off');
  assert.equal(s.state.mode, 'ltr', 'the series direction survived the switch being turned off');
  assert.equal(s.state.rendered, true, 'the mode changed without anything being redrawn');
  assert.deepEqual(s.store.readerSeries, {}, 'the record is still in storage');
  assert.deepEqual(s.flashed, [t('readerSeriesOff')]);
});

test('a novel stays vertical whatever the settings say when the switch goes off', () => {
  const s = series({ stored: { readerMode: 'rtl' }, state: { novel: true, mode: 'vertical' } });
  s.state.seriesPrefs = { mode: 'vertical', stripWidth: 100, textWidth: 680 };
  s.api.toggleSeriesPrefs(false);
  assert.equal(s.state.mode, 'vertical', 'a text chapter was put into a page-turning mode');
});

test('a page with no series behind it remembers nothing, and says nothing about it', () => {
  const s = series({ state: { meta: {} } });
  s.state.seriesPrefs = { mode: 'rtl' };
  s.api.saveSeriesPrefs();
  assert.equal(s.store.readerSeries, undefined, 'a record was keyed on nothing');
});

test('the store is pruned oldest first, and only once it is over the cap', () => {
  const s = series();
  const all = {};
  for (let i = 0; i < SERIES_LIMIT; i++) all[`https://scan.test/s${i}`] = { mode: 'rtl', at: i + 1 };
  s.state.seriesAll = all;
  s.state.seriesPrefs = { mode: 'ltr' };
  s.api.saveSeriesPrefs();

  const kept = s.store.readerSeries;
  assert.equal(Object.keys(kept).length, SERIES_LIMIT, 'the store did not settle at the cap');
  assert.ok(kept['https://scan.test/berserk'], 'the series just written is the one that was pruned');
  assert.equal(kept['https://scan.test/s0'], undefined, 'the oldest record survived a prune');
  assert.ok(kept['https://scan.test/s1'], 'more than one record was pruned to make room for one');
});

test('the settings panel writes the global copy, not the live one', () => {
  // Source-level, because the mistake is a two-character one and it is silent.
  assert.match(rjs, /chrome\.storage\.local\.set\(\{ readerPrefs: state\.globalPrefs \}\)/);
  assert.doesNotMatch(rjs, /readerPrefs: state\.prefs/);
});

test('opening a series reads the default, then the setting, then the record', () => {
  // The fallback chain, as text: the record wins over the setting, the setting
  // wins over the default, and a missing record changes nothing.
  assert.match(rjs, /state\.prefs = \{ \.\.\.state\.globalPrefs, \.\.\.seriesPick\(state\.seriesPrefs\) \}/);
  assert.match(rjs, /state\.globalPrefs = \{ \.\.\.DEFAULT_PREFS, \.\.\.\(v\.readerPrefs \|\| \{\}\) \}/);
  assert.match(rjs, /state\.seriesPrefs\?\.mode \|\| v\.readerMode/,
    'the series direction no longer outranks the global one');
});

// --- the end of the chapter -------------------------------------------------

/** The panel, as much of it as the code under test touches. */
function panelStub() {
  const el = () => ({ textContent: '', hidden: false, disabled: false });
  const parts = {
    '.pf-end-title': el(), '.pf-end-left': el(),
    '[data-act="end-next"]': el(), '[data-act="end-read"]': el(),
  };
  const classes = new Set();
  return {
    hidden: true, parts, classes,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    querySelector: (sel) => parts[sel],
  };
}

function ending(over = {}) {
  const { store, chrome } = storage();
  const panel = panelStub();
  const state = {
    meta: {
      chapterUrl: 'https://scan.test/c/12', chapterLabel: 'Chapter 12',
      sourceUrl: 'https://scan.test/berserk',
    },
    prefs: { autoNext: false }, nav: null, chapters: [], page: 0, images: ['a', 'b', 'c'],
    readChapters: new Set(), root: { querySelector: () => panel },
    ...over,
  };
  const api = lift(
    '  function nextChapterUrl() {',
    '  function onTapZones(e) {',
    ['nextChapterUrl', 'hereIndex', 'endOfChapter', 'showEnd', 'chaptersLeftText', 'markChapterRead'],
    {
      state, chrome, t,
      isHere: (url) => url === state.meta.chapterUrl,
      gotoChapter: (url) => { state.went = url; },
      location: { href: 'https://scan.test/c/12' },
      pageTotal: () => state.images.length,
      clock: { day: '2026-08-22' }, localDay: () => '2026-08-22',
      saveProgress: Object.assign(() => { state.saved = true; }, { flush() { state.flushed = true; } }),
      fillWheel() { state.wheel = true; },
      requestAnimationFrame: (fn) => fn(),
    },
  );
  return { state, store, panel, api };
}

/** A merged chapter list, newest first, the way the reader builds it. */
const list = (...labels) => labels.map((n) => ({ url: `https://scan.test/c/${n}`, label: String(n) }));

test("the site's own link is preferred, and the list is the fallback", () => {
  // A derived URL is a very good guess; the site's link is the address the site
  // publishes. And the list runs newest first, so the chapter *after* this one
  // is the row before it — an off-by-one here reads the series backwards.
  const e = ending({ nav: { nextUrl: 'https://scan.test/c/13-official' }, chapters: list(14, 13, 12, 11) });
  assert.equal(e.api.nextChapterUrl(), 'https://scan.test/c/13-official');

  const noNav = ending({ chapters: list(14, 13, 12, 11) });
  assert.equal(noNav.api.nextChapterUrl(), 'https://scan.test/c/13');

  const newest = ending({ chapters: list(12, 11, 10) });
  assert.equal(newest.api.nextChapterUrl(), null, 'it offered a chapter newer than the newest one');

  const stranger = ending({ chapters: list(9, 8) });
  assert.equal(stranger.api.nextChapterUrl(), null, 'a chapter absent from the list was placed in it anyway');
});

test('auto next wins, and wins before the panel is ever drawn', () => {
  const e = ending({ prefs: { autoNext: true }, nav: { nextUrl: 'https://scan.test/c/13' } });
  e.api.endOfChapter();
  assert.equal(e.state.went, 'https://scan.test/c/13');
  assert.equal(e.panel.hidden, true, 'someone who asked to be carried on was stopped by a panel');
});

test('the last chapter of all shows the panel instead of navigating to nothing', () => {
  const e = ending({ prefs: { autoNext: true }, chapters: list(12, 11) });
  e.api.endOfChapter();
  assert.equal(e.state.went, undefined, 'it navigated to a chapter it does not have');
  assert.equal(e.panel.hidden, false);
  assert.equal(e.panel.parts['[data-act="end-next"]'].hidden, true,
    'a "next chapter" button that leads nowhere is offered');
});

test('the panel names the chapter it is the end of', () => {
  const e = ending({ chapters: list(13, 12) });
  e.api.showEnd(true);
  assert.equal(e.panel.parts['.pf-end-title'].textContent, t('readerEndOf', ['Chapter 12']));
  assert.equal(e.panel.parts['[data-act="end-next"]'].textContent, t('readerEndNext'));
  assert.equal(e.panel.parts['[data-act="end-next"]'].hidden, false);
  assert.ok(e.panel.classes.has('pf-on'), 'the panel never fades in, so it appears out of nowhere');

  // A site that gives its chapters no label at all still gets a sentence.
  const bare = ending({ meta: { chapterUrl: 'https://scan.test/c/12' } });
  bare.api.showEnd(true);
  assert.equal(bare.panel.parts['.pf-end-title'].textContent, t('readerEndOf', [t('readerEndThis')]));
});

test('how much is left is counted in the list, and says nothing when it cannot be', () => {
  assert.equal(ending({ chapters: list(14, 13, 12) }).api.chaptersLeftText(),
    t('readerEndLeftMany', ['2']));
  assert.equal(ending({ chapters: list(13, 12) }).api.chaptersLeftText(), t('readerEndLeftOne'));
  assert.equal(ending({ chapters: list(12, 11) }).api.chaptersLeftText(), t('readerEndCaughtUp'));
  // Nothing to say rather than something wrong: a chapter the list does not
  // contain, and a list of one, are both silence.
  assert.equal(ending({ chapters: list(9, 8) }).api.chaptersLeftText(), '');
  assert.equal(ending({ chapters: list(12) }).api.chaptersLeftText(), '');
  assert.equal(ending().api.chaptersLeftText(), '');
});

test('marking it read writes a history row, in pages and not in seconds', () => {
  // The wheel greys a row when the history has one for it. A second flag
  // meaning "read" would be a second answer to drift from the first — and
  // banking seconds for a chapter nobody sat through would put a lie in the
  // statistics the reader is shown.
  const e = ending({ chapters: list(13, 12) });
  e.api.markChapterRead();

  const [msg] = e.store.sent;
  assert.equal(msg.type, 'recordRead');
  assert.equal(msg.read.chapterUrl, 'https://scan.test/c/12');
  assert.equal(msg.read.pages, 3);
  assert.equal(msg.read.seconds, 0, 'time nobody spent reading was banked as reading time');
  // And the position, so the shelf agrees with the wheel.
  assert.equal(e.state.page, 2);
  assert.equal(e.state.scrollRatio, 1);
  assert.equal(e.state.flushed, true, 'the progress is left to a debounce the page may outlive');
  assert.equal(e.state.wheel, true, 'the wheel still shows the chapter as unread');
  assert.equal(e.panel.parts['[data-act="end-read"]'].disabled, true);
  assert.equal(e.panel.parts['[data-act="end-read"]'].textContent, t('readerEndMarked'));
});

test('a chapter already in the history opens the panel with nothing left to claim', () => {
  const e = ending({ readChapters: new Set(['https://scan.test/c/12']) });
  e.api.showEnd(true);
  assert.equal(e.panel.parts['[data-act="end-read"]'].disabled, true);
  assert.equal(e.panel.parts['[data-act="end-read"]'].textContent, t('readerEndMarked'));
});

test('closing the panel takes the fade off with it', () => {
  const e = ending();
  e.api.showEnd(true);
  e.api.showEnd(false);
  assert.equal(e.panel.hidden, true);
  assert.equal(e.panel.classes.has('pf-on'), false,
    'the class stays on, so the next opening starts already faded in');
});

// --- the ending that had no code at all -------------------------------------

test('the bottom of a long strip is an ending, and only when it is crossed', () => {
  // The half of R4 that was missing rather than wrong: `endOfChapter` was
  // called from `step()` alone, so a webtoon — the mode most people read in —
  // never ended at all.
  //
  // A crossing and not a state, for a reason with teeth: restoreProgress can
  // drop the reader straight at the bottom of a strip they left there, and with
  // "auto next chapter" on, a state test would walk a whole series unread at
  // one chapter per restored scroll.
  assert.match(rjs, /if \(atEnd && !state\.atEnd\) endOfChapter\(\);/);
  assert.match(rjs, /if \(!atEnd && state\.atEnd\) showEnd\(false\);/);
  assert.match(rjs, /state\.atEnd = atEnd;/);
  assert.match(rjs, /atEnd: true,/,
    'the reader opens claiming not to be at the end, so a restored scroll counts as a crossing');
});

test('a tap on the panel is a tap on the panel, not on the page behind it', () => {
  const zones = rjs.slice(rjs.indexOf('  function onTapZones(e) {'), rjs.indexOf('  function onTapZones(e) {') + 400);
  assert.match(zones, /if \(e\.target\.closest\('\.pf-end'\)\) return;/,
    'pressing "next chapter" also turns the page under it');
});

test('escape closes the panel before it closes the reader', () => {
  const esc = rjs.slice(rjs.indexOf("!$('.pf-help').hidden"), rjs.indexOf('return close();'));
  assert.match(esc, /!\$\('\.pf-end'\)\.hidden\) return showEnd\(false\)/,
    'escape at the end of a chapter throws the reader out of the reader');
});

// --- what it is not allowed to be -------------------------------------------

test('the panel is navigation and nothing else', () => {
  // redesign.md §2.3, and the sharpest complaint made about WEBTOON: the toll
  // gate falls at the end of the episode with no warning. This panel appears at
  // the same moment, and may therefore only offer the three things the reader
  // came to it for — the next chapter, the record, and going back to reading.
  const from = rjs.indexOf('<div class="pf-end"');
  assert.ok(from !== -1, 'the end panel markup is not where this test expects it');
  const html = rjs.slice(from, rjs.indexOf('</div>', rjs.indexOf('pf-end-acts', from)));

  const acts = [...html.matchAll(/data-act="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(acts.sort(), ['end-next', 'end-read', 'end-stay'],
    'the end-of-chapter panel has grown a control that is not navigation');

  for (const word of [/\brate\b/i, /rating/i, /star/i, /notif/i, /subscri/i, /tracker/i,
    /anilist/i, /myanimelist/i, /premium/i, /donate/i, /share/i]) {
    assert.doesNotMatch(html, word, `the panel asks the reader for something: ${word}`);
  }
  // And no way out to the site it came from: being sent back there is the whole
  // thing this panel exists to prevent.
  assert.doesNotMatch(html, /<a\b/, 'the panel links somewhere');
});

// --- the sheet --------------------------------------------------------------

test('the panel rises into place, and the switch is set apart from the settings', () => {
  const css = read('extension/content/reader.css');
  const end = css.match(/#panelflow-reader \.pf-end \{([^}]*)\}/);
  assert.ok(end, 'the end panel has no rules at all');
  assert.match(end[1], /transition: opacity \.16s ease, transform \.16s ease/);
  assert.match(end[1], /transform: translate\(-50%, 6px\)/,
    'the panel fades in on the spot, so it reads as having always been open');
  assert.match(css, /#panelflow-reader \.pf-end\.pf-on \{[^}]*transform: translate\(-50%, 0\)/);
  // Scoped, because this sheet is injected into someone else's page and a bare
  // `[hidden]` rule in it would restyle theirs.
  assert.match(css, /#panelflow-reader \.pf-end\[hidden\] \{ display: none; \}/);
  assert.match(css, /#panelflow-reader \.pf-prefs \.pf-seriesrow \{[^}]*border-top:/,
    'the switch reads as one more checkbox in a list of checkboxes');
  // Every colour this sheet uses is a token declared on #panelflow-reader
  // itself; a hex here is one the reader's own theme cannot reach.
  assert.doesNotMatch(css.slice(css.indexOf('#panelflow-reader .pf-end {')), /#[0-9a-f]{3,8}\b/i);
});
