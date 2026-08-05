// PanelFlow store core — every rule about the library, progress, duplicates and
// backend sync lives here, and only here.
//
// The extension's service worker, the Android shell and the iOS shell all run
// this same file. They differ only in what they hand to `createCore`: a key/value
// store, a `fetch`, and a way to raise a notification. Nothing below touches a
// `chrome.*` API, a DOM, or a Node built-in, so it loads unchanged as a Chrome
// content/worker script, inside a WKWebView, inside an Android WebView, and in
// `node --test`.
//
// Plain IIFE rather than an ES module on purpose: Chrome MV3 content scripts
// cannot be modules, and this file has to be loadable by `importScripts` too.
// Edit this copy — `extension/shared/` and `mobile/shared/` are generated
// (`npm run sync:shared`).
(function (root) {
  'use strict';

  const M = root.PanelFlowMatch;
  if (!M) throw new Error('panelflow-core.js requires series-match.js to be loaded first');
  const { normUrl, seriesKey, sameSeries, findMatches, furtherChapter, chapterNumber } = M;

  const DEFAULTS = { backendUrl: 'http://localhost:8787', checkIntervalMin: 360 };
  const RULES_TTL_MS = 6 * 3600 * 1000;

  // Pull the chapter number out of a label like "Ch. 110". Stripping non-digits
  // instead leaves the dot from "Ch." glued to the front (".110" → 0.11), which
  // made "Ch. 9" (0.9) look newer than "Ch. 10" (0.1) and blocked the advance.
  const labelNum = (label) => {
    const m = String(label ?? '').match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : NaN;
  };

  const CHAPTER_RE = /(chapter|chapitre|chap|ch|episode)[-_\s]*([\d]+(?:\.\d+)?)/gi;

  // Prefer chapter numbers found in link targets/texts (the chapter list) over
  // numbers loose in the page — same logic as the backend's meta scraper.
  const CHAPTER_LINK_RES = [
    /(?:href|value|data-href|data-url)=["'][^"']*?(?:chapter|chapitre|chap|ch|episode)[-_/]?([\d]+(?:\.\d+)?)[^"']*["']/gi,
    />\s*(?:chapter|chapitre|chap\.?|ch\.?|episode)[-_\s]*([\d]+(?:\.\d+)?)/gi,
  ];

  function maxChapterIn(html) {
    let max = null;
    for (const re of CHAPTER_LINK_RES) {
      for (const m of html.matchAll(re)) {
        const n = parseFloat(m[1]);
        if (!Number.isNaN(n) && n < 10000 && (max === null || n > max)) max = n;
      }
    }
    if (max !== null) return max;
    for (const m of html.matchAll(CHAPTER_RE)) {
      const n = parseFloat(m[2]);
      if (!Number.isNaN(n) && n < 10000 && (max === null || n > max)) max = n;
    }
    return max;
  }

  // Titles scraped from a chapter page keep the separators around them
  // ("Ao no Hako »"). Once entries merge, prefer one without that debris.
  const cleanTitle = (t) => String(t || '').replace(/^[\s»«|•·:—–-]+|[\s»«|•·:—–-]+$/g, '').trim();

  /**
   * @param {object} env
   * @param {{get(keys): Promise<object>, set(obj): Promise<void>}} env.storage
   * @param {Function} env.fetch          network access (same signature as global fetch)
   * @param {Function} [env.notify]       ({ id, title, message, entry }) → void, new-chapter alerts
   * @param {Function} [env.now]          () → ISO string, injectable for tests
   * @param {Function} [env.uuid]         () → string
   * @param {number}   [env.checkPacingMs] gap between requests in checkNewChapters
   * @param {object}   [env.defaults]     settings defaults (backendUrl, checkIntervalMin)
   */
  function createCore(env) {
    const store = env.storage;
    const netFetch = env.fetch;
    const notify = env.notify || (() => {});
    const now = env.now || (() => new Date().toISOString());
    const uuid = env.uuid || (() => root.crypto.randomUUID());
    const pacingMs = env.checkPacingMs ?? 2000;
    const defaults = { ...DEFAULTS, ...(env.defaults || {}) };

    async function getSettings() {
      const { settings } = await store.get(['settings']);
      return { ...defaults, ...(settings || {}) };
    }

    async function setSettings(patch) {
      const settings = { ...(await store.get(['settings'])).settings, ...patch };
      await store.set({ settings });
      return { ...defaults, ...settings };
    }

    async function getToken() {
      const { authToken } = await store.get(['authToken']);
      return authToken || null;
    }

    async function apiFetch(path, options = {}) {
      const settings = await getSettings();
      const token = await getToken();
      const resp = await netFetch(settings.backendUrl + path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {}),
        },
      });
      if (!resp.ok) throw new Error(`API ${path}: ${resp.status}`);
      return resp.status === 204 ? null : resp.json();
    }

    // --- detection rules (remote config with bundled fallback) ---------------

    async function getRules() {
      const { rulesCache } = await store.get(['rulesCache']);
      if (rulesCache && Date.now() - rulesCache.fetchedAt < RULES_TTL_MS) {
        return rulesCache.rules;
      }
      try {
        const rules = await apiFetch('/api/rules');
        await store.set({ rulesCache: { rules, fetchedAt: Date.now() } });
        return rules;
      } catch {
        return rulesCache ? rulesCache.rules : null; // clients carry their own fallback
      }
    }

    // --- library (local-first, sync when signed in) --------------------------

    async function getLibrary() {
      const { library } = await store.get(['library']);
      return library || [];
    }

    // Series URLs are guessed from chapter URLs and the guess drifts between
    // visits, so two entries for one series rarely share a URL. seriesKey (from
    // shared/series-match.js) reduces every URL to host + series slug so
    // ".../ao-no-hako/245/" and ".../ao-no-hako/247/" land on the same book, and
    // a site that files chapters under /chapter/ and the series under /manga/
    // still resolves to one entry.
    const findEntry = (library, url) => library.find((e) => sameSeries(e.sourceUrl, url));

    // That same drift means an entry's sourceUrl gets rewritten in place —
    // adding chapter 110 of a series first added from chapter 109 moves it. But
    // progress is keyed by sourceUrl, so unless the bookmark moves with it the
    // user's place in the book is orphaned under a URL nothing points at any
    // more, and "Continue reading" silently loses the series. migrateEntry does
    // this the long way round because it also has an absorbed entry to fold in;
    // here there are only ever two bookmarks to reconcile.
    async function rekeyProgress(from, to) {
      if (!from || !to || normUrl(from) === normUrl(to)) return;
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      const moved = map[from];
      if (!moved) return;
      delete map[from];
      // Forward-only, the same rule chapterVisited uses: whichever bookmark is
      // deeper into the series wins, so re-keying can never rewind the user.
      const rank = (p) => (p ? (chapterNumber(p.chapterLabel) ?? -1) : -Infinity);
      const winner = rank(map[to]) > rank(moved) ? map[to] : moved;
      map[to] = { ...winner, sourceUrl: to, updatedAt: now() };
      await store.set({ progress: map });
    }

    async function addToLibrary(entry) {
      // Where the user is reading rides along with the entry, but it is
      // progress, not library metadata — keep it out of the stored record.
      const { chapterUrl, chapterLabel, ...fields } = entry;
      const library = await getLibrary();
      const existing = findEntry(library, entry.sourceUrl);
      const movedFrom = existing?.sourceUrl;
      const record = existing || {
        folder: 'reading',
        id: uuid(),
        dateAdded: now(),
      };
      // Re-adding an entry is how the modal saves edits, so incoming fields win
      // — but only the ones actually supplied, or a quick add would blank the
      // rest.
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null) record[k] = v;
      }
      record.updatedAt = now();
      if (!existing) library.push(record);
      await store.set({ library });
      await rekeyProgress(movedFrom, record.sourceUrl);
      if (await getToken()) {
        try {
          await pushEntry(record, library);
          await backfillMeta(record, library);
        } catch (e) { warn('library sync failed', e); }
      }
      // Now that the entry exists, the chapter the user added it from can be
      // pinned as their progress (chapterVisited is forward-only, so re-adding
      // an old chapter later cannot rewind the bookmark).
      if (chapterUrl && chapterLabel) {
        await chapterVisited({ sourceUrl: record.sourceUrl, chapterUrl, chapterLabel });
      }
      return record;
    }

    // Push one local entry to the backend; POST is idempotent per (user, sourceUrl).
    async function pushEntry(record, library) {
      const remote = await apiFetch('/api/library', {
        method: 'POST',
        body: JSON.stringify({
          title: record.title,
          coverUrl: record.coverUrl ?? null,
          sourceDomain: record.sourceDomain,
          sourceUrl: record.sourceUrl,
          tags: record.tags || [],
          lastKnownChapter: record.lastKnownChapter ?? null,
          folder: record.folder ?? null,
          language: record.language ?? null,
          score: record.score ?? null,
          note: record.note ?? null,
          startDate: record.startDate ?? null,
          finishDate: record.finishDate ?? null,
          rereads: record.rereads ?? null,
          seriesStatus: record.seriesStatus ?? null,
        }),
      });
      record.remoteId = remote.id;
      await store.set({ library });
      return remote;
    }

    // Chapter pages rarely carry a usable og:image, so entries added from the
    // reader often have no cover and no latest chapter. Ask the backend to
    // scrape the series page and fill both, locally and remotely.
    async function backfillMeta(record, library) {
      if (record.coverUrl && record.lastKnownChapter) return;
      const meta = await apiFetch('/api/meta/scrape?url=' + encodeURIComponent(record.sourceUrl));
      const patch = {};
      if (!record.coverUrl && meta.coverUrl) patch.coverUrl = meta.coverUrl;
      if (!record.lastKnownChapter && meta.latestChapter !== null) {
        patch.lastKnownChapter = String(meta.latestChapter);
      }
      if (Object.keys(patch).length === 0) return;
      Object.assign(record, patch);
      await store.set({ library });
      if (record.remoteId) {
        await apiFetch(`/api/library/${record.remoteId}`, { method: 'PUT', body: JSON.stringify(patch) });
      }
    }

    // Collapse entries that seriesKey says are one series. Older builds guessed
    // a different sourceUrl on every visit, so a single book could end up filed
    // four times; the surviving entry keeps the best field from each and
    // inherits the furthest progress. Deleting the losers also soft-deletes them
    // server-side, so the web app converges without a separate migration.
    function pickCanonical(group) {
      // A sourceUrl left ending on a separator is the old broken guess — it
      // 404s, so it must never win however complete the rest of the entry looks.
      const rank = (e) =>
        (e.coverUrl ? 4 : 0) + (e.lastKnownChapter ? 2 : 0) + (e.remoteId ? 1 : 0) -
        (/[-_.\s]$/.test(String(e.sourceUrl || '')) ? 8 : 0);
      return group.reduce((best, e) => (rank(e) > rank(best) ? e : best), group[0]);
    }

    async function dedupeLibrary() {
      const library = await getLibrary();
      const groups = new Map();
      for (const e of library) {
        const k = seriesKey(e.sourceUrl);
        groups.set(k, (groups.get(k) || []).concat(e));
      }
      const merged = [];
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const keep = pickCanonical(group);
        const losers = group.filter((e) => e !== keep);
        for (const e of losers) {
          for (const [k, v] of Object.entries(e)) {
            // Fill gaps only: the canonical entry's own values are the good ones.
            if (v !== undefined && v !== null && v !== '' &&
                (keep[k] === undefined || keep[k] === null || keep[k] === '') &&
                !['id', 'remoteId', 'sourceUrl', 'dateAdded'].includes(k)) {
              keep[k] = v;
            }
          }
          keep.lastKnownChapter = furtherChapter(keep.lastKnownChapter, e.lastKnownChapter);
          // Keep the earliest date the series entered the library.
          if (e.dateAdded && (!keep.dateAdded || e.dateAdded < keep.dateAdded)) {
            keep.dateAdded = e.dateAdded;
          }
          keep.tags = [...new Set([...(keep.tags || []), ...(e.tags || [])])];
        }
        keep.title = cleanTitle(keep.title) || keep.title;
        merged.push({ keep, losers });
      }
      if (merged.length === 0) return { groups: 0, removed: 0 };

      // Move progress onto the surviving entry, furthest chapter wins.
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      for (const { keep, losers } of merged) {
        for (const e of losers) {
          const p = map[e.sourceUrl];
          if (!p) continue;
          const cur = map[keep.sourceUrl];
          if (!cur || !(labelNum(cur.chapterLabel) >= labelNum(p.chapterLabel))) {
            map[keep.sourceUrl] = { ...p, sourceUrl: keep.sourceUrl };
          }
          delete map[e.sourceUrl];
        }
        keep.updatedAt = now();
      }
      const drop = new Set(merged.flatMap(({ losers }) => losers.map((e) => e.id)));
      const kept = library.filter((e) => !drop.has(e.id));
      await store.set({ library: kept, progress: map });

      // Remote cleanup, one by one so a single failure cannot abort the rest.
      if (await getToken()) {
        for (const { losers } of merged) {
          for (const e of losers) {
            if (!e.remoteId) continue;
            try {
              await apiFetch(`/api/library/${e.remoteId}`, { method: 'DELETE' });
            } catch (err) { warn('dedupe remote delete failed', e.sourceUrl, err); }
          }
        }
        for (const { keep } of merged) {
          // `map` and `kept` are what was just written to the store, so re-reading
          // them once per group would only cost a round-trip per surviving entry.
          const p = map[keep.sourceUrl];
          try {
            if (!keep.remoteId) await pushEntry(keep, kept);
            else await apiFetch(`/api/library/${keep.remoteId}`, {
              method: 'PUT',
              body: JSON.stringify({
                title: keep.title,
                coverUrl: keep.coverUrl ?? null,
                lastKnownChapter: keep.lastKnownChapter ?? null,
                tags: keep.tags || [],
              }),
            });
            if (p && keep.remoteId) {
              await apiFetch(`/api/progress/${keep.remoteId}`, {
                method: 'PUT', body: JSON.stringify(p),
              });
            }
          } catch (err) { warn('dedupe remote merge failed', keep.sourceUrl, err); }
        }
      }
      return { groups: merged.length, removed: drop.size };
    }

    // Full reconciliation with the backend: adopt entries that never got a
    // remoteId (added while signed out), re-push all local progress, and
    // backfill missing covers. Runs after sign-in and on app/browser startup.
    async function syncAll() {
      if (!(await getToken())) return;
      await dedupeLibrary();
      const library = await getLibrary();
      for (const entry of library) {
        try {
          if (!entry.remoteId) await pushEntry(entry, library);
          await backfillMeta(entry, library);
        } catch (e) { warn('sync failed for', entry.sourceUrl, e); }
      }
      const { progress } = await store.get(['progress']);
      for (const p of Object.values(progress || {})) {
        const entry = findEntry(library, p.sourceUrl);
        if (!entry?.remoteId) continue;
        try {
          await apiFetch(`/api/progress/${entry.remoteId}`, { method: 'PUT', body: JSON.stringify(p) });
        } catch (e) { warn('progress sync failed for', p.sourceUrl, e); }
      }
      // Whatever was read while the account was unreachable. Last, because it
      // needs the entries above to have been pushed and given a remoteId.
      await flushHistory();
    }

    // Adopt the server's library into the local store. The extension never
    // needed this (it only ever pushes), but a phone that was signed in on
    // another device starts with an empty store and must be able to pull.
    async function pullLibrary() {
      if (!(await getToken())) return { added: 0, updated: 0 };
      const remote = await apiFetch('/api/library');
      const library = await getLibrary();
      let added = 0, updated = 0;
      for (const r of remote) {
        const local = library.find((e) => e.remoteId === r.id) || findEntry(library, r.sourceUrl);
        if (local) {
          // Last write wins, and the server row is only newer if it says so.
          if (!local.updatedAt || String(r.updatedAt) > String(local.updatedAt)) {
            Object.assign(local, r, { id: local.id, remoteId: r.id });
            updated++;
          } else if (!local.remoteId) {
            local.remoteId = r.id;
          }
        } else {
          library.push({ ...r, id: uuid(), remoteId: r.id });
          added++;
        }
      }
      await store.set({ library });

      const { progress } = await store.get(['progress']);
      const map = progress || {};
      for (const p of await apiFetch('/api/progress/continue').catch(() => [])) {
        const entry = library.find((e) => e.remoteId === p.libraryId);
        if (!entry) continue;
        const cur = map[entry.sourceUrl];
        if (cur && String(cur.updatedAt || '') >= String(p.updatedAt || '')) continue;
        map[entry.sourceUrl] = {
          sourceUrl: entry.sourceUrl,
          chapterUrl: p.chapterUrl,
          chapterLabel: p.chapterLabel,
          page: p.page ?? 0,
          pageCount: p.pageCount ?? null,
          scrollPos: p.scrollPos ?? 0,
          updatedAt: p.updatedAt,
        };
      }
      await store.set({ progress: map });
      return { added, updated };
    }

    // Patch one entry. Unlike addToLibrary's merge, an explicit null here clears
    // the field — that is how the detail view removes a score or a note.
    async function updateEntry(id, patch) {
      const library = await getLibrary();
      const entry = library.find((e) => e.id === id);
      if (!entry) throw new Error('entry not found');
      const movedFrom = entry.sourceUrl;
      Object.assign(entry, patch, { updatedAt: now() });
      await store.set({ library });
      await rekeyProgress(movedFrom, entry.sourceUrl);
      if (entry.remoteId && await getToken()) {
        apiFetch(`/api/library/${entry.remoteId}`, {
          method: 'PUT',
          body: JSON.stringify(patch),
        }).catch((e) => warn('entry sync failed', e));
      }
      return entry;
    }

    async function removeFromLibrary(id) {
      const library = await getLibrary();
      const entry = library.find((e) => e.id === id);
      await store.set({ library: library.filter((e) => e.id !== id) });
      if (entry?.remoteId && await getToken()) {
        apiFetch(`/api/library/${entry.remoteId}`, { method: 'DELETE' }).catch(() => {});
      }
    }

    // --- duplicates across sites ---------------------------------------------

    // Everything in the library that might already be the work on `meta`'s page.
    // Answered from local storage so it is instant and works signed out; the
    // server has the same matcher behind POST /api/library/match for clients
    // that do not carry the library locally.
    async function findSimilar(meta) {
      if (!meta?.title && !meta?.sourceUrl) return [];
      const library = await getLibrary();
      return findMatches(meta, library).map((m) => ({
        confidence: m.confidence,
        score: m.score,
        entry: m.entry,
      }));
    }

    /**
     * Move an existing entry to a different scan site, keeping progress, score,
     * tags and the date it was added. This is the alternative offered when the
     * series being added is already in the library under another site — without
     * it the user ends up reading the same book twice, in two places, with two
     * half-finished bookmarks.
     *
     * If a separate entry already sits on the destination it is absorbed rather
     * than left behind, mirroring what POST /api/library/:id/migrate does server
     * side so both stores end up with the same single entry.
     */
    async function migrateEntry(id, target) {
      const { sourceUrl, sourceDomain, title, coverUrl, lastKnownChapter, tags,
              chapterUrl, chapterLabel } = target || {};
      if (!sourceUrl || !sourceDomain) throw new Error('sourceUrl and sourceDomain required');

      const library = await getLibrary();
      const entry = library.find((e) => e.id === id);
      if (!entry) throw new Error('entry not found');
      const from = entry.sourceUrl;
      if (normUrl(sourceUrl) === normUrl(from)) throw new Error('already the current source');

      const other = library.find((e) => e.id !== entry.id && sameSeries(e.sourceUrl, sourceUrl));
      const keep = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? null;

      entry.previousSources = [...(entry.previousSources || []), {
        sourceUrl: from,
        sourceDomain: entry.sourceDomain,
        lastKnownChapter: entry.lastKnownChapter ?? null,
        migratedAt: now(),
      }];
      entry.sourceUrl = sourceUrl;
      entry.sourceDomain = sourceDomain;
      entry.title = keep(title, entry.title, other?.title);
      entry.coverUrl = keep(coverUrl, entry.coverUrl, other?.coverUrl);
      entry.lastKnownChapter = furtherChapter(entry.lastKnownChapter, other?.lastKnownChapter, lastKnownChapter);
      entry.tags = [...new Set([...(entry.tags || []), ...(other?.tags || []), ...(tags || [])])];
      // 'reading' is where every entry starts, so it loses to a folder the user
      // actually picked on the entry being absorbed.
      if (other && (!entry.folder || entry.folder === 'reading')) entry.folder = other.folder ?? entry.folder;
      for (const field of ['language', 'score', 'note', 'startDate', 'finishDate', 'seriesStatus']) {
        entry[field] = keep(entry[field], other?.[field]);
      }
      entry.rereads = Math.max(entry.rereads || 0, other?.rereads || 0);
      if (other?.dateAdded && other.dateAdded < entry.dateAdded) entry.dateAdded = other.dateAdded;
      entry.updatedAt = now();

      // Progress is keyed by sourceUrl, so it has to be re-filed under the new
      // one. Three bookmarks can exist: the one from the site being left, the
      // one the absorbed entry had, and the page the user is standing on. Keep
      // the furthest — and note that only the first has a URL into a site that
      // is being abandoned, so it gets aimed at the new series page instead.
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      const mine = map[from];
      const theirs = other ? map[other.sourceUrl] : undefined;
      const candidates = [
        mine && { ...mine, chapterUrl: sourceUrl, live: false },
        theirs && { ...theirs, live: true },
        chapterUrl && chapterLabel && { chapterUrl, chapterLabel, page: 0, live: true },
      ].filter(Boolean);
      const winner = candidates.sort((a, b) =>
        ((chapterNumber(b.chapterLabel) ?? -1) - (chapterNumber(a.chapterLabel) ?? -1))
        || (Number(b.live) - Number(a.live)))[0];

      delete map[from];
      if (other) delete map[other.sourceUrl];
      if (winner) {
        const { live, ...p } = winner;
        map[sourceUrl] = { ...p, sourceUrl, updatedAt: now() };
      }

      const next = other ? library.filter((e) => e.id !== other.id) : library;
      await store.set({ library: next, progress: map });

      if (await getToken()) {
        try {
          // No remoteId means the entry was added signed out; POST it first so
          // the migration has something server-side to move.
          if (!entry.remoteId) await pushEntry(entry, next);
          else {
            const { entry: remote } = await apiFetch(`/api/library/${entry.remoteId}/migrate`, {
              method: 'POST',
              body: JSON.stringify({
                sourceUrl, sourceDomain,
                title: entry.title,
                coverUrl: entry.coverUrl ?? null,
                lastKnownChapter: entry.lastKnownChapter ?? null,
                tags: entry.tags,
                chapterUrl: map[sourceUrl]?.chapterUrl ?? null,
                chapterLabel: map[sourceUrl]?.chapterLabel ?? null,
              }),
            });
            entry.remoteId = remote.id;
            await store.set({ library: next });
          }
        } catch (e) { warn('migration sync failed', e); }
      }
      return { entry, merged: other ?? null };
    }

    // --- progress ------------------------------------------------------------

    async function saveProgress(p) {
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      map[p.sourceUrl] = { ...p, updatedAt: now() };
      await store.set({ progress: map });
      if (await getToken()) {
        const library = await getLibrary();
        const entry = findEntry(library, p.sourceUrl);
        if (!entry) return;
        try {
          // Entry added while signed out: adopt it on the backend first.
          if (!entry.remoteId) await pushEntry(entry, library);
          await apiFetch(`/api/progress/${entry.remoteId}`, {
            method: 'PUT',
            body: JSON.stringify(p),
          });
        } catch (e) { warn('progress sync failed', e); }
      }
    }

    async function getProgressAll() {
      return store.get(['progress']);
    }

    // --- reading history -----------------------------------------------------

    // Reading happens on trains and planes; the account is not always reachable
    // and the reader must not have to care. A read is written locally first and
    // pushed when it can be, which is the same shape as progress — except that
    // progress overwrites and history accumulates, so a failed push here cannot
    // simply be left for the next save to carry.
    const HISTORY_LIMIT = 2000;
    const historyKey = (r) => `${r.chapterUrl}|${r.day}`;

    /** The reader's local day, not the server's: 1 a.m. is still last night. */
    function localDay(ts = Date.now()) {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    async function recordRead(read) {
      if (!read || !read.sourceUrl || !read.chapterUrl) return { ok: false };
      const seconds = Math.max(0, Math.round(Number(read.seconds) || 0));
      const pages = Math.max(0, Math.round(Number(read.pages) || 0));
      if (!seconds && !pages) return { ok: false };

      const day = read.day || localDay();
      const { history } = await store.get(['history']);
      const map = history || {};
      const key = historyKey({ chapterUrl: read.chapterUrl, day });
      const prev = map[key];
      map[key] = {
        sourceUrl: read.sourceUrl,
        chapterUrl: read.chapterUrl,
        chapterLabel: read.chapterLabel ?? prev?.chapterLabel ?? null,
        day,
        // Same arithmetic as the server, so a row that syncs late and a row
        // that syncs at once end up saying the same thing: time adds up,
        // pages is how far the chapter got.
        seconds: (prev?.seconds ?? 0) + seconds,
        pages: Math.max(prev?.pages ?? 0, pages),
        // What has not reached the server yet, which is what a later sync must
        // send — not the running total, or a retry would double-count it.
        pending: (prev?.pending ?? 0) + seconds,
        pendingPages: Math.max(prev?.pendingPages ?? 0, pages),
        at: now(),
      };
      prune(map);
      await store.set({ history: map });
      await pushRead(map[key], map);
      return { ok: true };
    }

    // Oldest days go first: the local copy exists to survive a flight, not to
    // be an archive — the account holds that.
    function prune(map) {
      const keys = Object.keys(map);
      if (keys.length <= HISTORY_LIMIT) return;
      keys.sort((a, b) => String(map[a].day).localeCompare(String(map[b].day)));
      for (const k of keys.slice(0, keys.length - HISTORY_LIMIT)) delete map[k];
    }

    async function pushRead(row, map) {
      if (!row.pending && !row.pendingPages) return;
      if (!(await getToken())) return;
      const library = await getLibrary();
      const entry = findEntry(library, row.sourceUrl);
      if (!entry) return;
      try {
        if (!entry.remoteId) await pushEntry(entry, library);
        await apiFetch('/api/history', {
          method: 'POST',
          body: JSON.stringify({
            libraryId: entry.remoteId,
            chapterUrl: row.chapterUrl,
            chapterLabel: row.chapterLabel,
            pages: row.pendingPages,
            seconds: row.pending,
            day: row.day,
          }),
        });
        // Re-read: the push took a round-trip and the reader may have added
        // more seconds to this same row in the meantime. Subtracting what was
        // sent keeps those, where clearing the field would drop them.
        const { history } = await store.get(['history']);
        const fresh = history || map;
        const cur = fresh[historyKey(row)];
        if (cur) {
          cur.pending = Math.max(0, (cur.pending ?? 0) - row.pending);
          cur.pendingPages = cur.pendingPages > row.pendingPages ? cur.pendingPages : 0;
          await store.set({ history: fresh });
        }
      } catch (e) { warn('history sync failed', row.chapterUrl, e); }
    }

    async function flushHistory() {
      const { history } = await store.get(['history']);
      const map = history || {};
      for (const row of Object.values(map)) await pushRead(row, map);
    }

    async function getHistory() {
      const { history } = await store.get(['history']);
      return Object.values(history || {}).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    }

    // Statistics are the server's: it holds every device's reads, and a second
    // implementation over the local copy would answer a different question
    // while looking like the same one.
    async function getStats() {
      if (!(await getToken())) return null;
      await flushHistory();
      return apiFetch('/api/history/stats');
    }

    /**
     * The chapters of one series that have actually been read — which is the
     * history, not the progress. Progress remembers one chapter per series (the
     * last one open), so it cannot answer "have I seen chapter 42"; history has
     * a row per chapter per day, written only once the reader banked real time
     * or real pages on it. Opening a chapter and closing it at once leaves no
     * row, which is the right answer: it was not read.
     *
     * A Set is what the caller wants, but this crosses a JSON bridge, so it
     * goes back as an array.
     */
    async function getReadChapters(sourceUrl) {
      const { history } = await store.get(['history']);
      const seen = new Set();
      for (const row of Object.values(history || {})) {
        if (sourceUrl && row.sourceUrl !== sourceUrl) continue;
        seen.add(row.chapterUrl);
      }
      return [...seen];
    }

    async function getProgressFor(chapterUrl) {
      const { progress } = await store.get(['progress']);
      for (const p of Object.values(progress || {})) {
        if (p.chapterUrl === chapterUrl) return p;
      }
      return null;
    }

    async function removeProgress(sourceUrl) {
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      delete map[sourceUrl];
      await store.set({ progress: map });
    }

    // A detected page carries fresh series meta scraped from the live DOM — the
    // only vantage point that works on Cloudflare-walled sites. Update the
    // matching library entry: cover if missing, latest chapter if it advanced.
    async function seriesSeen(meta) {
      if (!meta) return;
      const library = await getLibrary();
      const entry = findEntry(library, meta.sourceUrl) || findEntry(library, meta.chapterUrl);
      if (!entry) return;
      const patch = {};
      if (!entry.coverUrl && meta.coverUrl) patch.coverUrl = meta.coverUrl;
      // labelNum, not parseFloat: what the page yields is free text as often as
      // a bare number ("Chapitre 1055"), and parseFloat reads that as NaN and
      // drops the update.
      const seen = labelNum(meta.lastKnownChapter);
      const known = labelNum(entry.lastKnownChapter);
      if (!Number.isNaN(seen) && (Number.isNaN(known) || seen > known)) {
        patch.lastKnownChapter = String(seen);
      }
      if (Object.keys(patch).length === 0) return;
      Object.assign(entry, patch);
      await store.set({ library });
      if (entry.remoteId && await getToken()) {
        apiFetch(`/api/library/${entry.remoteId}`, { method: 'PUT', body: JSON.stringify(patch) })
          .catch(() => {});
      }
    }

    // Merely opening a chapter of a series you follow advances your progress —
    // no reader, no button. This is what keeps the library in step when you
    // navigate 109 → 110 with the site's own next-chapter link.
    async function chapterVisited(meta) {
      if (!meta?.chapterUrl || !meta.chapterLabel) return;
      const library = await getLibrary();
      const entry = findEntry(library, meta.sourceUrl) || findEntry(library, meta.chapterUrl);
      if (!entry) return; // only track series the user actually pinned
      const { progress } = await store.get(['progress']);
      const cur = (progress || {})[entry.sourceUrl];
      // Same chapter: the reader owns the page position, don't reset it to 0.
      if (cur && cur.chapterUrl === meta.chapterUrl) return;
      // Forward-only, so re-reading an old chapter doesn't rewind the bookmark.
      const seen = labelNum(meta.chapterLabel);
      const known = labelNum(cur?.chapterLabel);
      if (!Number.isNaN(known) && !Number.isNaN(seen) && seen < known) return;
      await saveProgress({
        sourceUrl: entry.sourceUrl,
        chapterUrl: meta.chapterUrl,
        chapterLabel: meta.chapterLabel,
        page: 0,
        pageCount: null,
        scrollPos: 0,
      });
    }

    // --- new chapter check ---------------------------------------------------

    async function checkNewChapters() {
      const library = await getLibrary();
      const found = new Map(); // entry id -> the chapter number seen on the site
      for (const entry of library) {
        try {
          // With the user's cookies: Cloudflare-walled sites (scan-manga) answer
          // normally in the browser but challenge anonymous/server requests.
          const resp = await netFetch(entry.sourceUrl, { credentials: 'include' });
          if (!resp.ok) continue;
          const latest = maxChapterIn(await resp.text());
          if (latest === null) continue;
          const known = parseFloat(entry.lastKnownChapter);
          if (!Number.isNaN(known) && latest > known) {
            notify({
              id: `pf-${entry.id}`,
              title: 'New chapter!',
              message: `${entry.title} — chapter ${latest} is out on ${entry.sourceDomain}`,
              entry,
              latest,
            });
          }
          entry.lastKnownChapter = String(latest);
          found.set(entry.id, entry.lastKnownChapter);
          if (entry.remoteId && await getToken()) {
            apiFetch(`/api/library/${entry.remoteId}`, {
              method: 'PUT',
              body: JSON.stringify({ lastKnownChapter: entry.lastKnownChapter }),
            }).catch(() => {});
          }
          // Respectful pacing: one request per series with a gap between domains.
          if (pacingMs) await new Promise((r) => setTimeout(r, pacingMs));
        } catch { /* site unreachable — try next cycle */ }
      }
      if (found.size === 0) return;
      // Re-read before writing. A full pass is one request plus a pause per
      // series, so it runs for minutes in the background while the user keeps
      // adding and editing entries — and `library` above is a snapshot from
      // before all of that. Writing it back would silently undo their work, so
      // only the field this function owns is carried over.
      const current = await getLibrary();
      for (const entry of current) {
        const latest = found.get(entry.id);
        if (latest !== undefined) entry.lastKnownChapter = latest;
      }
      await store.set({ library: current });
    }

    // --- auth ----------------------------------------------------------------

    async function authenticate(kind, email, password) {
      const data = await apiFetch(`/api/auth/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      await store.set({ authToken: data.token, authUser: data.user });
      return data.user;
    }

    async function logout() {
      await store.set({ authToken: null, authUser: null });
    }

    async function getAccount() {
      return store.get(['authUser']);
    }

    const warn = (...args) => (root.console ? root.console.warn(...args) : undefined);

    return {
      getSettings, setSettings, getToken, apiFetch, getRules,
      getLibrary, findEntry, addToLibrary, pushEntry, backfillMeta,
      updateEntry, removeFromLibrary, dedupeLibrary, syncAll, pullLibrary,
      findSimilar, migrateEntry,
      saveProgress, getProgressAll, getProgressFor, removeProgress,
      recordRead, getHistory, getReadChapters, getStats, flushHistory, localDay,
      seriesSeen, chapterVisited, checkNewChapters,
      authenticate, logout, getAccount,
    };
  }

  /**
   * The message hub every shell shares: one `{ type, ... }` in, one reply out.
   * The extension's service worker, the iOS `WKScriptMessageHandler` and the
   * Android `@JavascriptInterface` all funnel into this, so a content script
   * cannot tell which platform it is running on.
   *
   * `extras` lets a shell add the messages only it can answer (the extension's
   * declarativeNetRequest referer rules, for instance) without forking the hub.
   */
  function createHub(core, extras = {}) {
    return async function handle(msg) {
      try {
        switch (msg && msg.type) {
          case 'getRules': return { rules: await core.getRules() };
          case 'pageDetected':
            await core.seriesSeen(msg.meta);
            await core.chapterVisited(msg.meta);
            return { ok: true };
          case 'addToLibrary': return { ok: true, entry: await core.addToLibrary(msg.entry) };
          case 'removeFromLibrary': await core.removeFromLibrary(msg.id); return { ok: true };
          case 'updateEntry': return { ok: true, entry: await core.updateEntry(msg.id, msg.patch) };
          case 'getLibrary': return { library: await core.getLibrary() };
          case 'findSimilar': return { matches: await core.findSimilar(msg.meta) };
          case 'migrateEntry': return { ok: true, ...(await core.migrateEntry(msg.id, msg.target)) };
          case 'saveProgress': await core.saveProgress(msg.progress); return { ok: true };
          case 'getProgressFor': return { progress: await core.getProgressFor(msg.chapterUrl) };
          case 'getProgressAll': return core.getProgressAll();
          case 'removeProgress': await core.removeProgress(msg.sourceUrl); return { ok: true };
          case 'recordRead': return core.recordRead(msg.read);
          case 'getHistory': return { history: await core.getHistory() };
          case 'getReadChapters':
            return { chapters: await core.getReadChapters(msg.sourceUrl) };
          case 'getStats': return { stats: await core.getStats() };
          case 'auth': {
            const user = await core.authenticate(msg.kind, msg.email, msg.password);
            // Adopt whatever the account already holds before pushing what this
            // device has: a phone signing in for the first time starts empty,
            // and pushing first would leave it looking like the account is too.
            // Deliberately not awaited — signing in should not block on a sync.
            core.pullLibrary().then(() => core.syncAll())
              .catch((e) => (root.console && root.console.warn('post-login sync failed', e)));
            return { ok: true, user };
          }
          case 'logout': await core.logout(); return { ok: true };
          case 'getAccount': return core.getAccount();
          case 'checkNow': await core.checkNewChapters(); return { ok: true };
          case 'syncNow': await core.syncAll(); return { ok: true };
          case 'pullNow': return { ok: true, ...(await core.pullLibrary()) };
          case 'dedupeLibrary': return { ok: true, ...(await core.dedupeLibrary()) };
          // Search and the compatibility check are server-side (no search
          // engine allows a cross-origin query, and the check needs a page
          // fetch the client would be blocked from making), so the hub's job
          // is only to carry the call and the bearer token.
          case 'search': {
            const q = new root.URLSearchParams({ q: String(msg.q ?? '') });
            if (msg.scans) q.set('scans', '1');
            if (msg.check) q.set('check', '1');
            return core.apiFetch(`/api/search?${q}`);
          }
          case 'compat':
            return core.apiFetch('/api/meta/compat?url=' + encodeURIComponent(msg.url ?? ''));
          case 'scrape':
            return core.apiFetch('/api/meta/scrape?url=' + encodeURIComponent(msg.url ?? ''));
          case 'getSettings': return { settings: await core.getSettings() };
          case 'setSettings': return { ok: true, settings: await core.setSettings(msg.patch) };
          default: {
            const extra = extras[msg && msg.type];
            if (extra) return await extra(msg);
            return { error: `unknown message: ${msg && msg.type}` };
          }
        }
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    };
  }

  root.PanelFlowCore = { createCore, createHub, maxChapterIn, labelNum, cleanTitle, DEFAULTS };
})(typeof globalThis !== 'undefined' ? globalThis : self);
