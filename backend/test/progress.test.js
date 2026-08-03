import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, addEntry, newUser, shutdown } from '../test-support/harness.js';

after(shutdown);

const chapter = (n) => `https://example-manga-site.test/manga/x/ch-${n}`;

test('progress needs a chapter url', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  for (const body of [{}, { chapterLabel: 'Ch. 1' }, { chapterUrl: '' }, { chapterUrl: null }]) {
    const r = await api('PUT', `/api/progress/${e.id}`, body, u.token);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('progress on an unknown entry is 404', async () => {
  const u = await newUser();
  const r = await api('PUT', '/api/progress/no-such-entry', { chapterUrl: chapter(1) }, u.token);
  assert.equal(r.status, 404);
});

test('progress cannot be written onto another user entry', async () => {
  const a = await newUser();
  const b = await newUser();
  const ea = await addEntry(a.token);
  const r = await api('PUT', `/api/progress/${ea.id}`, { chapterUrl: chapter(1) }, b.token);
  assert.equal(r.status, 404, "B must not be able to write into A's entry");
  assert.equal((await api('GET', '/api/progress', undefined, a.token)).body.length, 0);
});

test('a minimal write gets the documented defaults', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  const r = await api('PUT', `/api/progress/${e.id}`, { chapterUrl: chapter(1) }, u.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.libraryId, e.id, 'libraryId must be mapped from library_id');
  assert.equal(r.body.chapterUrl, chapter(1));
  assert.equal(r.body.chapterLabel, null);
  assert.equal(r.body.page, 0);
  assert.equal(r.body.pageCount, null);
  assert.equal(r.body.scrollPos, 0);
  assert.ok(r.body.updatedAt);
});

test('page 0 and scrollPos 0 are stored, not defaulted away', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  let r = await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: chapter(1), page: 5, pageCount: 20, scrollPos: 0.9,
  }, u.token);
  assert.equal(r.body.page, 5);
  // Going back to the top of a chapter is a real update, not a no-op.
  r = await api('PUT', `/api/progress/${e.id}`, { chapterUrl: chapter(1), page: 0, scrollPos: 0 }, u.token);
  assert.equal(r.body.page, 0);
  assert.equal(r.body.scrollPos, 0);
});

test('a fractional scroll position keeps its precision', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  const r = await api('PUT', `/api/progress/${e.id}`, { chapterUrl: chapter(1), scrollPos: 0.123456 }, u.token);
  assert.equal(r.body.scrollPos, 0.123456);
});

test('writing again upserts instead of duplicating', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  for (let n = 1; n <= 5; n++) {
    await api('PUT', `/api/progress/${e.id}`, {
      chapterUrl: chapter(n), chapterLabel: `Ch. ${n}`, page: n, pageCount: 30,
    }, u.token);
  }
  const all = await api('GET', '/api/progress', undefined, u.token);
  assert.equal(all.body.length, 1, 'one row per (user, entry)');
  assert.equal(all.body[0].chapterLabel, 'Ch. 5');
  assert.equal(all.body[0].page, 5);
});

test('progress is per-user', async () => {
  const a = await newUser();
  const b = await newUser();
  const ea = await addEntry(a.token);
  const eb = await addEntry(b.token);
  await api('PUT', `/api/progress/${ea.id}`, { chapterUrl: chapter(1), chapterLabel: 'A' }, a.token);
  await api('PUT', `/api/progress/${eb.id}`, { chapterUrl: chapter(2), chapterLabel: 'B' }, b.token);
  assert.equal((await api('GET', '/api/progress', undefined, a.token)).body[0].chapterLabel, 'A');
  assert.equal((await api('GET', '/api/progress', undefined, b.token)).body[0].chapterLabel, 'B');
});

test('continue reading carries the series metadata', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, {
    title: 'Continue Me', coverUrl: 'https://cdn.test/c.jpg', sourceDomain: 'asura.test',
  });
  await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: chapter(9), chapterLabel: 'Ch. 9', page: 2, pageCount: 18,
  }, u.token);
  const r = await api('GET', '/api/progress/continue', undefined, u.token);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].title, 'Continue Me');
  assert.equal(r.body[0].coverUrl, 'https://cdn.test/c.jpg');
  assert.equal(r.body[0].sourceDomain, 'asura.test');
  assert.equal(r.body[0].chapterLabel, 'Ch. 9');
  assert.equal(r.body[0].libraryId, e.id);
});

test('continue reading drops entries removed from the library', async () => {
  const u = await newUser();
  const kept = await addEntry(u.token, { title: 'Kept' });
  const gone = await addEntry(u.token, { title: 'Gone' });
  await api('PUT', `/api/progress/${kept.id}`, { chapterUrl: chapter(1) }, u.token);
  await api('PUT', `/api/progress/${gone.id}`, { chapterUrl: chapter(2) }, u.token);
  assert.equal((await api('GET', '/api/progress/continue', undefined, u.token)).body.length, 2);

  await api('DELETE', `/api/library/${gone.id}`, undefined, u.token);
  const r = await api('GET', '/api/progress/continue', undefined, u.token);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].title, 'Kept');

  // The raw progress list is not filtered by `deleted` — the row is still there.
  assert.equal((await api('GET', '/api/progress', undefined, u.token)).body.length, 2);
});

test('progress survives a delete + re-pin cycle', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  await api('PUT', `/api/progress/${e.id}`, { chapterUrl: chapter(42), chapterLabel: 'Ch. 42' }, u.token);
  await api('DELETE', `/api/library/${e.id}`, undefined, u.token);
  await api('POST', '/api/library', {
    title: e.title, sourceDomain: 'example-manga-site.test', sourceUrl: e.sourceUrl,
  }, u.token);
  const r = await api('GET', '/api/progress/continue', undefined, u.token);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].chapterLabel, 'Ch. 42', 'the bookmark comes back with the entry');
});

test('continue reading is capped at 20', async () => {
  const u = await newUser();
  for (let i = 0; i < 23; i++) {
    const e = await addEntry(u.token);
    await api('PUT', `/api/progress/${e.id}`, { chapterUrl: chapter(i), chapterLabel: `Ch. ${i}` }, u.token);
  }
  const r = await api('GET', '/api/progress/continue', undefined, u.token);
  assert.equal(r.body.length, 20);
  assert.equal((await api('GET', '/api/progress', undefined, u.token)).body.length, 23);
});

test('continue reading is ordered most-recent-first', async () => {
  const u = await newUser();
  const older = await addEntry(u.token, { title: 'Older' });
  const newer = await addEntry(u.token, { title: 'Newer' });
  await api('PUT', `/api/progress/${older.id}`, { chapterUrl: chapter(1) }, u.token);
  // datetime('now') has second resolution; cross the boundary so the order is
  // a fact about the query rather than about insertion luck.
  await new Promise((r) => setTimeout(r, 1100));
  await api('PUT', `/api/progress/${newer.id}`, { chapterUrl: chapter(2) }, u.token);
  const r = await api('GET', '/api/progress/continue', undefined, u.token);
  assert.equal(r.body[0].title, 'Newer');
  assert.equal(r.body[1].title, 'Older');
});

test('checking chapters does not reorder the library', async () => {
  const u = await newUser();
  const first = await addEntry(u.token, { title: 'First' });
  await new Promise((r) => setTimeout(r, 1100));
  const second = await addEntry(u.token, { title: 'Second' });
  const before = (await api('GET', '/api/library', undefined, u.token)).body.map((e) => e.id);
  assert.deepEqual(before, [second.id, first.id]);

  // Every source URL is unreachable in the test env, so /check touches nothing
  // — which is exactly the invariant: it must never bump updated_at.
  await api('POST', '/api/meta/check', {}, u.token);
  const after = (await api('GET', '/api/library', undefined, u.token)).body.map((e) => e.id);
  assert.deepEqual(after, before);
});
