// Reading history and the statistics built on it.
//
// The one thing worth being careful about here is that history is *derived*
// from behaviour the user cannot restate: if a chapter is counted twice, or a
// suspended laptop books four hours of reading, nobody can tell by looking.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { streaks } from '../src/routes/history.js';

after(shutdown);

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

test('a read is recorded and read back', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token, { title: 'Berserk' });

  const r = await api('POST', '/api/history', {
    libraryId: entry.id,
    chapterUrl: 'https://example-manga-site.test/manga/berserk/1',
    chapterLabel: 'Chapter 1',
    pages: 40,
    seconds: 300,
  }, u.token);
  assert.equal(r.status, 201);
  assert.equal(r.body.seconds, 300);
  assert.equal(r.body.day, today());

  const list = await api('GET', '/api/history', undefined, u.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].title, 'Berserk');
  assert.equal(list.body[0].removed, false);
});

test('the same chapter on the same day is one read with the time added up', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token);
  const post = (seconds, pages) => api('POST', '/api/history', {
    libraryId: entry.id, chapterUrl: 'https://x.test/c/1', chapterLabel: 'Chapter 1',
    seconds, pages,
  }, u.token);

  await post(120, 10);
  await post(90, 4);   // read on, then went back a few pages
  const list = await api('GET', '/api/history', undefined, u.token);
  assert.equal(list.body.length, 1, 'closing and reopening a chapter is one read');
  assert.equal(list.body[0].seconds, 210);
  assert.equal(list.body[0].pages, 10, 'pages is how far it got, not a running total');
});

test('the same chapter on another day is a reread', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token);
  const body = { libraryId: entry.id, chapterUrl: 'https://x.test/c/1', seconds: 60 };
  await api('POST', '/api/history', { ...body, day: daysAgo(3) }, u.token);
  await api('POST', '/api/history', body, u.token);

  const stats = await api('GET', '/api/history/stats', undefined, u.token);
  assert.equal(stats.body.chapters, 2);
  assert.equal(stats.body.series, 1);
});

test('an implausible session is capped rather than believed', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token);
  // A machine that slept for two days mid-chapter and woke up still on it.
  const r = await api('POST', '/api/history', {
    libraryId: entry.id, chapterUrl: 'https://x.test/c/9', seconds: 172800,
  }, u.token);
  assert.equal(r.status, 201);
  assert.ok(r.body.seconds <= 4 * 3600, `capped, got ${r.body.seconds}`);
});

test('a day the client invents is refused, not stored', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token);
  for (const day of ['not-a-day', '2099-01-01', '20260101']) {
    const r = await api('POST', '/api/history', {
      libraryId: entry.id, chapterUrl: 'https://x.test/c/' + day, seconds: 10, day,
    }, u.token);
    assert.equal(r.body.day, today(), `${day} should fall back to today`);
  }
});

test('history belongs to one account', async () => {
  const a = await newUser();
  const b = await newUser();
  const entry = await addEntry(a.token);
  await api('POST', '/api/history',
    { libraryId: entry.id, chapterUrl: 'https://x.test/c/1', seconds: 60 }, a.token);

  // b cannot write against a's entry, and cannot see a's reads.
  const write = await api('POST', '/api/history',
    { libraryId: entry.id, chapterUrl: 'https://x.test/c/1', seconds: 60 }, b.token);
  assert.equal(write.status, 404);
  const list = await api('GET', '/api/history', undefined, b.token);
  assert.deepEqual(list.body, []);
});

test('history outlives the library entry it points at', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token, { title: 'Removed Later' });
  await api('POST', '/api/history',
    { libraryId: entry.id, chapterUrl: 'https://x.test/c/1', seconds: 60 }, u.token);
  await api('DELETE', '/api/library/' + entry.id, undefined, u.token);

  const list = await api('GET', '/api/history', undefined, u.token);
  assert.equal(list.body.length, 1, 'removing a series must not rewrite what you read');
  assert.equal(list.body[0].removed, true);
});

test('stats add up over several series and days', async () => {
  const u = await newUser();
  const a = await addEntry(u.token, { title: 'A', folder: 'reading' });
  const b = await addEntry(u.token, { title: 'B', folder: 'completed', score: 8 });

  await api('POST', '/api/history',
    { libraryId: a.id, chapterUrl: 'https://x.test/a/1', seconds: 100, pages: 20 }, u.token);
  await api('POST', '/api/history',
    { libraryId: a.id, chapterUrl: 'https://x.test/a/2', seconds: 200, pages: 20 }, u.token);
  await api('POST', '/api/history',
    { libraryId: b.id, chapterUrl: 'https://x.test/b/1', seconds: 300, day: daysAgo(1) }, u.token);

  const s = (await api('GET', '/api/history/stats', undefined, u.token)).body;
  assert.equal(s.chapters, 3);
  assert.equal(s.seconds, 600);
  assert.equal(s.series, 2);
  assert.equal(s.days.length, 2);
  assert.equal(s.days[0].day, today(), 'newest day first');
  assert.equal(s.secondsPerDay, 300);
  assert.equal(s.current, 2, 'today and yesterday');
  assert.deepEqual(s.folders, { reading: 1, completed: 1 });
  assert.equal(s.entries, 2);
  assert.equal(s.scored, 1);
  assert.equal(s.avgScore, 8);
  assert.equal(s.topSeries[0].title, 'A');
  assert.equal(s.topSeries[0].chapters, 2);
});

test('an account that has read nothing gets zeroes, not nulls', async () => {
  const u = await newUser();
  const s = (await api('GET', '/api/history/stats', undefined, u.token)).body;
  assert.equal(s.chapters, 0);
  assert.equal(s.seconds, 0);
  assert.equal(s.secondsPerDay, 0);
  assert.equal(s.current, 0);
  assert.equal(s.longest, 0);
  assert.equal(s.avgScore, 0);
  assert.deepEqual(s.days, []);
  assert.equal(s.firstDay, null);
});

test('clearing history leaves the library alone', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token);
  await api('POST', '/api/history',
    { libraryId: entry.id, chapterUrl: 'https://x.test/c/1', seconds: 60 }, u.token);

  const r = await api('DELETE', '/api/history', undefined, u.token);
  assert.equal(r.body.removed, 1);
  assert.deepEqual((await api('GET', '/api/history', undefined, u.token)).body, []);
  assert.equal((await api('GET', '/api/library', undefined, u.token)).body.length, 1);
});

test('history requires auth', async () => {
  for (const [method, path] of [['GET', '/api/history'], ['GET', '/api/history/stats'],
    ['POST', '/api/history'], ['DELETE', '/api/history']]) {
    const r = await api(method, path, method === 'POST' ? {} : undefined, null);
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('a streak is unbroken until the missed day is over', () => {
  // Read yesterday, not yet today: still a streak. Reading today extends it.
  assert.deepEqual(streaks(['2026-08-03', '2026-08-02'], '2026-08-04'), { current: 2, longest: 2 });
  assert.deepEqual(streaks(['2026-08-04', '2026-08-03'], '2026-08-04'), { current: 2, longest: 2 });
  // A two-day gap ends it, but the longest run is still remembered.
  assert.deepEqual(
    streaks(['2026-08-01', '2026-07-31', '2026-07-30'], '2026-08-04'),
    { current: 0, longest: 3 });
  assert.deepEqual(streaks([], '2026-08-04'), { current: 0, longest: 0 });
  // Across a month boundary, which is where hand-rolled date maths goes wrong.
  assert.deepEqual(
    streaks(['2026-08-01', '2026-07-31'], '2026-08-01'), { current: 2, longest: 2 });
});
