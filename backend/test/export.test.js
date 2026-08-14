// Getting the library back out, and back in.
//
// A backup is only worth anything if it restores, so the test that matters most
// here is the round trip: export an account, wipe it, restore the file, and
// find the same shelf, the same bookmarks and the same reading history. The
// MyAnimeList export is round-tripped too, through the very reader the import
// side uses — the two halves of that format live in different files and would
// otherwise be free to drift apart.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, base, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { buildBackup, toMalXml, toCsv, restoreBackup } from '../src/routes/export.js';
import { fromMalXml } from '../src/routes/import.js';

after(shutdown);

/** A user with one fully filled-in series, a bookmark and a day of history. */
async function seeded(over = {}) {
  const u = await newUser();
  const entry = await addEntry(u.token, {
    title: 'Ao no Hako',
    sourceUrl: 'https://old-scan.test/manga/ao-no-hako',
    sourceDomain: 'old-scan.test',
    tags: ['romance', 'sport'],
    lastKnownChapter: '109',
    folder: 'reading',
    score: 9,
    note: 'la meilleure, avec une virgule',
    language: 'fr',
    startDate: '2024-01-05',
    rereads: 2,
    ...over,
  });
  await api('PUT', `/api/progress/${entry.id}`, {
    chapterUrl: 'https://old-scan.test/manga/ao-no-hako/chapitre-104',
    chapterLabel: 'Chapitre 104',
    page: 7,
    pageCount: 22,
    scrollPos: 0.5,
  }, u.token);
  await api('POST', '/api/history', {
    libraryId: entry.id,
    chapterUrl: 'https://old-scan.test/manga/ao-no-hako/chapitre-104',
    chapterLabel: 'Chapitre 104',
    pages: 22,
    seconds: 300,
  }, u.token);
  return { ...u, entry };
}

const download = (path, token) =>
  fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

// --- the JSON backup --------------------------------------------------------

test('the backup carries the shelf, the bookmark and the history together', async () => {
  const u = await seeded();
  const backup = await buildBackup(u.id);

  assert.equal(backup.app, 'panelflow');
  assert.equal(backup.library.length, 1);
  const e = backup.library[0];
  assert.equal(e.title, 'Ao no Hako');
  assert.deepEqual(e.tags, ['romance', 'sport']);
  assert.equal(e.score, 9);
  assert.equal(e.rereads, 2);
  assert.equal(e.startDate, '2024-01-05');
  // Nested under the series rather than in a parallel array: the ids that would
  // join them mean nothing outside the database they came from.
  assert.equal(e.progress.chapterLabel, 'Chapitre 104');
  assert.equal(e.progress.page, 7);
  assert.equal(e.history.length, 1);
  assert.equal(e.history[0].seconds, 300);
});

test('a removed series stays removed', async () => {
  // A restore that resurrects everything the user ever deleted is a punishment,
  // not a recovery.
  const u = await seeded();
  await api('DELETE', `/api/library/${u.entry.id}`, undefined, u.token);
  assert.deepEqual((await buildBackup(u.id)).library, []);
});

test('the download arrives as a file with the date in its name', async () => {
  const u = await seeded();
  const res = await download('/api/export', u.token);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.match(res.headers.get('content-disposition'),
    /attachment; filename="panelflow-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal((await res.json()).library.length, 1);
});

test('an export belongs to whoever asked for it', async () => {
  const a = await seeded();
  const b = await newUser();
  assert.deepEqual((await (await download('/api/export', b.token)).json()).library, []);
  assert.equal((await fetch(base + '/api/export')).status, 401);
  assert.ok(a.entry);
});

// --- the round trip ---------------------------------------------------------

test('a backup restored into an empty account rebuilds it', async () => {
  const source = await seeded();
  const file = await buildBackup(source.id);

  const target = await newUser();
  const report = await restoreBackup(target.id, file, { dryRun: false });
  assert.equal(report.added, 1);
  assert.equal(report.bookmarks, 1);
  assert.equal(report.reads, 1);

  const back = await buildBackup(target.id);
  const [a] = file.library;
  const [b] = back.library;
  for (const key of ['title', 'sourceUrl', 'folder', 'score', 'note', 'language',
    'startDate', 'rereads', 'lastKnownChapter', 'dateAdded']) {
    assert.deepEqual(b[key], a[key], `${key} did not survive the round trip`);
  }
  assert.deepEqual(b.tags, a.tags);
  assert.equal(b.progress.chapterUrl, a.progress.chapterUrl);
  assert.equal(b.progress.page, 7);
  assert.deepEqual(b.history, a.history);
});

test('a preview writes nothing', async () => {
  const source = await seeded();
  const file = await buildBackup(source.id);
  const target = await newUser();

  const dry = await restoreBackup(target.id, file, { dryRun: true });
  assert.equal(dry.added, 1);
  assert.equal(dry.dryRun, true);
  assert.deepEqual((await buildBackup(target.id)).library, []);
});

test('restoring the same file twice does not double the reading time', async () => {
  // History is merged on the larger value, not added: otherwise a nervous user
  // restoring a backup twice ends up with a reading record nobody achieved.
  const source = await seeded();
  const file = await buildBackup(source.id);
  const target = await newUser();
  await restoreBackup(target.id, file, { dryRun: false });
  await restoreBackup(target.id, file, { dryRun: false });

  const back = await buildBackup(target.id);
  assert.equal(back.library.length, 1);
  assert.equal(back.library[0].history.length, 1);
  assert.equal(back.library[0].history[0].seconds, 300);
});

test('a restore never overwrites where the reader has since got to', async () => {
  const source = await seeded();
  const file = await buildBackup(source.id);

  const target = await newUser();
  const mine = await addEntry(target.token, {
    title: 'Ao no Hako',
    sourceUrl: 'https://old-scan.test/manga/ao-no-hako',
    sourceDomain: 'old-scan.test',
  });
  await api('PUT', `/api/progress/${mine.id}`, {
    chapterUrl: 'https://old-scan.test/manga/ao-no-hako/chapitre-140',
    chapterLabel: 'Chapitre 140',
    page: 1,
  }, target.token);

  await restoreBackup(target.id, file, { dryRun: false });
  const back = await buildBackup(target.id);
  assert.equal(back.library[0].progress.chapterLabel, 'Chapitre 140',
    'the backup pushed the reader back 36 chapters');
  // The holes it can fill, it does.
  assert.equal(back.library[0].score, 9);
});

test('a file that is not one of ours is refused, and so is one from the future', async () => {
  const u = await newUser();
  for (const junk of [null, {}, { app: 'other', library: [] }, { app: 'panelflow' }]) {
    await assert.rejects(() => restoreBackup(u.id, junk, {}), /does not look like/);
  }
  await assert.rejects(
    () => restoreBackup(u.id, { app: 'panelflow', version: 99, library: [] }, {}),
    /newer PanelFlow/,
  );
});

test('the restore is reachable over HTTP with a body no other route would accept', async () => {
  const source = await seeded();
  const file = await buildBackup(source.id);
  const target = await newUser();

  const res = await fetch(`${base}/api/import/panelflow?dryRun=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
    body: JSON.stringify(file),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'panelflow');
  assert.equal(body.added, 1);

  assert.equal((await fetch(`${base}/api/import/panelflow`, { method: 'POST' })).status, 401);
});

// --- the ways out -----------------------------------------------------------

test('the MyAnimeList export reads back through our own MAL reader', async () => {
  // The writer is in export.js and the reader is in import.js. Nothing but this
  // stops them drifting apart, and the symptom would be a file MAL rejects.
  const u = await seeded({ folder: 'paused', finishDate: null });
  const xml = toMalXml(await buildBackup(u.id));

  const [back] = fromMalXml(xml);
  assert.equal(back.title, 'Ao no Hako');
  assert.equal(back.folder, 'paused');
  assert.equal(back.score, 9);
  assert.equal(back.rereads, 2);
  assert.equal(back.startDate, '2024-01-05');
  assert.equal(back.finishDate, null, '0000-00-00 came back as a date');
  assert.equal(back.note, 'la meilleure, avec une virgule');
  // The bookmark, not the latest chapter the site has: MAL asks how far the
  // reader got, and 109 is how far the translators got.
  assert.equal(back.chaptersRead, 104);
});

test('an entry that came from MyAnimeList can go home', async () => {
  const u = await newUser();
  await addEntry(u.token, {
    title: 'Berserk',
    sourceUrl: 'https://myanimelist.net/manga/2',
    sourceDomain: 'myanimelist.net',
  });
  const xml = toMalXml(await buildBackup(u.id));
  assert.match(xml, /<manga_mangadb_id>2<\/manga_mangadb_id>/);
  // Without this MAL reads the file and changes nothing.
  assert.match(xml, /<update_on_import>1<\/update_on_import>/);
});

test('a series from a scan site is still in the MAL file, id-less', async () => {
  const u = await seeded();
  const xml = toMalXml(await buildBackup(u.id));
  assert.match(xml, /<manga_mangadb_id>0<\/manga_mangadb_id>/);
  assert.equal(fromMalXml(xml).length, 1, 'the entry was dropped for having no MAL id');
});

test('the MAL export never claims chapters the user has not read', async () => {
  // The file carries update_on_import, so every number in it overwrites what
  // MAL already had. An entry the user added and never opened has no bookmark;
  // exporting the site's latest chapter in its place would tell MAL they had
  // read 237 chapters of a series they have not started.
  const u = await newUser();
  await addEntry(u.token, {
    title: 'Blue Box',
    sourceUrl: 'https://myanimelist.net/manga/135538',
    sourceDomain: 'myanimelist.net',
    lastKnownChapter: '237',
  });
  const xml = toMalXml(await buildBackup(u.id));
  assert.match(xml, /<my_read_chapters>0<\/my_read_chapters>/);
  assert.doesNotMatch(xml, /<my_read_chapters>237<\/my_read_chapters>/);
  assert.equal(fromMalXml(xml)[0].chaptersRead, 0);
});

test('the CSV survives a title with a comma and a quote in it', async () => {
  const u = await seeded({ title: 'Say "Hello", Box' });
  const csv = toCsv(await buildBackup(u.id));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2, 'a quoted newline or comma split the row');
  assert.match(lines[1], /"Say ""Hello"", Box"/);
  // Excel reads a plain UTF-8 CSV as Latin-1, and every accent in a French
  // note comes out as mojibake without the BOM.
  assert.ok(csv.startsWith('﻿'));
});

test('the CSV download names its columns', async () => {
  const u = await seeded();
  const res = await download('/api/export/csv', u.token);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const text = await res.text();
  // Status is one of the five; Shelf is the name the user gave the shelf, when
  // they filed it on one of their own.
  assert.match(text.split('\r\n')[0], /"Title","Status","Shelf","Chapter read"/);
});

test('an empty library exports an empty file rather than failing', async () => {
  const u = await newUser();
  const backup = await buildBackup(u.id);
  assert.deepEqual(backup.library, []);
  assert.match(toMalXml(backup), /<user_total_manga>0<\/user_total_manga>/);
  assert.equal(toCsv(backup).trim().split('\r\n').length, 1);
});
