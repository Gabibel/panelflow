// One account can never reach another account's rows by naming their ids.
//
// Every route that takes an id from the path or the body (a series, a shelf,
// a bookmark, a tracker link, a history row) is asked by account B with
// account A's ids, and A's data is then read back unchanged. Ids are not
// secret: they travel in exports, in URLs and in the clients' storage, so a
// route that trusted one without checking whose it is would hand any account
// to anyone who had seen one of its ids (QA, P5).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, addEntry, shutdown } from '../test-support/harness.js';

after(shutdown);

const CHAPTER = 'https://scans.test/manga/silent-tide/chapter-3/';

/** Account A with one of everything: a series, a shelf, a bookmark, a read. */
async function populated() {
  const a = await newUser();
  const entry = await addEntry(a.token, { title: 'Silent Tide', sourceUrl: 'https://scans.test/manga/silent-tide/' });
  const shelf = (await api('POST', '/api/categories', { name: 'Weekly' }, a.token)).body;
  assert.ok(shelf?.id, `no shelf: ${JSON.stringify(shelf)}`);
  const mark = await api('PUT', `/api/progress/${entry.id}`, { chapterUrl: CHAPTER, chapterLabel: 'Chapter 3', page: 4 }, a.token);
  assert.equal(mark.status, 200, JSON.stringify(mark.body));
  const read = await api('POST', '/api/history', { libraryId: entry.id, chapterUrl: CHAPTER, chapterLabel: 'Chapter 3', pages: 10, seconds: 300 }, a.token);
  assert.equal(read.status, 201, JSON.stringify(read.body));
  return { a, entry, shelf };
}

/** What A holds, as A reads it. */
async function snapshot(token) {
  const get = async (path) => (await api('GET', path, undefined, token)).body;
  return {
    library: await get('/api/library'),
    shelves: await get('/api/categories'),
    progress: await get('/api/progress'),
    history: await get('/api/history'),
  };
}

test('another account\'s ids open nothing and change nothing', async () => {
  const { a, entry, shelf } = await populated();
  const before = await snapshot(a.token);
  const b = await newUser();

  const attempts = [
    ['PUT', `/api/library/${entry.id}`, { title: 'Taken', score: 1 }],
    ['DELETE', `/api/library/${entry.id}`],
    ['POST', `/api/library/${entry.id}/migrate`, { sourceUrl: 'https://evil.test/manga/x/', sourceDomain: 'evil.test' }],
    ['POST', '/api/library/migrate-bulk', { items: [{ id: entry.id, sourceUrl: 'https://evil.test/manga/x/', sourceDomain: 'evil.test' }] }],
    ['PUT', `/api/categories/${shelf.id}`, { name: 'Taken' }],
    ['DELETE', `/api/categories/${shelf.id}`],
    ['PUT', `/api/progress/${entry.id}`, { chapterUrl: 'https://scans.test/manga/silent-tide/chapter-99/', chapterLabel: 'Chapter 99' }],
    ['POST', '/api/history', { libraryId: entry.id, chapterUrl: CHAPTER, seconds: 999 }],
    ['PUT', `/api/trackers/anilist/link/${entry.id}`, { state: 'muted' }],
    ['DELETE', `/api/trackers/anilist/link/${entry.id}`],
    ['POST', `/api/trackers/anilist/add/${entry.id}`, {}],
    ['DELETE', `/api/trackers/anilist/entry/${entry.id}`],
    ['POST', '/api/news/seen', { items: [{ libraryId: entry.id, chapter: '4' }] }],
  ];
  for (const [method, path, body] of attempts) {
    const r = await api(method, path, body, b.token);
    // Refused, or a no-op on B's own (empty) account: never a success on A's row.
    assert.ok(r.status >= 400 || method === 'POST' && /migrate-bulk|news\/seen/.test(path),
      `${method} ${path} answered ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    if (/migrate-bulk/.test(path)) assert.equal(r.body.moved, 0, 'a bulk move reached another account');
  }

  // A's account, read back, is exactly what it was.
  assert.deepEqual(await snapshot(a.token), before);
  // And B saw none of it.
  const seen = await snapshot(b.token);
  assert.deepEqual(seen.library, []);
  assert.deepEqual(seen.progress, []);
  assert.deepEqual(seen.history, []);
  assert.deepEqual(seen.shelves.filter((s) => s.id === shelf.id), []);
});

test('an export holds the account that asked for it and nobody else', async () => {
  const { a } = await populated();
  const b = await newUser();
  await addEntry(b.token, { title: 'Own Series', sourceUrl: 'https://scans.test/manga/own/' });
  const file = (await api('GET', '/api/export', undefined, b.token)).body;
  assert.deepEqual(file.library.map((e) => e.title), ['Own Series']);
  assert.equal(JSON.stringify(file).includes('Silent Tide'), false, 'A\'s series reached B\'s export');
  assert.equal(JSON.stringify(file).includes(a.email), false, 'A\'s address reached B\'s export');
});
