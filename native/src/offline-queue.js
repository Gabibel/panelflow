// The chapters waiting to be kept for offline reading, saved one at a time.
//
// The series sheet's offline list (screens/OfflineChaptersScreen.js) puts
// chapters in; the hidden browser (components/OfflineSaver.js) takes them out,
// one by one, and opens each in the reader that saves it. Nothing here knows
// about a WebView: the browser is a `driver`, `(job) => Promise<{ ok, error }>`,
// so the order, the retries, the pauses and the stops can be tested without
// one (backend/test/offline-batch.test.js).
//
// The rules, each for a reason:
// - One chapter at a time, with a pause between two: a site is asked for one
//   chapter's pages and then left alone a moment, as a reader would.
// - A chapter that fails is tried once more, then left as failed: the next
//   one may well work, and the list says which did not.
// - A chapter that never answers is given up after `timeoutMs`.
// - The store being full stops everything, and what was left stays waiting:
//   it is the one failure every later chapter would hit too.
// - No limit on how many chapters are asked for (owner, October 2026).
// - What is left to do is written down after every change, so a queue the
//   phone cut short (the app closed, the system stopped it) is taken up again
//   at the next start.

/**
 * What the reader in the hidden browser may ask the app, and nothing else.
 *
 * Opening a chapter is how the reader saves it, and opening a chapter in the
 * visible browser also moves the bookmark, files the chapter as read, may add
 * the series or push progress to a tracker. A chapter kept for later has not
 * been read: here the reader gets what it needs to find the pages and store
 * them, and every write to the library, the history or a tracker is refused.
 */
export const HIDDEN_PAGE_TYPES = new Set([
  'getRules', 'getAccount', 'getProgressFor', 'getProgressAll', 'getReadChapters', 'findSimilar',
  'chapterList', 'chapterPages', 'compatHtml', 'fetchImage', 'imageAccess', 'storageGet', 'nativeInfo',
  'offlineHas', 'offlinePage', 'offlineFetchPage', 'offlineCommit',
]);

export const SAVE_PAUSE_MS = 1500;
// Five minutes a chapter: forty pages, each tried again a few times on a
// slow network (reader.js, PAGE_RETRY_MS), and still not forever.
export const SAVE_TIMEOUT_MS = 5 * 60 * 1000;

const sleepFor = (ms) => new Promise((wake) => setTimeout(wake, ms));

/**
 * @param {object} opts
 * @param {number} [opts.pauseMs]    between two chapters
 * @param {number} [opts.timeoutMs]  per attempt
 * @param {number} [opts.retries]    attempts after the first
 * @param {{ load: () => Promise<object[]>, save: (jobs: object[]) => Promise<void> }} [opts.storage]
 */
export function createSaveQueue({
  pauseMs = SAVE_PAUSE_MS, timeoutMs = SAVE_TIMEOUT_MS, retries = 1, storage: kept = null,
} = {}) {
  let storage = kept;
  let jobs = [];               // { url, n, label, sourceUrl, title, state, error }
  let status = 'idle';         // idle | running | stopped
  let reason = null;           // why it stopped: 'full' | 'cancelled'
  let driver = null;
  let current = null;          // the job being saved
  let cancelled = false;
  const listeners = new Set();

  const counts = () => ({
    saved: jobs.filter((j) => j.state === 'saved').length,
    failed: jobs.filter((j) => j.state === 'failed').length,
    total: jobs.length,
  });

  const snapshot = () => ({
    status, reason, current: current ? current.url : null, jobs: jobs.map((j) => ({ ...j })), ...counts(),
  });

  const changed = () => {
    if (storage) {
      const left = jobs.filter((j) => j.state === 'waiting' || j.state === 'saving')
        .map(({ url, n, label, sourceUrl, title }) => ({ url, n, label, sourceUrl, title }));
      storage.save(left).catch(() => {});
    }
    for (const l of listeners) {
      try { l(snapshot()); } catch { /* a screen that fails to redraw is not the queue's */ }
    }
  };

  /** One attempt, given up after `timeoutMs`. */
  const attempt = (job) => {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs); });
    const answer = Promise.resolve()
      .then(() => driver(job))
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    return Promise.race([answer, late]).finally(() => clearTimeout(timer));
  };

  async function run() {
    if (status === 'running' || !driver) return;
    status = 'running';
    reason = null;
    cancelled = false;
    changed();
    let first = true;
    for (;;) {
      const job = jobs.find((j) => j.state === 'waiting');
      if (!job || cancelled) break;
      if (!first && pauseMs) await sleepFor(pauseMs);
      first = false;
      if (cancelled) break;
      current = job;
      job.state = 'saving';
      changed();
      let result = null;
      for (let i = 0; i <= retries; i++) {
        result = await attempt(job);
        if (result?.ok || result?.error === 'offline-full' || cancelled) break;
      }
      current = null;
      if (result?.error === 'offline-full') {
        job.state = 'waiting';
        status = 'stopped';
        reason = 'full';
        changed();
        return;
      }
      job.state = result?.ok ? 'saved' : 'failed';
      job.error = result?.ok ? null : (result?.error || 'failed');
      changed();
    }
    if (cancelled) {
      jobs = jobs.filter((j) => j.state !== 'waiting');
      status = 'stopped';
      reason = 'cancelled';
    } else {
      status = 'idle';
    }
    changed();
  }

  return {
    /** Chapters to save, `{ url, n, label, sourceUrl, title }`; one already queued is not queued twice. */
    add(items) {
      const queued = new Set(jobs.filter((j) => j.state === 'waiting' || j.state === 'saving').map((j) => j.url));
      // A finished queue's rows are history: a new request starts a new list.
      if (status !== 'running') jobs = jobs.filter((j) => j.state === 'waiting');
      for (const item of items || []) {
        if (!item?.url || queued.has(item.url)) continue;
        queued.add(item.url);
        jobs.push({ ...item, state: 'waiting', error: null });
      }
      changed();
      run();
    },
    /** Stops after the chapter under way; the rest is dropped. */
    cancel() {
      if (status !== 'running') {
        jobs = jobs.filter((j) => j.state !== 'waiting');
        status = 'stopped';
        reason = 'cancelled';
        changed();
        return;
      }
      cancelled = true;
    },
    /** What is left from before, taken up again. */
    async restore() {
      if (!storage) return;
      let left = [];
      try { left = await storage.load(); } catch { left = []; }
      if (Array.isArray(left) && left.length) this.add(left);
    },
    /** The browser that saves a chapter; the queue starts once it has one. */
    setDriver(fn) {
      driver = fn;
      if (driver && jobs.some((j) => j.state === 'waiting')) run();
    },
    /** Where what is left to do is written down (the app's own storage). */
    setStorage(s) { storage = s; },
    /** Starts again after a stop (the store was full and has been emptied). */
    resume() { run(); },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot,
  };
}

/** The one queue of the app. */
export const saveQueue = createSaveQueue();
