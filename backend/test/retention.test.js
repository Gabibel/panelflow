// How long a removed series stays on the server.
//
// Removing a series hides it, so that adding it back restores it as it was.
// The QA pass of September 2026 found that grace had no end — every series a
// reader had ever removed, note and bookmark and history included, stayed until
// the account went — while the privacy page said it went with the series. It
// now lasts REMOVED_GRACE_DAYS, and the privacy page quotes that figure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, addEntry, newUser, shutdown } from '../test-support/harness.js';
import { pruneRemovedSeries, REMOVED_GRACE_DAYS } from '../src/routes/library.js';
import { db } from '../src/db.js';

after(shutdown);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A series with a bookmark and a day of history, then removed. */
async function removed(u, slug) {
  const e = await addEntry(u.token, { title: `Series ${slug}`, sourceUrl: `https://scan.test/manga/${slug}`, note: 'mine' });
  await api('PUT', `/api/progress/${e.id}`, { chapterUrl: `https://scan.test/manga/${slug}/12`, chapterLabel: 'Ch. 12' }, u.token);
  await api('POST', '/api/history', {
    libraryId: e.id, chapterUrl: `https://scan.test/manga/${slug}/12`, chapterLabel: 'Ch. 12', pages: 10, seconds: 60,
  }, u.token);
  assert.equal((await api('DELETE', `/api/library/${e.id}`, undefined, u.token)).status, 204);
  return e;
}

const count = async (table, id) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'library' ? 'id' : 'library_id'} = ?`).get(id)).n;

test('a series removed within the grace comes back as it was', async () => {
  const u = await newUser();
  const e = await removed(u, 'recent');
  await pruneRemovedSeries();
  const back = await addEntry(u.token, { title: 'Series recent', sourceUrl: 'https://scan.test/manga/recent' });
  assert.equal(back.id, e.id);
  assert.equal(back.note, 'mine');
  assert.equal(await count('progress', e.id), 1);
});

test('after the grace the series is erased, with its bookmark and its history', async () => {
  const u = await newUser();
  const e = await removed(u, 'old');
  await db.prepare("UPDATE library SET updated_at = datetime('now', ?) WHERE id = ?")
    .run(`-${REMOVED_GRACE_DAYS + 1} days`, e.id);
  await pruneRemovedSeries();
  for (const table of ['library', 'progress', 'history']) {
    assert.equal(await count(table, e.id), 0, `${table} still holds the removed series`);
  }
  // A series still on the shelf is never touched, however old.
  const kept = await addEntry(u.token, { title: 'Kept', sourceUrl: 'https://scan.test/manga/kept' });
  await db.prepare("UPDATE library SET updated_at = datetime('now', '-400 days') WHERE id = ?").run(kept.id);
  await pruneRemovedSeries();
  assert.equal(await count('library', kept.id), 1);
});

test('the nightly run is what sweeps it, and the privacy page gives the same figure', () => {
  assert.match(readFileSync(join(root, 'backend', 'src', 'routes', 'watch.js'), 'utf8'), /pruneRemovedSeries\(\)/);
  const privacy = readFileSync(join(root, 'web', 'confidentialite.html'), 'utf8');
  assert.ok(privacy.includes(`${REMOVED_GRACE_DAYS} jours après que vous l'avez retirée`),
    'the privacy page does not say how long a removed series stays');
  const english = readFileSync(join(root, 'web', 'privacy.html'), 'utf8');
  assert.ok(english.includes(`${REMOVED_GRACE_DAYS} days after you remove it`));
});
