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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, base, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { t } from './helpers/i18n.js';
import { buildBackup, toMalXml, toCsv, restoreBackup, malLeftOut } from '../src/routes/export.js';
import { fromMalXml } from '../src/routes/import.js';
import { db } from '../src/db.js';

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

// --- a manga list holds no anime ---------------------------------------------
//
// MyAnimeList keeps anime and manga apart, one list per file: user_export_type
// 1 is anime, 2 is manga, and ours says 2. An anime in it is an episode count
// written onto a manga list, and anything that matches on title takes it for
// the manga of the same name. So the file leaves anime out and the download
// says how many, and the manga it does carry are written exactly as before.

/**
 * Three series as the MAL writer wrote them before anime were left out, byte
 * for byte: an entry from MAL with a note to escape, a webtoon on a shelf of the
 * reader's own, and a light novel with a chapter in its label.
 */
const MAL_BEFORE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<myanimelist>',
  '  <myinfo>',
  '    <user_export_type>2</user_export_type>',
  '    <user_total_manga>3</user_total_manga>',
  '  </myinfo>',
  '  <manga>',
  '    <manga_mangadb_id>2</manga_mangadb_id>',
  '    <manga_title><![CDATA[Berserk]]></manga_title>',
  '    <my_read_chapters>364</my_read_chapters>',
  '    <my_start_date>2024-01-05</my_start_date>',
  '    <my_finish_date>0000-00-00</my_finish_date>',
  '    <my_score>10</my_score>',
  '    <my_status>Reading</my_status>',
  '    <my_times_read>1</my_times_read>',
  '    <my_comments><![CDATA[Guts & <Griffith> ]]&gt; "quoted"]]></my_comments>',
  '    <update_on_import>1</update_on_import>',
  '  </manga>',
  '  <manga>',
  '    <manga_mangadb_id>0</manga_mangadb_id>',
  '    <manga_title><![CDATA[Solo Leveling]]></manga_title>',
  '    <my_read_chapters>0</my_read_chapters>',
  '    <my_start_date>0000-00-00</my_start_date>',
  '    <my_finish_date>2025-02-01</my_finish_date>',
  '    <my_score>0</my_score>',
  '    <my_status>On-Hold</my_status>',
  '    <my_times_read>0</my_times_read>',
  '    <my_comments><![CDATA[]]></my_comments>',
  '    <update_on_import>1</update_on_import>',
  '  </manga>',
  '  <manga>',
  '    <manga_mangadb_id>0</manga_mangadb_id>',
  '    <manga_title><![CDATA[Mushoku Tensei]]></manga_title>',
  '    <my_read_chapters>3</my_read_chapters>',
  '    <my_start_date>0000-00-00</my_start_date>',
  '    <my_finish_date>0000-00-00</my_finish_date>',
  '    <my_score>7</my_score>',
  '    <my_status>Plan to Read</my_status>',
  '    <my_times_read>0</my_times_read>',
  '    <my_comments><![CDATA[]]></my_comments>',
  '    <update_on_import>1</update_on_import>',
  '  </manga>',
  '</myanimelist>',
  '',
].join('\n');

/** A backup in the shape buildBackup writes, holding `library`. */
const backupOf = (library) => ({
  app: 'panelflow', version: 1, exportedAt: '2026-10-16T00:00:00.000Z',
  categories: [{ id: 'c1', name: 'Weekly', status: 'paused', position: 0 }],
  library,
});

const BERSERK = {
  title: 'Berserk', sourceUrl: 'https://myanimelist.net/manga/2', sourceDomain: 'myanimelist.net',
  folder: 'reading', score: 10, startDate: '2024-01-05', finishDate: null, rereads: 1,
  note: 'Guts & <Griffith> ]]> "quoted"', medium: 'manga', tags: [],
  progress: { chapterLabel: 'Chapter 364' }, history: [],
};
const SOLO_LEVELING = {
  title: 'Solo Leveling', sourceUrl: 'https://scans.test/solo', sourceDomain: 'scans.test',
  folder: 'cat:c1', score: null, startDate: null, finishDate: '2025-02-01', rereads: 0,
  note: null, medium: 'webtoon', tags: [], progress: null, history: [],
};
const MUSHOKU = {
  title: 'Mushoku Tensei', sourceUrl: 'https://ln.test/mushoku', sourceDomain: 'ln.test',
  folder: 'plan', score: 7, startDate: null, finishDate: null, rereads: 0,
  note: '', medium: 'novel', tags: [], progress: { chapterLabel: 'Vol. 3 ch. 12.5' }, history: [],
};
const FRIEREN = {
  title: 'Frieren', sourceUrl: 'https://myanimelist.net/anime/52991', sourceDomain: 'myanimelist.net',
  folder: 'completed', score: 9, startDate: '2023-09-29', finishDate: '2024-03-22', rereads: 0,
  note: 'episode 10 !', medium: 'anime', tags: [], progress: { chapterLabel: 'Episode 28' }, history: [],
};

test('the MyAnimeList file is a manga list: an anime in the library is left out of it', async () => {
  const u = await newUser();
  await addEntry(u.token, { title: 'Blue Box', sourceUrl: 'https://myanimelist.net/manga/135538' });
  await addEntry(u.token, { title: 'Frieren', sourceUrl: 'https://anime.test/frieren', medium: 'anime' });
  await addEntry(u.token, { title: 'Solo Leveling', sourceUrl: 'https://scans.test/solo', medium: 'webtoon' });
  await addEntry(u.token, { title: 'Mushoku Tensei', sourceUrl: 'https://ln.test/mushoku', medium: 'novel' });
  const backup = await buildBackup(u.id);
  const xml = toMalXml(backup);

  // A webtoon and a light novel stay: MAL files both on its manga list.
  assert.deepEqual(fromMalXml(xml).map((e) => e.title).sort(), ['Blue Box', 'Mushoku Tensei', 'Solo Leveling']);
  assert.doesNotMatch(xml, /Frieren/);
  assert.match(xml, /<user_export_type>2<\/user_export_type>/);
  // The count the file gives is the count of what is in it.
  assert.match(xml, /<user_total_manga>3<\/user_total_manga>/);
  assert.equal(malLeftOut(backup), 1);
});

test('leaving the anime out leaves every manga in the file byte for byte as it was', () => {
  assert.equal(toMalXml(backupOf([BERSERK, SOLO_LEVELING, MUSHOKU])), MAL_BEFORE);
  // The anime in the middle changes nothing around it, not even the count.
  assert.equal(toMalXml(backupOf([BERSERK, FRIEREN, SOLO_LEVELING, MUSHOKU])), MAL_BEFORE);
  // An entry from before the field existed is a manga, as everywhere else.
  const unmarked = { ...MUSHOKU, medium: undefined };
  assert.match(toMalXml(backupOf([unmarked])), /Mushoku Tensei/);
  assert.equal(malLeftOut(backupOf([BERSERK, FRIEREN, unmarked])), 1);
});

test('the download says how many anime it left out, in a header a page can read', async () => {
  const u = await newUser();
  await addEntry(u.token, { title: 'Blue Box', sourceUrl: 'https://myanimelist.net/manga/135538' });
  const none = await download('/api/export/mal', u.token);
  assert.equal(none.status, 200);
  assert.equal(none.headers.get('x-panelflow-anime-left-out'), '0');

  await addEntry(u.token, { title: 'Frieren', sourceUrl: 'https://anime.test/frieren', medium: 'anime' });
  await addEntry(u.token, { title: 'Dandadan', sourceUrl: 'https://anime.test/dandadan', medium: 'anime' });
  const res = await download('/api/export/mal', u.token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-panelflow-anime-left-out'), '2');
  // The API answers other origins too, and a header they are not told about is
  // a header their pages cannot see.
  assert.match(res.headers.get('access-control-expose-headers'), /X-PanelFlow-Anime-Left-Out/i);
  // The body is still the file, and only the manga are in it.
  assert.match(res.headers.get('content-disposition'), /attachment; filename="panelflow-\d{4}-\d{2}-\d{2}\.xml"/);
  assert.deepEqual(fromMalXml(await res.text()).map((e) => e.title), ['Blue Box']);
});

test('the web app tells the reader how many anime the file left out, and why', () => {
  // Lifted out of the shipping web/app.js: a file three series short, with
  // nothing on screen to say why, reads as three series lost.
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'app.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const a = app.indexOf('function sayAnimeLeftOut(res) {');
  const b = app.indexOf('\n}\n', a) + 3;
  assert.ok(a !== -1 && b > a, 'sayAnimeLeftOut is not where this test expects it in web/app.js');
  const status = { hidden: true, textContent: '' };
  const say = new Function('$', 't', `${app.slice(a, b)}\nreturn sayAnimeLeftOut;`)(() => status, t);
  const reply = (n) => ({ headers: new Headers(n === null ? {} : { 'X-PanelFlow-Anime-Left-Out': String(n) }) });

  say(reply(0));
  say(reply(null));
  assert.equal(status.hidden, true, 'a file with nothing left out says something anyway');
  say(reply(1));
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, '1 anime was left out of this file: MyAnimeList keeps anime on a separate list.');
  say(reply(3));
  assert.equal(status.textContent, '3 anime were left out of this file: MyAnimeList keeps anime on a separate list.');
  // Only the MyAnimeList button asks.
  assert.match(app, /if \(id === 'x-mal'\) sayAnimeLeftOut\(res\);/);
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

// --- the rest of the account (RGPD art. 15 and 20) ---------------------------

test('the backup carries the account itself, and never a working key', async () => {
  // The QA pass of September 2026 found the "complete" backup was the shelf
  // alone: no e-mail, settings, connections, found chapters, subscriptions or
  // removed series.
  const u = await seeded();
  await api('PUT', '/api/prefs', { theme: 'dark', favouriteSites: ['old-scan.test'] }, u.token);
  await db.prepare(`INSERT INTO trackers (user_id, service, access_token, refresh_token, remote_user)
                    VALUES (?, 'anilist', 'secret-access-token', 'secret-refresh-token', 'reader42')`).run(u.id);
  await db.prepare(`INSERT INTO tracker_links (user_id, library_id, service, remote_id, remote_title, state, last_chapter)
                    VALUES (?, ?, 'anilist', '12345', 'Ao no Hako', 'matched', 104)`).run(u.id, u.entry.id);
  await db.prepare('INSERT INTO news (user_id, library_id, chapter) VALUES (?, ?, ?)').run(u.id, u.entry.id, '110');
  await db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth)
                    VALUES (?, ?, 'secret-p256dh', 'secret-auth')`)
    .run(`https://fcm.googleapis.com/fcm/send/secret-device-${u.id}`, u.id);
  const gone = await addEntry(u.token, { title: 'Dropped One', sourceUrl: 'https://old-scan.test/manga/dropped' });
  assert.ok((await api('DELETE', `/api/library/${gone.id}`, undefined, u.token)).status < 300);

  const backup = await buildBackup(u.id);
  const { account } = backup;
  assert.equal(account.email, u.email);
  assert.ok(account.createdAt);
  assert.equal(account.prefs.theme, 'dark');
  assert.deepEqual(account.trackers.map((t) => [t.service, t.remoteUser]), [['anilist', 'reader42']]);
  assert.equal(account.trackerLinks[0].remoteId, '12345');
  assert.equal(account.trackerLinks[0].sourceUrl, 'https://old-scan.test/manga/ao-no-hako');
  assert.deepEqual(account.newChapters.map((n) => n.chapter), ['110']);
  assert.deepEqual(account.pushSubscriptions.map((p) => p.service), ['fcm.googleapis.com']);
  assert.deepEqual(account.removedSeries.map((r) => r.title), ['Dropped One']);
  // The removed series is listed, not restored.
  assert.ok(!backup.library.some((e) => e.title === 'Dropped One'));

  const text = JSON.stringify(backup);
  for (const secret of ['secret-access-token', 'secret-refresh-token', 'secret-p256dh', 'secret-auth',
    'secret-device', '$2a$', '$2b$', 'password']) {
    assert.ok(!text.includes(secret), `the backup carries ${secret}`);
  }
});

test('a removed series is exported with the bookmark and history the server still keeps', async () => {
  // The re-test of September 2026: the removed series were listed bare, while
  // the server kept their bookmark and history for thirty days.
  const u = await seeded();
  assert.equal((await api('DELETE', `/api/library/${u.entry.id}`, undefined, u.token)).status, 204);
  const { account } = await buildBackup(u.id);
  const gone = account.removedSeries.find((r) => r.title === 'Ao no Hako');
  assert.ok(gone, 'the removed series is not in the export');
  assert.equal(gone.progress?.chapterLabel, 'Chapitre 104');
  assert.equal(gone.history.length, 1);
  assert.equal(gone.history[0].seconds, 300);
});

test('a removed series keeps the whole of its progress in the export, as a series on the shelf does', async () => {
  // Third re-test (It.5, N9): the pages, the scroll and the bookmark's pages and
  // move were in the database and not in the file (articles 15-3 and 20).
  const u = await seeded();
  await api('PUT', `/api/progress/${u.entry.id}`, {
    chapterUrl: 'https://example-manga-site.test/manga/ao-no-hako/chapitre-104', chapterLabel: 'Chapitre 104',
    page: 2, pageCount: 18, scrollPos: 0.25,
  }, u.token);
  const shelf = (await buildBackup(u.id)).library.find((e) => e.title === 'Ao no Hako').progress;
  assert.equal((await api('DELETE', `/api/library/${u.entry.id}`, undefined, u.token)).status, 204);
  const gone = (await buildBackup(u.id)).account.removedSeries.find((r) => r.title === 'Ao no Hako').progress;
  assert.deepEqual(Object.keys(gone).sort(), Object.keys(shelf).sort());
  assert.equal(gone.page, 2);
  assert.equal(gone.pageCount, 18);
  assert.equal(gone.scrollPos, 0.25);
  assert.deepEqual(Object.keys(gone.furthest).sort(), ['at', 'chapterLabel', 'chapterUrl', 'movedAt', 'page', 'pageCount']);
});

test('a removed series is exported with its note, score, tags and folder too', async () => {
  // Second re-test: they come back when the series is added again, so the
  // server holds them, so the export has to say so.
  const u = await seeded();
  await api('PUT', `/api/library/${u.entry.id}`,
    { note: 'Note privée', score: 8, tags: ['romance'], folder: 'plan' }, u.token);
  assert.equal((await api('DELETE', `/api/library/${u.entry.id}`, undefined, u.token)).status, 204);
  const { account } = await buildBackup(u.id);
  const gone = account.removedSeries.find((r) => r.title === 'Ao no Hako');
  assert.equal(gone.note, 'Note privée');
  assert.equal(gone.score, 8);
  assert.deepEqual(gone.tags, ['romance']);
  assert.equal(gone.folder, 'plan');
  assert.ok(gone.removedAt);
  assert.equal(gone.id, undefined, 'an internal id is not a reader\'s data');
});

test('restoring a backup into another account never brings the account section with it', async () => {
  const from = await seeded();
  await api('PUT', '/api/prefs', { theme: 'dark' }, from.token);
  const to = await newUser();
  const before = (await api('GET', '/api/prefs', undefined, to.token)).body;

  const r = await restoreBackup(to.id, await buildBackup(from.id), { dryRun: false });
  assert.ok(r);
  const after = await buildBackup(to.id);
  assert.equal(after.account.email, to.email, 'the restore moved an e-mail address between accounts');
  assert.deepEqual((await api('GET', '/api/prefs', undefined, to.token)).body, before);
  assert.deepEqual(after.library.map((e) => e.title), ['Ao no Hako']);
});

test('a CSV cell a spreadsheet would run as a formula is written as text', async () => {
  // QA report F-51: a note or a title starting with "=" is executed by Excel
  // and LibreOffice when the export is opened.
  const csv = toCsv({
    categories: [],
    library: [{
      title: '=HYPERLINK("http://evil.test","x")', folder: 'reading', tags: [], sourceDomain: 's.test',
      sourceUrl: 'https://s.test/a', note: '@SUM(1+1)', dateAdded: '2026-01-01', progress: { chapterLabel: '-1' },
      score: -3, rereads: 0,
    }],
  });
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil\.test"",""x""\)"/);
  assert.match(csv, /"'@SUM\(1\+1\)"/);
  assert.match(csv, /"-1"/, 'a negative number is a number, not a formula');
  assert.match(csv, /"-3"/);
});
