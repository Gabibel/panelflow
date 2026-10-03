// Chapters kept on the device, for reading with no network.
//
// The bytes cannot live where the rest of the app's state lives. `storage` in
// the core is a JSON key-value store — chrome.storage.local in the extension,
// localStorage in the mobile worker — and a chapter is forty images. So this is
// its own store, and the only one in the project that holds binary.
//
// Where it runs matters more than usual. A content script shares the *site's*
// origin, so a chapter saved from there would land in a database belonging to
// whichever site the user happened to be on, invisible to everything else and
// wiped with that site's data. The store therefore lives on the app's own side
// of the bridge — the extension's service worker, the mobile worker WebView —
// and the page streams its bytes across. `offlineMessages()` at the bottom is
// that crossing, and it is the same set of messages on every platform.
//
// Two logical stores, not one: a chapter's metadata is a few hundred bytes and
// its pages are tens of megabytes, and the list screen must not have to load
// the second to show the first.
(function (root) {
  'use strict';

  const DB_NAME = 'panelflow-offline';
  const DB_VERSION = 1;
  const META = 'meta';
  const PAGES = 'pages';

  /**
   * IndexedDB behind a flat async interface, so everything below is testable
   * without a browser and a different backend could be dropped in.
   * @param {IDBFactory} idb
   */
  function idbBackend(idb) {
    let dbp = null;
    const open = () => (dbp || (dbp = new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        if (!db.objectStoreNames.contains(PAGES)) db.createObjectStore(PAGES);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })));

    const run = async (store, mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.onabort = tx.onerror = () => reject(tx.error || (req && req.error));
        // The request's result, once the transaction it belongs to has actually
        // committed — a value read from a transaction that then aborts is a
        // value that was never really there.
        tx.oncomplete = () => resolve(req ? req.result : undefined);
      });
    };

    return {
      get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
      put: (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key)),
      del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
      keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
      values: (store) => run(store, 'readonly', (s) => s.getAll()),
    };
  }

  // How long a saved chapter is kept. Downloads are a convenience for a train
  // ride, not an archive: without an expiry the store only ever grows, and the
  // chapters at the bottom of it are ones nobody will open again. Ninety days
  // is long enough that a reader coming back to a series still has what they
  // saved, and short enough that the disk does not fill with last year's.
  const RETENTION_DAYS = 90;
  const DAY_MS = 86400000;

  /** A chapter's page N. Sorts correctly as a string, which `keys()` relies on. */
  const pageKey = (url, index) => `${url} ${String(index).padStart(4, '0')}`;
  const chapterOf = (key) => key.slice(0, key.indexOf(' '));

  /**
   * @param {object} backend  from `idbBackend`, or a fake in tests
   * @param {object} [env]
   * @param {Function} [env.now] () → epoch ms
   */
  function createOfflineStore(backend, env = {}) {
    const now = env.now || (() => Date.now());

    /**
     * One page of a chapter being saved. Written as it arrives rather than
     * buffered: a service worker can be killed between two messages, and a
     * half-saved chapter that resumes beats a half-saved chapter that is lost.
     */
    async function putPage(chapterUrl, index, blob) {
      if (!chapterUrl) throw new Error('putPage needs a chapter url');
      await backend.put(PAGES, pageKey(chapterUrl, index), blob);
      return { ok: true };
    }

    /**
     * The commit. Metadata is written last and is what `list()` reads, so a
     * chapter interrupted halfway simply does not exist — its orphan pages are
     * swept below rather than shown as something readable.
     */
    async function commit(meta) {
      const url = meta && meta.chapterUrl;
      if (!url) throw new Error('commit needs a chapter url');
      const keys = (await backend.keys(PAGES)).filter((k) => chapterOf(k) === url);
      const pageCount = meta.kind === 'text' ? (meta.paragraphs || []).length : keys.length;
      if (!pageCount) throw new Error('nothing to save');
      const record = {
        ...meta,
        kind: meta.kind === 'text' ? 'text' : 'images',
        pageCount,
        bytes: meta.bytes || 0,
        savedAt: now(),
      };
      await backend.put(META, url, record);
      return record;
    }

    async function get(chapterUrl) {
      const meta = await backend.get(META, chapterUrl);
      if (!meta) return null;
      if (meta.kind === 'text') return { meta, pages: [] };
      const keys = (await backend.keys(PAGES))
        .filter((k) => chapterOf(k) === chapterUrl).sort();
      const pages = [];
      for (const k of keys) pages.push(await backend.get(PAGES, k));
      // `!== undefined` and not a truthiness test: what is being dropped is a
      // key whose value has gone, and "falsy" is not the same question.
      return { meta, pages: pages.filter((p) => p !== undefined) };
    }

    const has = async (chapterUrl) => !!(await backend.get(META, chapterUrl));

    /** Every saved chapter, newest first. Metadata only — never the bytes. */
    async function list() {
      const metas = await backend.values(META);
      return metas.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    }

    async function remove(chapterUrl) {
      for (const k of await backend.keys(PAGES)) {
        if (chapterOf(k) === chapterUrl) await backend.del(PAGES, k);
      }
      await backend.del(META, chapterUrl);
      return { ok: true };
    }

    /** Everything saved for one series — what "remove from library" implies. */
    async function removeSeries(sourceUrl) {
      let removed = 0;
      for (const meta of await list()) {
        if (meta.sourceUrl !== sourceUrl) continue;
        await remove(meta.chapterUrl);
        removed++;
      }
      return { ok: true, removed };
    }

    async function usage() {
      const metas = await list();
      return {
        chapters: metas.length,
        bytes: metas.reduce((n, m) => n + (m.bytes || 0), 0),
      };
    }

    /** Days left before a saved chapter is dropped; 0 means it is due now. */
    const daysLeft = (meta, days = RETENTION_DAYS) =>
      Math.max(0, Math.ceil(((meta.savedAt || 0) + days * DAY_MS - now()) / DAY_MS));

    /**
     * Drop what has aged out. Deliberately not a background timer inside the
     * store: it runs when something is already looking at the shelf — browser
     * start, the chapter check alarm, the saved-chapters page — so a chapter is
     * never deleted out from under a reader who has it open.
     */
    async function expire({ days = RETENTION_DAYS } = {}) {
      const cutoff = now() - days * DAY_MS;
      const dropped = [];
      for (const meta of await list()) {
        // A record with no savedAt predates the field and is not evidence of
        // age — leave it rather than delete something on a guess.
        if (!meta.savedAt || meta.savedAt > cutoff) continue;
        await remove(meta.chapterUrl);
        dropped.push(meta.chapterUrl);
      }
      return { ok: true, dropped: dropped.length, chapters: dropped };
    }

    /**
     * Pages with no chapter to belong to: a save that was interrupted, or one
     * whose metadata was deleted while its bytes were being written. Nothing
     * reads them and nothing ever will, but they still occupy the disk.
     */
    async function sweep() {
      const live = new Set(await backend.keys(META));
      let dropped = 0;
      for (const k of await backend.keys(PAGES)) {
        if (live.has(chapterOf(k))) continue;
        await backend.del(PAGES, k);
        dropped++;
      }
      return { ok: true, dropped };
    }

    return {
      putPage, commit, get, has, list, remove, removeSeries,
      usage, sweep, expire, daysLeft,
    };
  }

  // --- the crossing ---------------------------------------------------------

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /**
   * Bytes out of a base64 string, without atob: the extension has it, but a
   * worker WebView on an old Android does not always, and this file is the one
   * place in the project that moves binary across the bridge.
   */
  function bytesFromB64(b64) {
    const s = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array((s.length * 3) >> 2);
    let acc = 0, bits = 0, i = 0;
    for (const ch of s) {
      acc = (acc << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) { bits -= 8; out[i++] = (acc >> bits) & 0xff; }
    }
    return out.subarray(0, i);
  }

  /**
   * The messages a page uses to save a chapter into the app's store. Spread
   * into `createHub`'s extras by every shell, so the content script that sends
   * them cannot tell which platform answered.
   *
   * Reading is deliberately absent: a blob cannot survive a hub reply (the
   * extension's messaging is JSON, and the bridge is a string channel), and
   * everything that reads a saved chapter — the extension's offline page, the
   * app's shell — is already on the store's own origin and opens it directly.
   */
  function offlineMessages(store, env = {}) {
    const Blob_ = env.Blob || root.Blob;
    return {
      offlinePage: async (msg) => {
        const bytes = bytesFromB64(msg.b64);
        const blob = new Blob_([bytes], { type: msg.mime || 'image/jpeg' });
        await store.putPage(msg.chapterUrl, msg.index, blob);
        return { ok: true, bytes: bytes.length };
      },
      offlineCommit: async (msg) => ({ ok: true, chapter: await store.commit(msg.meta) }),
      offlineHas: async (msg) => ({ saved: await store.has(msg.chapterUrl) }),
      // Every listing expires first, so nothing that has aged out is ever
      // offered as readable — including to a shell that never calls expire().
      offlineList: async () => {
        await store.expire();
        return { chapters: await store.list(), retentionDays: RETENTION_DAYS };
      },
      offlineExpire: async (msg) => store.expire(msg || {}),
      offlineRemove: async (msg) => store.remove(msg.chapterUrl),
      offlineUsage: async () => store.usage(),
      offlineSweep: async () => store.sweep(),
    };
  }

  root.PanelFlowOffline = {
    createOfflineStore, idbBackend, offlineMessages, bytesFromB64, pageKey,
    DB_NAME, RETENTION_DAYS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
