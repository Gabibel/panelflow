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

importScripts('shared/series-match.js', 'shared/panelflow-core.js');
const { createCore, createHub } = self.PanelFlowCore;

const core = createCore({
  storage: {
    get: (keys) => chrome.storage.local.get(keys),
    set: (obj) => chrome.storage.local.set(obj),
  },
  fetch: (...args) => fetch(...args),
  notify: ({ id, title, message }) => chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
  }),
});

// --- alarms ----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await core.getSettings();
  chrome.alarms.create('pf-check-chapters', { periodInMinutes: settings.checkIntervalMin });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pf-check-chapters') core.checkNewChapters();
});

// Catch-up sync when the browser starts: pushes anything saved while the
// backend was unreachable or the user was signed out.
chrome.runtime.onStartup.addListener(() => {
  // Dedupe first and unconditionally: syncAll bails when signed out, but a
  // local library full of duplicates is worth collapsing either way.
  core.dedupeLibrary().catch(() => {});
  core.syncAll().catch(() => {});
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
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse);
  return true; // async response
});
