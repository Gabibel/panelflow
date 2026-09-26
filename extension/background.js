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

// site-rules.js first: the core reads `PanelFlowSites` at call time to work out
// which site a URL belongs to, and without it here the worker quietly lost the
// two things that depend on a domain rule — the chapter list of a site that
// builds its page in the browser, and the panels of a chapter that never puts
// them in the DOM. Both failed as "this site has nothing", which is the shape
// of bug that survives for months.
importScripts('i18n.js',
  'shared/series-match.js', 'shared/site-rules.js', 'shared/folders.js',
  // Before the core: it asks prefs.js what a setting may be, on the way to
  // the account and on the way back from it.
  'shared/prefs.js',
  'shared/panelflow-core.js', 'shared/offline-store.js', 'shared/adblock.js',
  // Read markup the content scripts fetched themselves — see `compatHtml`.
  'shared/compat.js',
  // The "report a problem" buffer: what happened lately, for the options page.
  'shared/report.js');
const { createCore, createHub, describeWith } = self.PanelFlowCore;
const { createDiagnostics, fromTrail } = self.PanelFlowReport;
const { createOfflineStore, idbBackend, offlineMessages } = self.PanelFlowOffline;
const { sitesOf, toDnr, allowRules } = self.PanelFlowAdblock;

const core = createCore({
  storage: {
    get: (keys) => chrome.storage.local.get(keys),
    set: (obj) => chrome.storage.local.set(obj),
  },
  fetch: (...args) => fetch(...args),
  // A refusal the server named reaches the pages in the reader's language
  // (err_<code> in _locales), never as the server's English sentence.
  describe: describeWith(t),
  // Whether this extension holds a host permission for that origin.
  //
  // The worker runs on a `chrome-extension://` origin, so a fetch to a site it
  // was not granted is blocked by CORS — permanently, and with the failure
  // reported against the *site*, which had nothing to do with it. Asking first
  // turns a red line in chrome://extensions into a series the core knows to
  // leave to the server-side watcher.
  //
  // `chrome.permissions.contains` and not a match against the manifest: the
  // reader can grant a site by hand from the popup, and that grant is exactly
  // what this has to notice.
  canFetch: async (url) => {
    try {
      return await chrome.permissions.contains({ origins: [new URL(url).origin + '/*'] });
    } catch {
      // A stored entry whose sourceUrl is not a URL any more. Not a permission
      // problem, and not this function's to answer — let the fetch fail and be
      // named where failures are named.
      return true;
    }
  },
  // The core hands over both the finished English sentence and the parts it
  // was made of, because the web app and the phone share that file and cannot
  // translate. Here we can, so the sentence is rebuilt from the parts — and
  // falls back to what the core wrote if any of them are missing.
  notify: ({ id, message, seriesTitle, sourceDomain, latest, url }) => {
    if (url) rememberTarget(id, url);
    const localised = seriesTitle && latest != null
      ? t('notifyNewChapterBody', [String(seriesTitle), String(latest), String(sourceDomain || '')])
      : message;
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: t('notifyNewChapterTitle'),
      message: localised,
    });
  },
  // Removing a series takes the chapters saved from it off the device. The
  // store is declared further down and this only ever runs long after, which
  // is what makes the forward reference safe.
  onRemoved: (entry) => offline.removeSeries(entry.sourceUrl),
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

// What happened lately, for the options page's "report a problem" and nothing
// else: the last page a content script detected, and what this worker noted.
// The core keeps its own trail of failed calls (`diag.trail()`); the two are
// read together when a report is written. In memory, no transport. (The
// popup guard's refusals stay in the page's console: it runs in the main
// world, where there is no `chrome.runtime` to send them here with.)
const diagnostics = createDiagnostics();

// --- alarms ----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  // First, and before any await: a fresh install shows nothing on its own —
  // the toolbar button is behind Chrome's puzzle piece and every page that is
  // not a chapter is correctly silent — so the setup page is the only thing
  // telling a new user the extension arrived. It must not be lost to a
  // getSettings that throws because the backend is unreachable.
  //
  // `install` only. An update that reopened it would interrupt someone in the
  // middle of a chapter to explain an extension they already use.
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  }
  const settings = await core.getSettings();
  chrome.alarms.create('pf-check-chapters', { periodInMinutes: settings.checkIntervalMin });
  await applyAdblock();
  // An update rewrites the manifest's site list, and a site that moved into it
  // no longer needs its granted-origin registration.
  await syncOptionalSites();
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
  // And the account's settings, on the same clock. This is what makes a theme
  // chosen on the website reach a browser whose options page nobody opens —
  // the pages here paint from localStorage, and something has to refill it.
  core.pullAccountPrefs().catch(() => {});
  // The filter list is refreshed on the same clock. getFilterList has its own
  // TTL, so this is a chance to fetch, not a fetch.
  applyAdblock();
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
  // Dynamic rules survive a restart, but the list they came from may have moved
  // on, and the static ruleset may have been left disabled by the last session.
  applyAdblock();
  // Registrations persist across sessions, so this is a reconciliation rather
  // than a setup — and it is what repairs a profile where they did not.
  syncOptionalSites();
});

// --- sites the user added by hand -------------------------------------------
//
// The manifest names the sites the rules file knew about the day the extension
// was built, and nothing else — see scripts/sync-shared.mjs. That list is
// deliberately short of the truth in two ways: the rules file is updated over
// the air and gains sites this build has never heard of, and a reader may
// simply use one nobody has added yet.
//
// Both are the same request — "run here too" — and it is asked in the popup,
// for one origin, by someone looking at that site. Chrome grants it out of
// `optional_host_permissions`; what it does not do is start injecting, so the
// scripts the manifest declares are registered again here for the origins that
// were granted.
//
// Mirrored from the manifest rather than listed a second time: the two entries
// are read back out of it, so a script added to the manifest reaches the
// granted sites without anybody remembering this file exists.
const OPTIONAL_PREFIX = 'pf-site-';

const declaredOrigins = () => chrome.runtime.getManifest().host_permissions || [];

/** The origins Chrome has granted that the manifest did not already declare. */
async function extraOrigins() {
  const declared = new Set(declaredOrigins());
  const granted = await chrome.permissions.getAll().catch(() => null);
  return (granted?.origins || []).filter((o) => !declared.has(o));
}

/** The manifest's own injections — every entry except the relay on our site. */
const injections = () => chrome.runtime.getManifest().content_scripts
  .filter((c) => !(c.js || []).includes('content/site-bridge.js'));

/**
 * Bring the dynamically registered scripts in line with what has been granted.
 *
 * Unregister-then-register rather than a diff: the whole set is four entries at
 * most, this runs at browser start and when a permission changes, and a diff
 * that gets `matches` wrong leaves a script injected on a site the user has
 * just taken back.
 */
async function syncOptionalSites() {
  const origins = await extraOrigins();
  const want = origins.length ? injections().map((c, i) => ({
    id: `${OPTIONAL_PREFIX}${i}`,
    matches: origins,
    // The sites the manifest already covers are cut back out. Granting the
    // whole web from the settings page — which is one of the two ways this is
    // reached — otherwise means every listed site runs two detectors and two
    // readers, each undoing the other.
    excludeMatches: declaredOrigins(),
    js: c.js,
    ...(c.css ? { css: c.css } : {}),
    runAt: c.run_at || 'document_idle',
    world: c.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
    // Registration outlives the worker, which is killed seconds after this
    // returns; without it the sites would work until the first idle timeout.
    persistAcrossSessions: true,
  })) : [];

  const registered = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const mine = registered.filter((s) => s.id.startsWith(OPTIONAL_PREFIX)).map((s) => s.id);
  if (mine.length) await chrome.scripting.unregisterContentScripts({ ids: mine }).catch(() => {});
  if (want.length) {
    // One bad entry costs the feature, not the worker: everything below this
    // point in the file — alarms, the reader command, the message hub — is
    // still loading when this runs.
    await chrome.scripting.registerContentScripts(want)
      .catch((e) => console.warn('PanelFlow: granted sites not registered', e));
  }
}

// A permission granted from the popup, or revoked from Chrome's own settings
// page, which the popup never sees.
/**
 * The page already open, without making the reader reload it.
 *
 * registerContentScripts() decides what runs on the *next* navigation; Chrome
 * does not apply it to a tab that is already sitting there, and the tab that is
 * already sitting there is the one the reader just granted. So it is injected by
 * hand, once, here.
 *
 * The document_start entry is left out: popup-guard.js replaces window.open
 * before the page's own scripts run, and there is no catching up on that after
 * the fact. It is registered like the rest and takes effect at the next page
 * load, which is also the first moment it could have done anything.
 */
async function injectNow(tabId) {
  if (!tabId) return;
  for (const c of injections()) {
    if ((c.run_at || 'document_idle') === 'document_start') continue;
    await chrome.scripting.executeScript({ target: { tabId }, files: c.js })
      .catch((e) => console.warn('PanelFlow: the open tab was not injected', e));
    if (c.css) {
      await chrome.scripting.insertCSS({ target: { tabId }, files: c.css }).catch(() => {});
    }
  }
}

// A site granted or taken back is also a site ads are, or are no longer,
// blocked on — see applyAdblock.
chrome.permissions.onAdded.addListener(() => { syncOptionalSites(); applyAdblock(); });
chrome.permissions.onRemoved.addListener(() => { syncOptionalSites(); applyAdblock(); });

// --- ad blocking -----------------------------------------------------------
// The extension ships a filter list as a static ruleset, which is what blocks
// ads on a fresh install and with no network. Everything below is what makes
// it a list rather than a constant: the backend serves a newer one, it is
// installed as dynamic rules, and the static ruleset steps aside so that a host
// *removed* upstream actually stops being blocked.
//
// The whitelist is applied either way. It was previously stored by the options
// page and read by nobody in Chrome — the user could exempt a site and watch it
// keep being blocked — while Android had honoured it all along.
//
// Every block rule is confined to the reading sites: a request is refused when
// one of those sites' pages makes it, and never anywhere else on the web. The
// listing and the privacy policy both say "on these sites", and the Chrome Web
// Store holds an extension to its one purpose. The sites are the manifest's
// plus any the reader granted from the popup; the bundled ruleset only knows
// the manifest's, having been written before anything was granted.

async function applyAdblock() {
  const [settings, remote, granted] = await Promise.all([
    core.getSettings().catch(() => ({})),
    core.getFilterList().catch(() => null),
    extraOrigins().catch(() => []),
  ]);
  const sites = sitesOf([...declaredOrigins(), ...granted]);
  const blocks = remote ? toDnr(remote, { sites }) : [];
  const allows = allowRules(settings.whitelist || []);
  try {
    const current = await chrome.declarativeNetRequest.getDynamicRules();
    // One atomic swap, not a clear then a fill: the gap between the two would
    // be a window with the whitelist gone and, worse, nothing blocked.
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: current.map((r) => r.id),
      addRules: [...blocks, ...allows],
    });
    // Only stand the bundled list down once the fetched one is in force. A
    // backend that is down, or a reply that failed to install, must leave the
    // user blocking exactly what they were blocking a minute ago.
    await chrome.declarativeNetRequest.updateEnabledRulesets(blocks.length
      ? { disableRulesetIds: ['adblock_base'] }
      : { enableRulesetIds: ['adblock_base'] });
  } catch (e) {
    console.warn('adblock rules not applied', e);
  }
}

// The options page writes the whitelist through the shared core, so the change
// arrives here as a storage event rather than a message. Watching storage also
// covers the settings being edited from another window entirely.
chrome.storage.onChanged.addListener((changes, area) =>
  (area === 'local' && changes.settings ? applyAdblock() : undefined));

// --- cover referer rules (MangaPin technique) ------------------------------
// Manga CDNs 403 hotlinked images. For requests made BY the extension (popup
// covers, the images of a chapter saved for offline reading), a session
// declarativeNetRequest rule per
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

/**
 * The hosts among `urls` this extension is not allowed to fetch from.
 *
 * Almost no site serves its own pages: asurascans serves them from
 * gg.asuracomic.net, comick.io from meo.comick.pictures. Displaying them needs
 * no permission — an <img> is not a read — but taking the bytes back does, and
 * from both sides: the reader's own fetch is refused by CORS and the one below
 * is refused before it leaves. Long-running mangas are the titles kept on a
 * separate image CDN, which is why a webtoon downloaded and a manga produced a
 * warning glyph and no explanation.
 *
 * Asked once for the whole chapter, because the answer is the same for all
 * forty pages, and answered as hostnames because that is the part of it a
 * reader can be shown and can act on.
 */
async function missingImageHosts(urls) {
  const byOrigin = new Map();
  for (const url of urls || []) {
    try {
      const u = new URL(url);
      // blob: and data: are the reader's own bytes already — nothing to ask for.
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      byOrigin.set(u.origin + '/*', u.hostname);
    } catch { /* not an address anything could be asked about */ }
  }
  const missing = [];
  for (const [pattern, host] of byOrigin) {
    const allowed = await chrome.permissions
      .contains({ origins: [pattern] }).catch(() => true);
    if (!allowed && !missing.includes(host)) missing.push(host);
  }
  return missing;
}

// --- cross-origin image fetch for a chapter saved for offline reading ---------
// The reader reads the pages itself where it can (blob: URLs only exist in its
// document); it only comes here for cross-origin CDN images CORS won't let it
// read. The DNR referer rule above makes the CDN treat this fetch as same-site.

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

/**
 * The keys of `obj` that are in `keys` and are actually present.
 *
 * "Present" and not "truthy": every checkbox here has `false` as a real answer,
 * and a filter that dropped it would make unticking a box do nothing at all.
 */
const pick = (obj, keys) => Object.fromEntries(
  keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));

// Shared cases come from createHub; the two below are Chrome-only because they
// depend on declarativeNetRequest, which no WebView has an equivalent for
// (the native shells set the Referer header on the request itself instead).

const handle = createHub(core, {
  /**
   * "Is this markup a chapter, and where are its pages?"
   *
   * The same answer `/api/meta/compat` gives, computed here instead — because
   * the markup did not come from the server. The reader fetches the next
   * chapter from inside the page, where the session is, and hands it over: a
   * chapter that only opens for a signed-in browser is one no server-side fetch
   * would ever have seen.
   *
   * The mobile worker has answered this since it was written; the extension
   * needed it the day the reader stopped reloading the document to turn a
   * chapter, which is a thing it does in every browser and not only on a phone.
   */
  compatHtml: async (msg) => ({
    ...self.PanelFlowCompat.analyze(msg.html || '', msg.url || '',
      { rules: (await core.getRules()) || {} }),
    url: msg.url || '',
  }),
  // Everything a settings page shows, gathered from wherever it happens to
  // live: three loose keys in storage, the reader's own prefs object, and the
  // core's settings. Two faces ask for it — the extension's options page, and
  // the Settings tab in the web app, which reaches this worker through
  // content/site-bridge.js. A second answer to "where does tapZones live" is
  // how those two faces start disagreeing with each other.
  getPrefs: async (msg) => {
    // `refresh` goes and asks the server; without it this is the cached answer,
    // which is what the popup wants — a settings page can afford a round trip
    // and a toolbar window that pauses before it draws cannot.
    if (msg?.refresh) await core.pullAccountPrefs();
    const local = await chrome.storage.local.get(
      ['readerMode', 'readerPrefs', 'autoShowDefault', 'uiLang', 'authUser']);
    const settings = await core.getSettings();
    // Which answer wins, and where each setting lives, is `project` in
    // shared/prefs.js — the same rule the phone runs. This worker only fetches
    // the three homes and hands them over.
    const flat = PanelFlowPrefs.project({
      account: await core.getAccountPrefs(),
      local,
      install: settings,
    });
    return {
      ok: true,
      ...flat,
      // The pages of this extension read the reader's four under `prefs`, the
      // shape they always had; the phone reads them flat. One rule, two doors.
      prefs: pick(flat, PanelFlowPrefs.READER_KEYS),
      // Never from the account. It is the address of the server the account is
      // on, and a device that took it from there could be sent anywhere.
      backendUrl: settings.backendUrl,
      // Only that there is one, and which address it is: the token stays here.
      user: local.authUser ? { email: local.authUser.email } : null,
    };
  },
  setPrefs: async (msg) => {
    // The page sends the reader's four under `prefs`; the rule takes them
    // flat, so they are folded in before it is asked.
    const patch = { ...(msg.patch || {}), ...((msg.patch || {}).prefs || {}) };
    delete patch.prefs;
    // Merged, never replaced: brightness and the reader's own state live in
    // `readerPrefs` and are written from inside the reader, where a settings
    // page cannot see them. `split` does the merge, given the current object.
    const { readerPrefs } = await chrome.storage.local.get(['readerPrefs']);
    const { account, local, settings } = PanelFlowPrefs.split(patch, { readerPrefs });

    // The same change, up to three times: onto the account so the site and the
    // phone hear about it, into this browser so the page it came from is right
    // immediately and stays right offline, and into the install for the two
    // keys that are the install's. Awaited: the page shows "Saved ✓" and a
    // reader who then opens a site expects it there.
    if (Object.keys(account).length) await core.saveAccountPrefs(account);
    if (Object.keys(local).length) await chrome.storage.local.set(local);
    // Through the core rather than a direct write: `set({ settings })` replaces
    // the whole object, and a settings page knows three of its keys.
    if (Object.keys(settings).length) await core.setSettings(settings);
    // The alarm is created with this period on install and never touched
    // again, so a new number that does not re-create it is decoration.
    if (settings.checkIntervalMin) {
      chrome.alarms.create('pf-check-chapters', { periodInMinutes: settings.checkIntervalMin });
    }
    // The state as the next reader of it will see it, not as this function
    // assembled it — a blank URL that has just become a default again is the
    // case where those two differ.
    return handle({ type: 'getPrefs' });
  },
  // The interface language, when the reader wants one that is not the
  // browser's. Chrome resolves __MSG_…__ against the UI locale and nothing
  // else, so choosing here means shipping the strings ourselves: this reads the
  // very file Chrome would have read and leaves it in storage, where i18n.js
  // finds it in every page and every content script. It has to happen in the
  // worker — `_locales` is a reserved directory that no page can fetch out of.
  setLanguage: async (msg) => {
    const lang = msg.lang;
    // On the account as well: the language is the reader's, not the browser's.
    // Sent before the early return below, so choosing "follow the browser"
    // records that too rather than leaving the last named language on file.
    if (lang === 'auto' || PanelFlowI18n.LANGS.some((l) => l.code === lang)) {
      await core.saveAccountPrefs({ uiLang: lang || 'auto' });
    }
    if (!lang || lang === 'auto') {
      await chrome.storage.local.remove(['uiLang', 'uiMessages']);
      return { ok: true, lang: 'auto' };
    }
    if (!PanelFlowI18n.LANGS.some((l) => l.code === lang)) return { error: 'unknown language' };
    const resp = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
    const raw = await resp.json();
    // Flattened to key → sentence: the descriptions are for translators and
    // the placeholders are already inside the sentence, so keeping the whole
    // file would put a few kilobytes of prose in storage for nothing.
    const uiMessages = Object.fromEntries(
      Object.entries(raw).map(([key, entry]) => [key, entry.message]));
    await chrome.storage.local.set({ uiLang: lang, uiMessages });
    // The worker translates its own notifications, and it is long-lived.
    await PanelFlowI18n.reload();
    return { ok: true, lang };
  },
  coverRules: async (msg) => {
    for (const { imgUrl, siteUrl } of msg.pairs || []) await ensureRefererRule(imgUrl, siteUrl);
    return { ok: true };
  },
  fetchImage: async (msg) => ({ ok: true, b64: await fetchImageB64(msg.url, msg.siteUrl) }),
  imageAccess: async (msg) => ({ ok: true, missing: await missingImageHosts(msg.urls) }),
  // `chrome.permissions.request` needs a real click on an extension page, which
  // a content script is not — so the reader cannot ask for the hosts itself. It
  // sends the reader to the one page that can.
  openOptions: async () => { await chrome.runtime.openOptionsPage(); return { ok: true }; },
  // An origin has just been granted, from the popup or from the settings page.
  // Chrome grants and stops there: the registration below is what makes it hold
  // for every later page, and `tabId` — the tab the reader is looking at — is
  // what makes it hold for this one, with no reload to ask for.
  syncSites: async (msg) => {
    await syncOptionalSites();
    await injectNow(msg.tabId);
    return { ok: true };
  },
  // Connecting a tracker from inside a page: the library sheet is a content
  // script and has no chrome.tabs, and an OAuth page has to open somewhere
  // that outlives it. The URL is fetched here rather than accepted from the
  // caller — a message that opens any tab it is handed is a wider door than
  // this feature needs.
  trackerConnectTab: async (msg) => {
    const resp = await handle({ type: 'trackerConnect', service: msg.service });
    if (resp?.authorizeUrl) chrome.tabs.create({ url: resp.authorizeUrl });
    return resp;
  },
  ...offlineMessages(offline),

  /** Everything the report prints, for the options page. */
  diagnostics: () => ({
    lastPage: diagnostics.lastPage(),
    events: [...diagnostics.recent(), ...fromTrail(self.PanelFlowCore.diag.trail())],
  }),
});

// The last net, under everything above.
//
// An MV3 worker is a long-lived context full of listeners — alarms, commands,
// notification clicks, storage changes — and every one of them is `async`. A
// throw inside any of those is a rejected promise nobody awaited: Chrome swallows
// it, the alarm simply does not fire again, and there is no error anywhere to
// say so. That is the exact shape of bug that survives for months.
//
// This does not fix anything. It makes the failure *say its own name*, which is
// the whole difference between a report of "the new-chapter alerts stopped" and
// one line naming the function that stopped them.
self.addEventListener('unhandledrejection', (ev) => {
  self.PanelFlowCore.diag.report('worker:unhandled', ev.reason);
});

// Alarms and notification clicks are the worker's own doing; a report that
// says "checked for chapters at 03:12" beside "the alerts stopped" is worth
// the line.
chrome.alarms.onAlarm.addListener((alarm) => diagnostics.note('alarm', alarm.name));

/**
 * A settings patch as a page's guest may send it: without the address this
 * install syncs to, at any depth the worker reads. Only the extension's own
 * pages may move the server; a content script is on somebody's site, and the
 * relay's own filter was walked past once by nesting the key (QA, September
 * 2026).
 */
function withoutServer(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  const out = { ...patch };
  delete out.backendUrl;
  for (const nested of ['prefs', 'settings']) {
    if (out[nested] && typeof out[nested] === 'object') {
      out[nested] = { ...out[nested] };
      delete out[nested].backendUrl;
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromPage = !!sender?.url && !String(sender.url).startsWith(chrome.runtime.getURL(''));
  if (fromPage && msg && msg.type === 'setPrefs') msg = { ...msg, patch: withoutServer(msg.patch) };
  // The page a content script last found a chapter on: the first line of a
  // bug report, noted here so the options page can say which page it was.
  if (msg && msg.type === 'pageDetected' && msg.meta && msg.meta.url) diagnostics.sawPage(msg.meta.url);
  // The catch is the point. `handle` answers its own failures, so a rejection
  // here means one escaped it — a `return` that forgot its `await` puts the
  // promise outside the hub's own try/catch, and then sendResponse is never
  // called at all. What the caller sees is the port closing: "The message port
  // closed before a response was received", with no page, no message type and
  // no server sentence in it. Answering with the error keeps that a bug report
  // that names itself instead of one about Chrome.
  handle(msg).then(sendResponse, (e) => {
    const seen = self.PanelFlowCore.diag.report(`worker:${(msg && msg.type) || 'unknown'}`, e);
    sendResponse({ error: seen.message, failedAt: seen.scope });
  });
  return true; // async response
});
