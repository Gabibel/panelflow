// The reader's answers in the situations the QA campaign of October 2026
// found it wrong in (qa-sim/BUGS.md), each pinned to the bug it was.
//
// Same lifting trick as page-turn.test.js and reader-end.test.js: reader.js is
// a browser IIFE with no exports, so each part is pulled out of the shipping
// source and run here against stubs. What is tested is the code that ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normUrl } from '../src/series-match.js';
import { chapterNumber } from '../src/site-rules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rjs = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');

/** A slice of reader.js between two markers, run with `inject` as its free variables. */
const lift = (from, to, names, inject) => {
  const a = rjs.indexOf(from);
  const b = rjs.indexOf(to);
  assert.ok(a !== -1 && b > a, `${from.trim()} is not where this test expects it`);
  const keys = Object.keys(inject);
  return new Function(...keys, `${rjs.slice(a, b)}\nreturn { ${names.join(', ')} };`)(
    ...keys.map((k) => inject[k]));
};

// --- which chapter is which, after a swap (NEW-21, RS-4) ---------------------

const BASE = 'https://scan.test/manga/gentle-station/chapter-';
const list = (...ns) => ns.map((n) => ({ n, url: `${BASE}${n}/`, label: `Chapter ${n}` }));

function chapters(state, href) {
  return lift('  const sameUrl = ', '  const rowHeight = ',
    ['isHere', 'chapterIndexOf', 'isSeriesPage', 'cleanNav'], {
      state,
      location: { href },
      window: { PanelFlowMatch: { normUrl }, PanelFlowSites: { chapterNumber } },
    });
}

test('NEW-21: the chapter swapped in is found by its own address, not by the one being left', () => {
  // The list runs newest first. On the way back from 5 to 4 the address bar
  // already says 4 while state.meta still says 5, and isHere() answers yes for
  // both: the first match was 5, so chapter 4 was labelled "Chapter 5", its
  // "next" pointed at 6, and the next press went from 4 to 6.
  const state = { chapters: list(8, 7, 6, 5, 4, 3), meta: { chapterUrl: `${BASE}5/` } };
  const c = chapters(state, `${BASE}4/`);
  assert.equal(c.isHere(`${BASE}5/`), true, 'the ambiguity this guards against');
  assert.equal(c.chapterIndexOf(`${BASE}4/`), 4);
  assert.equal(state.chapters[c.chapterIndexOf(`${BASE}4/`) - 1].url, `${BASE}5/`, 'next is 5, not 6');
});

test('NEW-21: an address the list spells differently is found by its number', () => {
  const state = { chapters: list(3, 2, 1), meta: { chapterUrl: `${BASE}1/` } };
  const c = chapters(state, `${BASE}1/`);
  assert.equal(c.chapterIndexOf(`${BASE}2/?utm=x`), 1);
  assert.equal(c.chapterIndexOf('https://scan.test/about'), -1);
});

test('RS-4: the series page is never a chapter to move to', () => {
  const series = 'https://www.mangaread.org/manga/i-killed-an-academy-player/';
  const state = { chapters: [], meta: { sourceUrl: series, chapterUrl: `${series}chapter-140/` } };
  const c = chapters(state, `${series}chapter-140/`);
  assert.deepEqual(c.cleanNav({ prevUrl: `${series}chapter-139/`, nextUrl: series, options: [] }),
    { prevUrl: `${series}chapter-139/`, nextUrl: null, options: [] });
  // A one-shot whose only chapter is the series' own address is still read.
  const oneShot = chapters({ chapters: [], meta: { sourceUrl: series, chapterUrl: series } }, series);
  assert.equal(oneShot.isSeriesPage(series), false);
});

// --- auto-scroll (H8, H9, NEW-3, UX-1) ------------------------------------------

/** A scrolling stage: a column `height` tall in a window `client` tall. */
const stage = (height, client = 800) => ({
  scrollTop: 0, scrollHeight: height, clientHeight: client, isConnected: true,
  set top(v) { this.scrollTop = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
});

/** The autoplay half of the reader, on a frame clock this test turns by hand. */
function autoplay({ autoNext = false, next = null } = {}) {
  const frames = [];
  const calls = { goto: [], end: 0, saved: 0, counted: 0 };
  const button = { innerHTML: '[play]' };
  const state = {
    mode: 'vertical', playing: false, playRaf: 0, playLastTs: 0,
    root: { querySelector: () => button }, prefs: { autoplaySpeed: 100, autoNext },
  };
  let current = stage(10000);
  const doc = { hidden: false };
  const api = lift('  // --- autoplay (long strip)', '  // --- zoom & pan',
    ['startAutoplay', 'stopAutoplay', 'resumeAutoplay'], {
      state, document: doc,
      $: (sel) => (sel === '.pf-stage' ? current : button),
      requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
      cancelAnimationFrame: () => { frames.length = 0; },
      nextChapterUrl: () => next,
      gotoChapter: (url) => { calls.goto.push(url); },
      endOfChapter: () => { calls.end++; },
      // The page under the top of the screen, 1000 px a page in this strip.
      pageAt: (st) => Math.floor(st.scrollTop / 1000),
      pageTotal: () => 10,
      updateCounter: () => { calls.counted++; },
      saveProgress: () => { calls.saved++; },
      icon: (name) => `[${name}]`,
      asHTML: (html) => html,
    });
  // Scroll writes go through the setter, as a real element clamps them.
  const proxy = (s) => new Proxy(s, { set(t, k, v) { if (k === 'scrollTop') t.top = v; else t[k] = v; return true; } });
  current = proxy(current);
  // A browser's frame clock is never at zero (the loop treats 0 as "no
  // previous frame"), so the times this test hands in are offset.
  const frame = (ts) => { const queued = frames.splice(0); for (const fn of queued) fn(ts + 1000); };
  return {
    state, calls, api, doc, frame,
    get stage() { return current; },
    swap(height) { current = proxy(stage(height)); },
    detach() { const old = current; old.isConnected = false; old.scrollHeight = 0; old.clientHeight = 0; },
  };
}

test('H8: a chapter swapped in during auto-scroll is the strip that scrolls next', () => {
  // The loop used to keep the strip it started on. After "next chapter" that
  // strip was detached, measured 0 everywhere, read as "at the bottom", and
  // the chapter ended again one frame after it began: one press, two chapters.
  const r = autoplay({ autoNext: true, next: 'https://scan.test/c/7' });
  r.api.startAutoplay();
  r.frame(0); r.frame(16);
  const before = r.stage.scrollTop;
  assert.ok(before > 0);
  r.detach();
  r.swap(10000);
  r.frame(32); r.frame(48);
  assert.deepEqual(r.calls.goto, [], 'the detached strip ended the new chapter');
  assert.equal(r.calls.end, 0);
  assert.ok(r.stage.scrollTop > 0, 'the new strip did not move');
  assert.equal(r.state.playing, true, 'auto-scroll carries on into the new chapter (UX-1)');
});

test('H9: coming back from the background does not replay the whole absence', () => {
  const r = autoplay({ autoNext: true, next: 'https://scan.test/c/7' });
  r.api.startAutoplay();
  r.frame(0); r.frame(16);
  const before = r.stage.scrollTop;
  r.frame(16 + 10 * 60 * 1000); // ten minutes later
  const jump = r.stage.scrollTop - before;
  assert.ok(jump <= 100 * 0.1 + 1, `jumped ${jump} px after ten minutes away`);
  assert.deepEqual(r.calls.goto, [], 'the chapter ended while nobody was reading');
});

test('H9: while the page is hidden the strip does not move at all', () => {
  const r = autoplay();
  r.api.startAutoplay();
  r.frame(0); r.frame(16);
  const before = r.stage.scrollTop;
  r.doc.hidden = true;
  for (let t = 32; t < 2000; t += 16) r.frame(t);
  assert.equal(r.stage.scrollTop, before);
  assert.equal(r.state.playing, true, 'it waits, it does not stop');
});

test('NEW-3: a jump made during auto-scroll is kept, and scrolling goes on from there', () => {
  const r = autoplay();
  r.api.startAutoplay();
  r.frame(0); r.frame(16);
  r.stage.scrollTop = 6000; // the scrubber, or a key
  r.frame(32);
  assert.ok(r.stage.scrollTop >= 6000, `undone to ${r.stage.scrollTop}`);
});

test('UX-1: at the bottom with auto-next on, auto-scroll waits for the next chapter instead of stopping', () => {
  const r = autoplay({ autoNext: true, next: 'https://scan.test/c/7' });
  r.api.startAutoplay();
  r.stage.scrollTop = 9200 - 1;
  r.frame(0); r.frame(16);
  assert.deepEqual(r.calls.goto, ['https://scan.test/c/7']);
  assert.equal(r.state.playing, true);
  r.swap(5000);
  r.api.resumeAutoplay();
  r.frame(100); r.frame(116);
  assert.ok(r.stage.scrollTop > 0, 'the next chapter did not scroll');
});

test('without auto-next, the bottom stops auto-scroll and shows the end', () => {
  const r = autoplay({ autoNext: false });
  r.api.startAutoplay();
  r.stage.scrollTop = 9200 - 1;
  r.frame(0); r.frame(16);
  assert.equal(r.calls.end, 1);
  assert.equal(r.state.playing, false);
});

// --- the end of a strip scrolled in one movement (NEW-2) -------------------------

function strip({ settling = false } = {}) {
  const handlers = {};
  const s = stage(20000);
  s.addEventListener = (type, fn) => { (handlers[type] ||= []).push(fn); };
  const calls = { end: 0 };
  let pending = null;
  // A crossing at open time is not one: the reader opens with atEnd true.
  const state = { root: {}, atEnd: true, settling, playing: false, novel: false, chromeVisible: true };
  lift('  /** Whether a scrolling stage is at its bottom.', '  // --- putting the strip somewhere',
    ['attachStripScroll'], {
      state, $: () => s,
      debounce: (fn) => (...a) => { pending = () => fn(...a); },
      pageAt: () => 0, pageTotal: () => 20, updateCounter() {}, updateProgress() {}, saveProgress() {},
      endOfChapter: () => { calls.end++; }, showEnd() {}, setChrome() {}, stopAutoplay() {},
      stopSettling() {}, chromeAwayForReading() {}, getSelection: () => '',
    }).attachStripScroll(s);
  const scroll = (top) => { s.top = top; for (const fn of handlers.scroll) fn(); };
  const settle = () => { const run = pending; pending = null; run?.(); };
  return { scroll, settle, calls, state };
}

test('NEW-2: a strip scrolled to the bottom in one movement ends the chapter', () => {
  // The check is debounced, so a reader who never paused half a second on the
  // way only ever showed it "at the bottom", never "not at the end" first.
  const r = strip();
  for (let top = 0; top <= 20000; top += 900) r.scroll(top);
  r.scroll(20000);
  r.settle();
  assert.equal(r.calls.end, 1);
});

test('NEW-2: arriving at the bottom because the reader put you there is not the end', () => {
  // A chapter resumed where it was left, at its last page, must not walk on
  // to the next one with auto-next on before a page of it is read.
  const r = strip({ settling: true });
  r.scroll(5000); r.scroll(20000);
  r.settle();
  assert.equal(r.calls.end, 0);
});

// --- where the reader is, by page (NEW-22) -----------------------------------------

/** A strip whose pages start at `tops` (content coordinates). */
function pages(tops, client = 800) {
  const s = stage(tops[tops.length - 1] + 2000, client);
  s.getBoundingClientRect = () => ({ top: 0 });
  s.children = tops.map((t) => ({
    top: t, complete: true, naturalHeight: 1000,
    getBoundingClientRect() { return { top: this.top - s.scrollTop }; },
  }));
  return s;
}

function positioning(s) {
  const timers = [];
  const state = { root: { querySelector: () => s }, settling: false, atEnd: true };
  const api = lift('  // --- putting the strip somewhere', '  function renderPaged(stage) {',
    ['pageAt', 'scrollToPage', 'stopSettling'], {
      state, $: () => s, atBottom: () => false,
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
    });
  const run = (max = 100) => { for (let i = 0; i < max && timers.length; i++) timers.shift()(); };
  return { api, state, run };
}

test('NEW-22: the page counted is the one at the top of the view, whatever the heights', () => {
  // Webtoon slices run from one screen to five: the old count, the scroll
  // ratio times the page count, was a different page every time.
  const s = pages([0, 1000, 2500, 2600, 4000, 9000]);
  const { api } = positioning(s);
  s.scrollTop = 0; assert.equal(api.pageAt(s), 0);
  s.scrollTop = 2550; assert.equal(api.pageAt(s), 2);
  s.scrollTop = 3990; assert.equal(api.pageAt(s), 3);
  s.scrollTop = 3999; assert.equal(api.pageAt(s), 4, 'a page a pixel or two away from the top is the page at the top');
  s.scrollTop = 8000; assert.equal(api.pageAt(s), 4);
});

test('NEW-22: going back to a page follows it while the pages above it load', () => {
  // Pages above the target arrive with no height and push it down as they
  // load; one scroll at the start lands wherever it happens to be by then.
  const s = pages([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const { api, state, run } = positioning(s);
  api.scrollToPage(s, 12);
  assert.equal(state.settling, true);
  run(1);
  // The pages above load: page 12 ends up 12 screens down.
  s.scrollHeight = 30000;
  s.children.forEach((p, i) => { p.top = i * 1200; });
  run(60);
  assert.equal(s.scrollTop, 12 * 1200);
  assert.equal(state.settling, false, 'the reader never got the strip back');
});

test('NEW-22: a hand on the strip ends the positioning at once', () => {
  const s = pages([0, 1000, 2000, 3000]);
  const { api, state, run } = positioning(s);
  api.scrollToPage(s, 3);
  api.stopSettling();
  assert.equal(state.settling, false);
  s.scrollTop = 500;
  run(60);
  assert.equal(s.scrollTop, 500, 'the strip was taken back from the reader');
});

// --- a next chapter the site does not have (H25) ---------------------------------

function fetching(response, state = { images: ['https://cdn.test/s/4/1.jpg', 'blob:https://x/1'] }) {
  const sent = [];
  const api = lift('  async function chapterImages(url) {', '  /** How long a chapter gets the network to itself',
    ['chapterImages'], {
      state,
      send: async (msg) => {
        sent.push(msg);
        if (msg.type === 'compatHtml') return { pages: ['https://cdn.test/s/5/1.jpg', 'https://cdn.test/s/5/2.jpg', 'https://cdn.test/s/5/3.jpg'] };
        return { pages: [] };
      },
      fetch: async () => response,
      location: { href: 'https://scan.test/c/4', origin: 'https://scan.test' },
      console: { warn() {}, info() {} },
    });
  return { api, sent, state };
}

test('H25: a chapter the site answers 404 for is not loaded at all, and the answer is kept', async () => {
  // Loading it "the old way" took the reader out of the book and onto the
  // site's error page. The refusal is kept for chapterUnavailable to say.
  for (const status of [404, 410]) {
    const { api, state } = fetching({ ok: false, status, text: async () => '' });
    assert.equal(await api.chapterImages('https://scan.test/c/5'), null);
    assert.deepEqual(state.unreachable, { url: 'https://scan.test/c/5', status });
  }
});

test('a 5xx is asked again once before the chapter is loaded the old way', async () => {
  // One request's bad luck (a busy server, Cloudflare's 52x) used to send the
  // reader out of the book for a full page load, exposed to the same luck.
  const answers = [{ ok: false, status: 503, text: async () => '' }, { ok: true, status: 200, text: async () => '<html></html>' }];
  let asked = 0;
  const state = { images: ['https://cdn.test/s/4/1.jpg'] };
  const api = lift('  async function chapterImages(url) {', '  /** How long a chapter gets the network to itself',
    ['chapterImages'], {
      state,
      send: async (msg) => (msg.type === 'compatHtml'
        ? { pages: ['https://cdn.test/s/5/1.jpg', 'https://cdn.test/s/5/2.jpg', 'https://cdn.test/s/5/3.jpg'] }
        : { pages: [] }),
      fetch: async () => answers[Math.min(asked++, answers.length - 1)],
      location: { href: 'https://scan.test/c/4', origin: 'https://scan.test' },
      console: { warn() {}, info() {} },
    });
  const got = await api.chapterImages('https://scan.test/c/5');
  assert.equal(asked, 2, 'asked twice');
  assert.equal(got.length, 3, 'and read from the second answer');
  assert.equal(state.unreachable, undefined, 'a second answer that came is not a refusal');
  // Twice busy is a refusal like the others.
  const busy = fetching({ ok: false, status: 503, text: async () => '' });
  assert.equal(await busy.api.chapterImages('https://scan.test/c/5'), null);
  assert.equal(busy.state.unreachable.status, 503);
});

test('RS-1: the next chapter is read as `pages`, held to the pages on screen', async () => {
  const { api, sent } = fetching({ ok: true, status: 200, text: async () => '<html></html>' });
  const got = await api.chapterImages('https://scan.test/c/5');
  assert.equal(got.length, 3);
  const asked = sent.find((m) => m.type === 'compatHtml');
  assert.deepEqual(asked.like, ['https://cdn.test/s/4/1.jpg'], 'blob addresses say nothing about a folder');
});

test('H25: a chapter the site refused keeps the reader where it is, with a word', () => {
  // The swap answers "handled" for it, so gotoChapter does not go and load the
  // dead page in its place; auto-scroll waiting at the bottom for it stops.
  const swap = rjs.slice(rjs.indexOf('  async function loadChapterInPlace(url) {'), rjs.indexOf('  async function gotoChapter(url) {'));
  assert.match(swap, /if \(state\.unreachable\?\.url === url\) \{\s*pauseAutoplayAtEnd\(\);\s*chapterUnavailable\(url\);\s*return true;\s*\}/);
  // And "not found" is said as such, not as a site that is down.
  const said = rjs.slice(rjs.indexOf('  function chapterUnavailable(url) {'), rjs.indexOf('  function neighboursIn(html, url) {'));
  assert.match(said, /status === 404 \|\| status === 410/);
  assert.match(said, /t\(missing \? 'readerChapterMissing' : 'readerChapterUnavailable'\)/);
});

// --- a next chapter on another site, in the phone app ----------------------------

/** gotoChapter with the in-place load failing, in a browser or in the app. */
function turning({ app, from = 'https://scans.test/manga/x/chapter-2/' }) {
  const asked = [];
  const here = new URL(from);
  const location = { href: from, host: here.host };
  const api = lift('  let changingChapter = false;', '  // --- what one series remembers for itself', ['gotoChapter'], {
    state: { playing: false, root: null },
    saveProgress: { flush() {} },
    loadChapterInPlace: async () => false,
    reachable: async () => true,
    lastHeadStatus: 0,
    pauseAutoplayAtEnd() {},
    chapterUnavailable() {},
    setTimeout: () => 0,
    chrome: { storage: { local: { set: (values, done) => done() } } },
    window: app ? { ReactNativeWebView: {} } : {},
    send: async (msg) => { asked.push(msg); return { ok: true }; },
    location,
  });
  return { api, asked, location };
}

test('in the app, a next chapter on another site is opened by the app, not by the page', async () => {
  // A page sending its window to another site is what the app's navigation
  // policy refuses as a hijack: a "next" on a mirror domain left the reader in
  // place. The app opens what it is asked to.
  const mirror = 'https://mirror.test/manga/x/chapter-3/';
  const app = turning({ app: true });
  await app.api.gotoChapter(mirror);
  assert.deepEqual(app.asked, [{ type: 'openUrl', url: mirror }]);
  assert.equal(app.location.href, 'https://scans.test/manga/x/chapter-2/', 'the page did not go itself');

  const sameSite = turning({ app: true });
  await sameSite.api.gotoChapter('https://scans.test/manga/x/chapter-3/');
  assert.deepEqual(sameSite.asked, []);
  assert.equal(sameSite.location.href, 'https://scans.test/manga/x/chapter-3/');

  const browser = turning({ app: false });
  await browser.api.gotoChapter(mirror);
  assert.deepEqual(browser.asked, [], 'a browser has no app to ask');
  assert.equal(browser.location.href, mirror);
});

test('auto-scroll moves the page, the counter and the bookmark along, about once a second', () => {
  // The scroll handler that keeps them waits for the scrolling to stop, which
  // auto-scroll never does: the counter stood still for a whole chapter, and
  // an app killed mid-chapter came back where auto-scroll had started.
  const r = autoplay();
  r.api.startAutoplay();
  // 100 px a second for 25 s: 2500 px, the third page of 1000 px.
  for (let t = 0; t <= 25000; t += 16) r.frame(t);
  assert.ok(r.stage.scrollTop > 2400, 'the strip moved');
  assert.equal(r.state.page, 2, 'the page under the top of the screen');
  assert.ok(r.calls.saved >= 23 && r.calls.saved <= 26, `saved ${r.calls.saved} times in 25 s`);
  assert.equal(r.calls.counted, r.calls.saved, 'the counter moves with it');
});

// --- pages given back when they leave (RENDER-2, QA P6) ----------------------

test('RENDER-2: the pages the reader drops have no source left to keep them alive', () => {
  // On the real Android WebView every chapter turned in place kept all of the
  // previous chapter's pages alive (an unfinished lazy load is a pending
  // activity the engine holds), forty listeners and half a megabyte a chapter.
  const { releasePages } = lift('  function releasePages(root) {', '  function render() {', ['releasePages'], {});
  const img = (src) => ({ src, gone: false, removeAttribute(name) { if (name === 'src') { this.gone = true; this.src = ''; } } });
  const pages = [img('c5/1.png'), img('c5/2.png')];
  releasePages({ querySelectorAll: (sel) => (sel === 'img' ? pages : []) });
  assert.ok(pages.every((p) => p.gone), 'a dropped page still has its source');
  assert.doesNotThrow(() => releasePages(null));
  // Every place that drops pages gives them back: the chapter swapped out
  // (render), the page turned in paged mode (showPage), the reader closed.
  const body = (from, to) => { const a = rjs.indexOf(from); return rjs.slice(a, rjs.indexOf(to, a)); };
  assert.match(body('  function render() {', 'resetTransform();'), /old\.replaceWith\(stage\);\s*releasePages\(old\);/);
  assert.match(body('  function showPage(n', 'wrap.appendChild'), /releasePages\(wrap\);\s*wrap\.replaceChildren\(\);/);
  assert.match(body('    state.root?.remove();', 'state.root = null;'), /releasePages\(state\.root\);/);
  // A name of its own: close() holds a local `release` of the detector's, and
  // a call to the helper by that name hit it before its declaration (E2E).
  assert.equal((rjs.match(/function releasePages\(/g) || []).length, 1);
});
