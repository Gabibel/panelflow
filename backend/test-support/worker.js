// Runs extension/background.js under a stub `chrome`, so the service worker's
// own logic can be tested from `node --test`.
//
// The parts worth testing here are the ones that rewrite stored data — the
// migration merge above all: if it drops a bookmark or a score there is no undo
// and no error, just a library that quietly lost something. Chrome APIs are
// stubbed only as far as loading the worker requires.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { fakeIndexedDB } from './fake-indexeddb.js';
import { i18n } from '../test/helpers/i18n.js';

const extDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

// The real manifest, not a sketch of one: the worker mirrors its own content
// script entries onto sites the reader granted by hand, so a stub manifest here
// would be testing a set of injections the extension does not ship.
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));

/**
 * Boot a fresh worker.
 * @param {object} [opts]
 * @param {object} [opts.storage] initial chrome.storage.local contents
 * @param {Function} [opts.fetch]  stands in for the network; omit to be offline
 */
export function bootWorker({ storage = {}, fetch: fetchImpl } = {}) {
  const local = structuredClone(storage);
  const listeners = {
    message: [], startup: [], installed: [], alarm: [], command: [],
    notificationClick: [], notificationClose: [], storageChanged: [], permissions: [],
  };
  // Content scripts registered at run time, for origins outside the manifest.
  let registeredScripts = [];
  const calls = [];
  const notifications = [];   // every alert raised, in order
  const opened = [];          // every tab the worker asked Chrome to open

  const asKeys = (keys) => (Array.isArray(keys) ? keys : [keys]);

  // The rules the worker has installed, as Chrome would hold them: a dynamic
  // set it replaces wholesale, and the enabled/disabled state of the ruleset
  // bundled with the extension.
  const dnr = { dynamic: [], staticEnabled: true };

  const chrome = {
    storage: {
      onChanged: { addListener: (f) => listeners.storageChanged.push(f) },
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return structuredClone(local);
          const out = {};
          for (const k of asKeys(keys)) if (k in local) out[k] = structuredClone(local[k]);
          return out;
        },
        async remove(keys) {
          for (const k of asKeys(keys)) delete local[k];
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: local[k], newValue: v };
          }
          Object.assign(local, structuredClone(obj));
          // Chrome notifies after the write lands, and a listener that throws
          // is the listener's problem, not the writer's.
          for (const f of listeners.storageChanged) {
            try { await f(structuredClone(changes), 'local'); } catch { /* as Chrome does */ }
          }
        },
      },
    },
    runtime: {
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      // Same shape Chrome gives: an absolute URL under the extension's own
      // origin, which the worker then fetches — so a test that wants to serve
      // one of the extension's own files strips this prefix and reads it.
      getURL: (path) => `chrome-extension://panelflow/${String(path).replace(/^\//, '')}`,
      getManifest: () => structuredClone(manifest),
      lastError: null,
    },
    // The real thing over the shipped English file: the worker writes the text
    // of its notifications through it, and tests assert that text.
    i18n,
    alarms: { create() {}, onAlarm: { addListener: (f) => listeners.alarm.push(f) } },
    commands: { onCommand: { addListener: (f) => listeners.command.push(f) } },
    // A profile with nothing granted beyond the manifest, which is what a fresh
    // install is. host-access.test.js drives the granted case directly.
    permissions: {
      getAll: async () => ({ origins: [...(manifest.host_permissions || [])], permissions: [] }),
      onAdded: { addListener: (f) => listeners.permissions.push(f) },
      onRemoved: { addListener: (f) => listeners.permissions.push(f) },
    },
    scripting: {
      getRegisteredContentScripts: async () => structuredClone(registeredScripts),
      registerContentScripts: async (scripts) => {
        registeredScripts.push(...structuredClone(scripts));
      },
      unregisterContentScripts: async ({ ids = [] } = {}) => {
        registeredScripts = registeredScripts.filter((s) => !ids.includes(s.id));
      },
    },
    notifications: {
      create(id, opts) { notifications.push({ id, ...opts }); },
      clear() {},
      onClicked: { addListener: (f) => listeners.notificationClick.push(f) },
      onClosed: { addListener: (f) => listeners.notificationClose.push(f) },
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {},
      create: async (opts) => { opened.push(opts?.url); },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, onClicked: { addListener() {} } },
    declarativeNetRequest: {
      getDynamicRules: async () => structuredClone(dnr.dynamic),
      async updateDynamicRules({ removeRuleIds = [], addRules = [] } = {}) {
        const gone = new Set(removeRuleIds);
        const kept = dnr.dynamic.filter((r) => !gone.has(r.id));
        // Chrome rejects the whole call on a duplicate id rather than keeping
        // the rules it liked, and code that relies on the lenient version would
        // pass here and install nothing in a real browser.
        const next = [...kept, ...structuredClone(addRules)];
        if (new Set(next.map((r) => r.id)).size !== next.length) {
          throw new Error('duplicate rule id');
        }
        dnr.dynamic = next;
      },
      async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] } = {}) {
        if (disableRulesetIds.includes('adblock_base')) dnr.staticEnabled = false;
        if (enableRulesetIds.includes('adblock_base')) dnr.staticEnabled = true;
      },
      updateSessionRules: async () => {},
    },
  };

  const sandbox = {
    console,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto,
    // Saved chapters. In memory, and fresh per worker, so one test's library
    // cannot be another's — and Blob, because that is what a saved page is.
    indexedDB: fakeIndexedDB(),
    Blob, atob, btoa,
    chrome,
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      if (!fetchImpl) throw new Error('offline');
      return fetchImpl(url, init);
    },
    // The worker pulls in shared/series-match.js this way.
    importScripts(...paths) {
      for (const p of paths) {
        vm.runInContext(readFileSync(join(extDir, p), 'utf8'), context, { filename: p });
      }
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(extDir, 'background.js'), 'utf8'), context,
    { filename: 'background.js' });

  /** Send a message the way a content script would, and await the reply. */
  const send = (msg) => new Promise((resolve, reject) => {
    let settled = false;
    const respond = (r) => { if (!settled) { settled = true; resolve(r); } };
    const results = listeners.message.map((f) => f(msg, {}, respond));
    // The worker answers asynchronously and returns true to say so; a listener
    // that returns anything else has already responded or ignored the message.
    if (!results.some((r) => r === true) && !settled) {
      reject(new Error(`no listener handled ${msg.type}`));
    }
    setTimeout(() => { if (!settled) reject(new Error(`${msg.type} never responded`)); }, 4000);
  });

  return {
    send,
    /** Current chrome.storage.local contents. */
    storage: () => structuredClone(local),
    /** Every fetch the worker attempted, in order. */
    calls,
    listeners,
    /** What the worker is blocking: its dynamic rules, and the bundled ruleset. */
    dnr: () => structuredClone(dnr),
    /** Every notification raised, and every URL the worker opened a tab on. */
    notifications,
    opened,
    /** Tap a notification, the way the user does. */
    clickNotification: async (id) => {
      for (const f of listeners.notificationClick) await f(id);
    },
  };
}

/** A library entry as the worker stores it. */
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
    note: 'la meilleure',
    language: 'French',
    startDate: '2024-01-05',
    rereads: 0,
    dateAdded: '2024-01-05T10:00:00.000Z',
    updatedAt: '2024-06-01T10:00:00.000Z',
    ...over,
  };
}
