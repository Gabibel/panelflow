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

const extDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

/**
 * Boot a fresh worker.
 * @param {object} [opts]
 * @param {object} [opts.storage] initial chrome.storage.local contents
 * @param {Function} [opts.fetch]  stands in for the network; omit to be offline
 */
export function bootWorker({ storage = {}, fetch: fetchImpl } = {}) {
  const local = structuredClone(storage);
  const listeners = { message: [], startup: [], installed: [], alarm: [], command: [] };
  const calls = [];

  const asKeys = (keys) => (Array.isArray(keys) ? keys : [keys]);

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return structuredClone(local);
          const out = {};
          for (const k of asKeys(keys)) if (k in local) out[k] = structuredClone(local[k]);
          return out;
        },
        async set(obj) { Object.assign(local, structuredClone(obj)); },
      },
    },
    runtime: {
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      lastError: null,
    },
    alarms: { create() {}, onAlarm: { addListener: (f) => listeners.alarm.push(f) } },
    commands: { onCommand: { addListener: (f) => listeners.command.push(f) } },
    notifications: { create() {}, onClicked: { addListener() {} } },
    tabs: { query: async () => [], sendMessage: async () => {}, create: async () => {} },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, onClicked: { addListener() {} } },
    declarativeNetRequest: { updateEnabledRulesets: async () => {} },
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
