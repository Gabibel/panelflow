// The extension keeps its own copy of the library in chrome.storage.local and
// migrates it locally, so a signed-out user gets the same behaviour as a signed
// -in one. That local merge is unrecoverable if it goes wrong — nothing else
// holds the data — so these run background.js for real under a stub chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootWorker, entryFixture } from '../test-support/worker.js';

const NEW = 'https://new-scan.test/read/blue-box';
const target = (over = {}) => ({
  sourceUrl: NEW, sourceDomain: 'new-scan.test', title: 'Blue Box', ...over,
});

const progressFor = (entry, over = {}) => ({
  [entry.sourceUrl]: {
    sourceUrl: entry.sourceUrl,
    chapterUrl: `${entry.sourceUrl}/chapitre-42`,
    chapterLabel: 'Chapitre 42',
    page: 7,
    scrollPos: 0.5,
    updatedAt: '2024-06-01T10:00:00.000Z',
    ...over,
  },
});

// ── spotting the duplicate ───────────────────────────────────────────────────

test('findSimilar sees the same work under a different romanisation', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e] } });
  const { matches } = await w.send({ type: 'findSimilar', meta: {
    title: 'Blue Box', altTitles: ['Ao no Hako'], sourceUrl: NEW,
  }});
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entry.id, e.id);
  assert.equal(matches[0].confidence, 'same-title');
});

test('findSimilar reports a chapter page of an entry as the same site', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e] } });
  const { matches } = await w.send({ type: 'findSimilar', meta: {
    title: 'Ao no Hako - Chapitre 110', sourceUrl: `${e.sourceUrl}/chapitre-110`,
  }});
  assert.equal(matches[0].confidence, 'same-site');
});

test('findSimilar stays quiet for an unrelated series and an empty library', async () => {
  // Lengths rather than deepEqual: the worker runs in its own vm realm, so the
  // arrays it returns are not reference-equal to a host-realm [].
  const w = bootWorker({ storage: { library: [entryFixture()] } });
  assert.equal((await w.send({ type: 'findSimilar', meta: {
    title: 'Vinland Saga', sourceUrl: 'https://new-scan.test/read/vinland-saga',
  }})).matches.length, 0);

  const empty = bootWorker();
  assert.equal((await empty.send({ type: 'findSimilar', meta: {
    title: 'Ao no Hako', sourceUrl: NEW,
  }})).matches.length, 0);
});

// ── migrating ────────────────────────────────────────────────────────────────

test('migrating repoints the entry and keeps what the user built up', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e] } });

  const r = await w.send({ type: 'migrateEntry', id: e.id, target: target({
    lastKnownChapter: '112', coverUrl: 'https://new-scan.test/cover.jpg',
  })});
  assert.equal(r.ok, true);

  const [after] = w.storage().library;
  assert.equal(after.id, e.id, 'the same entry, moved — not a new one');
  assert.equal(after.sourceUrl, NEW);
  assert.equal(after.sourceDomain, 'new-scan.test');
  assert.equal(after.title, 'Blue Box');
  assert.equal(after.coverUrl, 'https://new-scan.test/cover.jpg');
  assert.equal(after.lastKnownChapter, '112');
  assert.equal(after.score, 9);
  assert.equal(after.note, 'la meilleure');
  assert.equal(after.language, 'French');
  assert.equal(after.startDate, '2024-01-05');
  assert.deepEqual(after.tags, ['romance']);
  assert.equal(after.dateAdded, e.dateAdded, 'the day it entered the library does not move');
  assert.equal(w.storage().library.length, 1);
});

test('the site being left is recorded in the entry history', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e] } });
  await w.send({ type: 'migrateEntry', id: e.id, target: target() });

  const [after] = w.storage().library;
  assert.equal(after.previousSources.length, 1);
  assert.equal(after.previousSources[0].sourceUrl, e.sourceUrl);
  assert.equal(after.previousSources[0].sourceDomain, 'old-scan.test');
  assert.equal(after.previousSources[0].lastKnownChapter, '109');
});

test('an older chapter on the new site never rolls the entry back', async () => {
  const e = entryFixture({ lastKnownChapter: '109' });
  const w = bootWorker({ storage: { library: [e] } });
  await w.send({ type: 'migrateEntry', id: e.id, target: target({ lastKnownChapter: '12' })});
  assert.equal(w.storage().library[0].lastKnownChapter, '109');
});

test('progress is re-filed under the new url, off the site being left', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e], progress: progressFor(e) } });
  await w.send({ type: 'migrateEntry', id: e.id, target: target() });

  const progress = w.storage().progress;
  assert.equal(progress[e.sourceUrl], undefined, 'the old key would never be read again');
  const moved = progress[NEW];
  assert.ok(moved, 'progress follows the series');
  assert.equal(moved.chapterLabel, 'Chapitre 42', 'the chapter number is what matters');
  assert.equal(moved.page, 7);
  assert.equal(moved.scrollPos, 0.5);
  assert.equal(moved.chapterUrl, NEW, 'a link into the abandoned site is a dead link');
  assert.equal(moved.sourceUrl, NEW);
});

test('the chapter the user is standing on wins when it is further', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e], progress: progressFor(e) } });
  await w.send({ type: 'migrateEntry', id: e.id, target: target({
    chapterUrl: `${NEW}/chapitre-90`, chapterLabel: 'Chapitre 90',
  })});
  const moved = w.storage().progress[NEW];
  assert.equal(moved.chapterLabel, 'Chapitre 90');
  assert.equal(moved.chapterUrl, `${NEW}/chapitre-90`, 'a live link on the new site');
});

test('opening the series at chapter 1 on the new site does not erase 42 chapters', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e], progress: progressFor(e) } });
  await w.send({ type: 'migrateEntry', id: e.id, target: target({
    chapterUrl: `${NEW}/chapitre-1`, chapterLabel: 'Chapitre 1',
  })});
  assert.equal(w.storage().progress[NEW].chapterLabel, 'Chapitre 42');
});

test('an entry that was never opened simply moves', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e] } });
  await w.send({ type: 'migrateEntry', id: e.id, target: target() });
  assert.deepEqual(w.storage().progress, {}, 'no bookmark invented out of nothing');
});

// ── absorbing a duplicate that is already there ──────────────────────────────

test('migrating onto an existing entry merges the two into one', async () => {
  const keep = entryFixture();
  const dupe = entryFixture({
    title: 'Blue Box', sourceDomain: 'new-scan.test', sourceUrl: NEW,
    tags: ['school'], lastKnownChapter: '120', folder: 'paused',
    score: null, note: null, rereads: 3, dateAdded: '2023-01-01T00:00:00.000Z',
  });
  const w = bootWorker({ storage: {
    library: [keep, dupe],
    progress: { ...progressFor(keep), ...progressFor(dupe, {
      chapterUrl: `${NEW}/chapitre-95`, chapterLabel: 'Chapitre 95', page: 3,
    })},
  }});

  const r = await w.send({ type: 'migrateEntry', id: keep.id, target: target() });
  assert.equal(r.merged.id, dupe.id);

  const library = w.storage().library;
  assert.equal(library.length, 1, 'exactly one entry survives');
  const [after] = library;
  assert.equal(after.id, keep.id);
  assert.equal(after.lastKnownChapter, '120', 'the further of the two');
  assert.deepEqual(after.tags.sort(), ['romance', 'school']);
  assert.equal(after.score, 9, 'the score only the kept entry had');
  assert.equal(after.folder, 'paused', 'a chosen folder beats the default');
  assert.equal(after.rereads, 3);
  assert.equal(after.dateAdded, '2023-01-01T00:00:00.000Z', 'the earlier of the two');

  const progress = w.storage().progress;
  assert.equal(Object.keys(progress).length, 1, 'one series, one bookmark');
  assert.equal(progress[NEW].chapterLabel, 'Chapitre 95', 'the further bookmark');
  assert.equal(progress[NEW].chapterUrl, `${NEW}/chapitre-95`, 'already a live link');
});

test('a behind bookmark on the absorbed entry does not undo progress', async () => {
  const keep = entryFixture();
  const dupe = entryFixture({ title: 'Blue Box', sourceUrl: NEW, sourceDomain: 'new-scan.test' });
  const w = bootWorker({ storage: {
    library: [keep, dupe],
    progress: { ...progressFor(keep), ...progressFor(dupe, {
      chapterUrl: `${NEW}/chapitre-2`, chapterLabel: 'Chapitre 2',
    })},
  }});
  await w.send({ type: 'migrateEntry', id: keep.id, target: target() });
  assert.equal(w.storage().progress[NEW].chapterLabel, 'Chapitre 42');
});

test('the absorbed entry keeps nothing behind in progress', async () => {
  const keep = entryFixture();
  const dupe = entryFixture({ title: 'Blue Box', sourceUrl: NEW, sourceDomain: 'new-scan.test' });
  const w = bootWorker({ storage: {
    library: [keep, dupe],
    progress: { ...progressFor(keep), ...progressFor(dupe, { chapterLabel: 'Chapitre 1' }) },
  }});
  await w.send({ type: 'migrateEntry', id: keep.id, target: target() });
  assert.deepEqual(Object.keys(w.storage().progress), [NEW]);
});

// ── refusals and offline behaviour ───────────────────────────────────────────

test('migrating to the url it already has is refused', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e] } });
  for (const sourceUrl of [e.sourceUrl, `${e.sourceUrl}/`]) {
    const r = await w.send({ type: 'migrateEntry', id: e.id,
      target: target({ sourceUrl, sourceDomain: 'old-scan.test' }) });
    assert.match(r.error, /already the current source/);
  }
  assert.equal(w.storage().library[0].sourceUrl, e.sourceUrl, 'and nothing moved');
});

test('a migration needs a destination and a real entry', async () => {
  const e = entryFixture();
  const w = bootWorker({ storage: { library: [e] } });
  assert.match((await w.send({ type: 'migrateEntry', id: e.id, target: {} })).error, /required/);
  assert.match((await w.send({ type: 'migrateEntry', id: e.id })).error, /required/);
  assert.match((await w.send({ type: 'migrateEntry', id: 'nope', target: target() })).error,
    /not found/);
  assert.deepEqual(w.storage().library, [e], 'a rejected migration changes nothing');
});

test('signed out, the migration still happens locally', async () => {
  const e = entryFixture();
  // No authToken in storage, and fetch throws: the worker is fully offline.
  const w = bootWorker({ storage: { library: [e], progress: progressFor(e) } });
  const r = await w.send({ type: 'migrateEntry', id: e.id, target: target() });
  assert.equal(r.ok, true);
  assert.equal(w.storage().library[0].sourceUrl, NEW);
  assert.equal(w.storage().progress[NEW].chapterLabel, 'Chapitre 42');
  assert.deepEqual(w.calls, [], 'nothing was even attempted over the network');
});

test('signed in, the migration is forwarded to the backend', async () => {
  const e = entryFixture({ remoteId: 'remote-1' });
  const w = bootWorker({
    // The backend URL is set here rather than left to the core's default: what
    // this test is about is the path and the body, and hardcoding the default
    // made it fail the day the shipped one changed.
    storage: {
      library: [e],
      progress: progressFor(e),
      authToken: 'tok',
      settings: { backendUrl: 'https://api.test' },
    },
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({ entry: { id: 'remote-1' }, merged: null }),
    }),
  });
  await w.send({ type: 'migrateEntry', id: e.id, target: target() });

  const call = w.calls.find((c) => c.url.includes('/migrate'));
  assert.ok(call, 'the backend is told to move the row too');
  assert.equal(call.url, 'https://api.test/api/library/remote-1/migrate');
  assert.equal(call.init.method, 'POST');
  const body = JSON.parse(call.init.body);
  assert.equal(body.sourceUrl, NEW);
  assert.equal(body.sourceDomain, 'new-scan.test');
  assert.equal(body.chapterLabel, 'Chapitre 42', 'the merged bookmark, not the old one');
});

test('a backend that is down does not undo the local migration', async () => {
  const e = entryFixture({ remoteId: 'remote-1' });
  const w = bootWorker({
    storage: { library: [e], authToken: 'tok' },
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  const r = await w.send({ type: 'migrateEntry', id: e.id, target: target() });
  assert.equal(r.ok, true, 'the user is not blocked by a server they cannot reach');
  assert.equal(w.storage().library[0].sourceUrl, NEW);
});

// --- new-chapter notifications ----------------------------------------------

test('tapping a new-chapter notification opens that chapter', async () => {
  // The alert is only half the feature. Chrome kills the worker within seconds
  // of the check finishing and the notification outlives it by hours, so where
  // it leads has to be written down rather than held in a variable.
  const e = entryFixture({ lastKnownChapter: '109' });
  const w = bootWorker({
    storage: {
      library: [e],
      progress: progressFor(e, { chapterUrl: `${e.sourceUrl}/chapitre-109`, chapterLabel: 'Chapitre 109', page: 0 }),
    },
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => { throw new Error('not json'); },
      text: async () => '<a href="/manga/ao-no-hako/chapitre-110">Chapitre 110</a>',
    }),
  });
  // The worker asks for a host permission before fetching a series page, and a
  // fixture site has none — see host-fetch-guard.test.js for why it asks. This
  // test is about where a notification leads, not about permissions, so the
  // obstacle is removed rather than worked around.
  w.grant(`*://*.${e.sourceDomain}/*`);

  await w.send({ type: 'checkNow' });
  assert.equal(w.notifications.length, 1, 'a chapter came out and nobody was told');

  await w.clickNotification(w.notifications[0].id);
  assert.deepEqual(w.opened, [`${e.sourceUrl}/chapitre-110`]);
  // And the note of where it led is torn up behind it, or the map grows a URL
  // per series forever.
  assert.deepEqual(w.storage().notifyTargets, {});
});

test('a notification nobody raised opens nothing', async () => {
  const w = bootWorker({ storage: { library: [] } });
  await w.clickNotification('pf-unknown');
  assert.deepEqual(w.opened, [], 'an unknown id must not open a tab');
});
