// The updates feed: what is out that has not been read, and in what order.
//
// R3's whole risk is that this view grows its own idea of "new". The card, the
// phone and the server already have one — shared/library-view.js, taught by B3
// to ask shared/folders.js whether anybody is still following the series — and
// the bug B3 fixed was precisely a screen announcing a gap on a series filed
// under Completed, forever. A feed is that bug with a page of its own, so the
// first test here is that no second rule was written: the feed asks
// `PanelFlowView.newChapters()` and takes what it is given.
//
// The order is the other half. There is exactly one real date in this schema —
// `news.found_at`, written by the overnight watcher — and /api/meta/check
// deliberately does not touch `updated_at`, because checking must not reorder
// the library. So a feed that claimed to be chronological off `updatedAt` would
// be sorting by when somebody last edited the row. What the ordering actually
// promises, and what it falls back to when there is no date, is pinned below.
//
// The functions are lifted out of web/app.js rather than copied, as in
// page-turn.test.js: web/ is served straight to a browser and has no module
// system to import from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { t } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const app = read('web/app.js');
const html = read('web/index.html');
const css = read('web/styles.css');

// Folders before the view, for the reason read-state.test.js gives: the news
// rule asks PanelFlowFolders at call time.
await import(pathToFileURL(join(root, 'shared', 'folders.js')).href);
await import(pathToFileURL(join(root, 'shared', 'library-view.js')).href);
const { PanelFlowView, PanelFlowFolders } = globalThis;

const lift = (from, to, names, inject) => {
  const a = app.indexOf(from);
  const b = app.indexOf(to);
  assert.ok(a !== -1 && b > a, `${from} is not where this test expects it in web/app.js`);
  const keys = Object.keys(inject);
  return new Function(...keys, `${app.slice(a, b)}
    return { ${names.join(', ')} };`)(...keys.map((k) => inject[k]));
};

// A fixed "now", so "2 days ago" is a fact rather than a function of the clock
// the suite happens to run on.
const NOW = Date.parse('2026-08-21T12:00:00Z');

/**
 * The feed's three functions, wired to a library. Everything they read is a
 * module-level `let` in app.js and comes in here as an argument instead.
 */
function feedOn({ entries, progress = {}, cats = [], fresh = [], news = {}, now = NOW }) {
  const categories = cats;
  const { folderOf, statusOf } = lift(
    'const folderOf = (entry) => {',
    '// "Chapter 42", "ch-42.5"',
    ['folderOf', 'statusOf'],
    {
      categories,
      DEFAULT_FOLDER: PanelFlowFolders.DEFAULT_FOLDER,
      STATUSES: PanelFlowFolders.BUILTIN_IDS,
      folderFor: PanelFlowFolders.folderFor,
      folderStatus: PanelFlowFolders.folderStatus,
    },
  );
  return lift(
    'const watched = (entry) =>',
    'function renderUpdates() {',
    ['watched', 'updatesFeed', 'ago'],
    {
      library: entries,
      progressMap: progress,
      categories,
      freshIds: new Set(fresh),
      newsAt: news,
      statusOf,
      PanelFlowView,
      PanelFlowFolders,
      t,
      // Date.now is the only part of the clock these functions use; parse is
      // the real one, because reading the stamp is what is being tested.
      Date: { now: () => now, parse: Date.parse },
    },
  );
}

const series = (id, title, latest, folder = 'reading') => ({
  id, title, folder, lastKnownChapter: latest,
  sourceUrl: `https://scan.test/${id}`, sourceDomain: 'scan.test',
});
const at = (label) => ({ chapterUrl: `https://scan.test/ch/${label}`, chapterLabel: label });

/** Four series, one behind by 3, one by 1, one by 5, one by 2. */
const LIB = {
  entries: [
    series('a', 'Ashes', 'Chapter 40'),
    series('b', 'Bluebox', 'Chapter 11'),
    series('c', 'Cendres', 'Chapter 55'),
    series('d', 'Dandadan', 'Chapter 22'),
  ],
  progress: {
    a: at('Chapter 37'), b: at('Chapter 10'), c: at('Chapter 50'), d: at('Chapter 20'),
  },
};

const titles = (rows) => rows.map((r) => r.entry.title);

test('a series nobody is following any more never enters the feed', () => {
  // The B3 bug, given a page of its own: a series filed under Completed keeps
  // whatever gap the last check left it with, forever. Thirteen chapters behind
  // and not one of them is news.
  const entries = [
    series('a', 'Ashes', 'Chapter 40'),
    series('z', 'Zenith', 'Chapter 90', 'completed'),
    series('y', 'Yesterday', 'Chapter 90', 'dropped'),
  ];
  const progress = { a: at('Chapter 37'), z: at('Chapter 77'), y: at('Chapter 77') };
  const { updatesFeed } = feedOn({ entries, progress });
  assert.deepEqual(titles(updatesFeed()), ['Ashes']);
});

test('a shelf of the reader\'s own is judged by the status it stands for', () => {
  // A custom shelf that means "completed" is completed, whatever it is called —
  // the same answer the chip on the cover gives, from the same place.
  const cats = [{ id: 'k', name: 'Keepers', status: 'completed' }];
  const folder = PanelFlowFolders.folderFor(cats[0]);
  const entries = [series('a', 'Ashes', 'Chapter 40', folder)];
  const { updatesFeed, watched } = feedOn({ entries, progress: { a: at('Chapter 37') }, cats });
  assert.equal(watched(entries[0]), false);
  assert.deepEqual(updatesFeed(), []);

  // And the same shelf standing for "reading" is followed.
  const reading = [{ id: 'k', name: 'Keepers', status: 'reading' }];
  const on = feedOn({
    entries: [series('a', 'Ashes', 'Chapter 40', PanelFlowFolders.folderFor(reading[0]))],
    progress: { a: at('Chapter 37') },
    cats: reading,
  });
  assert.deepEqual(titles(on.updatesFeed()), ['Ashes']);
});

test('being caught up is not news, and neither is a series never opened', () => {
  const entries = [
    series('a', 'Ashes', 'Chapter 40'),
    series('b', 'Bluebox', 'Chapter 11'),
  ];
  // Read up to the latest, and no bookmark at all: the second is the trap —
  // chaptersBehind is null there, and null taken for a number would put every
  // series nobody has started into a feed about chapters nobody has read.
  const { updatesFeed } = feedOn({ entries, progress: { a: at('Chapter 40') } });
  assert.deepEqual(updatesFeed(), []);
});

test('a dated feed runs newest first', () => {
  const { updatesFeed } = feedOn({
    ...LIB,
    news: {
      a: '2026-08-19 08:00:00',
      b: '2026-08-21 09:30:00',
      c: '2026-08-20 22:00:00',
      d: '2026-08-21 11:00:00',
    },
  });
  assert.deepEqual(titles(updatesFeed()), ['Dandadan', 'Bluebox', 'Cendres', 'Ashes']);
});

test('what the watcher dated comes before what it never saw', () => {
  // Two of them have a real timestamp and two do not. A row with no date is not
  // "the beginning of time" — sorting it as one would bury the biggest backlogs
  // under whatever the watcher happened to catch last night.
  const { updatesFeed } = feedOn({
    ...LIB,
    news: { a: '2026-08-19 08:00:00', b: '2026-08-21 09:30:00' },
  });
  // Dated, newest first; then the undated by how far behind — Cendres is 5,
  // Dandadan is 2.
  assert.deepEqual(titles(updatesFeed()), ['Bluebox', 'Ashes', 'Cendres', 'Dandadan']);
});

test('with nothing to date and nothing to separate them, the order is the alphabet', () => {
  // Not the order the library came back in: that is `updated_at DESC`, which is
  // when the row was last edited, and importing forty series in one go makes
  // that the order of the import file.
  const entries = [
    series('d', 'Dandadan', 'Chapter 22'),
    series('a', 'Ashes', 'Chapter 22'),
    series('c', 'Cendres', 'Chapter 22'),
  ];
  const progress = { a: at('Chapter 20'), c: at('Chapter 20'), d: at('Chapter 20') };
  const { updatesFeed } = feedOn({ entries, progress });
  assert.deepEqual(titles(updatesFeed()), ['Ashes', 'Cendres', 'Dandadan']);
});

test('the count is the news count, and it is what the card shows', () => {
  const { updatesFeed } = feedOn(LIB);
  const rows = Object.fromEntries(updatesFeed().map((r) => [r.entry.title, r.count]));
  assert.deepEqual(rows, { Ashes: 3, Bluebox: 1, Cendres: 5, Dandadan: 2 });
});

test('a chapter the check found but could not number is still in the feed', () => {
  // Sites that label chapters "Nouveau chapitre" give nothing to subtract, so
  // newChapters is 0 and the arithmetic has no opinion. Dropping those would
  // mean a check reporting "2 series have new chapters" above a list of one.
  const entries = [
    series('a', 'Ashes', 'Nouveau chapitre'),
    series('b', 'Bluebox', 'Chapter 11'),
  ];
  const progress = { a: at('Chapitre précédent'), b: at('Chapter 10') };
  const { updatesFeed } = feedOn({ entries, progress, fresh: ['a'] });
  const rows = updatesFeed();
  assert.deepEqual(titles(rows).sort(), ['Ashes', 'Bluebox']);
  assert.equal(rows.find((r) => r.entry.title === 'Ashes').count, 0);
  assert.equal(rows.find((r) => r.entry.title === 'Ashes').fresh, true);
});

test('a check cannot drag a series nobody follows back into the feed', () => {
  // freshIds comes off /api/meta/check, which sweeps the whole library. The
  // folder gate is asked first, so a completed series the check happened to
  // find a chapter for still does not reappear.
  const entries = [series('z', 'Zenith', 'Nouveau chapitre', 'completed')];
  const { updatesFeed } = feedOn({ entries, progress: { z: at('Chapter 77') }, fresh: ['z'] });
  assert.deepEqual(updatesFeed(), []);
});

test('the watcher stamp is read as UTC, not as whatever this machine is', () => {
  const { ago } = feedOn(LIB);
  // SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" with no zone on it.
  // Parsed as local time, every chapter found this morning reads as hours out —
  // and east of Greenwich, as being found in the future.
  // The short forms, and the same ones the popup uses: this page used to carry
  // a second relative-time function of its own with fuller sentences, so the
  // same distance in time was spelt two ways on two halves of it — and only one
  // of the two would ever have been translated.
  assert.equal(ago('2026-08-21 11:59:30'), 'now');
  assert.equal(ago('2026-08-21 11:20:00'), '40m ago');
  assert.equal(ago('2026-08-21 09:00:00'), '3h ago');
  assert.equal(ago('2026-08-20 12:00:00'), '1d ago');
  assert.equal(ago('2026-08-18 12:00:00'), '3d ago');
  assert.equal(ago('2026-07-24 12:00:00'), '4w ago');
  // The ISO form the API could start sending instead is understood too.
  assert.equal(ago('2026-08-21T09:00:00Z'), '3h ago');
  // And nothing is invented for a row that has no date.
  assert.equal(ago(null), null);
  assert.equal(ago('not a date'), null);
});

/* ---------- What the source has to keep saying ---------- */

test('the feed asks the shared rule instead of working it out again', () => {
  assert.match(app, /PanelFlowView\.newChapters\(entry, prog, categories\)/,
    'the feed derives its own idea of what is new');
  // The folder question is asked of shared/folders.js, from the same list the
  // server watches on — not from a list of statuses written out here.
  assert.match(app, /PanelFlowFolders\.WATCHED\.includes\(statusOf\(entry\)\)/,
    'the feed keeps its own list of which folders are followed');
  assert.doesNotMatch(app.slice(app.indexOf('const watched = (entry) =>'), app.indexOf('function renderUpdates() {')),
    /'completed'|'dropped'|'reading'|'paused'/,
    'a folder is named by hand in the feed, which is a second copy of the rule');
});

test('a line of the feed opens the chapter, not the series page', () => {
  const body = app.slice(app.indexOf('function renderUpdates()'), app.indexOf('/* ---------- Tabs, search'));
  assert.match(body, /const target = continueTarget\(entry, prog\)/,
    'the feed links somewhere of its own devising');
  assert.match(body, /a\.href = target\.url \|\| entry\.sourceUrl/,
    'the series page is the link rather than the fallback');
});

test('opening the app does not silence a notification the phone never showed', () => {
  // /api/news is read with ?all=1 and never drained: `seen` belongs to the
  // notification, and the extension's core is what marks it.
  assert.match(app, /api\('\/news\?all=1'\)/, 'the feed has stopped reading the news table');
  assert.doesNotMatch(app, /news\/seen/, 'the web app marks news seen, which is the core\'s job');
  // And a news request that fails takes the feed's dates with it, not the shelf.
  assert.match(app, /api\('\/news\?all=1'\)\.catch\(\(\) => \[\]\)/,
    'a failed news request now takes the library down with it');
});

test('the app opens on the feed, but only when there is something in it', () => {
  assert.match(app, /if \(!sent && updatesFeed\(\)\.length > 0\) showView\('updates'\)/,
    'the landing rule has changed shape; an empty feed as a front page is worse than the shelf');
  assert.match(app, /const VIEWS = \[[^\]]*'updates'/, 'updates is not a view');
});

test('the check moved to the view it fills', () => {
  const toolbar = html.match(/<div class="library-actions">[\s\S]*?<\/div>/)[0];
  assert.ok(!toolbar.includes('check-updates'),
    'the check is back in the library toolbar, five along a row, above the wrong list');
  const updates = html.match(/<div id="updates-view"[\s\S]*?\n      <\/div>/)[0];
  assert.ok(updates.includes('id="check-updates"') && updates.includes('id="check-status"'),
    'the check and what it reports are not in the updates view');
  assert.ok(updates.includes('id="updates-list"') && updates.includes('id="updates-empty"'));
  assert.match(html, /<div id="updates-view" hidden>/, 'the view is on screen before it is chosen');
  assert.match(html, /data-view="updates"/, 'there is no tab to reach the feed by');
});

test('the feed is drawn with a rule, like every other list in R2', () => {
  const row = css.match(/\.feed-row \{([^}]*)\}/);
  assert.ok(row, 'no rule for .feed-row');
  assert.match(row[1], /border:\s*1px solid var\(--line\)/,
    'the feed row is filled rather than drawn, which is not the visual idea of R2');
  // A long title has to give way to the date, not push it off the row.
  assert.match(css, /\.feed-row \.meta \{[^}]*min-width: 0/);
  // And both lines clip rather than wrap, so every row is the same height —
  // a column of rows that are not is a column you cannot run your eye down.
  assert.match(css, /\.feed-row \.title, \.feed-row \.sub \{[^}]*white-space: nowrap/,
    'a line of the row wraps, so one long title makes its row taller than the rest');
  // No colour written here: the palette lives in shared/theme.css and
  // theme.test.js fails on a hex code in this file.
  assert.doesNotMatch(css.slice(css.indexOf('.feed {'), css.indexOf('/* ---------- Tabs')), /#[0-9a-f]{3,8}\b/i);
});
