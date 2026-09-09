// The store core, running in the app itself.
//
// This is the one place the React Native client differs from the Kotlin and
// Swift shells by design rather than by dialect. Those two cannot run
// `shared/panelflow-core.js`, so they host it in an offscreen WebView and reach
// it over a bridge. React Native *is* a JavaScript engine, so the core is
// simply imported and the bridge disappears: `send()` below is the same message
// hub the extension's service worker exposes, called directly.
//
// Everything above this file — every screen, and every injected content script
// in the in-app browser — asks through `send`. So "add to library" behaves
// identically here and in Chrome, because it is literally the same function.
import * as Crypto from 'expo-crypto';

// Load order matters and is the same order the worker's <script> tags use:
// the core throws if the matcher is not already there, and prefs has to exist
// before the core is asked what a setting may be.
import '../generated/messages.js';
import '../generated/shared/series-match.js';
import '../generated/shared/folders.js';
import '../generated/shared/prefs.js';
import '../generated/shared/panelflow-core.js';
import '../generated/shared/site-rules.js';
import '../generated/shared/library-view.js';

import { storage } from './storage.js';
import { raise } from './notify.js';

const { createCore, createHub, DEFAULTS } = globalThis.PanelFlowCore;

// --- events ------------------------------------------------------------------
//
// The shells emit 'ready', 'notify' and 'resumed' over the bridge; here there is
// nothing to cross, so it is a plain listener table. Screens subscribe to
// 'changed' to redraw after something else moved the library — a page turn in
// the in-app browser, a pull from the server on resume.
const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
  for (const h of listeners.get(event) || []) {
    try { h(payload); } catch (e) { console.warn(`[panelflow] ${event} handler failed`, e); }
  }
}

export const core = createCore({
  storage,
  fetch: (...args) => fetch(...args),
  // Hermes has no `crypto.randomUUID`. expo-crypto's is the platform's own
  // random source, which matters: these ids are what two devices merge a
  // library on, and a weak one collides.
  uuid: () => Crypto.randomUUID(),
  // The one capability a WebView genuinely cannot have, and the one thing that
  // was worth writing native code for on the other two shells.
  notify: (n) => { raise(n); emit('notify', n); },
});

const hub = createHub(core, {
  /**
   * The whole account, as the file `/api/export` hands back.
   *
   * Not a core message because no other client needs one: the extension and the
   * website are in a browser, where an export is a link you click. A phone has
   * no downloads folder to click into, so the shell fetches the file itself and
   * hands it to the share sheet.
   */
  exportAccount: async () => ({ data: await core.apiFetch('/api/export') }),
  // The injected content scripts read and write `chrome.storage.local` for
  // reader preferences and per-site auto-open. `chrome-shim.js` turns those
  // three calls into these three messages, and they land in the same store the
  // library uses — so a preference set inside the reader is visible everywhere.
  storageGet: async (msg) => ({ values: await storage.get(msg.keys ?? null) }),
  storageSet: async (msg) => { await storage.set(msg.values || {}); return { ok: true }; },
  storageRemove: async (msg) => {
    const keys = Array.isArray(msg.keys) ? msg.keys : [msg.keys];
    await storage.set(Object.fromEntries(keys.map((k) => [k, undefined])));
    return { ok: true };
  },
});

/**
 * The messages this shell answers itself instead of handing to the hub.
 *
 * Deliberately short, and for the reason NativeMessages.kt gives: every type
 * here is something a page the user browsed to can ask for, not just the app's
 * own screens. `openUrl` is validated on its own terms rather than trusted
 * because it arrived over the bridge — `intent://`, `file://` and `javascript:`
 * are not browsing, they are ways out of the WebView.
 */
export function nativeMessage(msg, shell = {}) {
  switch (msg?.type) {
    case 'openUrl': {
      const url = String(msg.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'unsupported url' };
      shell.openUrl?.(url, msg.meta ?? null);
      return { ok: true };
    }
    case 'share': {
      const url = String(msg.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'unsupported url' };
      shell.share?.(url, String(msg.title ?? ''));
      return { ok: true };
    }
    case 'nativeInfo':
      return { platform: 'react-native', version: shell.version ?? null };
    default:
      return null; // not ours — forward it
  }
}

// --- what a browsed page is allowed to ask ------------------------------------
//
// In Chrome the content scripts run in an isolated world: `chrome.runtime` is
// theirs, and the page's own JavaScript cannot see it or call it. A WebView has
// no such thing. `chrome-shim.js` runs in the same world as the site, so
// *anything the site's own scripts do* reaches this hub — and a scan site is
// exactly the kind of place that would try.
//
// So the shell decides what a page may ask for, and it is this list: the
// twenty-five messages the injected scripts actually send, and nothing else.
// What that keeps out is the interesting part — `setSettings` would let a page
// point this install's backend at a server of its own and then wait for the
// library and the bearer token to be synced there; `auth`, `logout` and
// `setAccountPrefs` are the account itself.
//
// Grepped from extension/content/*.js rather than imagined; `backend/test/
// native-shell.test.js` checks the list still covers what those files send, so
// a new message in the reader fails here rather than on a phone.
const PAGE_TYPES = new Set([
  'addToLibrary', 'chapterList', 'chapterPages', 'fetchImage', 'findSimilar',
  'getAccount', 'getProgressAll', 'getProgressFor', 'getReadChapters', 'getRules',
  'imageAccess', 'migrateEntry', 'offlineCommit', 'offlineHas', 'offlinePage',
  'offlineRemove', 'openOptions', 'pageDetected', 'recordRead', 'saveProgress',
  'trackerConnectTab', 'trackerEntry', 'trackerLink', 'trackerPushOne', 'trackerSearch',
  // The shim's own three, narrowed to particular keys below.
  'storageGet', 'storageSet', 'storageRemove',
  // Answered by the shell itself, and each already validated on its own terms.
  'openUrl', 'share', 'nativeInfo',
]);

/**
 * The store keys a page may see and set — the reader's own settings, and
 * nothing else.
 *
 * `authToken` is why this is a list and not a rule. It sits in the same store
 * as `readerPrefs`, and `chrome.storage.local.get(['authToken'])` from a scan
 * site would hand that site the account's bearer token. Same store, same shim,
 * one line of the page's own JavaScript.
 */
const PAGE_READS = new Set([
  'readerHelpSeen', 'readerMode', 'readerPrefs', 'readerSeries', 'videoUi',
  'autoShowDefault', 'autoShowSites', 'reopenReaderFor',
  // detect.js reads this for `autoOpenReader`. It carries the backend's address,
  // which is not a secret — it is printed in every request the page can watch.
  'settings',
]);

// `settings` is readable and not writable: the address this install syncs to is
// not a page's business, and it is the one key that would be worth taking.
const PAGE_WRITES = new Set([
  'readerHelpSeen', 'readerMode', 'readerPrefs', 'readerSeries', 'videoUi',
  'autoShowDefault', 'autoShowSites', 'reopenReaderFor',
]);

const only = (keys, allowed) => (Array.isArray(keys) ? keys : [keys])
  .filter((k) => allowed.has(k));

/**
 * A message that arrived from a page in the in-app browser.
 *
 * Same hub, narrower door. A refusal is an `{ error }` like any other, because
 * that is what the shim's callers already handle — a page that asks for
 * something it may not have gets the same answer as one asking a worker that
 * is not there.
 */
export function sendFromPage(msg, shell) {
  if (!PAGE_TYPES.has(msg?.type)) {
    console.warn(`[panelflow] a page asked for ${msg?.type} and was refused`);
    return Promise.resolve({ error: 'not available to a page' });
  }
  switch (msg.type) {
    // `null` means "everything I own" and must not mean that here.
    case 'storageGet':
      return send({ ...msg, keys: msg.keys == null ? [...PAGE_READS] : only(msg.keys, PAGE_READS) }, shell);
    case 'storageRemove':
      return send({ ...msg, keys: only(msg.keys, PAGE_WRITES) }, shell);
    case 'storageSet':
      return send({
        ...msg,
        values: Object.fromEntries(
          Object.entries(msg.values || {}).filter(([k]) => PAGE_WRITES.has(k)),
        ),
      }, shell);
    default:
      return send(msg, shell);
  }
}

export { PAGE_TYPES, PAGE_READS, PAGE_WRITES };

/**
 * Ask the core something. Never rejects: a failure comes back as
 * `{ error }`, which is what every caller — the screens here and the content
 * scripts in the browser — already handles.
 */
export async function send(msg, shell) {
  const mine = nativeMessage(msg, shell);
  if (mine) return mine;
  try {
    return await hub(msg);
  } catch (e) {
    console.warn(`[panelflow] ${msg?.type ?? 'unknown'} failed`, e);
    return { error: String(e?.message ?? e) };
  }
}

/**
 * What the shells call on launch: settle the local store against the account.
 *
 * Each step is allowed to fail on its own. A phone opened on a train has no
 * network, and the library it already has is worth drawing.
 */
export async function boot() {
  await core.dedupeLibrary().catch(() => {});
  await core.pullLibrary().catch(() => {});
  await core.syncAll().catch(() => {});
  emit('changed');
}

export { DEFAULTS };
