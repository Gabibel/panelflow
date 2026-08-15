// Opening the reader by itself, and what happens when the page is not ready.
//
// Detection settles as soon as three panels have a measurable size, which on a
// paginated reader is well before those panels have a src worth reading. The
// auto-open then fired on empty hands: it removed the pill, called open() with
// a near-empty list, and left the page with no reader and no way to ask for one
// — observed on natomanga, where it lost the race every time.
//
// So openReader now reports whether it opened anything, and everything that
// takes the pill away waits for that answer. Both halves are lifted out of the
// shipping detect.js, which is a browser IIFE with no exports.
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
  // Every free name the slice needs arrives as a parameter, so the code runs
  // exactly as written with no copy of it kept here.
  return new Function(...params, `${src.slice(from, to)}\nreturn ${exported};`);
};

const buildOpenReader = lift(
  '  /** Opens the reader.', '  // --- scan orchestration',
  ['detection', 'rules', 'seriesMeta', 'stableImageSrc', 'window', 'panelsIn'], 'openReader');

const RULES = { heuristics: { minGalleryImages: 3 } };

/** A reader that records what it was asked to show. */
const spyReader = () => {
  const calls = [];
  return {
    calls,
    window: {
      PanelFlowReader: {
        open: (srcs) => calls.push({ kind: 'open', srcs }),
        openText: (paras) => calls.push({ kind: 'text', paras }),
      },
    },
  };
};

const gallery = (srcs) => ({
  gallery: { container: {}, images: srcs.map((s) => ({ src: s })) },
});

const openWith = (detection, reader) => buildOpenReader(
  detection, RULES, () => ({ title: 'X' }), (img) => img.src, reader.window,
  (g) => g.images)();

test('a full strip opens the reader and says so', async () => {
  const reader = spyReader();
  assert.equal(await openWith(gallery(['a.jpg', 'b.jpg', 'c.jpg']), reader), true);
  assert.equal(reader.calls.length, 1);
  assert.deepEqual(reader.calls[0].srcs, ['a.jpg', 'b.jpg', 'c.jpg']);
});

test('panels that have not loaded yet are not opened on', async () => {
  const reader = spyReader();
  // Three <img> elements, one src between them: this is the natomanga state,
  // and it is indistinguishable from a real strip until the srcs are resolved.
  assert.equal(await openWith(gallery(['a.jpg', '', '']), reader), false);
  assert.equal(reader.calls.length, 0, 'the reader must not open on one panel');
});

test('nothing to open reports failure rather than throwing', async () => {
  const reader = spyReader();
  assert.equal(await openWith(null, reader), false);
  assert.equal(await openWith({}, reader), false);
  assert.equal(reader.calls.length, 0);
});

test('a prose chapter opens without needing panels', async () => {
  const reader = spyReader();
  const ok = await openWith({ novel: { paragraphs: ['un', 'deux'] } }, reader);
  assert.equal(ok, true);
  assert.equal(reader.calls[0].kind, 'text');
});

// --- the retry -------------------------------------------------------------

const buildAutoOpen = lift(
  '  // Detection settles as soon as', '  // Lazy-loaded images and SPA navigations',
  ['detection', 'document', 'openReader', 'setTimeout', 'autoOpened', 'panelCount'],
  'autoOpenNow');

/** Runs autoOpenNow with time collapsed: every timer fires immediately. */
const runAutoOpen = (openReader, { counts = [], images = [] } = {}) => {
  const pill = { removed: false, remove() { this.removed = true; } };
  const document = { getElementById: () => pill };
  const waits = [];
  const now = (fn, ms) => { waits.push(ms); return Promise.resolve().then(fn); };
  // A strip that grows: each look at the page returns the next count, and the
  // last one repeats for as long as anyone keeps asking.
  const seen = [];
  const panelCount = () => {
    const n = counts.length ? counts[Math.min(seen.length, counts.length - 1)] : 0;
    seen.push(n);
    return n;
  };
  buildAutoOpen({ gallery: { images } }, document, openReader, now, false, panelCount)();
  return { pill, waits, seen };
};

test('auto-open comes back for panels that were not ready', async () => {
  let tries = 0;
  const openReader = async () => ++tries >= 3;
  const { pill, waits } = runAutoOpen(openReader);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tries, 3, 'it should have kept trying until the panels arrived');
  assert.equal(pill.removed, true, 'the pill goes once the reader is up');
  assert.ok(waits.every((ms) => ms >= 500), `waited ${waits} ms between tries`);
});

test('a page that never fills in keeps its pill, and stops trying', async () => {
  let tries = 0;
  const openReader = async () => { tries++; return false; };
  const { pill } = runAutoOpen(openReader);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(tries >= 2 && tries <= 10, `gave up after ${tries} tries`);
  // The whole point: no reader means the way in has to stay on screen.
  assert.equal(pill.removed, false, 'the pill was taken away for nothing');
});

test('the first try is enough when the page was ready', async () => {
  let tries = 0;
  const { pill, waits } = runAutoOpen(async () => { tries++; return true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tries, 1);
  assert.equal(waits.length, 0, 'a page that opened should not be waiting on anything');
  assert.equal(pill.removed, true);
});

// --- waiting for the strip to settle ---------------------------------------
//
// The retry above fixed "opens on nothing". This fixes "opens on some of it":
// natomanga had 25 panels and the reader took the 4 that had arrived, which is
// worse than the empty case because it looks like the whole chapter.

test('a strip that is still filling is not opened on', async () => {
  let tries = 0;
  const openReader = async () => { tries++; return true; };
  // Detection saw 3; the page then goes 4 → 12 → 25 and stays there.
  const { waits } = runAutoOpen(openReader, { counts: [4, 12, 25, 25], images: [0, 0, 0] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(waits.length, 3, 'it opened before the strip stopped growing');
  assert.equal(tries, 1, 'and it should only have opened once, at the end');
});

test('a chapter that was already whole opens immediately', async () => {
  const images = Array.from({ length: 20 }, (_, i) => i);
  let tries = 0;
  const { waits, pill } = runAutoOpen(async () => { tries++; return true; },
    { counts: [20, 20], images });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tries, 1);
  assert.equal(waits.length, 0, 'a settled page must not pay for the settle check');
  assert.equal(pill.removed, true);
});

test('a strip that never stops growing is read anyway', async () => {
  // Some sites append panels for as long as you keep scrolling. Waiting for
  // silence there means never opening, so the last try takes what it has.
  let tries = 0;
  const { waits, pill } = runAutoOpen(async () => { tries++; return true; },
    { counts: [5, 10, 15, 20, 25, 30], images: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tries, 1, 'the last try opens whatever the page is offering');
  assert.equal(waits.length, 5);
  assert.equal(pill.removed, true);
});
