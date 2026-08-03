// Migrating a series to another scan site is the one operation that destroys a
// row: when the destination is already in the library, the two entries cannot
// both keep the (user_id, source_url) slot. So every one of these tests asks
// the same question — did anything the user built up get lost?
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, addEntry, shutdown } from '../test-support/harness.js';

after(shutdown);

const OLD = 'https://old-scan.test/manga/ao-no-hako';
const NEW = 'https://new-scan.test/read/blue-box';

/** An entry on the old site, with progress, a score and a note. */
async function seeded(token, overrides = {}) {
  const entry = await addEntry(token, {
    title: 'Ao no Hako',
    sourceDomain: 'old-scan.test',
    sourceUrl: OLD,
    coverUrl: 'https://old-scan.test/cover.jpg',
    tags: ['romance'],
    lastKnownChapter: 'Chapitre 109',
    folder: 'reading',
    score: 9,
    note: 'la meilleure',
    language: 'fr',
    startDate: '2024-01-05',
    ...overrides,
  });
  await api('PUT', `/api/progress/${entry.id}`, {
    chapterUrl: `${OLD}/chapitre-42`,
    chapterLabel: 'Chapitre 42',
    page: 7,
    scrollPos: 0.5,
  }, token);
  return entry;
}

const migrate = (token, id, body) =>
  api('POST', `/api/library/${id}/migrate`, {
    sourceUrl: NEW,
    sourceDomain: 'new-scan.test',
    ...body,
  }, token);

// ── finding the duplicate ────────────────────────────────────────────────────

test('match finds the same work on a different site', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);

  const r = await api('POST', '/api/library/match', {
    title: 'Ao no Hako VF - Chapitre 110',
    sourceUrl: `${NEW}/chapitre-110`,
  }, u.token);

  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].entry.id, entry.id);
  assert.equal(r.body[0].confidence, 'same-title');
  assert.equal(typeof r.body[0].score, 'number');
});

test('match recognises the page it is already pinned from', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  const r = await api('POST', '/api/library/match', { title: 'Ao no Hako', sourceUrl: OLD }, u.token);
  assert.equal(r.body[0].confidence, 'same-page');
  assert.equal(r.body[0].entry.id, entry.id);
});

test('match says nothing for a series that is genuinely new', async () => {
  const u = await newUser();
  await seeded(u.token);
  const r = await api('POST', '/api/library/match', {
    title: 'Vinland Saga', sourceUrl: 'https://new-scan.test/read/vinland-saga',
  }, u.token);
  assert.deepEqual(r.body, []);
});

test('match never looks at another account', async () => {
  const a = await newUser();
  await seeded(a.token);
  const b = await newUser();
  const r = await api('POST', '/api/library/match', { title: 'Ao no Hako', sourceUrl: OLD }, b.token);
  assert.deepEqual(r.body, []);
});

test('match ignores entries the user removed', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  await api('DELETE', `/api/library/${entry.id}`, undefined, u.token);
  const r = await api('POST', '/api/library/match', { title: 'Ao no Hako', sourceUrl: NEW }, u.token);
  assert.deepEqual(r.body, []);
});

test('match needs something to match on, and needs auth', async () => {
  const u = await newUser();
  assert.equal((await api('POST', '/api/library/match', {}, u.token)).status, 400);
  assert.equal((await api('POST', '/api/library/match', { title: 'x' })).status, 401);
});

// ── the migration itself ─────────────────────────────────────────────────────

test('migrating repoints the entry and keeps everything around it', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);

  const r = await migrate(u.token, entry.id, { title: 'Blue Box', lastKnownChapter: 'Chapter 112' });
  assert.equal(r.status, 200);

  const after = r.body.entry;
  assert.equal(after.id, entry.id, 'the same row — not a replacement');
  assert.equal(after.sourceUrl, NEW);
  assert.equal(after.sourceDomain, 'new-scan.test');
  assert.equal(after.lastKnownChapter, 'Chapter 112', 'the newer chapter wins');
  // Everything the user chose survives untouched.
  assert.equal(after.score, 9);
  assert.equal(after.note, 'la meilleure');
  assert.equal(after.language, 'fr');
  assert.equal(after.startDate, '2024-01-05');
  assert.deepEqual(after.tags, ['romance']);
  assert.equal(after.dateAdded, entry.dateAdded);
  assert.equal(r.body.merged, null, 'there was nothing to absorb');
});

test('the old site is recorded rather than forgotten', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  const r = await migrate(u.token, entry.id);

  assert.equal(r.body.entry.previousSources.length, 1);
  const [prev] = r.body.entry.previousSources;
  assert.equal(prev.sourceUrl, OLD);
  assert.equal(prev.sourceDomain, 'old-scan.test');
  assert.equal(prev.lastKnownChapter, 'Chapitre 109');
  assert.match(prev.migratedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('migrating twice keeps both hops in order', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  await migrate(u.token, entry.id);
  const r = await migrate(u.token, entry.id, {
    sourceUrl: 'https://third-scan.test/m/blue-box', sourceDomain: 'third-scan.test',
  });
  assert.deepEqual(r.body.entry.previousSources.map((p) => p.sourceDomain),
    ['old-scan.test', 'new-scan.test']);
});

test('progress follows the series and stops pointing at the old site', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  await migrate(u.token, entry.id);

  const cont = await api('GET', '/api/progress/continue', undefined, u.token);
  const row = cont.body.find((e) => e.libraryId === entry.id);
  assert.ok(row, 'the entry is still in continue-reading');
  assert.equal(row.chapterLabel, 'Chapitre 42', 'the chapter number is what matters');
  assert.ok(!row.chapterUrl.includes('old-scan.test'),
    'a link into the site being left is a dead link');
  assert.equal(row.chapterUrl, NEW, 'aimed at the new series page instead');
  assert.equal(row.page, 7);
  assert.equal(row.scrollPos, 0.5);
});

test('the page the user is standing on becomes the bookmark when it is further', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  await migrate(u.token, entry.id, {
    chapterUrl: `${NEW}/chapitre-90`,
    chapterLabel: 'Chapitre 90',
  });
  const cont = await api('GET', '/api/progress/continue', undefined, u.token);
  const row = cont.body.find((e) => e.libraryId === entry.id);
  assert.equal(row.chapterLabel, 'Chapitre 90');
  assert.equal(row.chapterUrl, `${NEW}/chapitre-90`);
});

test('an earlier chapter on the new site does not roll progress back', async () => {
  const u = await newUser();
  const entry = await seeded(u.token); // read up to 42
  await migrate(u.token, entry.id, {
    chapterUrl: `${NEW}/chapitre-3`,
    chapterLabel: 'Chapitre 3',
  });
  const cont = await api('GET', '/api/progress/continue', undefined, u.token);
  const row = cont.body.find((e) => e.libraryId === entry.id);
  assert.equal(row.chapterLabel, 'Chapitre 42', 'losing 39 chapters of progress is not a migration');
});

test('migrating an entry that was never opened creates the bookmark', async () => {
  const u = await newUser();
  const entry = await addEntry(u.token, {
    title: 'Untouched', sourceDomain: 'old-scan.test', sourceUrl: `${OLD}-untouched`,
  });
  await migrate(u.token, entry.id, { chapterUrl: `${NEW}/chapitre-1`, chapterLabel: 'Chapitre 1' });
  const cont = await api('GET', '/api/progress/continue', undefined, u.token);
  const row = cont.body.find((e) => e.libraryId === entry.id);
  assert.equal(row.chapterLabel, 'Chapitre 1');
});

// ── merging with an entry that is already there ──────────────────────────────

test('migrating onto an existing entry merges the two instead of failing', async () => {
  const u = await newUser();
  const keep = await seeded(u.token);
  const dupe = await addEntry(u.token, {
    title: 'Blue Box', sourceDomain: 'new-scan.test', sourceUrl: NEW,
    tags: ['school'], lastKnownChapter: 'Chapter 120', folder: 'paused',
  });

  const r = await migrate(u.token, keep.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.merged.id, dupe.id, 'the absorbed entry is reported back');

  const after = r.body.entry;
  assert.equal(after.id, keep.id);
  assert.equal(after.sourceUrl, NEW);
  assert.equal(after.lastKnownChapter, 'Chapter 120', 'the further chapter of the two');
  assert.deepEqual(after.tags.sort(), ['romance', 'school']);
  assert.equal(after.score, 9, 'the score only the kept row had');
  assert.equal(after.folder, 'paused', 'a chosen folder beats the default');

  const list = await api('GET', '/api/library', undefined, u.token);
  assert.equal(list.body.filter((e) => e.sourceUrl === NEW).length, 1, 'exactly one entry survives');
  assert.ok(!list.body.some((e) => e.id === dupe.id));
});

test('the merged entry keeps the further of the two bookmarks', async () => {
  const u = await newUser();
  const keep = await seeded(u.token); // chapter 42 on the old site
  const dupe = await addEntry(u.token, {
    title: 'Blue Box', sourceDomain: 'new-scan.test', sourceUrl: NEW,
  });
  await api('PUT', `/api/progress/${dupe.id}`, {
    chapterUrl: `${NEW}/chapitre-95`, chapterLabel: 'Chapitre 95', page: 3,
  }, u.token);

  await migrate(u.token, keep.id);
  const cont = await api('GET', '/api/progress/continue', undefined, u.token);
  assert.equal(cont.body.length, 1, 'one series, one bookmark');
  assert.equal(cont.body[0].libraryId, keep.id);
  assert.equal(cont.body[0].chapterLabel, 'Chapitre 95');
  assert.equal(cont.body[0].chapterUrl, `${NEW}/chapitre-95`, 'already a live link');
});

test('a behind bookmark on the destination does not undo progress', async () => {
  const u = await newUser();
  const keep = await seeded(u.token); // chapter 42
  const dupe = await addEntry(u.token, {
    title: 'Blue Box', sourceDomain: 'new-scan.test', sourceUrl: NEW,
  });
  await api('PUT', `/api/progress/${dupe.id}`, {
    chapterUrl: `${NEW}/chapitre-2`, chapterLabel: 'Chapitre 2',
  }, u.token);

  await migrate(u.token, keep.id);
  const cont = await api('GET', '/api/progress/continue', undefined, u.token);
  assert.equal(cont.body[0].chapterLabel, 'Chapitre 42');
});

test('merging takes the earlier date added and the higher reread count', async () => {
  const u = await newUser();
  const older = await addEntry(u.token, {
    title: 'Blue Box', sourceDomain: 'new-scan.test', sourceUrl: NEW, rereads: 3,
  });
  const keep = await seeded(u.token, { rereads: 1 });

  const r = await migrate(u.token, keep.id);
  assert.equal(r.body.entry.rereads, 3);
  assert.ok(r.body.entry.dateAdded <= older.dateAdded);
});

test('migrating onto a previously removed entry reclaims its slot', async () => {
  const u = await newUser();
  const dupe = await addEntry(u.token, {
    title: 'Blue Box', sourceDomain: 'new-scan.test', sourceUrl: NEW, tags: ['school'],
  });
  await api('DELETE', `/api/library/${dupe.id}`, undefined, u.token);
  const keep = await seeded(u.token);

  const r = await migrate(u.token, keep.id);
  assert.equal(r.status, 200, 'a soft-deleted row still holds the UNIQUE slot');
  assert.equal(r.body.entry.sourceUrl, NEW);
  assert.deepEqual(r.body.entry.tags.sort(), ['romance', 'school']);

  const list = await api('GET', '/api/library', undefined, u.token);
  assert.equal(list.body.filter((e) => e.sourceUrl === NEW).length, 1);
});

test('re-pinning the old url after a migration starts a separate entry', async () => {
  // The old row moved; nothing is squatting on the old url any more, so adding
  // it again is a genuinely new entry rather than a resurrection.
  const u = await newUser();
  const entry = await seeded(u.token);
  await migrate(u.token, entry.id);

  const again = await api('POST', '/api/library', {
    title: 'Ao no Hako', sourceDomain: 'old-scan.test', sourceUrl: OLD,
  }, u.token);
  assert.equal(again.status, 201);
  assert.notEqual(again.body.id, entry.id);
});

// ── refusals ─────────────────────────────────────────────────────────────────

test('migrating to the url it already has is refused', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  for (const sourceUrl of [OLD, `${OLD}/`, OLD.toUpperCase()]) {
    const r = await migrate(u.token, entry.id, { sourceUrl, sourceDomain: 'old-scan.test' });
    assert.equal(r.status, 400, sourceUrl);
    assert.match(r.body.error, /already the current source/);
  }
});

test('a migration needs a destination', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  for (const body of [{}, { sourceUrl: NEW }, { sourceDomain: 'new-scan.test' }]) {
    const r = await api('POST', `/api/library/${entry.id}/migrate`, body, u.token);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('you cannot migrate an entry that is not yours, or does not exist', async () => {
  const a = await newUser();
  const entry = await seeded(a.token);
  const b = await newUser();

  assert.equal((await migrate(b.token, entry.id)).status, 404);
  assert.equal((await migrate(a.token, 'no-such-id')).status, 404);
  assert.equal((await api('POST', `/api/library/${entry.id}/migrate`, { sourceUrl: NEW, sourceDomain: 'x' })).status, 401);

  // The other account's entry is untouched.
  const list = await api('GET', '/api/library', undefined, a.token);
  assert.equal(list.body.find((e) => e.id === entry.id).sourceUrl, OLD);
});

test('a removed entry cannot be migrated', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  await api('DELETE', `/api/library/${entry.id}`, undefined, u.token);
  assert.equal((await migrate(u.token, entry.id)).status, 404);
});

test('/:id/migrate is not swallowed by the /:id routes', async () => {
  const u = await newUser();
  const entry = await seeded(u.token);
  // PUT and DELETE on /:id must still behave, and POST /migrate must not be
  // read as an entry id.
  assert.equal((await api('PUT', `/api/library/${entry.id}`, { title: 'Renamed' }, u.token)).status, 200);
  const r = await migrate(u.token, entry.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.entry.title, 'Renamed', 'a rename before the migration is kept');
});
