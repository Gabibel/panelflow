// One shelf, ordered and narrowed the same way everywhere.
//
// shared/library-view.js is a plain browser script, so there is nothing to
// import here in the usual sense: it hangs `PanelFlowView` off the global and
// this file picks it up from there — the same object the popup and the web app
// see. The last two tests check both clients actually call it, because the way
// this rule dies is not a wrong comparison, it is somebody quietly writing
// `.sort((a, b) => …)` inline again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

await import(pathToFileURL(join(root, 'shared', 'library-view.js')).href);
const { SORTS, SORT_IDS, sortLibrary, filterLibrary, tagCounts, chaptersBehind } =
  globalThis.PanelFlowView;

const entry = (over = {}) => ({
  id: over.title || 'x',
  title: 'A',
  folder: 'reading',
  tags: [],
  sourceDomain: 'a.test',
  updatedAt: '2026-01-01T00:00:00Z',
  dateAdded: '2026-01-01T00:00:00Z',
  ...over,
});

const titles = (list) => list.map((e) => e.title);

// --- the orders -------------------------------------------------------------

test('the default order is the one the shelf used to have', () => {
  const shelf = [
    entry({ title: 'old', updatedAt: '2026-01-01' }),
    entry({ title: 'new', updatedAt: '2026-06-01' }),
    entry({ title: 'mid', updatedAt: '2026-03-01' }),
  ];
  assert.deepEqual(titles(sortLibrary(shelf)), ['new', 'mid', 'old']);
});

test('sorting does not disturb the array it was given', () => {
  const shelf = [entry({ title: 'b' }), entry({ title: 'a' })];
  sortLibrary(shelf, { by: 'title' });
  assert.deepEqual(titles(shelf), ['b', 'a']);
});

test('chapters sort as numbers, not as text', () => {
  // "9" > "10" as strings, which is how a shelf sorted by chapter puts the
  // series with 300 chapters below the one with 9.
  const shelf = [
    entry({ title: 'nine', lastKnownChapter: 'Chapter 9' }),
    entry({ title: 'many', lastKnownChapter: 'Chapter 300' }),
    entry({ title: 'ten', lastKnownChapter: '10' }),
  ];
  assert.deepEqual(titles(sortLibrary(shelf, { by: 'chapter' })), ['many', 'ten', 'nine']);
});

test('titles sort ignoring case, and reverse on demand', () => {
  const shelf = [entry({ title: 'banana' }), entry({ title: 'Apple' }), entry({ title: 'cherry' })];
  assert.deepEqual(titles(sortLibrary(shelf, { by: 'title' })), ['Apple', 'banana', 'cherry']);
  assert.deepEqual(titles(sortLibrary(shelf, { by: 'title', dir: 'desc' })),
    ['cherry', 'banana', 'Apple']);
});

test('every order has a direction of its own, and it is the useful one', () => {
  // Nobody opens a library to see their worst-scored series first.
  for (const s of SORTS) assert.ok(s.dir === 'asc' || s.dir === 'desc', s.id);
  const shelf = [entry({ title: 'low', score: 2 }), entry({ title: 'high', score: 9 })];
  assert.deepEqual(titles(sortLibrary(shelf, { by: 'score' })), ['high', 'low']);
});

test('what has no value at all goes last, whichever way the order runs', () => {
  const shelf = [
    entry({ title: 'unrated' }),
    entry({ title: 'good', score: 8 }),
    entry({ title: 'bad', score: 3 }),
  ];
  assert.deepEqual(titles(sortLibrary(shelf, { by: 'score' })), ['good', 'bad', 'unrated']);
  assert.deepEqual(titles(sortLibrary(shelf, { by: 'score', dir: 'asc' })),
    ['bad', 'good', 'unrated'], 'the unrated series was treated as a zero');
});

test('ties break on the title rather than on the order rows arrived in', () => {
  const shelf = [
    entry({ title: 'zeta', sourceDomain: 'b.test' }),
    entry({ title: 'alpha', sourceDomain: 'b.test' }),
  ];
  assert.deepEqual(titles(sortLibrary(shelf, { by: 'site' })), ['alpha', 'zeta']);
});

test('"chapters behind" is measured against this reader, not the site', () => {
  const progress = {
    behind: { chapterLabel: 'Chapter 100' },
    caught: { chapterLabel: 'Chapter 40' },
  };
  const shelf = [
    entry({ title: 'caught', lastKnownChapter: '40' }),
    entry({ title: 'behind', lastKnownChapter: '150' }),
    entry({ title: 'unread', lastKnownChapter: '12' }),  // never opened
  ];
  const out = sortLibrary(shelf, { by: 'behind', progressOf: (e) => progress[e.title] });
  assert.deepEqual(titles(out), ['behind', 'caught', 'unread']);
  assert.equal(chaptersBehind(shelf[1], progress.behind), 50);
  // A bookmark past the latest chapter the site advertises is not "-2 behind".
  assert.equal(chaptersBehind({ lastKnownChapter: '98' }, { chapterLabel: 'Ch. 100' }), 0);
});

test('an unknown order falls back instead of leaving the shelf unsorted', () => {
  const shelf = [
    entry({ title: 'old', updatedAt: '2026-01-01' }),
    entry({ title: 'new', updatedAt: '2026-06-01' }),
  ];
  assert.deepEqual(titles(sortLibrary(shelf, { by: 'whatever-was-in-storage' })), ['new', 'old']);
  assert.deepEqual(sortLibrary(undefined), []);
});

// --- the filters ------------------------------------------------------------

test('the search box looks at the site as well as the title', () => {
  const shelf = [
    entry({ title: 'Ao no Hako', sourceDomain: 'old-scan.test' }),
    entry({ title: 'Berserk', sourceDomain: 'mangadex.org' }),
  ];
  assert.deepEqual(titles(filterLibrary(shelf, { query: 'hako' })), ['Ao no Hako']);
  assert.deepEqual(titles(filterLibrary(shelf, { query: 'MANGADEX' })), ['Berserk']);
  assert.equal(filterLibrary(shelf, { query: '   ' }).length, 2, 'a blank search hid everything');
});

test('a tag filter matches however the tag was capitalised', () => {
  const shelf = [
    entry({ title: 'a', tags: ['Shonen', 'Action'] }),
    entry({ title: 'b', tags: ['shonen'] }),
    entry({ title: 'c', tags: ['seinen'] }),
  ];
  assert.deepEqual(titles(filterLibrary(shelf, { tags: ['shonen'] })), ['a', 'b']);
  // Two tags is a narrower question, not a wider one.
  assert.deepEqual(titles(filterLibrary(shelf, { tags: ['shonen', 'action'] })), ['a']);
});

test('the folder filter can be told how to read a folder it does not know', () => {
  const shelf = [
    entry({ title: 'reading' }),
    entry({ title: 'paused', folder: 'paused' }),
    entry({ title: 'weird', folder: 'a-folder-from-the-future' }),
  ];
  assert.deepEqual(titles(filterLibrary(shelf, { folder: 'paused' })), ['paused']);
  assert.equal(filterLibrary(shelf, { folder: 'all' }).length, 3);
  // What the web app does: anything unrecognised reads as "reading", so a row
  // cannot fall through every tab and become invisible.
  const statusOf = (e) => (['reading', 'paused'].includes(e.folder) ? e.folder : 'reading');
  assert.deepEqual(titles(filterLibrary(shelf, { folder: 'reading', folderOf: statusOf })),
    ['reading', 'weird']);
});

test('"unread only" keeps what is out and not read, and nothing else', () => {
  const progress = { behind: { chapterLabel: '10' }, caught: { chapterLabel: '40' } };
  const shelf = [
    entry({ title: 'behind', lastKnownChapter: '12' }),
    entry({ title: 'caught', lastKnownChapter: '40' }),
    entry({ title: 'never-opened', lastKnownChapter: '5' }),
  ];
  assert.deepEqual(
    titles(filterLibrary(shelf, { unreadOnly: true, progressOf: (e) => progress[e.title] })),
    ['behind'],
  );
});

test('the filters combine', () => {
  const shelf = [
    entry({ title: 'keep', folder: 'paused', tags: ['shonen'] }),
    entry({ title: 'wrong folder', tags: ['shonen'] }),
    entry({ title: 'wrong tag', folder: 'paused', tags: ['seinen'] }),
    entry({ title: 'keep too', folder: 'paused', tags: ['shonen', 'action'] }),
  ];
  assert.deepEqual(titles(filterLibrary(shelf, { folder: 'paused', tags: ['shonen'], query: 'keep' })),
    ['keep', 'keep too']);
});

test('the tag list comes from the shelf, commonest first, spelt as it was typed', () => {
  const shelf = [
    entry({ title: 'a', tags: ['Shonen', 'action'] }),
    entry({ title: 'b', tags: ['shonen'] }),
    entry({ title: 'c', tags: ['  ', null] }),   // an editor that lets a blank through
  ];
  assert.deepEqual(tagCounts(shelf), [{ tag: 'Shonen', count: 2 }, { tag: 'action', count: 1 }]);
});

// --- both clients actually use it -------------------------------------------

test('the popup and the web app order their shelf with this rule and no other', () => {
  for (const [html, script, src] of [
    ['extension/popup/popup.html', 'extension/popup/popup.js', '../shared/library-view.js'],
    ['web/index.html', 'web/app.js', 'shared/library-view.js'],
  ]) {
    assert.match(read(html), new RegExp(`<script src="${src.replace(/[./]/g, '\\$&')}"`),
      `${html} does not load the shared view rule`);
    const js = read(script);
    assert.match(js, /PanelFlowView\.sortLibrary\(/, `${script} does not sort with it`);
    assert.match(js, /PanelFlowView\.filterLibrary\(/, `${script} does not filter with it`);
    // The shelf is the only list these files build from `library`; a `.sort(` on
    // it again means a second, divergent order has appeared.
    assert.doesNotMatch(js, /library\s*\n?\s*\.sort\(/, `${script} sorts the library itself`);
  }
});

test('every order offered can be chosen from either client', () => {
  // Both build their menu from SORTS, so this really only guards the storage
  // side: a saved sort id has to survive the round trip through the <select>.
  assert.deepEqual(SORT_IDS, SORTS.map((s) => s.id));
  for (const js of [read('extension/popup/popup.js'), read('web/app.js')]) {
    assert.match(js, /PanelFlowView\.SORTS/, 'the menu is hand-written instead of built from SORTS');
    assert.match(js, /SORT_IDS\.includes/,
      'a sort id read back from storage is used without checking it still exists');
  }
});
