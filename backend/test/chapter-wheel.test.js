// The reader's chapter list.
//
// Sites do not publish one. What they put on a chapter page is a three-entry
// dropdown — previous, current, next — which is fine for turning a page and
// useless for going back to chapter 12 of 245. The rest of the list is worked
// out from the one chapter whose address is known, and the reader spins it like
// a wheel.
//
// What is tested here is the deriving, because that is where an off-by-one
// sends the reader to a chapter that does not exist: everything below the one
// on screen is safe (a site cannot publish 245 without having published 1 to
// 244), everything above it is a guess bounded by what the library knows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootWorker, entryFixture } from '../test-support/worker.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, ...p.split('/')), 'utf8');

// The rule, lifted out of the core and run on its own — the same run of source
// backend/test/continue-target.test.js lifts, and the same markers.
const src = read('shared/panelflow-core.js');
const a = src.indexOf('  const URL_NUM_RE');
const b = src.indexOf('  // Titles scraped from a chapter page');
assert.ok(a !== -1 && b > a, 'the chapter rules are not where this test expects them');
const { chapterRange } = new Function(`
  const labelNum = (label) => {
    const m = String(label ?? '').match(/(\\d+(?:\\.\\d+)?)/);
    return m ? parseFloat(m[1]) : NaN;
  };
  ${src.slice(a, b)}
  return { chapterRange };
`)();

const CHAP = 'https://asuracomic.net/series/villain-to-kill/chapter/245';
const at = (rows, n) => rows.find((r) => r.n === n);

test('the whole series comes back, newest first', () => {
  const rows = chapterRange(CHAP, 'Chapter 245', '246');
  assert.equal(rows.length, 246);
  assert.equal(rows[0].n, 246);
  assert.equal(rows[rows.length - 1].n, 1);
  assert.equal(at(rows, 12).url,
    'https://asuracomic.net/series/villain-to-kill/chapter/12');
  assert.equal(at(rows, 12).label, 'Ch. 12');
});

test('the chapter on screen keeps the address it was opened with', () => {
  // Derivation would rebuild the same URL here, but not on a site whose links
  // carry a trailing slash or a query the rule does not reproduce — and being
  // one character off is what makes the wheel look like it jumped.
  const rows = chapterRange(`${CHAP}/?style=list`, 'Chapter 245', '246');
  assert.equal(at(rows, 245).url, `${CHAP}/?style=list`);
});

test('nothing above the chapter you are on when the series is not tracked', () => {
  // No library entry, so no idea whether 246 exists. Offering it anyway is a
  // 404 with the reader's name on it.
  for (const latest of [null, undefined, '', 'unknown']) {
    const rows = chapterRange(CHAP, 'Chapter 245', latest);
    assert.equal(rows[0].n, 245, `latest=${latest}`);
  }
});

test('a library that is behind never shortens the list', () => {
  // lastKnownChapter is whatever the last check saw; the chapter actually open
  // is proof of a higher number, and it wins.
  const rows = chapterRange(CHAP, 'Chapter 245', '200');
  assert.equal(rows[0].n, 245);
});

test('a padded site stays padded all the way down', () => {
  // Padded to the width the site writes, not to the width of the number: a site
  // addressing 245 as "0245" addresses 9 as "0009", and "009" 404s.
  const rows = chapterRange('https://x.com/c/0245', 'Chapter 245', '245');
  assert.equal(at(rows, 9).url, 'https://x.com/c/0009');
  assert.equal(at(rows, 100).url, 'https://x.com/c/0100');
});

test('a half chapter takes its own row, in its own place', () => {
  const rows = chapterRange('https://x.com/c/245.5', 'Chapter 245.5', '246');
  const ns = rows.slice(0, 4).map((r) => r.n);
  assert.deepEqual(ns, [246, 245.5, 245, 244]);
  assert.equal(at(rows, 245.5).url, 'https://x.com/c/245.5');
  assert.equal(at(rows, 244).url, 'https://x.com/c/244');
});

test('a URL nothing can be derived from yields no list at all', () => {
  // MangaDex mints a uuid per chapter. A wheel of links that all 404 is worse
  // than the three the page linked itself.
  const rows = chapterRange(
    'https://mangadex.org/chapter/8b8c1e02-1f4a-4a1a-9f3e-0d0c1b2a3f44', 'Chapter 42', '43');
  assert.deepEqual(rows, []);
});

test('an unnumbered chapter is nothing to count from', () => {
  assert.deepEqual(chapterRange(CHAP, 'Prologue', '246'), []);
  assert.deepEqual(chapterRange(CHAP, '', '246'), []);
});

test('a very long series is capped rather than built whole', () => {
  const rows = chapterRange('https://x.com/c/5000', 'Chapter 5000', '5000');
  assert.equal(rows.length, 2000);
  assert.equal(rows[0].n, 5000);
  assert.equal(rows[rows.length - 1].n, 3001);
});

// --- through the worker -----------------------------------------------------

test('the worker answers with the range the library allows', async () => {
  const entry = entryFixture({
    sourceUrl: 'https://asuracomic.net/series/villain-to-kill',
    lastKnownChapter: '246',
  });
  const w = bootWorker({ storage: { library: [entry] } });
  const { chapters } = await w.send({
    type: 'chapterList',
    sourceUrl: entry.sourceUrl,
    chapterUrl: CHAP,
    chapterLabel: 'Chapter 245',
  });
  assert.equal(chapters[0].n, 246, 'the ceiling did not come from the library');
  assert.equal(chapters.length, 246);
});

test('a series nobody has saved still gets its back catalogue', async () => {
  const w = bootWorker({ storage: { library: [] } });
  const { chapters } = await w.send({
    type: 'chapterList', sourceUrl: 'https://asuracomic.net/series/villain-to-kill',
    chapterUrl: CHAP, chapterLabel: 'Chapter 245',
  });
  assert.equal(chapters[0].n, 245);
  assert.equal(chapters.length, 245);
});

// --- the reader -------------------------------------------------------------

// The merge decides which of two addresses for the same chapter the reader
// navigates to, so it is lifted out of the content script and run here.
const rjs = read('extension/content/reader.js');
const ra = rjs.indexOf('  function mergeChapters(');
const rb = rjs.indexOf('  /** Whether a row is the chapter on screen. */');
assert.ok(ra !== -1 && rb > ra, 'mergeChapters is not where this test expects it');
const { mergeChapters } = new Function(`
  const window = { PanelFlowMatch: {
    chapterNumber: (label) => {
      const m = /\\d+(?:\\.\\d+)?/.exec(String(label ?? ''));
      return m ? Number(m[0]) : null;
    },
  } };
  ${rjs.slice(ra, rb)}
  return { mergeChapters };
`)();

test("the site's own link wins over a derived one", () => {
  // Derivation is a very good guess; the link the site printed is the address.
  const rows = mergeChapters(
    [{ label: 'Chapter 245', url: 'https://x.com/read/vtk-245-eng' }],
    [{ n: 245, label: 'Ch. 245', url: 'https://x.com/c/245' },
      { n: 244, label: 'Ch. 244', url: 'https://x.com/c/244' }],
  );
  assert.equal(rows[0].url, 'https://x.com/read/vtk-245-eng');
  assert.equal(rows[0].label, 'Chapter 245');
  assert.equal(rows[1].url, 'https://x.com/c/244', 'the derived chapters did not come along');
});

test('the merged list is newest first whatever order the page used', () => {
  const rows = mergeChapters(
    [{ label: 'Ch. 1', url: 'u1' }, { label: 'Ch. 3', url: 'u3' }, { label: 'Ch. 2', url: 'u2' }],
    [],
  );
  assert.deepEqual(rows.map((r) => r.n), [3, 2, 1]);
});

test('a chapter with no number in its name is kept, at the end', () => {
  // "Prologue", "Extra", "Omake" — real chapters with nothing to sort them by.
  // Dropping them would lose a chapter; interleaving them would put them
  // somewhere arbitrary.
  const rows = mergeChapters(
    [{ label: 'Prologue', url: 'u0' }, { label: 'Ch. 2', url: 'u2' }],
    [{ n: 1, label: 'Ch. 1', url: 'c1' }],
  );
  assert.deepEqual(rows.map((r) => r.label), ['Ch. 2', 'Ch. 1', 'Prologue']);
});

test('the reader asks for the range instead of trusting the page', () => {
  const js = read('extension/content/reader.js');
  assert.match(js, /type: 'chapterList'/, 'the reader no longer asks for the full list');
  assert.doesNotMatch(js, /class="pf-chapters/,
    'the chapter <select> is back; three entries is not a wheel');
  // Up and down are the wheel's whole point, so they cannot fall through to the
  // page-turning keys underneath it.
  const key = js.slice(js.indexOf('function onKey('), js.indexOf('function updateCounter('));
  assert.match(key, /onWheelKey/, 'the wheel does not get first refusal on keys');
});

test('every row of the wheel is the same height as the CSS says', () => {
  // The scroll position is turned into an index by dividing by the row height,
  // which only holds while a row is exactly one --pf-row tall and snaps to the
  // centre. A padding or a border added here breaks the arithmetic silently.
  const css = read('extension/content/reader.css');
  const rule = css.slice(css.indexOf('.pf-wrow {'), css.indexOf('.pf-wrow {') + 400);
  assert.match(rule, /height: var\(--pf-row\)/);
  assert.match(rule, /box-sizing: border-box/);
  assert.match(rule, /scroll-snap-align: center/);
});

test('the row in the middle is the brightest one, read or not', () => {
  // Same specificity, so the cascade decides: .pf-read declared after .pf-on
  // leaves the centre of the wheel dimmed on every chapter already read, which
  // looks like the wheel is pointing somewhere else.
  const css = read('extension/content/reader.css');
  assert.ok(css.indexOf('.pf-wrow.pf-read') < css.indexOf('.pf-wrow.pf-on {'),
    '.pf-wrow.pf-on no longer wins over .pf-wrow.pf-read');
  assert.ok(css.indexOf('.pf-wrow.pf-here {') < css.indexOf('.pf-wrow.pf-on {'),
    '.pf-wrow.pf-on no longer wins over .pf-wrow.pf-here');
});
