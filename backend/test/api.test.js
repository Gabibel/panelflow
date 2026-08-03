// Smoke suite: one happy path per surface. The per-surface files next to this
// one go deep; this one exists so a broken wiring shows up immediately.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, shutdown } from '../test-support/harness.js';

let token, libId;

after(shutdown);

test('health', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('register + login', async () => {
  let r = await api('POST', '/api/auth/register', { email: 'a@b.test', password: 'password123' });
  assert.equal(r.status, 201);
  assert.ok(r.body.token);

  r = await api('POST', '/api/auth/register', { email: 'a@b.test', password: 'password123' });
  assert.equal(r.status, 409);

  r = await api('POST', '/api/auth/login', { email: 'a@b.test', password: 'wrongpass1' });
  assert.equal(r.status, 401);

  r = await api('POST', '/api/auth/login', { email: 'a@b.test', password: 'password123' });
  assert.equal(r.status, 200);
  token = r.body.token;
});

test('auth required', async () => {
  const r = await api('GET', '/api/library');
  assert.equal(r.status, 401);
});

test('library CRUD', async () => {
  let r = await api('POST', '/api/library', {
    title: 'One Test Piece',
    sourceDomain: 'example-manga-site.test',
    sourceUrl: 'https://example-manga-site.test/manga/one-test-piece',
    tags: ['action'],
  }, token);
  assert.equal(r.status, 201);
  libId = r.body.id;
  assert.equal(r.body.title, 'One Test Piece');

  r = await api('GET', '/api/library', undefined, token);
  assert.equal(r.body.length, 1);

  r = await api('PUT', `/api/library/${libId}`, { lastKnownChapter: 'ch-42' }, token);
  assert.equal(r.body.lastKnownChapter, 'ch-42');

  r = await api('DELETE', `/api/library/${libId}`, undefined, token);
  assert.equal(r.status, 204);
  r = await api('GET', '/api/library', undefined, token);
  assert.equal(r.body.length, 0);

  // Re-pin resurrects the same entry (same id).
  r = await api('POST', '/api/library', {
    title: 'One Test Piece',
    sourceDomain: 'example-manga-site.test',
    sourceUrl: 'https://example-manga-site.test/manga/one-test-piece',
  }, token);
  assert.equal(r.body.id, libId);
});

test('library entry details', async () => {
  let r = await api('POST', '/api/library', {
    title: 'Detailed Test Manga',
    sourceDomain: 'example-manga-site.test',
    sourceUrl: 'https://example-manga-site.test/manga/detailed',
    folder: 'plan',
    language: 'English',
    score: 8,
    startDate: '2026-07-25',
  }, token);
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal(r.body.folder, 'plan');
  assert.equal(r.body.score, 8);
  assert.equal(r.body.startDate, '2026-07-25');
  assert.equal(r.body.rereads, 0);

  // New entries default to "reading" rather than a null folder.
  r = await api('POST', '/api/library', {
    title: 'Bare Test Manga',
    sourceDomain: 'example-manga-site.test',
    sourceUrl: 'https://example-manga-site.test/manga/bare',
  }, token);
  assert.equal(r.body.folder, 'reading');

  // An omitted key keeps the stored value...
  r = await api('PUT', `/api/library/${id}`, { folder: 'completed' }, token);
  assert.equal(r.body.folder, 'completed');
  assert.equal(r.body.score, 8, 'omitted score must survive the update');

  // ...but an explicit null clears it.
  r = await api('PUT', `/api/library/${id}`, { score: null, startDate: null }, token);
  assert.equal(r.body.score, null);
  assert.equal(r.body.startDate, null);

  r = await api('PUT', `/api/library/${id}`, { folder: 'not-a-folder' }, token);
  assert.equal(r.status, 400);
  r = await api('PUT', `/api/library/${id}`, { score: 42 }, token);
  assert.equal(r.status, 400);
  r = await api('PUT', `/api/library/${id}`, { startDate: '25/07/2026' }, token);
  assert.equal(r.status, 400);
});

test('progress upsert + continue reading', async () => {
  let r = await api('PUT', `/api/progress/${libId}`, {
    chapterUrl: 'https://example-manga-site.test/manga/one-test-piece/ch-42',
    chapterLabel: 'Chapter 42',
    page: 7,
    pageCount: 20,
    scrollPos: 0.35,
  }, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.page, 7);

  r = await api('PUT', `/api/progress/${libId}`, {
    chapterUrl: 'https://example-manga-site.test/manga/one-test-piece/ch-43',
    chapterLabel: 'Chapter 43',
    page: 1,
  }, token);
  assert.equal(r.body.chapterLabel, 'Chapter 43');

  r = await api('GET', '/api/progress/continue', undefined, token);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].title, 'One Test Piece');
  assert.equal(r.body[0].chapterLabel, 'Chapter 43');
});

test('rules remote config', async () => {
  const r = await api('GET', '/api/rules');
  assert.equal(r.status, 200);
  assert.ok(r.body.heuristics.scoreThreshold >= 0);
  assert.ok(Array.isArray(r.body.heuristics.urlPatterns));
});

test('meta scrape rejects private and invalid urls', async () => {
  let r = await api('GET', '/api/meta/scrape?url=http://localhost:8787/', undefined, token);
  assert.equal(r.status, 400);
  r = await api('GET', '/api/meta/scrape?url=http://192.168.1.1/', undefined, token);
  assert.equal(r.status, 400);
  r = await api('GET', '/api/meta/scrape?url=not-a-url', undefined, token);
  assert.equal(r.status, 400);
  r = await api('GET', '/api/meta/scrape?url=ftp://example.com/x', undefined, token);
  assert.equal(r.status, 400);
});

test('trackers require configuration', async () => {
  const r = await api('POST', '/api/trackers/anilist/connect', {}, token);
  assert.equal(r.status, 501); // no client id configured in test env
  const list = await api('GET', '/api/trackers', undefined, token);
  assert.deepEqual(list.body, []);
});
