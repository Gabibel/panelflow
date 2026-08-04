// The shared store core, driven the way the mobile shells drive it.
//
// `extension-migrate.test.js` already covers this logic as reached through
// background.js. These tests exist because the phone reaches it by a different
// road — no service worker, no `chrome` API, a WebView's localStorage instead —
// and the whole premise of shared/panelflow-core.js is that the road does not
// matter. Anything that only works under one harness is a bug in the split.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore, json, html, entryFixture } from '../test-support/core.js';

test('the library survives a round trip and is filed under one entry per series', async () => {
  const { core, storage } = bootCore();
  await core.addToLibrary({
    title: 'Ao no Hako',
    sourceDomain: 'scan.test',
    sourceUrl: 'https://scan.test/manga/ao-no-hako/chapitre-109',
    chapterUrl: 'https://scan.test/manga/ao-no-hako/chapitre-109',
    chapterLabel: 'Ch. 109',
  });
  // A different chapter of the same book is the same book.
  await core.addToLibrary({
    title: 'Ao no Hako',
    sourceDomain: 'scan.test',
    sourceUrl: 'https://scan.test/manga/ao-no-hako/chapitre-110',
    chapterUrl: 'https://scan.test/manga/ao-no-hako/chapitre-110',
    chapterLabel: 'Ch. 110',
  });

  const { library, progress } = storage();
  assert.equal(library.length, 1);
  // Progress rode along with the add, and moved forward with the second one.
  // The second add also rewrote the entry's sourceUrl, and the bookmark is
  // keyed by that — so exactly one key, filed under where the entry now points.
  assert.deepEqual(Object.keys(progress), [library[0].sourceUrl]);
  assert.equal(progress[library[0].sourceUrl].chapterLabel, 'Ch. 110');
});

test('renaming an entry\'s source url takes its bookmark with it', async () => {
  // Same orphaning hazard as above, reached through the library modal instead:
  // the user corrects a series URL that was guessed wrong, and their place in
  // the book must not be left behind under the old one.
  const entry = entryFixture();
  const to = 'https://old-scan.test/manga/ao-no-hako-vf';
  const { core, storage } = bootCore({
    storage: {
      library: [entry],
      progress: {
        [entry.sourceUrl]: { sourceUrl: entry.sourceUrl, chapterLabel: 'Ch. 109', page: 7 },
      },
    },
  });
  await core.updateEntry(entry.id, { sourceUrl: to });
  const { progress } = storage();
  assert.deepEqual(Object.keys(progress), [to]);
  assert.equal(progress[to].page, 7, 'the page they were on, not a reset to zero');
});

test('progress never rewinds when an old chapter is reopened', async () => {
  const entry = entryFixture({ sourceUrl: 'https://scan.test/manga/x' });
  const { core, storage } = bootCore({ storage: { library: [entry] } });

  const visit = (n) => core.chapterVisited({
    sourceUrl: entry.sourceUrl,
    chapterUrl: `https://scan.test/manga/x/chapter-${n}`,
    chapterLabel: `Ch. ${n}`,
  });
  await visit(10);
  await visit(9); // re-reading an earlier chapter
  assert.equal(storage().progress[entry.sourceUrl].chapterLabel, 'Ch. 10');
  await visit(11);
  assert.equal(storage().progress[entry.sourceUrl].chapterLabel, 'Ch. 11');
});

test('migrating to a new site keeps the bookmark, the score and the date added', async () => {
  const entry = entryFixture();
  const { core, storage } = bootCore({
    storage: {
      library: [entry],
      progress: {
        [entry.sourceUrl]: {
          sourceUrl: entry.sourceUrl,
          chapterUrl: 'https://old-scan.test/manga/ao-no-hako/chapitre-109',
          chapterLabel: 'Ch. 109',
          page: 4,
        },
      },
    },
  });

  const { entry: moved } = await core.migrateEntry(entry.id, {
    sourceUrl: 'https://new-scan.test/lecture/blue-box',
    sourceDomain: 'new-scan.test',
    lastKnownChapter: '112',
  });

  assert.equal(moved.sourceDomain, 'new-scan.test');
  assert.equal(moved.score, 9, 'the score is the user\'s, not the site\'s');
  assert.equal(moved.dateAdded, '2024-01-05T10:00:00.000Z');
  assert.equal(moved.lastKnownChapter, '112');
  assert.equal(moved.previousSources.length, 1);
  assert.equal(moved.previousSources[0].sourceDomain, 'old-scan.test');

  const { progress } = storage();
  assert.equal(progress[entry.sourceUrl], undefined, 'the old key is gone');
  const p = progress['https://new-scan.test/lecture/blue-box'];
  assert.equal(p.chapterLabel, 'Ch. 109', 'how far you got is what has to survive');
  // The old chapter URL points into the site being abandoned, so it is re-aimed
  // at the new series page rather than kept as a link that will rot.
  assert.equal(p.chapterUrl, 'https://new-scan.test/lecture/blue-box');
});

test('migrating onto an entry that already exists absorbs it instead of leaving two', async () => {
  const mine = entryFixture({ note: 'la meilleure' });
  const theirs = entryFixture({
    sourceUrl: 'https://new-scan.test/lecture/blue-box',
    sourceDomain: 'new-scan.test',
    title: 'Blue Box',
    tags: ['school'],
    folder: 'completed',
    lastKnownChapter: '120',
    score: null,
    dateAdded: '2023-05-01T00:00:00.000Z',
  });
  const { core, storage } = bootCore({ storage: { library: [mine, theirs] } });

  const { entry, merged } = await core.migrateEntry(mine.id, {
    sourceUrl: theirs.sourceUrl,
    sourceDomain: 'new-scan.test',
  });

  assert.equal(storage().library.length, 1, 'one book, one entry');
  assert.equal(merged.id, theirs.id);
  assert.equal(entry.lastKnownChapter, '120', 'the furthest chapter wins');
  assert.deepEqual(entry.tags.sort(), ['romance', 'school']);
  assert.equal(entry.folder, 'completed', 'a folder the user picked beats the default');
  assert.equal(entry.note, 'la meilleure');
  assert.equal(entry.score, 9);
  assert.equal(entry.dateAdded, '2023-05-01T00:00:00.000Z', 'the earlier date added wins');
});

test('findSimilar spots the same work on a different site without merging it', async () => {
  const { core } = bootCore({
    storage: { library: [entryFixture({ title: 'Ao no Hako' })] },
  });
  const matches = await core.findSimilar({
    title: 'Ao no Hako - Chapitre 110 VF',
    sourceUrl: 'https://other-scan.test/manga/ao-no-hako',
  });
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].confidence, 'same-title');
  // Nothing was changed: a cross-site match is a guess, and guesses get asked.
  assert.equal(matches[0].entry.sourceDomain, 'old-scan.test');
});

test('the new-chapter check notifies once and then remembers', async () => {
  const entry = entryFixture({ lastKnownChapter: '109' });
  const page = html('<a href="/manga/ao-no-hako/chapitre-111">Chapitre 111</a>');
  const { core, notifications, storage } = bootCore({
    storage: { library: [entry] },
    fetch: async () => page,
  });

  await core.checkNewChapters();
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /chapter 111/);
  assert.equal(storage().library[0].lastKnownChapter, '111');

  await core.checkNewChapters();
  assert.equal(notifications.length, 1, 'the same chapter must not notify twice');
});

test('the check does not undo work done while it was running', async () => {
  // A full pass is one page fetch plus a pause per series, so it runs for
  // minutes in the background while the user keeps using the library. The
  // snapshot it started from is stale by the end — writing it back wholesale
  // would delete whatever was added in the meantime.
  const entry = entryFixture({ lastKnownChapter: '109' });
  let core;
  const { core: c, storage } = bootCore({
    storage: { library: [entry] },
    fetch: async () => {
      await core.addToLibrary({
        title: 'Added mid-check',
        sourceDomain: 's.test',
        sourceUrl: 'https://s.test/manga/added',
      });
      return html('<a href="/manga/ao-no-hako/chapitre-111">Chapitre 111</a>');
    },
  });
  core = c;

  await core.checkNewChapters();

  const titles = storage().library.map((e) => e.title).sort();
  assert.deepEqual(titles, ['Added mid-check', 'Ao no Hako']);
  const checked = storage().library.find((e) => e.title === 'Ao no Hako');
  assert.equal(checked.lastKnownChapter, '111', 'and the check still saved what it found');
});

test('a latest chapter scraped as free text still advances the entry', async () => {
  // The page hands back whatever it displays; parseFloat("Chapitre 1055") is
  // NaN, which used to drop the update on the floor.
  const entry = entryFixture({ lastKnownChapter: '1054', coverUrl: null });
  const { core, storage } = bootCore({ storage: { library: [entry] } });
  await core.seriesSeen({
    sourceUrl: entry.sourceUrl,
    lastKnownChapter: 'Chapitre 1055',
  });
  assert.equal(storage().library[0].lastKnownChapter, '1055');
});

test('everything works signed out, and nothing is sent anywhere', async () => {
  const { core, calls } = bootCore();
  await core.addToLibrary({
    title: 'Solo', sourceDomain: 's.test', sourceUrl: 'https://s.test/manga/solo',
  });
  await core.saveProgress({
    sourceUrl: 'https://s.test/manga/solo', chapterUrl: 'https://s.test/manga/solo/ch-1',
    chapterLabel: 'Ch. 1', page: 0,
  });
  assert.deepEqual(calls, [], 'a signed-out library is a local library');
});

test('signing in adopts the account library instead of overwriting it', async () => {
  // The phone has one book saved offline; the account has another from the
  // browser. Pushing first would leave the account looking like the phone.
  const local = entryFixture({ sourceUrl: 'https://a.test/manga/local', title: 'Local' });
  const remote = {
    id: 'remote-1', title: 'From the browser',
    sourceDomain: 'b.test', sourceUrl: 'https://b.test/manga/remote',
    tags: [], updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const { core, storage } = bootCore({
    storage: { library: [local], authToken: 't' },
    fetch: async (url, init) => {
      const path = String(url).replace('https://api.test', '');
      if (path === '/api/library' && (!init || init.method === undefined)) return json([remote]);
      if (path === '/api/library' && init.method === 'POST') return json({ id: 'remote-2' });
      if (path === '/api/progress/continue') return json([]);
      if (path.startsWith('/api/meta/scrape')) return json({ coverUrl: null, latestChapter: null });
      return json({ ok: true });
    },
  });

  const r = await core.pullLibrary();
  assert.equal(r.added, 1);
  const titles = storage().library.map((e) => e.title).sort();
  assert.deepEqual(titles, ['From the browser', 'Local']);
  // The adopted entry keeps its server id so later edits update it rather than
  // creating a third copy.
  assert.equal(storage().library.find((e) => e.title === 'From the browser').remoteId, 'remote-1');
});

test('a pull matches an entry the phone already had by series, not by url', async () => {
  const local = entryFixture({ sourceUrl: 'https://a.test/manga/ao-no-hako/chapitre-109' });
  const { core, storage } = bootCore({
    storage: { library: [local], authToken: 't' },
    fetch: async (url) => {
      const path = String(url).replace('https://api.test', '');
      if (path === '/api/library') {
        return json([{
          id: 'remote-1', title: 'Ao no Hako', sourceDomain: 'a.test',
          sourceUrl: 'https://a.test/manga/ao-no-hako', tags: [],
          updatedAt: '2020-01-01T00:00:00.000Z', // older than the local copy
        }]);
      }
      if (path === '/api/progress/continue') return json([]);
      return json({});
    },
  });

  await core.pullLibrary();
  assert.equal(storage().library.length, 1, 'the same book on the same site is one entry');
  assert.equal(storage().library[0].remoteId, 'remote-1');
  // The server row was older, so it did not clobber the local one.
  assert.equal(storage().library[0].sourceUrl, 'https://a.test/manga/ao-no-hako/chapitre-109');
});

test('a failing backend never costs a local write', async () => {
  const { core, storage } = bootCore({
    storage: { authToken: 't' },
    fetch: async () => json({ error: 'boom' }, 500),
  });
  const entry = await core.addToLibrary({
    title: 'Offline', sourceDomain: 's.test', sourceUrl: 'https://s.test/manga/offline',
  });
  assert.equal(storage().library.length, 1);
  assert.equal(entry.remoteId, undefined, 'no server id, so syncAll will retry later');
});

// --- the message hub -------------------------------------------------------

test('the hub answers the same messages the extension does', async () => {
  const { hub } = bootCore();
  const added = await hub({
    type: 'addToLibrary',
    entry: { title: 'Hub', sourceDomain: 's.test', sourceUrl: 'https://s.test/manga/hub' },
  });
  assert.equal(added.ok, true);
  assert.equal((await hub({ type: 'getLibrary' })).library.length, 1);
  assert.equal((await hub({ type: 'getProgressAll' })).progress, undefined);
  assert.equal((await hub({ type: 'getAccount' })).authUser, undefined);
});

test('the hub turns a thrown error into a reply, never a rejection', async () => {
  // A rejection here would hang the caller: on mobile the reply is what
  // releases the pending promise on the other side of the native bridge.
  const { hub } = bootCore();
  const r = await hub({ type: 'migrateEntry', id: 'nope', target: {} });
  assert.match(r.error, /required/);
  assert.match((await hub({ type: 'nonsense' })).error, /unknown message/);
});

test('search and the compatibility check carry the bearer token', async () => {
  const seen = [];
  const { hub } = bootCore({
    storage: { authToken: 'tok-123' },
    fetch: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization });
      return json({ results: [] });
    },
  });
  await hub({ type: 'search', q: 'ao no hako', scans: true, check: true });
  await hub({ type: 'compat', url: 'https://scan.test/manga/x/chapitre-1' });

  assert.equal(seen[0].url,
    'https://api.test/api/search?q=ao+no+hako&scans=1&check=1');
  assert.equal(seen[1].url,
    'https://api.test/api/meta/compat?url=https%3A%2F%2Fscan.test%2Fmanga%2Fx%2Fchapitre-1');
  assert.ok(seen.every((s) => s.auth === 'Bearer tok-123'));
});

test('extras extend the hub without forking it', async () => {
  // This is how the extension keeps its declarativeNetRequest messages and the
  // mobile worker keeps chrome.storage passthrough, off one shared switch.
  const { core } = bootCore();
  const { createHub } = await import('../src/panelflow-core.js');
  const hub = createHub(core, { ping: async (msg) => ({ pong: msg.value }) });
  assert.deepEqual(await hub({ type: 'ping', value: 42 }), { pong: 42 });
  assert.equal((await hub({ type: 'getLibrary' })).library.length, 0);
});
