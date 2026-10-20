// Imports that a QA campaign broke, and what they must do instead.
//
// Every test here is a file somebody could really hand the server: an export
// that names one series twice, the same address written two ways, a download
// that stopped half way, a backup with impossible values in it, and a list long
// enough to hold the whole API while it was written. The data is built in each
// test rather than read from the campaign's fixtures, so the suite stands on
// its own.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, base, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { db } from '../src/db.js';
import { applyImport, fromMalXml } from '../src/routes/import.js';

after(shutdown);

const malXml = (entries) => `<?xml version="1.0" encoding="UTF-8" ?>
<myanimelist>
  <myinfo><user_export_type>2</user_export_type></myinfo>
  ${entries.map((e) => `
  <manga>
    <manga_mangadb_id>${e.id}</manga_mangadb_id>
    <manga_title><![CDATA[${e.title}]]></manga_title>
    <manga_publishing_status>Publishing</manga_publishing_status>
    <my_read_chapters>${e.chapters ?? 0}</my_read_chapters>
    <my_score>${e.score ?? 0}</my_score>
    <my_status>${e.status ?? 'Reading'}</my_status>
    <my_times_read>0</my_times_read>
    <my_start_date>${e.start ?? '0000-00-00'}</my_start_date>
    <my_finish_date>0000-00-00</my_finish_date>
    <my_comments><![CDATA[${e.note ?? ''}]]></my_comments>
  </manga>`).join('')}
</myanimelist>`;

async function postMal(xml, token, query = '') {
  const resp = await fetch(`${base}/api/import/mal${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', Authorization: `Bearer ${token}` },
    body: xml,
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

/** A backup file holding `library`, in the shape GET /api/export writes. */
const backupOf = (library, categories = []) => ({
  app: 'panelflow', version: 1, exportedAt: '2026-10-13T00:00:00.000Z', categories, library,
});

/** One series of a backup, on a scan site unless told otherwise. */
const series = (title, sourceUrl, extra = {}) => ({
  title, sourceUrl, sourceDomain: 'scans.test', folder: 'reading', tags: [], ...extra,
});

const restore = (file, token, query = '') => api('POST', `/api/import/panelflow${query}`, file, token);
const libraryOf = async (token) => (await api('GET', '/api/library', undefined, token)).body;

// --- one series named twice (H4) -------------------------------------------

test('a backup naming one series twice restores it once, and the preview says so', async () => {
  const u = await newUser();
  const file = backupOf([
    series('Silent Tide', 'http://scans.test/manga/silent-tide/', { score: 1 }),
    series('Gentle Station', 'http://scans.test/manga/gentle-station/', { folder: 'plan', tags: ['qa'] }),
    series('Silent Tide again', 'http://scans.test/manga/silent-tide/', { note: 'from the copy' }),
  ]);

  const preview = await restore(file, u.token, '?dryRun=1');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.added, 2, 'the preview counted the copy as a series of its own');
  assert.equal(preview.body.total, 2);
  assert.equal(preview.body.duplicates, 1);

  // This is the request that answered 500 after writing two rows.
  const real = await restore(file, u.token);
  assert.equal(real.status, 200, JSON.stringify(real.body));
  assert.equal(real.body.added, preview.body.added, 'the run did something the preview did not say');

  const lib = await libraryOf(u.token);
  assert.equal(lib.length, 2);
  const tide = lib.find((e) => e.sourceUrl.includes('silent-tide'));
  assert.equal(tide.title, 'Silent Tide', 'the first copy is the one kept');
  assert.equal(tide.score, 1);
  assert.equal(tide.note, 'from the copy', 'a later copy fills the blanks of the first');
});

test('a MyAnimeList export naming one work twice imports it once', async () => {
  const u = await newUser();
  const xml = malXml([
    { id: 100001, title: 'Same', chapters: 3, score: 7 },
    { id: 100002, title: 'Other', chapters: 4, score: 7 },
    { id: 100001, title: 'Same again', chapters: 5, score: 7 },
  ]);

  const preview = await postMal(xml, u.token, '?dryRun=1');
  const real = await postMal(xml, u.token);
  assert.equal(real.status, 200, JSON.stringify(real.body));
  assert.equal(preview.body.added, 2);
  assert.equal(real.body.added, preview.body.added);
  assert.equal(real.body.progress, preview.body.progress);

  assert.equal((await libraryOf(u.token)).length, 2);
  const cont = (await api('GET', '/api/progress/continue', undefined, u.token)).body;
  assert.equal(cont.find((c) => c.title === 'Same').chapterLabel, 'Chapter 3',
    'the bookmark is the first copy\'s, as the first bookmark written would have been');
});

test('AniList lists a series once per list it is on, and it is imported once', async () => {
  const u = await newUser();
  const media = {
    siteUrl: 'https://anilist.co/manga/30002', status: 'RELEASING', countryOfOrigin: 'JP',
    title: { romaji: 'Blue Lock' }, coverImage: {},
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(base)) return realFetch(input, init);
    return new Response(JSON.stringify({
      data: {
        MediaListCollection: {
          lists: [
            { entries: [{ status: 'CURRENT', progress: 246, score: 9, repeat: 0, media }] },
            { entries: [{ status: 'CURRENT', progress: 246, score: 9, repeat: 0, media }] },
          ],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const r = await api('POST', '/api/import/anilist', { username: 'someone' }, u.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.added, 1);
    assert.equal(r.body.duplicates, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal((await libraryOf(u.token)).length, 1);
});

test('works MyAnimeList no longer has are skipped, not folded into one row', async () => {
  // Its exporter writes id 0 for a deleted work, and so does ours for a series
  // from a scan site. Two of them would otherwise be "the same address".
  const u = await newUser();
  const r = await postMal(malXml([
    { id: 0, title: 'Deleted one' },
    { id: 0, title: 'Deleted two' },
    { id: 5, title: 'Still there' },
  ]), u.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added, 1);
  assert.equal(r.body.skipped, 2);
  assert.deepEqual((await libraryOf(u.token)).map((e) => e.title), ['Still there']);
});

// --- all or nothing ---------------------------------------------------------

test('an import that fails is not left half-written', async () => {
  // A statement nothing could have planned for, appended to whatever the import
  // sends: the database refuses the batch on its very last line.
  const u = await newUser();
  const real = db.batch;
  const quiet = console.error;
  db.batch = (statements) => real.call(db, [...statements, { sql: 'INSERT INTO no_such_table VALUES (1)' }]);
  console.error = () => {};  // the 500 is expected, and its stack trace is noise here
  try {
    const r = await postMal(malXml([
      { id: 1, title: 'One', chapters: 2 },
      { id: 2, title: 'Two', chapters: 3 },
      { id: 3, title: 'Three' },
    ]), u.token);
    assert.equal(r.status, 500);
  } finally {
    db.batch = real;
    console.error = quiet;
  }
  assert.deepEqual(await libraryOf(u.token), [], 'the rows before the failure were kept');
  assert.deepEqual((await api('GET', '/api/progress', undefined, u.token)).body, []);
});

test('a long import cut off by the database says so, and running it again finishes it', async () => {
  const u = await newUser();
  const xml = malXml(Array.from({ length: 300 }, (_, i) => ({ id: i + 1, title: `Work ${i + 1}`, chapters: 2 })));

  const real = db.batch;
  const quiet = console.error;
  let calls = 0;
  let logged = 0;
  db.batch = (statements) => (++calls === 2
    ? Promise.reject(new Error('the database went away'))
    : real.call(db, statements));
  console.error = () => { logged++; };
  try {
    const r = await postMal(xml, u.token);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /run it again/);
    assert.equal(logged, 1, 'the failure underneath was not logged');
  } finally {
    db.batch = real;
    console.error = quiet;
  }

  const again = await postMal(xml, u.token);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const lib = await libraryOf(u.token);
  assert.equal(lib.length, 300);
  assert.equal(new Set(lib.map((e) => e.sourceUrl)).size, 300, 'the second run added a series twice');
  assert.equal((await api('GET', '/api/progress', undefined, u.token)).body.length, 300);
});

// --- one address, written two ways (NEW-5) ---------------------------------

test('the same address with a trailing slash, another case or an anchor is one series', async () => {
  const u = await newUser();
  const r = await restore(backupOf([
    series('Silent Tide', 'http://scans.test/manga/silent-tide/'),
    series('Silent Tide', 'http://scans.test/manga/silent-tide'),
    series('Silent Tide', 'http://SCANS.test/manga/silent-tide/'),
    series('Silent Tide', 'http://scans.test/manga/silent-tide#comments'),
  ]), u.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added, 1);
  assert.equal(r.body.duplicates, 3);
  assert.equal((await libraryOf(u.token)).length, 1);
});

test('an address written another way matches the series already in the library', async () => {
  const u = await newUser();
  await addEntry(u.token, {
    title: 'Blue Box', sourceUrl: 'http://scans.test/manga/blue-box/', sourceDomain: 'scans.test',
  });
  const r = await restore(backupOf([
    series('Blue Box', 'http://Scans.test/manga/blue-box', { score: 8 }),
  ]), u.token);
  assert.equal(r.body.added, 0);
  assert.equal(r.body.updated, 1, 'the score was not filled in on the series already here');
  const lib = await libraryOf(u.token);
  assert.equal(lib.length, 1);
  assert.equal(lib[0].sourceUrl, 'http://scans.test/manga/blue-box/', 'the stored address was rewritten');
  assert.equal(lib[0].score, 8);
});

test('a series already here under another spelling gets its bookmark on the address it has', async () => {
  const u = await newUser();
  await addEntry(u.token, {
    title: 'One Piece', sourceUrl: 'https://MyAnimeList.net/manga/21/', sourceDomain: 'myanimelist.net',
  });
  const r = await postMal(malXml([{ id: 21, title: 'One Piece', chapters: 1100 }]), u.token);
  assert.equal(r.body.added, 0);
  const progress = (await api('GET', '/api/progress', undefined, u.token)).body;
  assert.equal(progress.length, 1);
  assert.equal(progress[0].chapterUrl, 'https://MyAnimeList.net/manga/21/');
  assert.equal(progress[0].chapterLabel, 'Chapter 1100');
});

test('a fragment that is a route still tells two series apart', async () => {
  // On a site that navigates by hash, the fragment is the series.
  const u = await newUser();
  const r = await restore(backupOf([
    series('One', 'https://spa.test/#/manga/1'),
    series('Two', 'https://spa.test/#/manga/2'),
  ]), u.token);
  assert.equal(r.body.added, 2);
  assert.equal((await libraryOf(u.token)).length, 2);
});

// --- a file cut short (NEW-7) ----------------------------------------------

test('a MyAnimeList export cut off part way is refused whole, with a reason', async () => {
  const u = await newUser();
  const full = malXml(Array.from({ length: 10 }, (_, i) => ({ id: 200000 + i, title: `Cut ${i}` })));
  // Stopped inside the fifth block, as a download that died would leave it.
  const cut = full.slice(0, full.indexOf('Cut 4') + 60);
  const r = await postMal(cut, u.token);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cut off before its end/);
  assert.deepEqual(await libraryOf(u.token), [], 'four of the ten were imported anyway');

  // Cut exactly between two blocks, so that only the closing tag is missing.
  const between = full.slice(0, full.lastIndexOf('</manga>') + '</manga>'.length);
  assert.equal((await postMal(between, u.token)).status, 400);
  assert.throws(() => fromMalXml(between), /cut off/);
});

test('a comment that mentions a tag is not mistaken for a cut', async () => {
  const xml = malXml([{ id: 7, title: 'Tagged', note: 'better than <manga> and </myanimelist>' }]);
  assert.equal(fromMalXml(xml).length, 1);
});

// --- impossible values (NEW-6) ---------------------------------------------

test('a backup with impossible values restores what is sound and drops the rest', async () => {
  const u = await newUser();
  const chapter = (n) => `http://scans.test/manga/silent-tide/chapter-${n}/`;
  const r = await restore(backupOf([
    series('Silent Tide', 'http://scans.test/manga/silent-tide/', {
      score: 42, rereads: -3, startDate: '2026-13-45', finishDate: 'yesterday', dateAdded: 'yesterday',
      coverUrl: 'javascript:alert(1)',
      progress: { chapterUrl: chapter(1), page: -5, pageCount: 'many', scrollPos: 9 },
      history: [
        { chapterUrl: chapter(1), day: 'not-a-day', pages: 10, seconds: 60 },
        { chapterUrl: chapter(2), day: '2026-02-30', pages: 10, seconds: 60 },
        { chapterUrl: chapter(3), day: '2999-01-01', pages: 10, seconds: 60 },
        { chapterUrl: 'javascript:alert(1)', day: '2026-01-02', pages: 10, seconds: 60 },
        { chapterUrl: chapter(4), day: '2026-01-02', pages: -1, seconds: 1e12 },
      ],
    }),
    series('Gentle Station', 'http://scans.test/manga/gentle-station/', {
      score: 0, rereads: 2, startDate: '2024-02-29', folder: 'banana',
    }),
    series('Click me', 'javascript:alert(document.cookie)'),
    null, 42, 'string',
  ]), u.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added, 2, 'the sound series were not restored');
  assert.equal(r.body.skipped, 4);
  assert.equal(r.body.bookmarks, 1);
  assert.equal(r.body.reads, 1, 'only one history row of the five can be placed');

  const lib = await libraryOf(u.token);
  assert.equal(lib.length, 2);
  const tide = lib.find((e) => e.title === 'Silent Tide');
  assert.equal(tide.score, null, 'a score of 42 was stored');
  assert.equal(tide.rereads, 0);
  assert.equal(tide.startDate, null, '2026-13-45 was stored as a date');
  assert.equal(tide.finishDate, null);
  assert.equal(tide.coverUrl, null);
  assert.match(tide.dateAdded, /^\d{4}-\d{2}-\d{2}/, '"yesterday" was stored as when it was added');
  const station = lib.find((e) => e.title === 'Gentle Station');
  assert.equal(station.score, 0, 'a sound value was dropped with the bad ones');
  assert.equal(station.rereads, 2);
  assert.equal(station.startDate, '2024-02-29');
  assert.equal(station.folder, 'reading', 'a folder that does not exist was stored');

  const [bookmark] = (await api('GET', '/api/progress', undefined, u.token)).body;
  assert.equal(bookmark.page, 0);
  assert.equal(bookmark.pageCount, null);
  // Past the end is the end, by the rule a page turn is held to: a backup
  // written before the progress route checked anything can hold a phone's
  // overscroll, 1.02, and that reader was at the end of the chapter, not its top.
  assert.equal(bookmark.scrollPos, 1);

  const history = (await api('GET', '/api/history', undefined, u.token)).body;
  assert.equal(history.length, 1);
  assert.equal(history[0].day, '2026-01-02');
  assert.equal(history[0].pages, 0);
  assert.equal(history[0].seconds, 24 * 3600, 'a trillion seconds went into the statistics');
  const stats = (await api('GET', '/api/history/stats', undefined, u.token)).body;
  assert.equal(stats.seconds, 24 * 3600);
});

test('a MyAnimeList export with an impossible date keeps the series and drops the date', async () => {
  const u = await newUser();
  const r = await postMal(malXml([{ id: 9, title: 'Odd date', start: '2026-13-45' }]), u.token);
  assert.equal(r.body.added, 1);
  assert.equal((await libraryOf(u.token))[0].startDate, null);
});

test('history listed by two copies of one series is merged, not counted twice', async () => {
  const u = await newUser();
  const read = { chapterUrl: 'http://scans.test/manga/x/chapter-1/', day: '2026-01-02', pages: 10 };
  const r = await restore(backupOf([
    series('X', 'http://scans.test/manga/x/', { history: [{ ...read, seconds: 100 }] }),
    series('X', 'http://scans.test/manga/x', { history: [{ ...read, seconds: 300 }] }),
  ]), u.token);
  assert.equal(r.body.reads, 1);
  const history = (await api('GET', '/api/history', undefined, u.token)).body;
  assert.equal(history.length, 1);
  assert.equal(history[0].seconds, 300, 'the larger value, as a second restore would leave it');
});

// --- a long list (NEW-8) ----------------------------------------------------

test('a restore large enough to need many chunks lands whole, as previewed', async () => {
  const u = await newUser();
  const file = backupOf(Array.from({ length: 400 }, (_, i) => series(`Long ${i}`, `http://scans.test/manga/long-${i}/`, {
    progress: { chapterUrl: `http://scans.test/manga/long-${i}/chapter-2/`, chapterLabel: 'Chapter 2', page: 3 },
    history: [1, 2].map((n) => ({
      chapterUrl: `http://scans.test/manga/long-${i}/chapter-${n}/`, day: '2026-01-02', pages: 10, seconds: 60,
    })),
  })));
  const preview = await restore(file, u.token, '?dryRun=1');
  const real = await restore(file, u.token);
  assert.equal(real.status, 200, JSON.stringify(real.body));
  for (const key of ['added', 'bookmarks', 'reads']) {
    assert.equal(real.body[key], preview.body[key], `${key} differs between the preview and the run`);
  }
  const count = async (table) => (await db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(u.id)).n;
  assert.equal(await count('library'), 400);
  assert.equal(await count('progress'), 400);
  assert.equal(await count('history'), 800);
});

test('a 5000-entry import leaves the API answering while it is written', async (t) => {
  const u = await newUser();
  // Shaped exactly as the MyAnimeList reader hands them over.
  const entries = Array.from({ length: 5000 }, (_, i) => ({
    title: `Series ${i}`,
    coverUrl: null,
    sourceUrl: `https://myanimelist.net/manga/${i + 1}`,
    sourceDomain: 'myanimelist.net',
    folder: 'reading',
    score: 7,
    rereads: 0,
    startDate: '2026-01-01',
    finishDate: null,
    seriesStatus: null,
    language: null,
    chaptersRead: (i % 40) + 1,
    note: null,
  }));

  // The longest the event loop went without running a timer: how long a
  // request arriving during the import would have waited to be served.
  let last = performance.now();
  let longest = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);

  const started = performance.now();
  let importDone;
  let healthDone;
  try {
    const importing = applyImport(u.id, entries, { dryRun: false }).then(() => performance.now());
    // Asked once the import has begun. Before chunking, every statement ran in
    // one unbroken stretch and this could not even be sent until the last one;
    // by then the server had dropped the idle connection it was to go out on.
    const answered = fetch(`${base}/api/health`).then((res) => {
      assert.equal(res.status, 200);
      return performance.now();
    }, (err) => assert.fail(`/api/health went unanswered during the import (${err.cause?.code ?? err.message})`));
    [importDone, healthDone] = await Promise.all([importing, answered]);
  } finally {
    clearInterval(probe);
  }
  longest = Math.max(longest, performance.now() - last);

  t.diagnostic(`import ${Math.round(importDone - started)} ms; /api/health answered after `
    + `${Math.round(healthDone - started)} ms; longest stall ${Math.round(longest)} ms`);
  assert.ok(healthDone < importDone, '/api/health waited for the whole import');
  assert.ok(longest < 1000, `the event loop stalled for ${Math.round(longest)} ms`);

  const count = async (table) => (await db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(u.id)).n;
  assert.equal(await count('library'), 5000);
  assert.equal(await count('progress'), 5000);
});
