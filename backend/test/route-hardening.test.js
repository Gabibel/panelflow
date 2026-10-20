// Values the routes took that the import refuses, and what they do instead.
//
// The import was held to rules about what a date, an address or a count may be
// (import-hardening.test.js), and the same values still went in through the
// routes a client calls while someone reads: an impossible date and a
// javascript: address through /api/library, a javascript: chapter and a page
// count of Infinity through /api/history, anything at all through
// /api/progress. And a backup did not
// say what kind of work an entry is, so an anime came back from a restore as a
// manga. Every door now refuses an address that is not http(s) the same way
// (src/http-url.js, code bad_url), the library and the history ask the import's
// rules for the rest (src/entry-fields.js, src/history-fields.js), and each
// test below goes in through a door a client really uses.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, base, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { MAX_PAGES } from '../src/entry-fields.js';
import { buildBackup } from '../src/routes/export.js';

after(shutdown);

/**
 * One request with its JSON body sent as written. JSON.stringify cannot spell
 * 1e400 (it writes null), and anything that speaks HTTP can still send it.
 */
async function rawJson(method, path, text, token) {
  const resp = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: text,
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

const libraryOf = async (token) => (await api('GET', '/api/library', undefined, token)).body;
const progressOf = async (token) => (await api('GET', '/api/progress', undefined, token)).body;

/** A series as a client adds it, on a scan site unless told otherwise. */
const series = (title, sourceUrl, extra = {}) => ({
  title, sourceUrl, sourceDomain: 'scans.test', folder: 'reading', tags: [], ...extra,
});

/** A backup file holding `library`, in the shape GET /api/export writes. */
const backupOf = (library) => ({
  app: 'panelflow', version: 1, exportedAt: '2026-10-16T00:00:00.000Z', categories: [], library,
});

const restore = (file, token) => api('POST', '/api/import/panelflow', file, token);

// --- the library: dates and addresses ---------------------------------------

test('an entry whose address is not http(s) is refused, and nothing is stored', async () => {
  // The web app puts sourceUrl straight into an href: stored, this was a script
  // run by whoever clicked the series.
  const u = await newUser();
  const addresses = ['javascript:alert(document.cookie)', ' JavaScript:alert(1)', 'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'not an address', 42];
  for (const sourceUrl of addresses) {
    const r = await api('POST', '/api/library', series('Silent Tide', sourceUrl), u.token);
    assert.equal(r.status, 400, JSON.stringify(sourceUrl));
    assert.match(r.body.error, /sourceUrl must be an http\(s\) address/);
    assert.equal(r.body.code, 'bad_url');
  }
  assert.deepEqual(await libraryOf(u.token), []);
});

test('moving a series to an address that is not http(s) is refused, one move or many', async () => {
  // The other door to the same column: the web app's edit form moves the series
  // whenever its address field changes.
  const u = await newUser();
  const e = await addEntry(u.token, { coverUrl: 'https://cdn.test/a.jpg' });
  const one = await api('POST', `/api/library/${e.id}/migrate`,
    { sourceUrl: 'javascript:alert(1)', sourceDomain: 'evil.test' }, u.token);
  assert.equal(one.status, 400);
  assert.match(one.body.error, /sourceUrl must be an http\(s\) address/);

  const bulk = await api('POST', '/api/library/migrate-bulk', {
    items: [{ id: e.id, sourceUrl: 'javascript:alert(1)', sourceDomain: 'evil.test' }],
  }, u.token);
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.moved, 0);
  assert.match(bulk.body.results[0].error, /http\(s\)/);
  assert.equal((await libraryOf(u.token))[0].sourceUrl, e.sourceUrl, 'the refused move moved it');

  // A cover or a chapter the move carries is refused as well, and the move
  // with it: nothing of it is stored.
  const tainted = await api('POST', `/api/library/${e.id}/migrate`, {
    sourceUrl: 'https://new-scan.test/manga/x/', sourceDomain: 'new-scan.test',
    coverUrl: 'javascript:alert(1)', chapterUrl: 'javascript:alert(2)', chapterLabel: 'Chapter 9',
  }, u.token);
  assert.equal(tainted.status, 400);
  assert.match(tainted.body.error, /coverUrl, chapterUrl must be an http\(s\) address/);
  assert.equal((await libraryOf(u.token))[0].sourceUrl, e.sourceUrl, 'the refused move moved it');
  assert.deepEqual(await progressOf(u.token), [], 'a javascript: chapter became the bookmark');

  // A real destination still moves.
  const moved = await api('POST', `/api/library/${e.id}/migrate`, {
    sourceUrl: 'https://new-scan.test/manga/x/', sourceDomain: 'new-scan.test',
  }, u.token);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.entry.sourceUrl, 'https://new-scan.test/manga/x/');
  assert.equal(moved.body.entry.coverUrl, 'https://cdn.test/a.jpg', 'the entry lost its own cover');
});

test('a cover that is not http(s) is refused, and the entry stays as it was', async () => {
  // A picture nobody chose, or a script in an src: refused on the way in, as
  // the address of the series is. The import drops one instead and keeps the
  // series (import-hardening.test.js): a file is not a form to correct.
  const u = await newUser();
  const tide = 'https://scans.test/manga/silent-tide/';
  const refused = await api('POST', '/api/library',
    series('Silent Tide', tide, { coverUrl: 'javascript:alert(1)' }), u.token);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'bad_url');
  assert.deepEqual(await libraryOf(u.token), []);

  const made = await api('POST', '/api/library',
    series('Silent Tide', tide, { coverUrl: 'https://cdn.test/tide.jpg' }), u.token);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // Pinned again or edited with a bad cover, the good one already there stays.
  const again = await api('POST', '/api/library',
    series('Silent Tide', tide, { coverUrl: 'data:image/svg+xml,<svg onload=alert(1)>' }), u.token);
  assert.equal(again.status, 400);
  const edited = await api('PUT', `/api/library/${made.body.id}`, { coverUrl: 'javascript:alert(1)' }, u.token);
  assert.equal(edited.status, 400);
  assert.equal((await libraryOf(u.token))[0].coverUrl, 'https://cdn.test/tide.jpg');
  // Cleared with null, as always: null is not an address.
  const cleared = await api('PUT', `/api/library/${made.body.id}`, { coverUrl: null }, u.token);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.coverUrl, null);
});

test('a date no calendar has is refused on create and on edit, and real ones are kept', async () => {
  // The route checked the shape only, so 2026-13-45 went in; the import already
  // dropped it. Refused here, as this route has always refused a malformed date.
  const u = await newUser();
  for (const startDate of ['2026-13-45', '2026-02-30', '2025-02-29', '0000-00-00', 'yesterday']) {
    const r = await api('POST', '/api/library',
      series('Dated', `https://scans.test/manga/dated-${startDate}`, { startDate }), u.token);
    assert.equal(r.status, 400, startDate);
    assert.match(r.body.error, /startDate must be a real date, written YYYY-MM-DD/);
  }
  assert.deepEqual(await libraryOf(u.token), []);

  const e = await addEntry(u.token, { startDate: '2024-02-29', finishDate: '2026-10-16' });
  assert.equal(e.startDate, '2024-02-29', 'a leap day is a real day');
  for (const finishDate of ['2026-13-45', '2026-04-31']) {
    const r = await api('PUT', `/api/library/${e.id}`, { finishDate, score: 7 }, u.token);
    assert.equal(r.status, 400, finishDate);
    assert.match(r.body.error, /finishDate must be a real date/);
  }
  const [still] = await libraryOf(u.token);
  assert.equal(still.finishDate, '2026-10-16');
  assert.equal(still.score, null, 'a refused edit was written in part');
});

test('a score or a reread count that is not a number is refused rather than read as one', async () => {
  // Number(true) is 1 and Number(' ') is 0: a score nobody gave.
  const u = await newUser();
  const e = await addEntry(u.token);
  for (const patch of [{ score: true }, { score: ' ' }, { score: [5] }, { rereads: false }, { rereads: [2] }]) {
    const r = await api('PUT', `/api/library/${e.id}`, patch, u.token);
    assert.equal(r.status, 400, JSON.stringify(patch));
  }
  assert.equal((await libraryOf(u.token))[0].score, null);
  // Numeric strings still count, as they do on the form.
  const r = await api('PUT', `/api/library/${e.id}`, { score: '8', rereads: '2' }, u.token);
  assert.equal(r.body.score, 8);
  assert.equal(r.body.rereads, 2);
});

// --- reading history: the pages ---------------------------------------------

test('a page count JSON reads as Infinity is held in range rather than answered with a 500', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  const read = (n, pages) => rawJson('POST', '/api/history',
    `{"libraryId":"${e.id}","chapterUrl":"https://x.test/c/${n}","seconds":60,"pages":${pages}}`, u.token);

  const inf = await read(1, '1e400');
  assert.equal(inf.status, 201, JSON.stringify(inf.body));
  assert.equal(inf.body.pages, MAX_PAGES, 'held at the cap, as a session past its cap is');
  assert.equal((await read(2, '-1e400')).body.pages, 0);
  assert.equal((await read(3, '-12')).body.pages, 0);
  assert.equal((await read(4, '"many"')).body.pages, 0);
  // Past 2^53 the row was stored, and every later read of the history failed.
  assert.equal((await read(5, '1e16')).body.pages, MAX_PAGES);
  assert.equal((await read(6, '40')).body.pages, 40);

  const list = await api('GET', '/api/history', undefined, u.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 6);
  assert.equal((await api('GET', '/api/history/stats', undefined, u.token)).status, 200);
});

test('a read is held to a restored row\'s rules: an http(s) chapter, and a label that is text', async () => {
  // The web app's history page links every row to its chapter.
  const u = await newUser();
  const e = await addEntry(u.token);
  for (const chapterUrl of ['javascript:alert(1)', 'data:text/html,x', 'chapter-12', 12]) {
    const r = await api('POST', '/api/history', { libraryId: e.id, chapterUrl, seconds: 60 }, u.token);
    assert.equal(r.status, 400, JSON.stringify(chapterUrl));
    assert.match(r.body.error, /chapterUrl must be an http\(s\) address/);
  }
  assert.deepEqual((await api('GET', '/api/history', undefined, u.token)).body, []);

  // A label that is not text is no label, as in a restored row, where it was a
  // 500; and an empty one leaves the label already there.
  const read = (chapterLabel) => api('POST', '/api/history',
    { libraryId: e.id, chapterUrl: 'https://x.test/c/1', chapterLabel, seconds: 60 }, u.token);
  const odd = await read({ chapter: 1 });
  assert.equal(odd.status, 201, JSON.stringify(odd.body));
  assert.equal(odd.body.chapterLabel, null);
  await read('Chapter 1');
  assert.equal((await read('')).body.chapterLabel, 'Chapter 1');
});

// --- bookmarks --------------------------------------------------------------

test('a bookmark whose chapter is not an http(s) address is refused', async () => {
  // Every client offers the bookmark's chapter as "continue reading".
  const u = await newUser();
  const e = await addEntry(u.token);
  for (const chapterUrl of ['javascript:alert(1)', 'data:text/html,x', 'chapter-12', 12]) {
    const r = await api('PUT', `/api/progress/${e.id}`, { chapterUrl }, u.token);
    assert.equal(r.status, 400, JSON.stringify(chapterUrl));
    assert.match(r.body.error, /chapterUrl must be an http\(s\) address/);
  }
  assert.deepEqual(await progressOf(u.token), []);
});

test('a bookmark\'s numbers are never stored past what a reader can be put back at', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  const put = (fields) => rawJson('PUT', `/api/progress/${e.id}`,
    `{"chapterUrl":"https://x.test/c/1",${fields}}`, u.token);
  const numbers = (r) => [r.body.page, r.body.pageCount, r.body.scrollPos];

  // A page that is not one is the first page, a count that is not one is not
  // known, and the position is a fraction of the chapter (routes/progress.js).
  let r = await put('"page":-5,"pageCount":-3,"scrollPos":7');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(numbers(r), [0, null, 1], 'past the end of the chapter is its end');
  r = await put('"page":"abc","pageCount":0,"scrollPos":-0.2');
  assert.deepEqual(numbers(r), [0, 0, 0]);
  r = await put('"page":4.6,"pageCount":"many","scrollPos":"far"');
  assert.deepEqual(numbers(r), [0, null, 0]);

  // Infinity was a 500, and a page past 2^53 was stored and then failed every
  // read of the account's bookmarks, the continue list with them.
  r = await put('"page":1e400,"pageCount":1e400,"scrollPos":1e400');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(numbers(r), [0, null, 0]);
  r = await put('"page":1e16,"pageCount":1e16');
  assert.deepEqual(numbers(r), [0, null, 0]);
  assert.equal((await api('GET', '/api/progress', undefined, u.token)).status, 200);
  assert.equal((await api('GET', '/api/progress/continue', undefined, u.token)).status, 200);

  // A sound bookmark is kept exactly as sent.
  r = await put('"page":7,"pageCount":22,"scrollPos":0.5,"chapterLabel":"Chapter 1"');
  assert.deepEqual([...numbers(r), r.body.chapterLabel], [7, 22, 0.5, 'Chapter 1']);
});

test('a backup cannot carry in the page counts the routes refuse', async () => {
  const u = await newUser();
  const chapter = 'https://scans.test/manga/big/chapter-1/';
  const r = await restore(backupOf([series('Big', 'https://scans.test/manga/big/', {
    progress: { chapterUrl: chapter, page: 1e16, pageCount: 1e16, scrollPos: 0.5 },
    history: [{ chapterUrl: chapter, day: '2026-01-02', pages: 1e16, seconds: 60 }],
  })]), u.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const [bookmark] = await progressOf(u.token);
  assert.deepEqual([bookmark.page, bookmark.pageCount, bookmark.scrollPos], [MAX_PAGES, null, 0.5]);
  const history = await api('GET', '/api/history', undefined, u.token);
  assert.equal(history.status, 200, 'the restored history cannot be read back');
  assert.equal(history.body[0].pages, MAX_PAGES);
});

// --- what kind of work: the backup ------------------------------------------

test('a backup says what kind of work each entry is, and a restore applies it', async () => {
  const source = await newUser();
  await addEntry(source.token, { title: 'Frieren', sourceUrl: 'https://anime.test/frieren', medium: 'anime' });
  await addEntry(source.token, { title: 'Mushoku', sourceUrl: 'https://ln.test/mushoku', medium: 'webnovel' });
  await addEntry(source.token, { title: 'Berserk', sourceUrl: 'https://scans.test/berserk' });
  const file = await buildBackup(source.id);
  assert.deepEqual(file.library.map((e) => e.medium).sort(), ['anime', 'manga', 'webnovel']);

  const target = await newUser();
  const r = await restore(file, target.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const media = Object.fromEntries((await libraryOf(target.token)).map((e) => [e.title, e.medium]));
  assert.deepEqual(media, { Frieren: 'anime', Mushoku: 'webnovel', Berserk: 'manga' },
    'an anime came back from the restore as a manga');
});

test('a medium nobody knows restores as manga, and a series already here keeps its own', async () => {
  const u = await newUser();
  await addEntry(u.token, { title: 'Kept', sourceUrl: 'https://scans.test/kept', medium: 'webtoon' });
  const r = await restore(backupOf([
    series('Odd', 'https://scans.test/odd', { medium: 'donghua' }),
    // Written before backups carried the field.
    series('Old file', 'https://scans.test/old'),
    // The medium is set once, when a series is added: a restore fills blanks,
    // and this is never one.
    series('Kept', 'https://scans.test/kept', { medium: 'anime', score: 6 }),
  ]), u.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added, 2);

  const lib = await libraryOf(u.token);
  const media = Object.fromEntries(lib.map((e) => [e.title, e.medium]));
  assert.deepEqual(media, { Odd: 'manga', 'Old file': 'manga', Kept: 'webtoon' });
  assert.equal(lib.find((e) => e.title === 'Kept').score, 6, 'the blank the file could fill was not filled');
});
