// Importing a list from AniList or MyAnimeList.
//
// An import writes across the whole library at once, which is the one shape of
// operation where a bug is not a bug but a loss: silently overwriting the score
// you set here with the one you set on MAL two years ago is not recoverable.
// So most of what is checked below is what the import *refuses* to touch.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, base, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { fromMalXml } from '../src/routes/import.js';

after(shutdown);

const malXml = (entries) => `<?xml version="1.0" encoding="UTF-8" ?>
<myanimelist>
  <myinfo><user_name>someone</user_name></myinfo>
  ${entries.map((e) => `
  <manga>
    <manga_mangadb_id>${e.id}</manga_mangadb_id>
    <manga_title><![CDATA[${e.title}]]></manga_title>
    <manga_publishing_status>${e.publishing ?? 'Publishing'}</manga_publishing_status>
    <my_read_chapters>${e.chapters ?? 0}</my_read_chapters>
    <my_score>${e.score ?? 0}</my_score>
    <my_status>${e.status ?? 'Reading'}</my_status>
    <my_times_read>${e.rereads ?? 0}</my_times_read>
    <my_start_date>${e.start ?? '0000-00-00'}</my_start_date>
    <my_finish_date>${e.finish ?? '0000-00-00'}</my_finish_date>
    <my_comments><![CDATA[${e.note ?? ''}]]></my_comments>
  </manga>`).join('')}
</myanimelist>`;

/** POSTs XML with the content type the route expects, which `api` cannot do. */
async function postMal(xml, token, query = '') {
  const resp = await fetch(base + '/api/import/mal' + query, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', Authorization: `Bearer ${token}` },
    body: xml,
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

test('the MAL export parser reads the fields that matter', () => {
  const rows = fromMalXml(malXml([
    { id: 21, title: 'One Piece', chapters: 1100, score: 10, status: 'Reading' },
    { id: 2, title: 'Berserk & Co <ok>', chapters: 370, score: 9, status: 'On-Hold',
      start: '2019-04-01', finish: '0000-00-00', publishing: 'Finished', rereads: 2 },
    { id: 3, title: 'Planned', status: 'Plan to Read' },
  ]));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    title: 'One Piece', coverUrl: null,
    sourceUrl: 'https://myanimelist.net/manga/21', sourceDomain: 'myanimelist.net',
    folder: 'reading', score: 10, rereads: 0, startDate: null, finishDate: null,
    seriesStatus: null, language: null, chaptersRead: 1100, note: null,
  });
  assert.equal(rows[1].title, 'Berserk & Co <ok>', 'CDATA is taken literally');
  assert.equal(rows[1].folder, 'paused', 'On-Hold is Paused here');
  assert.equal(rows[1].startDate, '2019-04-01');
  assert.equal(rows[1].finishDate, null, '0000-00-00 is not a date');
  assert.equal(rows[1].seriesStatus, 'completed');
  assert.equal(rows[1].rereads, 2);
  assert.equal(rows[2].folder, 'plan');
  assert.equal(rows[2].score, null, 'a score of 0 on MAL means unscored');
});

test('the parser refuses something that is not an export', () => {
  assert.throws(() => fromMalXml('<html><body>nope</body></html>'), /MyAnimeList export/);
  assert.equal(fromMalXml('<myanimelist></myanimelist>').length, 0);
});

test('an import adds what is new', async () => {
  const u = await newUser();
  const r = await postMal(malXml([
    { id: 21, title: 'One Piece', chapters: 1100, score: 10 },
    { id: 2, title: 'Berserk', chapters: 370, status: 'Completed' },
  ]), u.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 2);
  assert.equal(r.body.dryRun, false);

  const lib = (await api('GET', '/api/library', undefined, u.token)).body;
  assert.equal(lib.length, 2);
  const op = lib.find((e) => e.title === 'One Piece');
  assert.equal(op.score, 10);
  assert.equal(op.folder, 'reading');
  assert.equal(op.sourceDomain, 'myanimelist.net');
});

test('a dry run reports exactly what the real run would do, and writes nothing', async () => {
  const u = await newUser();
  const xml = malXml([{ id: 21, title: 'One Piece', chapters: 5 }, { id: 2, title: 'Berserk' }]);

  const preview = await postMal(xml, u.token, '?dryRun=1');
  assert.equal(preview.body.dryRun, true);
  assert.equal(preview.body.added, 2);
  assert.equal((await api('GET', '/api/library', undefined, u.token)).body.length, 0);

  const real = await postMal(xml, u.token);
  assert.equal(real.body.added, preview.body.added);
  assert.equal(real.body.progress, preview.body.progress);
  assert.equal((await api('GET', '/api/library', undefined, u.token)).body.length, 2);
});

test('an import never overwrites what the library already holds', async () => {
  const u = await newUser();
  const mine = await addEntry(u.token, {
    title: 'One Piece (my copy)',
    sourceUrl: 'https://myanimelist.net/manga/21',
    sourceDomain: 'myanimelist.net',
    folder: 'paused', score: 6, note: 'my own note',
  });

  const r = await postMal(malXml([
    { id: 21, title: 'One Piece', score: 10, status: 'Reading', note: 'imported note' },
  ]), u.token);
  assert.equal(r.body.added, 0);
  assert.equal(r.body.unchanged, 1, 'nothing left to fill in');

  const entry = (await api('GET', '/api/library', undefined, u.token)).body[0];
  assert.equal(entry.title, 'One Piece (my copy)', 'the title here wins');
  assert.equal(entry.folder, 'paused', 'the folder here wins');
  assert.equal(entry.score, 6, 'the score here wins');
  assert.equal(entry.note, 'my own note');
});

test('an import fills in the blanks it can', async () => {
  const u = await newUser();
  await addEntry(u.token, {
    title: 'Berserk',
    sourceUrl: 'https://myanimelist.net/manga/2',
    sourceDomain: 'myanimelist.net',
  });
  const r = await postMal(malXml([
    { id: 2, title: 'Berserk', score: 9, status: 'Completed', start: '2019-04-01', rereads: 3 },
  ]), u.token);
  assert.equal(r.body.updated, 1);

  const entry = (await api('GET', '/api/library', undefined, u.token)).body[0];
  assert.equal(entry.score, 9, 'no score here, so the import supplies one');
  assert.equal(entry.startDate, '2019-04-01');
  assert.equal(entry.rereads, 3);
  assert.equal(entry.folder, 'reading', 'but the folder is still not overwritten');
});

test('progress is only invented for series you are actually in the middle of', async () => {
  const u = await newUser();
  await postMal(malXml([
    { id: 21, title: 'Reading it', chapters: 1100, status: 'Reading' },
    { id: 2, title: 'Finished it', chapters: 370, status: 'Completed' },
    { id: 3, title: 'Paused it', chapters: 12, status: 'On-Hold' },
    { id: 4, title: 'Not started', chapters: 0, status: 'Reading' },
  ]), u.token);

  const cont = (await api('GET', '/api/progress/continue', undefined, u.token)).body;
  const titles = cont.map((c) => c.title).sort();
  assert.deepEqual(titles, ['Paused it', 'Reading it'],
    'a finished or unstarted series must not turn up in Continue Reading');
  assert.equal(cont.find((c) => c.title === 'Reading it').chapterLabel, 'Chapter 1100');
});

test('an import does not move a bookmark the reader already wrote', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token, {
    title: 'One Piece', sourceUrl: 'https://myanimelist.net/manga/21', sourceDomain: 'myanimelist.net',
  });
  await api('PUT', '/api/progress/' + entry.id, {
    chapterUrl: 'https://scans.test/one-piece/1105',
    chapterLabel: 'Chapter 1105', page: 7,
  }, u.token);

  await postMal(malXml([{ id: 21, title: 'One Piece', chapters: 900, status: 'Reading' }]), u.token);

  const p = (await api('GET', '/api/progress', undefined, u.token)).body[0];
  assert.equal(p.chapterLabel, 'Chapter 1105', 'the reader knows better than the tracker');
  assert.equal(p.page, 7);
});

test('an import brings a removed series back', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token, {
    title: 'Berserk', sourceUrl: 'https://myanimelist.net/manga/2', sourceDomain: 'myanimelist.net',
  });
  await api('DELETE', '/api/library/' + entry.id, undefined, u.token);
  assert.equal((await api('GET', '/api/library', undefined, u.token)).body.length, 0);

  const r = await postMal(malXml([{ id: 2, title: 'Berserk' }]), u.token);
  assert.equal(r.body.updated, 1);
  assert.equal((await api('GET', '/api/library', undefined, u.token)).body.length, 1);
});

test('imports are refused without auth and when malformed', async () => {
  const u = await newUser();
  assert.equal((await postMal(malXml([{ id: 1, title: 'x' }]), 'not-a-token')).status, 401);
  assert.equal((await postMal('<html>no</html>', u.token)).status, 400);
  assert.equal((await postMal('<myanimelist></myanimelist>', u.token)).status, 400);
  assert.equal((await api('POST', '/api/import/anilist', {}, u.token)).status, 400);
  assert.equal((await api('POST', '/api/import/anilist', { username: 'x' }, null)).status, 401);
});
