// Chapters saved to the device.
//
// The thing worth testing here is not IndexedDB — it is what happens when a
// save does not finish. A service worker is killed at the browser's discretion,
// possibly between page 12 and page 13 of a forty-page chapter, and the store's
// whole design is one rule: a chapter exists when its metadata exists, and its
// metadata is written last. Everything below is that rule from a different
// angle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootWorker } from '../test-support/worker.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'shared', 'offline-store.js'), 'utf8');

// The file is a browser IIFE that hangs itself off the global, same as the
// other shared scripts — so run it, rather than reimplementing it as a module.
const sandbox = { Blob: class { constructor(parts) { this.parts = parts; } } };
new Function('globalThis', 'self', `${src}`).call(sandbox, sandbox, sandbox);
const { createOfflineStore, offlineMessages, bytesFromB64, pageKey } = sandbox.PanelFlowOffline;

/** The async key-value interface `idbBackend` provides, in a Map. */
function fakeBackend() {
  const stores = { meta: new Map(), pages: new Map() };
  return {
    stores,
    get: async (s, k) => stores[s].get(k),
    put: async (s, k, v) => { stores[s].set(k, v); },
    del: async (s, k) => { stores[s].delete(k); },
    // Insertion order, deliberately: real IndexedDB returns keys sorted, so a
    // store that depends on the order it happens to get them would pass here
    // and misorder pages in a browser.
    keys: async (s) => [...stores[s].keys()],
    values: async (s) => [...stores[s].values()],
  };
}

const meta = (over = {}) => ({
  chapterUrl: 'https://scan.test/manga/x/chapitre-109',
  sourceUrl: 'https://scan.test/manga/x',
  title: 'Ao no Hako',
  chapterLabel: 'Ch. 109',
  bytes: 4200,
  ...over,
});

async function saveChapter(store, pages = 3, over = {}) {
  const m = meta(over);
  for (let i = 0; i < pages; i++) await store.putPage(m.chapterUrl, i, `page-${i}`);
  return store.commit(m);
}

test('a saved chapter comes back with its pages in order', async () => {
  const backend = fakeBackend();
  const store = createOfflineStore(backend);
  // Out of order on purpose: pages arrive as their fetches resolve, not as
  // they were requested.
  for (const i of [2, 0, 3, 1]) await store.putPage(meta().chapterUrl, i, `page-${i}`);
  const rec = await store.commit(meta());
  assert.equal(rec.pageCount, 4);
  assert.equal(rec.kind, 'images');

  const got = await store.get(meta().chapterUrl);
  assert.deepEqual(got.pages, ['page-0', 'page-1', 'page-2', 'page-3']);
  assert.equal(got.meta.title, 'Ao no Hako');
});

test('page 10 sorts after page 9, not after page 1', async () => {
  // The keys are strings and the store sorts them as strings, so the padding is
  // load-bearing: without it a twelve-page chapter reads 1, 10, 11, 12, 2, 3.
  const store = createOfflineStore(fakeBackend());
  // The page's own index as its content, so the order is the assertion — and 0
  // as a value, which is the shape a truthiness filter silently eats.
  for (let i = 0; i < 12; i++) await store.putPage('u', i, i);
  await store.commit({ chapterUrl: 'u' });
  const { pages } = await store.get('u');
  assert.deepEqual(pages, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('an interrupted save is not a chapter', async () => {
  // Pages written, worker killed before the commit. The bytes are on disk, but
  // nothing may offer them as something readable — half a chapter presented as
  // a whole one is worse than a chapter that is simply not there.
  const backend = fakeBackend();
  const store = createOfflineStore(backend);
  for (let i = 0; i < 5; i++) await store.putPage(meta().chapterUrl, i, `page-${i}`);

  assert.equal(await store.has(meta().chapterUrl), false);
  assert.equal(await store.get(meta().chapterUrl), null);
  assert.deepEqual(await store.list(), []);

  // And the orphans are recoverable disk, not a leak.
  assert.equal(backend.stores.pages.size, 5);
  assert.deepEqual(await store.sweep(), { ok: true, dropped: 5 });
  assert.equal(backend.stores.pages.size, 0);
});

test('sweeping never touches a committed chapter', async () => {
  const backend = fakeBackend();
  const store = createOfflineStore(backend);
  await saveChapter(store, 3);
  await store.putPage('https://scan.test/manga/x/chapitre-110', 0, 'stray');

  assert.deepEqual(await store.sweep(), { ok: true, dropped: 1 });
  assert.equal((await store.get(meta().chapterUrl)).pages.length, 3);
});

test('a chapter with no pages is refused', async () => {
  const store = createOfflineStore(fakeBackend());
  await assert.rejects(() => store.commit(meta()), /nothing to save/);
  assert.deepEqual(await store.list(), []);
});

test('a text chapter keeps its words, not its bytes', async () => {
  const store = createOfflineStore(fakeBackend());
  const rec = await store.commit(meta({
    kind: 'text',
    paragraphs: ['One.', 'Two.', 'Three.'],
    chapterUrl: 'https://novels.test/novel/ri/chapter-812',
  }));
  assert.equal(rec.pageCount, 3);
  const got = await store.get('https://novels.test/novel/ri/chapter-812');
  assert.deepEqual(got.pages, []);
  assert.deepEqual(got.meta.paragraphs, ['One.', 'Two.', 'Three.']);
});

test('removing a chapter takes its pages with it', async () => {
  const backend = fakeBackend();
  const store = createOfflineStore(backend);
  await saveChapter(store, 4);
  await saveChapter(store, 2, { chapterUrl: 'https://scan.test/manga/x/chapitre-110' });

  await store.remove(meta().chapterUrl);
  assert.equal(await store.has(meta().chapterUrl), false);
  // Only the other chapter's two pages are left — no orphans, no over-deletion.
  assert.equal(backend.stores.pages.size, 2);
  assert.equal((await store.list()).length, 1);
});

test('removing a series removes every chapter of it and nothing else', async () => {
  const store = createOfflineStore(fakeBackend());
  await saveChapter(store, 2);
  await saveChapter(store, 2, { chapterUrl: 'https://scan.test/manga/x/chapitre-110' });
  await saveChapter(store, 2, {
    chapterUrl: 'https://scan.test/manga/y/chapitre-1',
    sourceUrl: 'https://scan.test/manga/y',
  });

  assert.deepEqual(await store.removeSeries('https://scan.test/manga/x'), { ok: true, removed: 2 });
  const left = await store.list();
  assert.equal(left.length, 1);
  assert.equal(left[0].sourceUrl, 'https://scan.test/manga/y');
});

test('the list is newest first and carries no bytes', async () => {
  let t = 1000;
  const store = createOfflineStore(fakeBackend(), { now: () => (t += 1000) });
  await saveChapter(store, 1);
  await saveChapter(store, 1, { chapterUrl: 'https://scan.test/manga/x/chapitre-110' });

  const list = await store.list();
  assert.deepEqual(list.map((m) => m.chapterLabel), ['Ch. 109', 'Ch. 109']);
  assert.ok(list[0].savedAt > list[1].savedAt);
  // A list screen must never have to load forty images to draw ten rows.
  for (const m of list) assert.ok(!('pages' in m));

  assert.deepEqual(await store.usage(), { chapters: 2, bytes: 8400 });
});

test('re-saving a chapter replaces it rather than doubling it', async () => {
  const backend = fakeBackend();
  const store = createOfflineStore(backend);
  await saveChapter(store, 3);
  await saveChapter(store, 3);
  assert.equal((await store.list()).length, 1);
  assert.equal(backend.stores.pages.size, 3);
});

// --- ninety days -----------------------------------------------------------
// Saved chapters are a convenience for a train ride, not an archive. Without an
// expiry the store only grows, and what is at the bottom of it is what nobody
// will open again.

const DAY = 86400000;

test('a chapter older than ninety days is dropped, pages and all', async () => {
  const backend = fakeBackend();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const store = createOfflineStore(backend, { now: () => clock });

  await saveChapter(store, 4);
  clock += 91 * DAY;
  await saveChapter(store, 2, { chapterUrl: 'https://scan.test/manga/x/chapitre-110' });

  const r = await store.expire();
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.chapters, ['https://scan.test/manga/x/chapitre-109']);
  assert.deepEqual((await store.list()).map((m) => m.chapterUrl),
    ['https://scan.test/manga/x/chapitre-110']);
  // The old chapter's four pages went with it — an expiry that left the bytes
  // would free nothing, which is the entire point of having one.
  assert.equal(backend.stores.pages.size, 2);
});

test('the day before the ninetieth is not the ninetieth', async () => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const store = createOfflineStore(fakeBackend(), { now: () => clock });
  await saveChapter(store, 1);

  clock += 89 * DAY;
  assert.equal((await store.expire()).dropped, 0);
  assert.equal((await store.list()).length, 1);

  clock += 2 * DAY;
  assert.equal((await store.expire()).dropped, 1);
});

test('daysLeft counts down to the day it goes', async () => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const store = createOfflineStore(fakeBackend(), { now: () => clock });
  const saved = await saveChapter(store, 1);

  assert.equal(store.daysLeft(saved), 90);
  clock += 85 * DAY;
  assert.equal(store.daysLeft(saved), 5);
  clock += 10 * DAY;
  // Never negative: "expires in -3 days" is not a thing to put on a screen.
  assert.equal(store.daysLeft(saved), 0);
});

test('a record with no savedAt is not deleted on a guess', async () => {
  // Written by a version of the store that predates the field. Its age is
  // unknown, and unknown is not old.
  const backend = fakeBackend();
  const store = createOfflineStore(backend, { now: () => Date.parse('2026-06-01') });
  await backend.put('pages', pageKey('u', 0), 'page');
  await backend.put('meta', 'u', { chapterUrl: 'u', kind: 'images', pageCount: 1 });

  assert.equal((await store.expire()).dropped, 0);
  assert.equal((await store.list()).length, 1);
});

test('listing expires first, so nothing past its date is ever offered', async () => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const store = createOfflineStore(fakeBackend(), { now: () => clock });
  const handlers = offlineMessages(store, { Blob: sandbox.Blob });
  await saveChapter(store, 2);

  clock += 120 * DAY;
  const r = await handlers.offlineList();
  assert.deepEqual(r.chapters, []);
  assert.equal(r.retentionDays, 90);
});

// --- the crossing ----------------------------------------------------------

test('base64 crosses the bridge byte for byte', () => {
  // Chrome messaging is JSON and the mobile bridge is a string channel, so
  // every page of every saved chapter goes through this function. A rounding
  // error here is a corrupt image, not an exception.
  const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 37) % 256);
  const b64 = Buffer.from(bytes).toString('base64');
  assert.deepEqual([...bytesFromB64(b64)], [...bytes]);

  // Every remainder of the padding, since that is where the arithmetic bites.
  for (const n of [1, 2, 3, 4, 5]) {
    const part = bytes.subarray(0, n);
    assert.deepEqual(
      [...bytesFromB64(Buffer.from(part).toString('base64'))], [...part], `${n} bytes`,
    );
  }
  assert.deepEqual([...bytesFromB64('')], []);
  assert.deepEqual([...bytesFromB64(null)], []);
});

test('the hub messages save a whole chapter end to end', async () => {
  const store = createOfflineStore(fakeBackend());
  const handlers = offlineMessages(store, { Blob: sandbox.Blob });
  const url = 'https://scan.test/manga/x/chapitre-109';

  assert.deepEqual(await handlers.offlineHas({ chapterUrl: url }), { saved: false });
  for (let i = 0; i < 3; i++) {
    const r = await handlers.offlinePage({
      chapterUrl: url, index: i, b64: Buffer.from(`page ${i}`).toString('base64'), mime: 'image/webp',
    });
    assert.equal(r.bytes, 6);
  }
  const { chapter } = await handlers.offlineCommit({ meta: meta() });
  assert.equal(chapter.pageCount, 3);

  assert.deepEqual(await handlers.offlineHas({ chapterUrl: url }), { saved: true });
  assert.equal((await handlers.offlineList()).chapters.length, 1);
  assert.deepEqual(await handlers.offlineUsage(), { chapters: 1, bytes: 4200 });

  await handlers.offlineRemove({ chapterUrl: url });
  assert.equal((await handlers.offlineList()).chapters.length, 0);
});

test('the store never answers with a blob over the bridge', () => {
  // A Blob does not survive JSON, so a read message would return `{}` to the
  // reader and look like an empty chapter. Reading is done on the store's own
  // origin instead, and this is what keeps someone from "fixing" that by
  // adding an offlineGet case.
  const handlers = offlineMessages(createOfflineStore(fakeBackend()), { Blob: sandbox.Blob });
  for (const name of Object.keys(handlers)) {
    assert.ok(!/^offlineGet/.test(name), `${name} would have to send bytes back through the hub`);
  }
});

test('a page needs a chapter to belong to', async () => {
  const store = createOfflineStore(fakeBackend());
  await assert.rejects(() => store.putPage('', 0, 'x'), /chapter url/);
  await assert.rejects(() => store.commit({}), /chapter url/);
});

// --- through the real service worker ---------------------------------------
// Everything above runs the store against a Map. These run it the way the
// reader does: messages into extension/background.js, over its generated copy
// of this file, against an IndexedDB. That is where the wiring lives — an
// import that was never added, extras that were spread into the wrong object,
// a database opened on the wrong side of the bridge.

test('the worker saves and returns a chapter sent to it as messages', async () => {
  const w = bootWorker();
  const url = 'https://scan.test/manga/x/chapitre-109';

  // `equal` on the field, not `deepEqual` on the reply: the worker's objects
  // are built inside a vm context, so they are structurally identical and never
  // reference-equal to a literal written out here.
  assert.equal((await w.send({ type: 'offlineHas', chapterUrl: url })).saved, false);
  for (let i = 0; i < 3; i++) {
    const r = await w.send({
      type: 'offlinePage',
      chapterUrl: url,
      index: i,
      b64: Buffer.from(`page ${i}`).toString('base64'),
    });
    assert.equal(r.ok, true, `page ${i} refused`);
  }
  const done = await w.send({ type: 'offlineCommit', meta: meta() });
  assert.equal(done.chapter.pageCount, 3);

  const { chapters } = await w.send({ type: 'offlineList' });
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].chapterLabel, 'Ch. 109');
  const used = await w.send({ type: 'offlineUsage' });
  assert.equal(used.chapters, 1);
  assert.equal(used.bytes, 4200);

  await w.send({ type: 'offlineRemove', chapterUrl: url });
  assert.equal((await w.send({ type: 'offlineHas', chapterUrl: url })).saved, false);
});

test("one worker's saved chapters are not another's", async () => {
  // Guards the test harness, not the store: a shared fake database would make
  // every assertion above depend on what ran before it.
  const a = bootWorker();
  await a.send({ type: 'offlinePage', chapterUrl: 'u', index: 0, b64: 'AAAA' });
  await a.send({ type: 'offlineCommit', meta: { chapterUrl: 'u' } });

  const b = bootWorker();
  assert.equal((await b.send({ type: 'offlineList' })).chapters.length, 0);
});

test('the page key holds a URL containing spaces', () => {
  // chapterOf() splits on the first space, so the key format only works while
  // the URL cannot contain one — which is true of an href a browser resolved,
  // and worth pinning before someone starts keying on a title.
  assert.equal(pageKey('https://a.test/c/1', 7), 'https://a.test/c/1 0007');
});
