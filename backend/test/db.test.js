// The driver swap (node:sqlite → @libsql/client) is the riskiest part of the
// Vercel migration: the routes kept their `prepare().get/all/run` shape, so a
// difference in how the adapter binds values or reports row counts would be
// invisible until it corrupted data. These tests pin the adapter itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import '../test-support/harness.js';
import { db, dbReady, uid } from '../src/db.js';
import { shutdown } from '../test-support/harness.js';

after(shutdown);

test('the schema is created before the first query resolves', async () => {
  const tables = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all();
  const names = tables.map((t) => t.name);
  for (const expected of ['library', 'progress', 'trackers', 'users']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
});

test('the additive migrations ran', async () => {
  const cols = await db.prepare("SELECT name FROM pragma_table_info('library')").all();
  const names = new Set(cols.map((c) => c.name));
  for (const expected of ['folder', 'language', 'score', 'note', 'start_date',
                          'finish_date', 'rereads', 'series_status']) {
    assert.ok(names.has(expected), `missing column ${expected}`);
  }
});

test('migrating twice is a no-op', async () => {
  // dbReady memoises, so a second call must resolve without re-running ALTER
  // TABLE (which would throw "duplicate column name").
  await dbReady();
  await dbReady();
  await dbReady();
  const cols = await db.prepare("SELECT count(*) AS n FROM pragma_table_info('library')").get();
  assert.ok(cols.n > 10);
});

test('run() reports affected rows as .changes', async () => {
  const id = uid();
  await db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(id, `changes-${id}@test.dev`, 'x');

  const hit = await db.prepare('UPDATE users SET tier = ? WHERE id = ?').run('pro', id);
  assert.equal(hit.changes, 1, 'libsql rowsAffected must surface as .changes');
  assert.equal(typeof hit.changes, 'number', 'not a BigInt — routes compare with ===');

  const miss = await db.prepare('UPDATE users SET tier = ? WHERE id = ?').run('pro', 'nobody');
  assert.equal(miss.changes, 0, 'the 404 paths depend on this being exactly 0');

  const del = await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  assert.equal(del.changes, 1);
});

test('get() returns undefined when there is no row', async () => {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get('definitely-not-there');
  assert.equal(row, undefined, 'routes branch on falsiness to answer 404');
});

test('all() returns a real array', async () => {
  const rows = await db.prepare('SELECT * FROM users WHERE id = ?').all('nope');
  assert.ok(Array.isArray(rows), 'the routes call rows.map()');
  assert.equal(rows.length, 0);
  assert.deepEqual(rows.map((r) => r.id), []);
});

test('undefined bindings are accepted and stored as NULL', async () => {
  // node:sqlite tolerated `undefined`; libsql rejects it outright. Route code
  // still passes `req.body.something` straight through, so the adapter has to
  // absorb it or every optional field becomes a 500.
  assert.equal((await db.prepare('SELECT ? AS v').get(undefined)).v, null);

  const uId = uid();
  await db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(uId, `undef-${uId}@test.dev`, 'x');
  const lId = uid();
  await db.prepare(
    'INSERT INTO library (id, user_id, title, source_domain, source_url, cover_url, score) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(lId, uId, 'Undef', 'd.test', `https://d.test/${lId}`, undefined, undefined);
  const row = await db.prepare('SELECT cover_url, score FROM library WHERE id = ?').get(lId);
  assert.equal(row.cover_url, null);
  assert.equal(row.score, null);
});

test('booleans are bound as 0/1', async () => {
  const uId = uid();
  await db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(uId, `bool-${uId}@test.dev`, 'x');
  const lId = uid();
  await db.prepare(
    'INSERT INTO library (id, user_id, title, source_domain, source_url, deleted) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(lId, uId, 'Bool', 'd.test', `https://d.test/${lId}`, true);
  const row = await db.prepare('SELECT deleted FROM library WHERE id = ?').get(lId);
  assert.equal(row.deleted, 1, 'SQLite has no boolean type');
});

test('column types come back as JavaScript numbers, not BigInt', async () => {
  const uId = uid();
  await db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(uId, `num-${uId}@test.dev`, 'x');
  const lId = uid();
  await db.prepare(
    'INSERT INTO library (id, user_id, title, source_domain, source_url, score, rereads) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(lId, uId, 'Num', 'd.test', `https://d.test/${lId}`, 7, 2);
  await db.prepare(`
    INSERT INTO progress (user_id, library_id, chapter_url, page, scroll_pos)
    VALUES (?, ?, ?, ?, ?)
  `).run(uId, lId, 'https://d.test/c/1', 12, 0.5);

  const lib = await db.prepare('SELECT score, rereads, deleted FROM library WHERE id = ?').get(lId);
  assert.equal(typeof lib.score, 'number');
  assert.equal(typeof lib.rereads, 'number');
  assert.equal(typeof lib.deleted, 'number');
  const prog = await db.prepare('SELECT page, scroll_pos FROM progress WHERE library_id = ?').get(lId);
  assert.equal(typeof prog.page, 'number');
  assert.equal(prog.scroll_pos, 0.5, 'REAL must not be truncated');
  // JSON.stringify chokes on BigInt; every route serialises rows straight out.
  assert.doesNotThrow(() => JSON.stringify({ lib, prog }));
});

test('rows spread and destructure like plain objects', async () => {
  const row = await db.prepare("SELECT 'a' AS x, 2 AS y").get();
  const { x, y } = row;
  assert.equal(x, 'a');
  assert.equal(y, 2);
  assert.equal(JSON.parse(JSON.stringify({ ...row })).x, 'a');
});

test('parameters are bound, never concatenated', async () => {
  const evil = "'; DROP TABLE users; --";
  const row = await db.prepare('SELECT ? AS v').get(evil);
  assert.equal(row.v, evil);
  const users = await db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get();
  assert.ok(users, 'the users table is still standing');
});

test('foreign keys cascade a deleted user away', async () => {
  const uId = uid();
  await db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(uId, `cascade-${uId}@test.dev`, 'x');
  const lId = uid();
  await db.prepare(
    'INSERT INTO library (id, user_id, title, source_domain, source_url) VALUES (?, ?, ?, ?, ?)'
  ).run(lId, uId, 'Cascade', 'd.test', `https://d.test/${lId}`);

  await db.prepare('DELETE FROM users WHERE id = ?').run(uId);
  const orphan = await db.prepare('SELECT id FROM library WHERE id = ?').get(lId);
  assert.equal(orphan, undefined, 'ON DELETE CASCADE must be active');
});

test('uid() produces distinct v4 uuids', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = uid();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});

test('concurrent queries do not race the one-time migration', async () => {
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) => db.prepare('SELECT ? AS n').get(i))
  );
  assert.deepEqual(results.map((r) => r.n), Array.from({ length: 25 }, (_, i) => i));
});
