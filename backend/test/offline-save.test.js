// The half of offline reading that had never been run.
//
// `offline-store.test.js` covers the store: what it keeps, what it refuses,
// what it drops after ninety days. What it does not cover is the side that
// fills it — the reader's 📥 button, which fetches forty images, base64s each
// one, sends it across, and only then writes the metadata that makes the
// chapter exist. That code had a test suite of zero and a comment in the
// comparison document admitting it had never been triggered.
//
// So this drives the shipped button, not a description of it: the real
// functions lifted out of `extension/content/reader.js`, talking to the real
// `shared/offline-store.js` over the real message names, and — in the last
// test — through `extension/background.js` itself.
//
// The failures worth catching here are all the same shape: a save that looks
// like it worked. A chapter missing one page, a chapter filed under the wrong
// URL, a button showing 📗 for something that was never written. None of them
// throws, and all of them are discovered weeks later by someone with no network
// and no way to fix it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootWorker } from '../test-support/worker.js';
import { fakeIndexedDB } from '../test-support/fake-indexeddb.js';
import { t, i18n } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rjs = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');
const store$ = readFileSync(join(root, 'shared', 'offline-store.js'), 'utf8');

// The store, run as the browser runs it: an IIFE onto a global.
const sandbox = { Blob, setTimeout, clearTimeout };
new Function('globalThis', 'self', store$).call(sandbox, sandbox, sandbox);
const { createOfflineStore, idbBackend, offlineMessages } = sandbox.PanelFlowOffline;

/** A run of the shipping reader, with its free names handed in. */
function lift(from, to, names, inject) {
  const a = rjs.indexOf(from);
  const b = rjs.indexOf(to);
  assert.ok(a !== -1 && b > a, `${from.trim()} is not where this test expects it`);
  const fn = new Function(...names, `${rjs.slice(a, b)}
  return { chunk: typeof chunk === 'undefined' ? null : chunk,
           imageType: typeof imageType === 'undefined' ? null : imageType,
           markOffline: typeof markOffline === 'undefined' ? null : markOffline,
           refreshOffline: typeof refreshOffline === 'undefined' ? null : refreshOffline,
           toggleOffline: typeof toggleOffline === 'undefined' ? null : toggleOffline };`);
  return fn(...names.map((n) => inject[n]));
}

const imageType = lift(
  '  // What an image actually is, read from its first bytes',
  '  async function downloadChapter(', [], {},
).imageType;

// --- a reader to press the button on -----------------------------------------

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [0x52, 0x49, 0x46, 0x46];

/** `n` bytes that are not all the same, so a truncation shows up. */
const body = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const page = (magic, n = 300, seed = 1) =>
  Uint8Array.from([...magic, ...body(n, seed)]);

/**
 * The reader as `toggleOffline` sees it: a state object, one button, and a
 * network that answers from a table.
 *
 * @param {object} o
 * @param {object} o.net   image url → bytes, or null for "cannot be fetched"
 * @param {object} [o.send] the hub; defaults to a real store behind real messages
 */
function reader({ net, send, novel = false, paragraphs = [], meta: over = {} }) {
  const btn = { textContent: '📥', title: '', dataset: {}, disabled: false };
  const flashes = [];
  const timers = [];
  const state = {
    root: { querySelector: () => btn },
    images: Object.keys(net || {}),
    novel,
    paragraphs,
    meta: {
      chapterUrl: 'https://scan.test/x/chapitre-109',
      sourceUrl: 'https://scan.test/x',
      title: 'Ao no Hako',
      chapterLabel: 'Ch. 109',
      ...over,
    },
  };
  const api = lift(
    '  const chunk = (bytes) => {',
    '  // --- library & progress ---',
    ['state', 'send', 'fetchPageBytes', 'imageType', 'flash', 'setTimeout', 't'],
    {
      state,
      send,
      t,
      fetchPageBytes: async (src) => net[src],
      imageType,
      flash: (text) => flashes.push(text),
      // Captured rather than run: the ⚠ button resets itself three seconds
      // later, and a test should not take three seconds to find that out.
      setTimeout: (fn) => { timers.push(fn); return 0; },
    },
  );
  return { ...api, state, btn, flashes, runTimers: () => timers.splice(0).forEach((f) => f()) };
}

/** A store on a real IndexedDB, behind the real message names. */
function hub() {
  const store = createOfflineStore(idbBackend(fakeIndexedDB()));
  const handlers = offlineMessages(store, { Blob });
  return { store, send: (msg) => handlers[msg.type](msg) };
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

// --- the round trip ----------------------------------------------------------

test('a chapter saved from the reader comes back byte for byte', async () => {
  // The whole point of the feature in one test: press 📥, then open what was
  // written and check it against what was on the page. Everything in between —
  // base64, the message hop, IndexedDB, the sort that puts page 10 after page 9
  // — is real here.
  const net = {
    'https://cdn.test/1.png': page(PNG, 400, 3),
    'https://cdn.test/2.jpg': page(JPG, 1500, 7),
    'https://cdn.test/3.webp': page(WEBP, 90, 11),
  };
  const h = hub();
  const r = reader({ net, send: h.send });
  await r.toggleOffline();

  assert.equal(r.btn.textContent, '📗', `the button says ${r.btn.textContent}`);
  assert.equal(r.btn.dataset.saved, '1');
  assert.deepEqual(r.flashes, [], 'a save that worked said nothing');

  const saved = await h.store.get(r.state.meta.chapterUrl);
  assert.ok(saved, 'the chapter was not written');
  assert.equal(saved.meta.pageCount, 3);
  assert.equal(saved.meta.title, 'Ao no Hako', 'the metadata came across with it');
  assert.equal(saved.meta.bytes, 404 + 1504 + 94, 'the size reported is the size stored');

  const want = Object.values(net);
  for (let i = 0; i < want.length; i++) {
    assert.deepEqual([...await bytesOf(saved.pages[i])], [...want[i]], `page ${i + 1}`);
  }
});

test('a saved page carries the type its bytes say, not the one its URL does', async () => {
  // The detector hands the reader blob: URLs as often as real ones, and a blob:
  // URL has no extension to read a type off. Guessing image/jpeg for a PNG is
  // the kind of wrong that works everywhere until it does not.
  const net = {
    'blob:https://scan.test/9f2a-aaaa': page(PNG),
    'blob:https://scan.test/9f2a-bbbb': page(WEBP),
    'https://cdn.test/three.png': page(JPG), // the URL lies; the bytes do not
  };
  const h = hub();
  await reader({ net, send: h.send }).toggleOffline();

  const saved = await h.store.get('https://scan.test/x/chapitre-109');
  assert.deepEqual(saved.pages.map((p) => p.type), ['image/png', 'image/webp', 'image/jpeg']);
});

test('the type falls back to the URL only when the bytes are unrecognised', () => {
  assert.deepEqual(imageType(new Uint8Array([0, 1, 2]), 'https://a.test/p.avif'),
    { ext: 'avif', mime: 'image/avif' });
  assert.deepEqual(imageType(new Uint8Array([0, 1, 2]), 'https://a.test/p.JPEG'),
    { ext: 'jpeg', mime: 'image/jpeg' });
  assert.deepEqual(imageType(new Uint8Array([0, 1, 2]), 'https://a.test/p.jpg?w=800'),
    { ext: 'jpg', mime: 'image/jpeg' }, 'a query string is not part of the extension');
  assert.deepEqual(imageType(new Uint8Array([]), 'https://cdn.test/img/40213'),
    { ext: 'jpg', mime: 'image/jpeg' }, 'no bytes and no extension still has to answer');
});

// --- what must not be called a saved chapter ---------------------------------

test('a chapter missing one page is not saved at all', async () => {
  // The failure this feature exists to avoid. Skipping the page that would not
  // fetch leaves a chapter that commits, lists, shows 📗 and opens — with a
  // page missing, discovered on a train three weeks later.
  const net = {
    'https://cdn.test/1.jpg': page(JPG),
    'https://cdn.test/2.jpg': null, // 404, hotlink block, expired token
    'https://cdn.test/3.jpg': page(JPG),
  };
  const h = hub();
  const r = reader({ net, send: h.send });
  await r.toggleOffline();

  assert.equal(await h.store.has('https://scan.test/x/chapitre-109'), false,
    'a chapter with a hole in it was offered as readable');
  assert.equal(r.btn.textContent, '⚠');
  assert.match(r.flashes.join(' '), /page 2/, 'the reader was not told which page failed');
  assert.equal(r.btn.disabled, false, 'the button was left dead');

  r.runTimers();
  assert.equal(r.btn.textContent, '📥', 'the button never came back');
});

test('the pages of a failed save are swept, not left on the disk', async () => {
  // They are unreachable the moment the commit does not happen — nothing lists
  // them and nothing ever will — but they are still tens of megabytes.
  const h = hub();
  await reader({
    net: { 'https://cdn.test/1.jpg': page(JPG, 5000), 'https://cdn.test/2.jpg': null },
    send: h.send,
  }).toggleOffline();

  assert.deepEqual(await h.store.usage(), { chapters: 0, bytes: 0 });
  assert.deepEqual(await h.store.sweep(), { ok: true, dropped: 1 });
  assert.deepEqual(await h.store.sweep(), { ok: true, dropped: 0 }, 'swept twice');
});

test('a save that outlives its chapter does not file pages under the next one', async () => {
  // Ten seconds to save forty pages, one second to click "next chapter". The
  // loop reading state.meta each time round would put the rest of chapter 109
  // inside chapter 110, and neither chapter would ever say so.
  const h = hub();
  const net = {
    'https://cdn.test/1.jpg': page(JPG, 100, 1),
    'https://cdn.test/2.jpg': page(JPG, 100, 2),
    'https://cdn.test/3.jpg': page(JPG, 100, 3),
  };
  const r = reader({ net, send: h.send });
  const first = r.state.meta.chapterUrl;

  // The reader moves on while page 2 is in flight.
  const realSend = h.send;
  let n = 0;
  const watched = async (msg) => {
    const out = await realSend(msg);
    if (msg.type === 'offlinePage' && ++n === 2) {
      r.state.meta = { ...r.state.meta, chapterUrl: 'https://scan.test/x/chapitre-110' };
    }
    return out;
  };
  const r2 = reader({ net, send: watched });
  r2.state.meta = r.state.meta;
  Object.assign(r, r2); // same state object, the watched hub
  await r2.toggleOffline();

  assert.equal(await h.store.has(first), false, 'the abandoned chapter was committed anyway');
  assert.equal(await h.store.has('https://scan.test/x/chapitre-110'), false,
    'chapter 110 was invented out of chapter 109’s pages');
  const orphans = await h.store.sweep();
  assert.ok(orphans.dropped > 0 && orphans.dropped < 3,
    `${orphans.dropped} pages were written after the reader had moved on`);
});

test('a stale answer does not paint the wrong chapter’s button', async () => {
  // offlineHas is asked on every open. Open two chapters quickly and the first
  // reply can land last, marking a chapter 📗 that was never saved.
  let answer;
  const r = reader({
    net: {},
    send: () => new Promise((res) => { answer = res; }),
  });
  const pending = r.refreshOffline();
  r.state.meta = { ...r.state.meta, chapterUrl: 'https://scan.test/x/chapitre-110' };
  answer({ saved: true });
  await pending;

  assert.equal(r.btn.textContent, '📥');
  assert.equal(r.btn.dataset.saved, undefined, 'chapter 110 was marked saved by 109’s answer');
});

// --- the shapes that are not images ------------------------------------------

test('a text chapter is saved by the commit alone', async () => {
  // Prose travels in the metadata, so there is nothing to fetch — and a network
  // that throws on every call proves it.
  const h = hub();
  const r = reader({
    net: {},
    send: h.send,
    novel: true,
    paragraphs: ['Le vent se lève.', 'Il faut tenter de vivre.'],
  });
  await r.toggleOffline();

  const saved = await h.store.get('https://scan.test/x/chapitre-109');
  assert.equal(saved.meta.kind, 'text');
  assert.equal(saved.meta.pageCount, 2);
  assert.deepEqual(saved.pages, [], 'a novel has no page bytes');
  assert.deepEqual(saved.meta.paragraphs, ['Le vent se lève.', 'Il faut tenter de vivre.']);
});

test('removing takes the chapter the button was clicked on', async () => {
  const h = hub();
  const net = { 'https://cdn.test/1.jpg': page(JPG) };
  const r = reader({ net, send: h.send });
  await r.toggleOffline();
  assert.equal(r.btn.dataset.saved, '1');

  await r.toggleOffline(); // the same button, now 📗
  assert.equal(await h.store.has('https://scan.test/x/chapitre-109'), false);
  assert.equal(r.btn.textContent, '📥');
  assert.deepEqual(await h.store.usage(), { chapters: 0, bytes: 0 });
});

// --- through the service worker ----------------------------------------------

test('the reader’s button saves a chapter through the real worker', async () => {
  // Everything above builds its own hub. This one goes through
  // extension/background.js — its generated copy of the store, its own
  // database, its own message table — because that is where the wiring bugs
  // live and this is the path a real 📥 takes.
  const w = bootWorker();
  const net = {
    'https://cdn.test/1.png': page(PNG, 800, 5),
    'https://cdn.test/2.jpg': page(JPG, 200, 6),
  };
  const r = reader({ net, send: w.send });
  await r.toggleOffline();

  assert.equal(r.btn.textContent, '📗', r.flashes.join(' ') || 'the save did not finish');
  const { chapters } = await w.send({ type: 'offlineList' });
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].chapterLabel, 'Ch. 109');
  assert.equal(chapters[0].pageCount, 2);
  assert.equal(chapters[0].bytes, 804 + 204);
  assert.equal((await w.send({ type: 'offlineHas', chapterUrl: r.state.meta.chapterUrl })).saved,
    true);
});

// --- what leaves with the series ---------------------------------------------

test('removing a series takes its saved chapters off the device', async () => {
  // `removeSeries` existed, was tested, and was called by nothing. Removing a
  // series left every chapter saved from it on the disk for ninety days — and
  // listed on the saved-chapters page under a series no longer in the library,
  // which is the shape of the storage the user was trying to get back.
  const w = bootWorker();
  const { entry } = await w.send({
    type: 'addToLibrary',
    entry: { title: 'Ao no Hako', sourceUrl: 'https://scan.test/x', sourceDomain: 'scan.test' },
  });

  const net = { 'https://cdn.test/1.jpg': page(JPG, 600) };
  for (const n of [109, 110]) {
    const r = reader({ net, send: w.send, meta: { chapterUrl: `https://scan.test/x/ch-${n}` } });
    await r.toggleOffline();
    assert.equal(r.btn.textContent, '📗', `chapter ${n} did not save`);
  }
  // One chapter of a different series, to prove the removal is aimed.
  const other = reader({
    net,
    send: w.send,
    meta: { chapterUrl: 'https://other.test/y/ch-1', sourceUrl: 'https://other.test/y' },
  });
  await other.toggleOffline();
  assert.equal((await w.send({ type: 'offlineList' })).chapters.length, 3);

  await w.send({ type: 'removeFromLibrary', id: entry.id });

  const { chapters } = await w.send({ type: 'offlineList' });
  assert.deepEqual(chapters.map((c) => c.chapterUrl), ['https://other.test/y/ch-1'],
    'the removed series left its chapters behind, or took someone else’s');
  assert.equal((await w.send({ type: 'offlineUsage' })).bytes, 604);
});

test('a series with nothing saved is still removed', async () => {
  // The cleanup runs on every removal, so it is on the path of every user who
  // has never pressed 📥 once — and it must not be able to fail that path.
  const w = bootWorker();
  const { entry } = await w.send({
    type: 'addToLibrary',
    entry: { title: 'Berserk', sourceUrl: 'https://scan.test/b', sourceDomain: 'scan.test' },
  });
  // `equal` on the field: the worker's objects are built inside a vm context,
  // so they are structurally identical and never reference-equal to a literal.
  assert.equal((await w.send({ type: 'removeFromLibrary', id: entry.id })).ok, true);
  assert.equal((await w.send({ type: 'getLibrary' })).library.length, 0);
});

test('a store that will not open does not block a removal', async () => {
  // Removing a series is the user's decision and it has already been taken.
  // Whatever the cleanup runs into afterwards is the cleanup's problem.
  // A quiet console: the failure below is the point of the test, and its stack
  // in the middle of a passing run reads as something having gone wrong.
  const box = { console: { ...console, warn() {} }, crypto, URL, URLSearchParams };
  box.globalThis = box;
  for (const f of ['series-match.js', 'panelflow-core.js']) {
    const src = readFileSync(join(root, 'shared', f), 'utf8');
    new Function('globalThis', 'self', src).call(box, box, box);
  }

  const local = { library: [{ id: 'a1', title: 'X', sourceUrl: 'https://scan.test/x' }] };
  const core = box.PanelFlowCore.createCore({
    storage: {
      get: async (keys) => Object.fromEntries(
        [].concat(keys).filter((k) => k in local).map((k) => [k, local[k]]),
      ),
      set: async (o) => Object.assign(local, o),
    },
    fetch: async () => { throw new Error('offline'); },
    onRemoved: async () => { throw new Error('QuotaExceededError'); },
  });

  await core.removeFromLibrary('a1');
  assert.deepEqual(local.library, [], 'the series survived because the cleanup did not');
});

// --- drift -------------------------------------------------------------------

test('nothing in the reader guesses an image type from a URL on its own', () => {
  // The .cbz and the offline store answered this question separately once, and
  // gave different answers for the same page. One sniffer, one call site each.
  const sniffs = rjs.match(/0x89 && bytes\[1\] === 0x50/g) || [];
  assert.equal(sniffs.length, 1, `${sniffs.length} copies of the magic-byte table`);
  const extRegex = rjs.match(/\(jpe\?g\|png\|webp\|gif\|avif\)/g) || [];
  assert.equal(extRegex.length, 1,
    `${extRegex.length} places read an extension off a URL; imageType is the only one allowed`);
});

test('the saved-chapters page is reachable and reads from the store directly', () => {
  // A blob cannot cross chrome messaging, so reading has to happen on the
  // store's own origin — and if nothing opens that page, everything above saves
  // into a shelf with no door.
  const popup = readFileSync(join(root, 'extension', 'popup', 'popup.js'), 'utf8');
  assert.match(popup, /offline\/offline\.html/, 'nothing opens the saved-chapters page');

  const page$ = readFileSync(join(root, 'extension', 'offline', 'offline.js'), 'utf8');
  assert.match(page$, /createOfflineStore\(idbBackend\(indexedDB\)\)/);
  assert.match(page$, /PanelFlowReader\.open\(/, 'the page lists chapters it cannot open');
  assert.ok(!/offlineGet/.test(page$), 'reading went back through the hub, where blobs die');

  const html = readFileSync(join(root, 'extension', 'offline', 'offline.html'), 'utf8');
  for (const src of ['../shared/offline-store.js', '../content/reader.js', 'offline.js']) {
    assert.ok(html.includes(src), `${src} is not loaded by the saved-chapters page`);
  }
});
