// Shelves of the user's own.
//
// The whole design rests on one claim: a category is not a sixth reading status,
// it *stands for* one of the five. Everything that has to decide something about
// a series — is it watched for new chapters, what does it export to MyAnimeList
// as, which bar of the stats does it fall in — asks what the shelf counts as,
// never what it is called. If that claim ever stops holding, filing a series
// more carefully is how you make it disappear from the watcher, and nothing
// anywhere reports an error. So most of this file is that one claim, checked
// once per place that could break it.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { MAX_CATEGORIES } from '../src/routes/categories.js';
import { buildBackup, toMalXml, toCsv, restoreBackup } from '../src/routes/export.js';
import { runWatch } from '../src/routes/watch.js';

after(shutdown);

/** Makes a shelf and returns it. */
async function shelf(token, name, status = 'reading') {
  const r = await api('POST', '/api/categories', { name, status }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const folderOf = async (token, id) =>
  (await api('GET', '/api/library', undefined, token)).body.find((e) => e.id === id)?.folder;

// --- the shelf list ---------------------------------------------------------

test('a new account has no shelves, and the ones it makes are its own', async () => {
  const a = await newUser();
  const b = await newUser();
  assert.deepEqual((await api('GET', '/api/categories', undefined, a.token)).body, []);

  const weekly = await shelf(a.token, 'Weekly');
  assert.equal(weekly.name, 'Weekly');
  assert.equal(weekly.status, 'reading');

  assert.equal((await api('GET', '/api/categories', undefined, a.token)).body.length, 1);
  assert.deepEqual((await api('GET', '/api/categories', undefined, b.token)).body, []);

  // Somebody else's shelf is a well-formed folder value and still not one this
  // account may file into — the ownership check is the only thing between them.
  const entry = await addEntry(b.token);
  const r = await api('PUT', `/api/library/${entry.id}`, { folder: `cat:${weekly.id}` }, b.token);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /does not exist/);
});

test('two shelves cannot share a name, whatever the capitals', async () => {
  const u = await newUser();
  await shelf(u.token, 'Weekly');

  const clash = await api('POST', '/api/categories', { name: 'weekly' }, u.token);
  assert.equal(clash.status, 409);

  // Including by rename, which is the same collision arriving the other way.
  const other = await shelf(u.token, 'Monthly');
  const renamed = await api('PUT', `/api/categories/${other.id}`, { name: 'WEEKLY' }, u.token);
  assert.equal(renamed.status, 409);

  // Renaming a shelf to what it is already called is not a clash with itself.
  const same = await api('PUT', `/api/categories/${other.id}`, { name: 'Monthly ' }, u.token);
  assert.equal(same.status, 200);
  assert.equal(same.body.name, 'Monthly');
});

test('a shelf is named and stands for one of the five, and nothing else', async () => {
  const u = await newUser();
  assert.equal((await api('POST', '/api/categories', { name: '   ' }, u.token)).status, 400);
  assert.equal((await api('POST', '/api/categories', {}, u.token)).status, 400);
  assert.equal(
    (await api('POST', '/api/categories', { name: 'Weekly', status: 'cat:x' }, u.token)).status, 400);
  // A sixth status is exactly what a shelf is not.
  assert.equal(
    (await api('POST', '/api/categories', { name: 'Weekly', status: 'weekly' }, u.token)).status, 400);

  const long = await shelf(u.token, 'x'.repeat(200));
  assert.equal(long.name.length, 40);
});

test('the shelf list is capped', async () => {
  const u = await newUser();
  for (let i = 0; i < MAX_CATEGORIES; i++) await shelf(u.token, `Shelf ${i}`);
  const over = await api('POST', '/api/categories', { name: 'One too many' }, u.token);
  assert.equal(over.status, 400);
  assert.match(over.body.error, /at most/);
});

test('shelves are reordered by id, and only the caller\'s own move', async () => {
  const u = await newUser();
  const other = await newUser();
  const a = await shelf(u.token, 'A');
  const b = await shelf(u.token, 'B');
  const c = await shelf(u.token, 'C');
  const theirs = await shelf(other.token, 'Theirs');

  // "order" must not be read as an id — the route that would answer it is the
  // rename, and a reorder silently renaming a shelf is a lovely bug to find.
  const r = await api('PUT', '/api/categories/order',
    { ids: [c.id, theirs.id, a.id, b.id] }, u.token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x) => x.name), ['C', 'A', 'B']);
  assert.deepEqual((await api('GET', '/api/categories', undefined, other.token)).body
    .map((x) => x.name), ['Theirs']);
});

// --- what a shelf means -----------------------------------------------------

test('removing a shelf refiles its series and removes nothing', async () => {
  const u = await newUser();
  const paused = await shelf(u.token, 'Waiting for the volumes', 'paused');
  const entry = await addEntry(u.token, { folder: `cat:${paused.id}` });
  assert.equal(await folderOf(u.token, entry.id), `cat:${paused.id}`);

  assert.equal((await api('DELETE', `/api/categories/${paused.id}`, undefined, u.token)).status, 204);
  // Onto what it counted as all along, not onto the default.
  assert.equal(await folderOf(u.token, entry.id), 'paused');
  assert.deepEqual((await api('GET', '/api/categories', undefined, u.token)).body, []);
});

test('the watcher asks a shelf what it stands for', async () => {
  const u = await newUser();
  const weekly = await shelf(u.token, 'Weekly', 'reading');
  const finished = await shelf(u.token, 'Read it all', 'completed');

  const watched = await addEntry(u.token, {
    sourceUrl: 'https://cat-watch.test/manga/watched',
    sourceDomain: 'cat-watch.test',
    lastKnownChapter: '10',
    folder: `cat:${weekly.id}`,
  });
  const ignored = await addEntry(u.token, {
    sourceUrl: 'https://cat-watch.test/manga/ignored',
    sourceDomain: 'cat-watch.test',
    lastKnownChapter: '10',
    folder: `cat:${finished.id}`,
  });

  // Every account's library is one pool to the watcher, so what is checked here
  // is which of these two it reached — not how many series it looked at.
  const asked = [];
  await runWatch({
    pacingMs: 0,
    fetch: async (url) => {
      asked.push(url);
      return '<a href="/c/11">Chapter 11</a>';
    },
  });
  assert.ok(asked.includes(watched.sourceUrl), 'a shelf that stands for reading is watched');
  assert.ok(!asked.includes(ignored.sourceUrl), 'a shelf that stands for completed is not');

  const news = (await api('GET', '/api/news', undefined, u.token)).body;
  assert.deepEqual(news.map((n) => n.libraryId), [watched.id]);
  assert.ok(!news.some((n) => n.libraryId === ignored.id));
});

test('the stats fold shelves into the five they stand for', async () => {
  const u = await newUser();
  const weekly = await shelf(u.token, 'Weekly', 'reading');
  await addEntry(u.token, { folder: 'reading' });
  await addEntry(u.token, { folder: `cat:${weekly.id}` });
  await addEntry(u.token, { folder: 'dropped' });

  const { folders } = (await api('GET', '/api/history/stats', undefined, u.token)).body;
  assert.equal(folders.reading, 2, 'the shelf counts as reading, not as itself');
  assert.equal(folders.dropped, 1);
  assert.ok(!(`cat:${weekly.id}` in folders));
});

test('the exports resolve a shelf through its status', async () => {
  const u = await newUser();
  const weekly = await shelf(u.token, 'Weekly', 'paused');
  await addEntry(u.token, { title: 'Ao no Hako', folder: `cat:${weekly.id}` });

  const backup = await buildBackup(u.id);
  assert.deepEqual(backup.categories.map((c) => c.name), ['Weekly']);

  assert.match(toMalXml(backup), /<my_status>On-Hold<\/my_status>/);

  // Every cell is quoted, so unquoting is enough to read one back.
  const rows = toCsv(backup).trim().split('\r\n')
    .map((line) => line.split(',').map((c) => c.replace(/^﻿/, '').slice(1, -1)));
  const statusCol = rows[0].indexOf('Status');
  const shelfCol = rows[0].indexOf('Shelf');
  assert.ok(statusCol > -1 && shelfCol > -1, rows[0].join('|'));
  assert.equal(rows[1][statusCol], 'paused');
  assert.equal(rows[1][shelfCol], 'Weekly');
});

// --- the round trip ---------------------------------------------------------

test('a backup restores its shelves, by name, with new ids', async () => {
  const from = await newUser();
  const weekly = await shelf(from.token, 'Weekly', 'reading');
  const later = await shelf(from.token, 'Some day', 'plan');
  await addEntry(from.token, { title: 'On the shelf', folder: `cat:${weekly.id}` });
  await addEntry(from.token, { title: 'For later', folder: `cat:${later.id}` });
  await addEntry(from.token, { title: 'Plain', folder: 'dropped' });
  const backup = await buildBackup(from.id);

  // A fresh account: every shelf has to be recreated, and every entry remapped
  // onto the id it got here rather than the one in the file.
  const to = await newUser();
  const report = await restoreBackup(to.id, backup, { dryRun: false });
  assert.equal(report.categories, 2);

  const mine = (await api('GET', '/api/categories', undefined, to.token)).body;
  assert.deepEqual(mine.map((c) => c.name), ['Weekly', 'Some day']);
  assert.deepEqual(mine.map((c) => c.status), ['reading', 'plan']);
  assert.ok(mine.every((c) => c.id !== weekly.id && c.id !== later.id), 'ids are regenerated');

  const byId = Object.fromEntries(mine.map((c) => [c.name, c.id]));
  const library = (await api('GET', '/api/library', undefined, to.token)).body;
  const folder = (title) => library.find((e) => e.title === title).folder;
  assert.equal(folder('On the shelf'), `cat:${byId.Weekly}`);
  assert.equal(folder('For later'), `cat:${byId['Some day']}`);
  assert.equal(folder('Plain'), 'dropped');
});

test('restoring into an account that already has the shelf reuses it', async () => {
  const from = await newUser();
  const weekly = await shelf(from.token, 'Weekly', 'reading');
  await addEntry(from.token, { title: 'Blue Box', folder: `cat:${weekly.id}` });
  const backup = await buildBackup(from.id);

  const to = await newUser();
  const mine = await shelf(to.token, 'weekly', 'paused');   // same name, different case
  const report = await restoreBackup(to.id, backup, { dryRun: false });
  assert.equal(report.categories, 0, 'no second "Weekly"');

  const after = (await api('GET', '/api/categories', undefined, to.token)).body;
  assert.deepEqual(after.map((c) => c.name), ['weekly']);
  // The shelf that was already here keeps what the user set it to: a restore
  // fills in what is missing, it does not overwrite decisions.
  assert.equal(after[0].status, 'paused');

  const library = (await api('GET', '/api/library', undefined, to.token)).body;
  assert.equal(library.find((e) => e.title === 'Blue Box').folder, `cat:${mine.id}`);
});

test('a dry run reports the shelves it would make and makes none', async () => {
  const from = await newUser();
  const weekly = await shelf(from.token, 'Weekly');
  await addEntry(from.token, { title: 'Dry', folder: `cat:${weekly.id}` });
  const backup = await buildBackup(from.id);

  const to = await newUser();
  const report = await restoreBackup(to.id, backup, { dryRun: true });
  assert.equal(report.categories, 1);
  assert.deepEqual((await api('GET', '/api/categories', undefined, to.token)).body, []);
});
