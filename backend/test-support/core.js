// Boots shared/panelflow-core.js the way the mobile worker WebView does: a
// key/value store and a `fetch`, nothing else.
//
// The extension gets the same core through `bootWorker`, which runs
// background.js under a stub `chrome`. Two harnesses, one core — which is the
// property worth testing, because the phone and the browser drifting apart on
// what a merge does is exactly the failure this design exists to prevent.
import { createCore, createHub } from '../src/panelflow-core.js';

/**
 * @param {object} [opts]
 * @param {object} [opts.storage] initial store contents
 * @param {Function} [opts.fetch] (url, init) → Response-ish; omit to be offline
 */
export function bootCore({ storage = {}, fetch: fetchImpl, canFetch } = {}) {
  const local = structuredClone(storage);
  const calls = [];
  const notifications = [];
  let clock = 0;

  const store = {
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(local);
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) {
        if (k in local) out[k] = structuredClone(local[k]);
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) delete local[k];
        else local[k] = structuredClone(v);
      }
    },
  };

  const core = createCore({
    storage: store,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (!fetchImpl) throw new Error('offline');
      return fetchImpl(url, init);
    },
    notify: (n) => notifications.push(n),
    // Monotonic and deterministic: real timestamps collide inside a single
    // synchronous merge, and a test that depends on collision order is a test
    // that fails on a faster machine.
    now: () => new Date(Date.UTC(2025, 0, 1) + (clock += 1000)).toISOString(),
    checkPacingMs: 0,
    // Only the extension answers anything but yes to this — its worker is on a
    // chrome-extension:// origin and a site it was not granted is refused by
    // CORS. Passed through so a test can stand in for that wall; omitted, the
    // core keeps the web app's and the phone's behaviour.
    ...(canFetch ? { canFetch } : {}),
    defaults: { backendUrl: 'https://api.test' },
  });

  return { core, hub: createHub(core), storage: () => structuredClone(local), calls, notifications };
}

/** A JSON response, as `fetch` would hand one back. */
export const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** An HTML response, for the chapter check. */
export const html = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { throw new Error('not json'); },
  text: async () => body,
});

/** A library entry as the core stores it. */
export function entryFixture(over = {}) {
  return {
    id: crypto.randomUUID(),
    title: 'Ao no Hako',
    sourceDomain: 'old-scan.test',
    sourceUrl: 'https://old-scan.test/manga/ao-no-hako',
    coverUrl: 'https://old-scan.test/cover.jpg',
    tags: ['romance'],
    lastKnownChapter: '109',
    folder: 'reading',
    score: 9,
    dateAdded: '2024-01-05T10:00:00.000Z',
    updatedAt: '2024-06-01T10:00:00.000Z',
    ...over,
  };
}
