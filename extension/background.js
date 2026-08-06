// PanelFlow MV3 service worker.
//
// The library, progress, duplicate and sync rules are NOT here — they live in
// shared/panelflow-core.js, which the Android and iOS shells run too, so the
// three clients cannot drift apart. What is left below is the part that is
// genuinely Chrome: storage and notification adapters, alarms, the Alt+R
// command, and the declarativeNetRequest referer trick for hotlink-protected
// covers.
//
// Both shared files are generated copies — edit shared/*.js and run
// `npm run sync:shared`.
'use strict';

importScripts('shared/series-match.js', 'shared/folders.js', 'shared/panelflow-core.js',
  'shared/offline-store.js');
const { createCore, createHub } = self.PanelFlowCore;
const { createOfflineStore, idbBackend, offlineMessages } = self.PanelFlowOffline;

const core = createCore({
  storage: {
    get: (keys) => chrome.storage.local.get(keys),
    set: (obj) => chrome.storage.local.set(obj),
  },
  fetch: (...args) => fetch(...args),
  notify: ({ id, title, message, url }) => {
    if (url) rememberTarget(id, url);
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
    });
  },
});

// Where each open notification leads. A "new chapter" alert you cannot tap is
// only half the feature — the point is to land on the chapter, not to be told
// it exists and have to go find it.
//
// In chrome.storage rather than a variable: the worker is killed within seconds
// of the check finishing, and the notification outlives it by hours.
const NOTIFY_TARGETS = 'notifyTargets';

async function rememberTarget(id, url) {
  const { [NOTIFY_TARGETS]: map } = await chrome.storage.local.get([NOTIFY_TARGETS]);
  const next = map || {};
  next[id] = url;
  await chrome.storage.local.set({ [NOTIFY_TARGETS]: next });
}

chrome.notifications.onClicked.addListener(async (id) => {
  const { [NOTIFY_TARGETS]: map } = await chrome.storage.local.get([NOTIFY_TARGETS]);
  const url = (map || {})[id];
  if (!url) return;
  chrome.tabs.create({ url });
  chrome.notifications.clear(id);
  delete map[id];
  await chrome.storage.local.set({ [NOTIFY_TARGETS]: map });
});

// Dismissing an alert is an answer too, and a map that only ever grows would
// keep a URL per series forever.
chrome.notifications.onClosed.addListener(async (id) => {
  const { [NOTIFY_TARGETS]: map } = await chrome.storage.local.get([NOTIFY_TARGETS]);
  if (!map || !(id in map)) return;
  delete map[id];
  await chrome.storage.local.set({ [NOTIFY_TARGETS]: map });
});

// Saved chapters live in the extension's own IndexedDB, opened here and only
// here: a content script's IndexedDB belongs to whatever site it was injected
// into, which is the wrong origin to keep a library in. The reader streams its
// pages across as base64, one message per page.
//
// Declared next to the core rather than beside the hub that uses it, because
// the onStartup listener below reaches for it and a listener that fires during
// evaluation would find a `const` further down the file still dead.
const offline = createOfflineStore(idbBackend(indexedDB));

// --- alarms ----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await core.getSettings();
  chrome.alarms.create('pf-check-chapters', { periodInMinutes: settings.checkIntervalMin });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'pf-check-chapters') return;
  // The server's watcher first: one request, and it covers the hours Chrome
  // was not running at all. The site-by-site check then fills in what the
  // server cannot reach — Cloudflare-walled sites answer the browser and
  // challenge the server, which is why both still exist.
  core.pullNews().catch(() => {}).then(() => core.checkNewChapters());
  // Saved chapters age out after 90 days. This alarm is the only thing that
  // wakes the worker on its own, so it is the only place an expiry can happen
  // without the user opening something first.
  offline.expire().catch(() => {});
});

// Catch-up sync when the browser starts: pushes anything saved while the
// backend was unreachable or the user was signed out.
chrome.runtime.onStartup.addListener(() => {
  // Dedupe first and unconditionally: syncAll bails when signed out, but a
  // local library full of duplicates is worth collapsing either way.
  core.dedupeLibrary().catch(() => {});
  // Sync, then drain: the news names series by their remote id, so pulling the
  // library first is what lets a chapter found on another device land on an
  // entry this one recognises. The site-by-site check is deliberately not run
  // here — it is minutes of network on the one occasion the user is trying to
  // do something else.
  core.syncAll().then(() => core.pullNews()).catch(() => {});
  // A save interrupted by the worker being killed leaves pages behind that
  // nothing will ever read. Browser start is the moment no save is in flight.
  offline.sweep().catch(() => {});
  offline.expire().catch(() => {});
});

// --- cover referer rules (MangaPin technique) ------------------------------
// Manga CDNs 403 hotlinked images. For requests made BY the extension (popup
// covers, CBZ download fetches), a session declarativeNetRequest rule per
// image domain removes Origin and sets Referer to the series' site, so the
// CDN sees a same-site load.

const refererRules = new Map(); // imgDomain -> ruleId
let nextRuleId = 1000;

async function ensureRefererRule(imgUrl, siteUrl) {
  let imgDomain, referer;
  try {
    imgDomain = new URL(imgUrl).hostname;
    referer = new URL(siteUrl || imgUrl).origin + '/';
  } catch { return; }
  if (refererRules.has(imgDomain)) return;
  const id = nextRuleId++;
  refererRules.set(imgDomain, id);
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id,
      condition: {
        initiatorDomains: [chrome.runtime.id],
        requestDomains: [imgDomain],
        resourceTypes: ['image', 'xmlhttprequest'],
      },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'remove' },
          { header: 'Referer', operation: 'set', value: referer },
        ],
      },
    }],
  }).catch((e) => { refererRules.delete(imgDomain); console.warn('DNR rule failed', e); });
}

// --- cross-origin image fetch for the reader's CBZ download ----------------
// The reader zips pages itself (blob: URLs only exist in its document); it
// only comes here for cross-origin CDN images CORS won't let it read. The
// DNR referer rule above makes the CDN treat this fetch as same-site.

async function fetchImageB64(url, siteUrl) {
  await ensureRefererRule(url, siteUrl);
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`image ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  let bin = '';
  for (let p = 0; p < bytes.length; p += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(p, p + 0x8000));
  }
  return btoa(bin);
}

// --- keyboard command (Alt+R) ----------------------------------------------

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle_reader') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'toggleReader' }).catch(() => {});
});

// --- message hub -----------------------------------------------------------
// Shared cases come from createHub; the two below are Chrome-only because they
// depend on declarativeNetRequest, which no WebView has an equivalent for
// (the native shells set the Referer header on the request itself instead).

const handle = createHub(core, {
  coverRules: async (msg) => {
    for (const { imgUrl, siteUrl } of msg.pairs || []) await ensureRefererRule(imgUrl, siteUrl);
    return { ok: true };
  },
  fetchImage: async (msg) => ({ ok: true, b64: await fetchImageB64(msg.url, msg.siteUrl) }),
  ...offlineMessages(offline),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse);
  return true; // async response
});
