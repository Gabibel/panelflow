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
import '../generated/shared/compat.js';
import '../generated/shared/offline-store.js';
import '../generated/shared/search.js';

import { storage } from './storage.js';
import { raise } from './notify.js';
import * as offline from './offline.js';
import { note } from './diagnostics.js';
import { forgetExport } from './export-file.js';
import { t } from './i18n.js';

const { createCore, createHub, DEFAULTS, describeWith } = globalThis.PanelFlowCore;

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
  // A refusal the server named, in the reader's language (err_<code>).
  describe: describeWith(t),
  // Hermes has no `crypto.randomUUID`. expo-crypto's is the platform's own
  // random source, which matters: these ids are what two devices merge a
  // library on, and a weak one collides.
  uuid: () => Crypto.randomUUID(),
  // The one capability a WebView genuinely cannot have, and the one thing that
  // was worth writing native code for on the other two shells.
  // The core writes the sentence in English, because it is shared with the web
  // app and cannot reach a translation; here it can, so the banner is rebuilt
  // from the parts in the reader's language — and says "episode" for an anime.
  notify: (n) => {
    const anime = n?.entry?.medium === 'anime';
    const said = n?.seriesTitle && n?.latest != null
      ? {
        ...n,
        title: t(anime ? 'notifyNewEpisodeTitle' : 'notifyNewChapterTitle'),
        message: t(anime ? 'notifyNewEpisodeBody' : 'notifyNewChapterBody',
          [String(n.seriesTitle), String(n.latest), String(n.sourceDomain || '')]),
      }
      : n;
    raise(said);
    emit('notify', n);
  },
  // Removing a series takes the chapters saved from it out of the app: that
  // space is what the reader was getting back.
  onRemoved: (entry) => offline.removeSeries(entry.sourceUrl),
  // An account's data leaving this phone (signed out with it erased, closed,
  // or gone on the server) takes its saved chapters and the last export with
  // it, as on the extension: they were the account's, and stayed behind on
  // the phone after "Delete my account" (QA, P5 H14).
  onForget: async () => {
    for (const meta of await offline.store.list()) await offline.store.remove(meta.chapterUrl);
    forgetExport();
  },
  // The search engine's page, from this phone's own address: the server's is
  // a datacenter's, and the engine answers that with a wall. A browser's
  // headers, because the no-JavaScript page is served on the strength of them.
  searchFetch: async (url) => {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html',
      },
    });
    if (!resp.ok) throw new Error(`search engine answered ${resp.status}`);
    return resp.text();
  },
});

const hub = createHub(core, {
  // Saved chapters: the shared store over the app's own files
  // (native/src/offline.js). They stay inside the app, are never exported to
  // the phone's Files, and expire after ninety days, like MangaPin's on the
  // App Store; the reader's save messages and the saved-chapters screen both
  // land here.
  ...offline.messages(),
  // `exportAccount` used to be here, as a phone-only message. It is the shared
  // hub's now (shared/panelflow-core.js): the extension's options page wanted
  // it too, and one route deserves one message.
  /**
   * "Is this markup a chapter, and where are its pages?"
   *
   * The same answer `/api/meta/compat` gives, computed here instead — because
   * the markup did not come from the server. The reader fetches the next
   * chapter from inside the page, where the session is, and hands it over: a
   * chapter that only opens for a signed-in browser is a chapter no server-side
   * fetch would have seen at all.
   *
   * The mobile worker has had this since it was written (mobile/www/worker.js);
   * this client needed it the day the reader stopped reloading the document to
   * turn a chapter.
   */
  compatHtml: async (msg) => ({
    ...globalThis.PanelFlowCompat.analyze(msg.html || '', msg.url || '',
      { rules: (await core.getRules()) || {},
        // The pages of the chapter on screen, for `pages` to be held to.
        like: Array.isArray(msg.like) ? msg.like.slice(0, 8) : [] }),
    url: msg.url || '',
  }),
  // "May PanelFlow read the pages from these hosts?" is the extension's
  // question (Chrome's host permissions). A phone has no such permission to
  // grant: the answer is always yes. Answered rather than left unknown, which
  // printed a warning on every save and every download.
  imageAccess: async () => ({ missing: [] }),
  // The extension's options page, where Chrome's host permissions are
  // granted. The reader asks for it only when imageAccess names a host, which
  // here it never does; answered all the same, so nothing a page may send
  // goes unanswered.
  openOptions: async () => ({ ok: false, error: 'no options page on a phone' }),
  // The same for a tracker's authorisation page, which the extension opens
  // in a new tab: the library sheet offers that only outside the app, and
  // points to the app's own tracker screen inside it.
  trackerConnectTab: async () => ({ error: 'trackers are connected from the app' }),
  // The extension's worker reads a page the reader could not. On a phone the
  // reader never asks: savePage has the app download such a page itself
  // (offlineFetchPage). A page that asks anyway is told so, not met with
  // "unknown message".
  fetchImage: async () => ({ error: 'on a phone the app downloads the pages itself' }),
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
    // The reader's home button: out of the browser, onto the library.
    case 'goHome':
      shell.goHome?.();
      return { ok: !!shell.goHome };
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
  'goHome', 'imageAccess', 'migrateEntry', 'offlineCommit', 'offlineFetchPage', 'offlineHas',
  'offlinePage', 'offlineRemove', 'openOptions', 'pageDetected', 'recordRead', 'saveProgress',
  'trackerAdd', 'trackerConnectTab', 'trackerEntry', 'trackerLink', 'trackerPushOne', 'trackerSearch',
  // The markup of the next chapter, fetched by the page and read here. It
  // carries no secret in either direction: what goes out is a page the reader
  // is already looking at, what comes back is a list of image addresses from
  // that same page.
  'compatHtml',
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
  // The reader's own note that auto-scroll was running when a chapter had to
  // be loaded the old way (reader.js, gotoChapter): a page URL, nothing more.
  'resumeAutoplayFor',
  // detect.js reads this for `autoOpenReader`. It carries the backend's address,
  // which is not a secret — it is printed in every request the page can watch.
  'settings',
]);

// `settings` is readable and not writable: the address this install syncs to is
// not a page's business, and it is the one key that would be worth taking.
const PAGE_WRITES = new Set([
  'readerHelpSeen', 'readerMode', 'readerPrefs', 'readerSeries', 'videoUi',
  'autoShowDefault', 'autoShowSites', 'reopenReaderFor', 'resumeAutoplayFor',
]);

const only = (keys, allowed) => (Array.isArray(keys) ? keys : [keys])
  .filter((k) => allowed.has(k));

// --- what a page is told, and what it may write --------------------------------
//
// The second layer under the signed channel (see BrowserScreen.js). A signature
// says the request came from the injected scripts; it does not make the page
// they run in any less somebody else's. So what crosses back is the least the
// reader needs, about the site being read — never the account's e-mail, never
// the bookmarks kept on other sites — and a write has to be about that site.
// Found by the QA pass of September 2026, which read an account's e-mail and
// every bookmark from a hostile page and wrote a series into the synced shelf.

/** The part of a host that says which site it is ("www.scan.fr" → "scan.fr"). */
/**
 * Suffixes under which every name belongs to somebody different, so that the
 * last two labels are not a site: `a.github.io` and `b.github.io` are two
 * people's pages, `x.co.uk` and `y.co.uk` two companies. Not the whole Public
 * Suffix List — thousands of entries, for an app — but the country second
 * levels and hosting platforms reading sites actually live under. The QA pass
 * of September 2026 had one github.io page read another's bookmarks.
 */
const SHARED_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp',
  'co.kr', 'or.kr', 'com.br', 'net.br', 'com.mx', 'com.ar', 'com.co', 'com.tr', 'com.vn', 'com.cn',
  'com.tw', 'com.hk', 'com.sg', 'com.my', 'com.ph', 'com.id', 'co.id', 'my.id', 'web.id', 'co.in',
  'co.za', 'com.pl', 'com.ua', 'com.ru',
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'herokuapp.com', 'glitch.me', 'neocities.org', 'blogspot.com', 'wordpress.com',
  'tumblr.com', 'wixsite.com', 'weebly.com', 'surge.sh', 'onrender.com', 'fly.dev', 'appspot.com',
  'azurewebsites.net', 'cloudfront.net',
]);

export const siteOf = (url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    // An address is its own site: 10.0.0.1 and 192.168.0.1 share their last
    // two numbers and nothing else.
    if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[') || host.includes(':')) return host;
    const labels = host.split('.');
    const two = labels.slice(-2).join('.');
    return SHARED_SUFFIXES.has(two) ? labels.slice(-3).join('.') : two;
  } catch {
    return null;
  }
};

/**
 * The same chapter: the same address, whatever the anchor, a trailing slash or
 * the query say — the reader may know the page by its canonical address, which
 * drops what the site's own links append.
 */
const chapterPath = (url) => {
  try { const u = new URL(String(url)); return (u.origin + u.pathname).replace(/\/+$/, ''); } catch { return null; }
};
const sameChapterUrl = (a, b) => !!chapterPath(a) && chapterPath(a) === chapterPath(b);

/** Is `url` an http(s) address on `site`? */
const onSite = (url, site) => !!site && siteOf(url) === site;

/**
 * The fields of an entry that say what it is, and none that say what you think
 * of it or where you filed it. The last chapter known stays: the duplicate
 * sheet sets it beside this page's to show which copy is further on, inside a
 * closed shadow root the page cannot read. The shelf it sits on does not.
 */
const publicEntry = (e) => e && ({
  id: e.id, title: e.title, sourceUrl: e.sourceUrl, sourceDomain: e.sourceDomain,
  coverUrl: e.coverUrl ?? null, lastKnownChapter: e.lastKnownChapter ?? null,
  medium: e.medium,
});

/** Longest a single reading record may claim, so a page cannot pad the statistics. */
export const MAX_READ_SECONDS = 2 * 3600;

const REFUSED = { error: 'not available to a page' };

/**
 * An http(s) address on the public web: not this device, not the local
 * network, not a bare name only a LAN resolves. Checked on the text of the
 * address, which is all there is before the request is made.
 */
export function publicWebAddress(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  // A name and a password in the address are no picture's business.
  if (u.username || u.password) return false;
  // A name may end with the root's dot, and "localhost." is localhost (QA, P5).
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // An IPv6 literal is never where a chapter's pages live, and it is a way to
  // spell this phone or its network that a text check would have to read in
  // every form (::7f00:1, 64:ff9b::…, 2002:…): refused outright (QA, P5).
  if (host.includes(':')) return false;
  if (!host.includes('.')) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // An IPv4 address only in its usual dotted form, judged by its range. The
  // other spellings a resolver accepts (0x7f.1, 0177.0.0.1) are refused: no
  // site writes them, and they went past the ranges below (QA, P5).
  if (host.split('.').every((label) => /^(0x[0-9a-f]*|\d+)$/i.test(label))) {
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!v4 || v4.slice(1).some((n) => Number(n) > 255 || (n.length > 1 && n.startsWith('0')))) return false;
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
  }
  return true;
}

/**
 * A message that arrived from a page in the in-app browser.
 *
 * Same hub, narrower door. A refusal is an `{ error }` like any other, because
 * that is what the shim's callers already handle — a page that asks for
 * something it may not have gets the same answer as one asking a worker that
 * is not there.
 */
export async function sendFromPage(msg, shell) {
  if (!PAGE_TYPES.has(msg?.type)) {
    console.warn(`[panelflow] a page asked for ${msg?.type} and was refused`);
    return REFUSED;
  }
  const site = siteOf(shell?.pageUrl);
  switch (msg.type) {
    // Whether somebody is signed in is what the sheet needs; who is not.
    case 'getAccount': {
      const r = await send(msg, shell);
      return { authUser: r?.authUser ? { signedIn: true } : null };
    }
    // This site's bookmarks, not the whole reading life.
    case 'getProgressAll': {
      const r = await send(msg, shell);
      return {
        progress: Object.fromEntries(Object.entries(r?.progress || {}).filter(([k]) => onSite(k, site))),
      };
    }
    // The bookmark further on, when this chapter is a reread of one before
    // it, is this site's or it is nothing.
    case 'getProgressFor': {
      if (!onSite(msg.chapterUrl, site)) return { progress: null, bookmark: null };
      const r = await send(msg, shell);
      const mark = r?.bookmark;
      return { ...r, bookmark: mark && onSite(mark.chapterUrl, site) && onSite(msg.sourceUrl, site) ? mark : null };
    }
    case 'getReadChapters':
      return onSite(msg.sourceUrl, site) ? send(msg, shell) : { chapters: [] };
    // The same series elsewhere is what the duplicate check is for, so other
    // sites' entries still come back — as what they are, without the reader's
    // score, note or tags.
    case 'findSimilar': {
      const r = await send(msg, shell);
      return {
        ...r,
        matches: (r?.matches || []).map((m) => (onSite(m?.entry?.sourceUrl, site)
          ? m : { ...m, entry: publicEntry(m?.entry) })),
      };
    }
    // Writes are about the page being read, or they are not answered.
    case 'addToLibrary':
      if (!onSite(msg.entry?.sourceUrl, site)
        || (msg.entry?.chapterUrl && !onSite(msg.entry.chapterUrl, site))) return REFUSED;
      return send(msg, shell);
    case 'saveProgress':
      if (!onSite(msg.progress?.chapterUrl, site) || !onSite(msg.progress?.sourceUrl, site)) return REFUSED;
      // Moving the bookmark is about the chapter on screen, and only that one:
      // the page may not move the bookmark of another chapter, or of another
      // series on the same site (QA re-test It.4, N-B3).
      if (msg.progress?.moveBookmark && !sameChapterUrl(msg.progress.chapterUrl, shell?.pageUrl)) return REFUSED;
      return send(msg, shell);
    case 'recordRead':
      if (!onSite(msg.read?.chapterUrl, site)) return REFUSED;
      return send({
        ...msg,
        read: { ...msg.read, seconds: Math.max(0, Math.min(MAX_READ_SECONDS, Number(msg.read?.seconds) || 0)) },
      }, shell);
    case 'migrateEntry':
      if (!onSite(msg.target?.sourceUrl, site)) return REFUSED;
      return send(msg, shell);
    // The app fetches a page for the page, so it fetches only a picture of
    // this site's chapter, from an address on the public web: never this
    // phone's own network (a router's admin page, a printer) on a page's say-so.
    case 'offlineFetchPage':
      if (!onSite(msg.chapterUrl, site) || !publicWebAddress(msg.url)) return REFUSED;
      return send({
        type: 'offlineFetchPage', chapterUrl: msg.chapterUrl, index: Number(msg.index), url: msg.url,
        siteUrl: shell?.pageUrl || null,
      }, shell);
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
    note('hub', `${msg?.type ?? 'unknown'}: ${e?.message ?? e}`);
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
  // Pulls before it pushes (see syncAll in the shared core).
  await core.syncAll().catch(() => {});
  emit('changed');
}

export { DEFAULTS };
