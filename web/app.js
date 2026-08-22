'use strict';

// Same-origin when served by the backend; override with ?api=<url> for dev.
const API = new URLSearchParams(location.search).get('api') ?? '';
// The folders, from the one file that names them (shared/folders.js). This page
// used to keep its own list and spelt "complete" where the column says
// "completed", which quietly turned every status change into a 400.
const { BUILTIN, BUILTIN_IDS: STATUSES, folderStatus, folderLabel, folderTabs,
  folderFor, DEFAULT_FOLDER } = PanelFlowFolders;
// shared/folders.js carries the English label, and the locales carry every
// language including that one. Looked up per call, not built once into a table:
// a table is read at load, and the reader can change the language after that.
const BUILTIN_LABELS = Object.fromEntries(BUILTIN.map((f) => [f.id, f.label]));
const statusLabel = (id) => t('folder_' + id, undefined) || BUILTIN_LABELS[id] || id;
// A shelf of the reader's own is called what they called it; a built-in one is
// called what this language calls it. `folderTabs` hands back the English label
// for both, which is right for exactly one of them.
const tabLabel = (f) => (f.custom ? f.label : statusLabel(f.id));

// What the coloured dot on a card means, for the hover that has to explain it.
const STAND_KEYS = {
  [PanelFlowView.UNREAD]: 'standUnread',
  [PanelFlowView.READING]: 'standReading',
  [PanelFlowView.READ]: 'standRead',
};

const LANGUAGE_KEYS = {
  ja: 'webLangJa', ko: 'webLangKo', zh: 'webLangZh',
  en: 'webLangEn', fr: 'webLangFr', es: 'webLangEs',
};

let token = localStorage.getItem('pf.token');
let user = null;
let library = [];
let continueList = [];
let progressMap = {};          // libraryId -> progress row
let freshIds = new Set();      // entries whose latest chapter advanced at last check
let categories = [];           // the account's own shelves, [] when it has none
// libraryId -> when the overnight watcher last saw a chapter appear for it.
// The only real timestamp in any of this: the library's `updatedAt` is when the
// row was edited, and /api/meta/check deliberately does not touch it, because
// checking must not reorder the shelf. See newsFound().
let newsAt = {};
let activeTab = 'all';
let activeView = 'library';

// How this browser last chose to look at the shelf. Kept next to the token
// rather than on the account: a sort order is a preference of the screen you
// are sitting at, and the phone has its own.
const view = {
  sort: PanelFlowView.DEFAULT_SORT,
  dir: null,             // null = the order's own direction
  tags: [],
  unreadOnly: false,
  ...(() => { try { return JSON.parse(localStorage.getItem('pf.view')) || {}; } catch { return {}; } })(),
};
const saveView = () => localStorage.setItem('pf.view', JSON.stringify(view));

const $ = (id) => document.getElementById(id);

// The annotated markup ships empty, and this is the script that runs last with a
// whole document above it. Everything painted after this point is built in JS
// and asks t() for itself; everything painted before it is filled here, once.
PanelFlowI18n.apply();

/**
 * The page's one opinion about motion, asked rather than assumed.
 *
 * Everything visual is in the stylesheet, under
 * `@media (prefers-reduced-motion: reduce)`. This exists for the one place
 * where JavaScript has to wait for an animation instead of drawing one: a
 * reader who has asked for less motion should not also be made to wait for the
 * motion they are not getting.
 */
const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const settle = (ms) =>
  (ms > 0 && !REDUCED?.matches ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve());

async function api(path, options = {}) {
  const res = await fetch(API + '/api' + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return unwrap(res);
}

// A body that is not JSON — the MyAnimeList export, which the backend takes as
// text/xml because JSON-encoding several megabytes of it doubles the upload for
// nothing.
async function apiPostRaw(path, body, contentType) {
  const res = await fetch(API + '/api' + path, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body,
  });
  return unwrap(res);
}

async function unwrap(res) {
  if (res.status === 401 && user) {
    signOut();
    throw new Error(t('webSessionExpired'));
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || t('webRequestFailed', [String(res.status)]));
  }
  return res.status === 204 ? null : res.json();
}

// Two different questions about one column, and conflating them is how a series
// ends up under two tabs at once.
//
// `folderOf` is where the entry is filed — a built-in folder or a shelf of the
// user's own — and it is what the tab row matches on. Anything unrecognisable
// (a shelf deleted on another device) folds to the default, so no row can fall
// through every tab and become invisible.
const folderOf = (entry) => {
  const f = String(entry.folder || DEFAULT_FOLDER);
  if (STATUSES.includes(f)) return f;
  return categories.some((c) => folderFor(c) === f) ? f : DEFAULT_FOLDER;
};

// `statusOf` is what that place *means*: one of the five, always. The chip on a
// cover says it, and it is what the backend watches and exports on.
const statusOf = (entry) => folderStatus(folderOf(entry), categories);

// "Chapter 42", "ch-42.5", "42" → 42.5 (for comparing read vs latest).
const chapterNum = (label) => {
  const m = String(label ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
};

/* ---------- Where a cover leads ---------- */
// The same rule as `nextChapterUrl` / `continueTarget` in shared/panelflow-core.js,
// written a second time because this page is served straight to a browser and has
// no bridge to the core the extension and the phones run. The two copies are held
// together by backend/test/continue-target.test.js, which lifts both out of their
// source files and runs them over one table of cases.

const URL_NUM_RE = /\d+(?:\.\d+)?/g;
// Anchored at a word start, or "/comic/245" reads as the abbreviation "c".
const CHAPTER_WORD_RE = /(?:^|[^a-z])(chapter|chapitre|chap|ch|episode|ep|c)[-_/]?$/i;

// Written the way the site writes it: 246 after /chapter/245 but 0246 after
// /chapter/0245, because a site that pads its numbers 404s on the short form.
const renderNum = (was, n) => {
  const [whole] = was.split('.');
  const [i, dec] = String(n).split('.');
  const padded = /^0\d/.test(whole) ? i.padStart(whole.length, '0') : i;
  return dec ? `${padded}.${dec}` : padded;
};

// The URL of another chapter of the same series, worked out from the URL of one
// you already have — null rather than a guess when the substitution is not
// obvious. Only the path and query are considered: the host is full of numbers
// that have nothing to do with chapters ("ww6.example.com").
function nextChapterUrl(url, from, to) {
  if (!url || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const tail = u.pathname + u.search;

  const hits = [];
  for (const m of tail.matchAll(URL_NUM_RE)) {
    if (parseFloat(m[0]) !== from) continue;
    hits.push({ at: m.index, text: m[0], keyed: CHAPTER_WORD_RE.test(tail.slice(0, m.index)) });
  }
  if (hits.length === 0) return null;
  const keyed = hits.filter((h) => h.keyed);
  const hit = hits.length === 1 ? hits[0] : keyed.length === 1 ? keyed[0] : null;
  if (!hit) return null;

  const moved = tail.slice(0, hit.at) + renderNum(hit.text, to) + tail.slice(hit.at + hit.text.length);
  return u.origin + moved;
}

// Normally the chapter you are on — that is what a bookmark is for — but once
// you have caught up and the site has moved on, the point of opening the series
// is the chapter you have not read. "The one after the one you finished", not
// the newest: someone five chapters behind wants 246, not 250.
function continueTarget(entry, progress) {
  const series = { url: entry?.sourceUrl || null, label: null, isNew: false };
  if (!progress?.chapterUrl) return series;
  const here = { url: progress.chapterUrl, label: progress.chapterLabel || null, isNew: false };

  const read = chapterNum(progress.chapterLabel);
  const latest = chapterNum(entry?.lastKnownChapter);
  if (!Number.isFinite(read) || !Number.isFinite(latest) || latest <= read) return here;

  // Positive evidence of being mid-chapter, and nothing weaker: a page count and
  // a page short of it. Most bookmarks have no count at all.
  if (progress.pageCount > 1 && (progress.page ?? 0) < progress.pageCount - 1) return here;

  const next = Math.min(read + 1, latest);
  const url = nextChapterUrl(progress.chapterUrl, read, next);
  return url ? { url, label: `Ch. ${next}`, isNew: true } : here;
}

// A new scan is out when the latest chapter seen on the site is past the one
// last read — or when the periodic check just saw the site advance.
function hasNewChapter(entry) {
  if (freshIds.has(entry.id)) return true;
  const latest = chapterNum(entry.lastKnownChapter);
  const read = chapterNum(progressMap[entry.id]?.chapterLabel);
  return latest !== null && read !== null && latest > read;
}

/* ---------- When a request does not come back ---------- */
//
// Every dialog on this page reports its own failures; the shelf did not, and
// the shelf is the one screen you cannot avoid. A request that failed on the
// way in left the app view up, empty, with nothing said and nothing to click —
// which reads as "PanelFlow lost my library", not as "the network hiccuped".
//
// So: one line, and the only button worth offering, which is the same request
// again. The retry re-runs the exact action that failed rather than reloading
// the page, because a reload also throws away whatever else was on screen.

// What failed, so the button can do it again. The description is kept apart
// from the message on screen: that message already has the error appended, and
// retrying twice would otherwise print the first failure inside the second.
let retrying = null;

function showTrouble(what, err, again) {
  retrying = { what, again };
  $('app-error-text').textContent = `${what} — ${err.message}`;
  $('app-error').hidden = false;
}

const hideTrouble = () => { $('app-error').hidden = true; retrying = null; };

$('app-error-retry').addEventListener('click', () => {
  const last = retrying;
  if (last) guard(last.what, last.again);
});

/**
 * Run something that talks to the server and, if it fails, say so on the line
 * above instead of throwing into nowhere. Anything a card can start goes
 * through here: a click that silently does nothing is worse than one that
 * fails out loud, because the next thing the user does is click it again.
 */
async function guard(what, fn) {
  try {
    await fn();
    hideTrouble();
    return true;
  } catch (err) {
    showTrouble(what, err, fn);
    return false;
  }
}

/* ---------- Auth ---------- */

// Three cards share the signed-out view: signing in, asking for a reset link,
// and spending one. Exactly one is on screen at a time, and switching clears
// what the previous one had to say — an error about a password left standing
// over the "check your inbox" line reads as a rejection of the address.
function showAuth(card = 'auth') {
  $('auth-view').hidden = false;
  $('app-view').hidden = true;
  for (const name of ['auth', 'forgot', 'reset']) {
    $(name === 'auth' ? 'auth-form' : `${name}-form`).hidden = name !== card;
  }
  for (const line of ['auth-error', 'forgot-error', 'forgot-sent', 'reset-error']) {
    $(line).hidden = true;
  }
}

function signOut() {
  // Before the token goes: unsubscribing needs it, and a browser that keeps
  // announcing the chapters of an account nobody is signed into is worse than
  // no notifications at all.
  dropPush();
  token = null;
  user = null;
  // The shelves belong to the account, not to the browser: leaving them behind
  // would show the next person to sign in on this tab a row of tabs that are
  // not theirs, and file their series onto ids they do not own.
  categories = [];
  localStorage.removeItem('pf.token');
  askAboutReset();
  showAuth();
}

$('auth-switch').addEventListener('click', (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  const toRegister = btn.dataset.mode === 'login';
  btn.dataset.mode = toRegister ? 'register' : 'login';
  btn.textContent = t(toRegister ? 'actionCreateAccount' : 'actionSignIn');
  $('auth-switch-label').textContent = t(toRegister ? 'webAlreadyRegistered' : 'webNoAccountYet');
  $('auth-switch').textContent = t(toRegister ? 'actionSignIn' : 'webCreateOne');
  // Nothing has been forgotten by someone who has not signed up yet — and
  // nothing can be sent by a server with no way to send it.
  $('auth-forgot-line').hidden = toRegister || !canReset;
  $('auth-error').hidden = true;
});

$('auth-forgot').addEventListener('click', (e) => {
  e.preventDefault();
  // Carried across, because it is almost always already typed by the time
  // someone realises they do not remember the password that goes with it.
  $('forgot-email').value = $('auth-email').value;
  showAuth('forgot');
});

$('forgot-back').addEventListener('click', (e) => { e.preventDefault(); showAuth('auth'); });
$('reset-back').addEventListener('click', (e) => { e.preventDefault(); clearResetHash(); showAuth('auth'); });

$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('forgot-submit');
  btn.disabled = true;
  try {
    const data = await api('/auth/forgot', { method: 'POST', body: { email: $('forgot-email').value } });
    // The server answers the same way whether or not that address has an
    // account, and so does this screen: saying "no such account" here would
    // hand anyone a way to test addresses without needing a password.
    $('forgot-sent').textContent = data.message ?? t('webForgotSent');
    $('forgot-sent').hidden = false;
    $('forgot-error').hidden = true;
  } catch (err) {
    $('forgot-error').textContent = err.message;
    $('forgot-error').hidden = false;
    $('forgot-sent').hidden = true;
  } finally {
    btn.disabled = false;
  }
});

$('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('reset-submit');
  btn.disabled = true;
  try {
    await api('/auth/reset', { method: 'POST', body: { token: resetToken, password: $('reset-password').value } });
    // No token comes back, on purpose: the new password gets typed once here
    // and once at the sign-in screen, and the second time is what catches a
    // typo before it becomes the password nobody knows.
    clearResetHash();
    showAuth('auth');
    $('auth-error').textContent = t('webPasswordChanged');
    $('auth-error').hidden = false;
  } catch (err) {
    $('reset-error').textContent = err.message;
    $('reset-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// A deployment with no mail provider cannot send a reset link, and a link that
// leads to "not configured on this server" is worse than no link: it costs a
// reader their address, a wait, and the belief that the mail is coming. So the
// line is absent from the page until the server says otherwise — and stays
// absent if the question cannot be asked at all, since a backend that will not
// answer this is not one that is about to send mail either.
let canReset = false;

async function askAboutReset() {
  try {
    canReset = !!(await api('/auth/capabilities')).passwordReset;
  } catch {
    canReset = false;
  }
  $('auth-forgot-line').hidden = !canReset || $('auth-submit').dataset.mode !== 'login';
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = $('auth-submit').dataset.mode;
  try {
    const data = await api('/auth/' + mode, {
      method: 'POST',
      body: { email: $('auth-email').value, password: $('auth-password').value },
    });
    token = data.token;
    user = data.user;
    localStorage.setItem('pf.token', token);
    // Awaited: the sign-in worked, so a failure past this point belongs to the
    // shelf and not to the credentials. Reporting it on the sign-in form —
    // which is no longer on screen — was how it used to disappear entirely.
    await guard(t('webLoadFailed'), enterApp);
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  }
});

// The reset token rides in the fragment rather than the query string: a
// fragment is never sent to any server, so it stays out of access logs, out of
// proxies, and out of the Referer header of everything this page loads.
let resetToken = null;

function readResetHash() {
  resetToken = location.hash.match(/^#reset=([\w-]+)$/)?.[1] ?? null;
  return resetToken;
}

/** Off the address bar as soon as it is in hand, so a reload cannot replay it. */
function clearResetHash() {
  resetToken = null;
  if (location.hash.startsWith('#reset=')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

/* ---------- App ---------- */

async function enterApp() {
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  $('account-email').textContent = user.email;
  // Not awaited: it asks the server for a key and registers a worker, and the
  // shelf below has no reason to wait for either.
  setupPush();
  // Also not awaited, and for a different reason: the page has already been
  // painted in whatever theme and language this browser last saw, so the
  // account's answer is a correction rather than a prerequisite. It is usually
  // the same answer and changes nothing; the one time it does not is the first
  // load on a new device, which is exactly the case this exists for.
  adoptAccountPrefs();
  // The extension's own settings page links here with #settings: the account
  // half of its settings is on this page, and landing on the shelf would be
  // landing one click short of the point. The fragment goes once it has been
  // read, so Back and reload behave like the rest of the app.
  const sent = location.hash === '#settings';
  if (sent) {
    history.replaceState(null, '', location.pathname + location.search);
    showView('settings');
  }
  await refresh();
  // And when nothing sent the reader anywhere in particular, the app opens on
  // what is out rather than on the shelf — but only when there is something in
  // it. An empty feed as a front page is a worse first screen than the library,
  // and a reader who is caught up should never be shown a page saying so.
  if (!sent && updatesFeed().length > 0) showView('updates');
}

async function refresh() {
  let progressRows;
  let news;
  [library, continueList, progressRows, categories, news] = await Promise.all([
    api('/library'),
    api('/progress/continue'),
    api('/progress'),
    api('/categories'),
    // Caught rather than awaited with the rest: this one decorates the feed
    // with dates and orders it, and a feed in the wrong order is worth far less
    // than the shelf, which would otherwise go down with it.
    api('/news?all=1').catch(() => []),
  ]);
  progressMap = Object.fromEntries(progressRows.map((p) => [p.libraryId, p]));
  // Rows come back newest first, so the first one seen for a series is its
  // latest. Deliberately not marked seen: `seen` is the notification drain, and
  // opening this page must not silence a notification the phone never showed.
  newsAt = {};
  for (const n of news) if (!(n.libraryId in newsAt)) newsAt[n.libraryId] = n.foundAt;
  renderContinue();
  // Before the grid: a card's folder menu and the tab it is filtered by both
  // come from this list.
  renderTabs();
  renderLibrary();
  renderUpdates();
}

/**
 * One drawing out of the sprite at the top of index.html, as the inside of a
 * button. `name` is always a literal here — nothing user-supplied reaches it.
 *
 * Buttons carried emoji before. An emoji is a different picture on every
 * platform, keeps its own colour whatever the button's is, and sits on a
 * baseline of its own; these are stroked in currentColor and sized in em.
 */
const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function coverEl(entry) {
  if (entry.coverUrl) {
    const img = document.createElement('img');
    img.className = 'cover';
    img.alt = '';
    img.loading = 'lazy';
    // Scan sites hotlink-protect their images: load through the backend proxy,
    // which fetches with the manga site as Referer (MangaPin does the same by
    // rewriting the header in the browser). Direct URL as a fallback.
    const ref = entry.sourceUrl || (entry.sourceDomain ? 'https://' + entry.sourceDomain + '/' : '');
    img.src = API + '/api/cover?url=' + encodeURIComponent(entry.coverUrl) +
      (ref ? '&ref=' + encodeURIComponent(ref) : '');
    // One retry, tracked by a flag rather than by comparing `img.src` back to
    // the URL we set: the property reflects the *resolved* address, so a
    // relative or protocol-relative cover never compared equal and the fallback
    // reassigned the same broken source forever.
    let triedDirect = false;
    // Shown when it has decoded, not when it has arrived. The proxy hands back
    // progressive JPEGs, which paint in visible steps; one fade over the
    // placeholder is one change instead of four.
    //
    // decode() *after* load and never instead of it: calling it on an image
    // that has not started loading begins the fetch, which would quietly undo
    // `loading="lazy"` across a shelf of two hundred covers. And a decode that
    // fails still reveals — the error handler below is what deals with a broken
    // cover, and an image left at zero opacity would be a hole nobody can see.
    const reveal = () => img.classList.add('ready');
    img.addEventListener('load', () => {
      if (img.decode) img.decode().then(reveal, reveal);
      else reveal();
    });
    img.addEventListener('error', () => {
      if (!triedDirect) {
        triedDirect = true;
        img.src = entry.coverUrl;
      } else {
        img.replaceWith(fallbackCover(entry.title));
      }
    });
    return img;
  }
  return fallbackCover(entry.title);
}

/**
 * A title, as a number.
 *
 * djb2, kept only because it is four lines and spreads short strings well; the
 * point is not the hash but that it is a pure function of the title, so a
 * series with no cover is the same rectangle on every device and every reload.
 */
function hashOf(title) {
  let h = 5381;
  for (let i = 0; i < title.length; i++) h = ((h * 33) ^ title.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * What a series with no cover looks like: its first letter, on a tint the title
 * decides. The gradient this used to be was the same gradient for every series,
 * which made a shelf of coverless entries one repeated rectangle.
 *
 * The tint goes out as a percentage rather than as a colour on purpose —
 * styles.css mixes it between two tokens from shared/theme.css, so the palette
 * stays in one file (backend/test/theme.test.js fails on a colour written here).
 */
function fallbackCover(title) {
  const div = document.createElement('div');
  div.className = 'cover-fallback';
  const name = (title || '?').trim();
  div.textContent = name.charAt(0).toUpperCase();
  // Two knobs off one hash, because one was not enough: --tint picks a warm
  // between the accent and the amber, and --tint-weight decides how much of it
  // lands on the surface. With only the first, six coverless series were six
  // shades of the same orange and the shelf looked printed on one sheet.
  const h = hashOf(name);
  div.style.setProperty('--tint', (h % 101) + '%');
  div.style.setProperty('--tint-weight', (22 + ((h >>> 9) % 19)) + '%');
  return div;
}

function renderContinue() {
  const sec = $('continue-section');
  sec.hidden = continueList.length === 0;
  const list = $('continue-list');
  list.innerHTML = '';
  for (const p of continueList) {
    // The shelf and the card below it are the same series, so they lead to the
    // same chapter — this row carries the progress but not the series, and the
    // rule needs both.
    const target = continueTarget(library.find((e) => e.id === p.libraryId), p);
    const a = document.createElement('a');
    a.className = 'shelf-card';
    a.href = target.url || p.chapterUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.appendChild(coverEl(p));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<span class="title"></span><span class="sub"></span>'
    + `<span class="resume">${t('actionResume')} ▸</span>`;
    if (target.isNew) meta.querySelector('.resume').textContent = `${target.label} ▸`;
    meta.querySelector('.title').textContent = p.title;
    meta.querySelector('.sub').textContent =
      `${p.chapterLabel || t('webFieldChapter')} · p.${(p.page ?? 0) + 1}${p.pageCount ? '/' + p.pageCount : ''}`;
    a.appendChild(meta);
    list.appendChild(a);
  }
}

const progressOf = (entry) => progressMap[entry.id];

function renderLibrary() {
  const grid = $('library-grid');
  grid.innerHTML = '';

  const items = PanelFlowView.sortLibrary(
    PanelFlowView.filterLibrary(library, {
      query: $('search').value,
      // The tabs are the folders, and 'all' means no folder filter — the same
      // word the shared rule uses.
      folder: activeTab,
      folderOf,
      tags: view.tags,
      unreadOnly: view.unreadOnly,
      // So a shelf of the user's own is judged by the status it stands for:
      // "unread only" on a category that means Completed hides it, like the
      // built-in folder would.
      categories,
      progressOf,
    }),
    { by: view.sort, dir: view.dir, progressOf },
  );
  $('empty').hidden = items.length > 0;
  renderTools(items.length);

  for (const entry of items) {
    const card = document.createElement('div');
    card.className = 'card';

    // The cover is the way back into the series, so it opens the chapter rather
    // than the site's front page: the one you are on, or — once you have caught
    // up and a new one is out — that one. The series page is still one click
    // away on the edit panel, and it is what a series with no bookmark falls to.
    const target = continueTarget(entry, progressMap[entry.id]);
    const coverWrap = document.createElement('a');
    coverWrap.className = 'cover-wrap';
    coverWrap.href = target.url || entry.sourceUrl;
    coverWrap.title = target.isNew
      ? `Read ${target.label}`
      : target.label ? t('actionContinueChapter', [target.label]) : t('actionOpenSeriesPage');
    coverWrap.target = '_blank';
    coverWrap.rel = 'noopener';
    coverWrap.appendChild(coverEl(entry));

    const chip = document.createElement('span');
    chip.className = 'status-chip';
    // The shelf it is on, which for a built-in folder is the status itself —
    // and for a shelf of the user's own is the name they gave it, with the
    // status it stands for one hover away.
    chip.textContent = folderLabel(folderOf(entry), categories);
    chip.title = statusLabel(statusOf(entry));
    coverWrap.appendChild(chip);

    if (hasNewChapter(entry)) {
      const newChip = document.createElement('span');
      newChip.className = 'new-chip';
      // The chip can be earned by the periodic check alone (freshIds), and a
      // label is free text — "Nouveau chapitre" has no number in it. Say so
      // without the "ch. null" this used to print.
      const n = chapterNum(entry.lastKnownChapter);
      newChip.textContent = n === null ? t('badgeNew') : t('badgeNewChapterNo', [String(n)]);
      newChip.title = t('webNewChapterOut');
      coverWrap.appendChild(newChip);
    }

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = t('actionRemoveFromLibrary');
    remove.innerHTML = icon('close');
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      guard(t('webCouldNotRemove', [entry.title]), async () => {
        await api('/library/' + entry.id, { method: 'DELETE' });
        await refresh();
      });
    });
    coverWrap.appendChild(remove);

    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.title = t('webEditDetails');
    edit.innerHTML = icon('pencil');
    edit.addEventListener('click', (e) => {
      e.preventDefault();
      openSeriesDialog(entry);
    });
    coverWrap.appendChild(edit);
    card.appendChild(coverWrap);

    const body = document.createElement('div');
    body.className = 'card-body';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = entry.title;
    title.title = entry.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = entry.sourceDomain +
      (entry.lastKnownChapter ? ` · latest ch.${chapterNum(entry.lastKnownChapter) ?? entry.lastKnownChapter}` : '');

    // The details the extension and the importers write and this page used to
    // drop on the floor: a score set on the phone was invisible here.
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const chip of detailChips(entry)) {
      const el = document.createElement('span');
      el.className = 'chip';
      el.textContent = chip.text;
      el.title = chip.title;
      chips.appendChild(el);
    }

    const progLine = document.createElement('div');
    progLine.className = 'progress-line';
    const prog = progressMap[entry.id];
    // Where this series stands, said in colour before it is said in words. The
    // card already carried the answer, spread over a chip, a chapter number and
    // a page count that all have to be read and compared; the dot is the same
    // answer at a glance, and it goes on the card as a class too so the whole
    // thing can be tinted rather than just the one line.
    const stand = PanelFlowView.readState(entry, prog, categories);
    card.classList.add('is-' + stand);
    const dot = document.createElement('span');
    dot.className = 'state-dot';
    dot.title = t(STAND_KEYS[stand]);
    progLine.appendChild(dot);
    // And the same thing again in words. The dot alone asked the reader to
    // remember what orange meant and gave no idea of the size of the gap: two
    // chapters and forty are the same dot. This is the number it stood for,
    // and it is only drawn when there is a number to say — a series with no
    // bookmark, or one whose latest chapter has no number in its label, has no
    // distance to report and gets the dot on its own as before.
    // The news count, not the raw gap: a series the reader has marked Completed
    // or Dropped is not behind on anything, however far the site ran on without
    // them, and saying so on the card contradicted the dot beside it.
    const behind = PanelFlowView.newChapters(entry, prog, categories);
    if (behind > 0) {
      const gap = document.createElement('span');
      gap.className = 'behind';
      gap.textContent = t(behind === 1 ? 'webOneBehind' : 'webNBehind', [String(behind)]);
      gap.title = t('webChaptersAhead', [String(behind)]);
      progLine.appendChild(gap);
    }
    if (prog) {
      const label = document.createElement('span');
      label.textContent = `${prog.chapterLabel || 'Chapter ?'} · p.${(prog.page ?? 0) + 1}${prog.pageCount ? '/' + prog.pageCount : ''}`;
      const resume = document.createElement('a');
      // The cover's target, not the bookmark's: two links on one card that go to
      // different chapters is a card that cannot be trusted.
      resume.href = target.url || prog.chapterUrl;
      resume.target = '_blank';
      resume.rel = 'noopener';
      resume.textContent = target.isNew ? `${target.label} ▸` : 'Resume ▸';
      if (target.isNew) resume.className = 'fresh';
      progLine.append(label, resume);
    } else {
      const label = document.createElement('span');
      label.textContent = t('webNotStarted');
      progLine.appendChild(label);
    }
    const editProg = document.createElement('button');
    editProg.className = 'edit-progress';
    editProg.title = t('webSetProgress');
    editProg.innerHTML = icon('pencil');
    editProg.addEventListener('click', () => openProgressDialog(entry));
    progLine.appendChild(editProg);
    const select = document.createElement('select');
    fillFolderSelect(select);
    select.value = folderOf(entry);
    select.addEventListener('change', () => {
      const wanted = select.value;
      // A card that is about to stop belonging to the tab being looked at
      // starts leaving at once, before the server has been asked. The write is
      // optimistic either way; without this the card sits there through the
      // round trip and then vanishes, which reads as a bug rather than as the
      // shelf having changed.
      const leaving = activeTab !== 'all' && wanted !== activeTab;
      if (leaving) card.classList.add('leaving');
      guard(t('webCouldNotMove', [entry.title]), async () => {
        const began = Date.now();
        await api('/library/' + entry.id, { method: 'PUT', body: { folder: wanted } });
        // Only ever the remainder, and nothing at all when the answer took
        // longer than the animation or when the reader asked for less motion:
        // this is here to let a fade finish, not to slow the page down.
        if (leaving) await settle(180 - (Date.now() - began));
        await refresh();
      // The <select> already shows the new shelf; without this it keeps showing
      // it after a failed save, and the card sits under a tab the server has
      // never heard of until the next reload.
      }).then((ok) => {
        if (ok) return;
        card.classList.remove('leaving');
        select.value = folderOf(entry);
      });
    });
    body.append(title, sub);
    if (chips.childElementCount) body.appendChild(chips);
    body.append(progLine, select);
    if (entry.note) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = entry.note;
      note.title = entry.note;
      body.appendChild(note);
    }
    card.appendChild(body);
    grid.appendChild(card);
  }
}

function detailChips(entry) {
  const out = [];
  if (entry.score != null) out.push({ text: `★ ${entry.score}`, title: t('webYourScore', [String(entry.score)]) });
  if (entry.language) {
    out.push({
      text: entry.language.toUpperCase(),
      title: LANGUAGE_KEYS[entry.language] ? t(LANGUAGE_KEYS[entry.language]) : entry.language,
    });
  }
  if (entry.seriesStatus) {
    out.push({
      text: t(entry.seriesStatus === 'completed' ? 'webFinished' : 'webOngoing'),
      title: t(entry.seriesStatus === 'completed' ? 'webFinishedHint' : 'webOngoingHint'),
    });
  }
  if (entry.rereads > 0) {
    out.push({ text: `↻ ${entry.rereads}`, title: t('webReadThrough', [String(entry.rereads + 1)]) });
  }
  const span = [entry.startDate, entry.finishDate].filter(Boolean);
  if (span.length) out.push({ text: span.join(' → '), title: 'Started / finished' });
  for (const tag of entry.tags ?? []) out.push({ text: tag, title: 'Tag' });
  return out;
}

/* ---------- The updates feed ---------- */
//
// What is out that has not been read, one line per series, and every line opens
// the chapter rather than the series page.
//
// Nothing here re-derives what counts as news. `PanelFlowView.newChapters()` is
// the answer — the same call the card's "3 chapters behind" line makes — and it
// is what keeps a series filed under Completed or Dropped out of this list:
// B3 taught it to read shared/folders.js, so the gap a finished series was
// left with stops being announced. A second rule written here would be a second
// rule to keep in step, and this is exactly the screen where the old one showed.

/** Whether the watcher is still following this series at all. */
const watched = (entry) => PanelFlowFolders.WATCHED.includes(statusOf(entry));

/**
 * The feed, newest first.
 *
 * "Newest" is only knowable where the overnight watcher wrote a row: the news
 * table is the one place with a real date on it. Everything else — a check run
 * from this page, a chapter number that arrived with an import — has no time
 * attached anywhere in the schema, so it is ordered by the size of the gap
 * behind the dated rows rather than pretending to a timestamp it does not have.
 */
function updatesFeed() {
  const rows = [];
  for (const entry of library) {
    if (!watched(entry)) continue;
    const prog = progressMap[entry.id];
    const count = PanelFlowView.newChapters(entry, prog, categories);
    // The count can be zero for a series the last check plainly flagged: a
    // label with no number in it ("Nouveau chapitre") gives nothing to subtract.
    // Dropping those would mean a check that says "3 series have new chapters"
    // followed by a list of two.
    if (count === 0 && !freshIds.has(entry.id)) continue;
    rows.push({ entry, prog, count, at: newsAt[entry.id] ?? null, fresh: freshIds.has(entry.id) });
  }
  rows.sort((a, b) => {
    if (a.at && b.at) return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
    if (a.at !== b.at) return a.at ? -1 : 1;
    return b.count - a.count || a.entry.title.localeCompare(b.entry.title);
  });
  return rows;
}

/** "2 days ago", down to "just now"; null for a date nobody recorded. */
function ago(at) {
  if (!at) return null;
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC, with no zone on it — read
  // as-is that is hours out, and every fresh chapter reads as "tomorrow".
  const then = Date.parse(at.includes('T') ? at : at.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(then)) return null;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 2) return t('agoNow');
  if (mins < 60) return t('agoMinutes', [String(mins)]);
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('agoHours', [String(hours)]);
  const days = Math.round(hours / 24);
  if (days < 14) return t('agoDays', [String(days)]);
  return t('agoWeeks', [String(Math.round(days / 7))]);
}

function renderUpdates() {
  const rows = updatesFeed();
  const list = $('updates-list');
  list.innerHTML = '';
  $('updates-empty').hidden = rows.length > 0;

  // The tab wears the number, because it is the only one worth seeing before it
  // is clicked — and it says nothing at all when there is nothing.
  const badge = $('updates-count');
  badge.hidden = rows.length === 0;
  badge.textContent = String(rows.length);

  for (const { entry, prog, count, at, fresh } of rows) {
    // The chapter, not the series page: the point of being told a chapter is
    // out is not having to go and look for it.
    const target = continueTarget(entry, prog);
    const a = document.createElement('a');
    a.className = 'feed-row';
    a.href = target.url || entry.sourceUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    if (fresh) a.classList.add('fresh');
    a.appendChild(coverEl(entry));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = entry.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    const latest = chapterNum(entry.lastKnownChapter);
    sub.textContent = [
      count > 0 ? t(count === 1 ? 'webOneNewChapter' : 'webNNewChapters', [String(count)]) : t('webNewChapter'),
      latest === null ? null : `latest ch. ${latest}`,
      entry.sourceDomain,
    ].filter(Boolean).join(' · ');
    meta.append(title, sub);
    a.appendChild(meta);

    const side = document.createElement('div');
    side.className = 'feed-when';
    const when = ago(at);
    if (when) {
      const stamp = document.createElement('span');
      stamp.className = 'stamp';
      stamp.textContent = when;
      stamp.title = at;
      side.appendChild(stamp);
    }
    const go = document.createElement('span');
    go.className = 'resume';
    go.textContent = target.isNew ? `${target.label} ▸` : t('actionRead') + ' ▸';
    side.appendChild(go);
    a.appendChild(side);

    list.appendChild(a);
  }
}

/* ---------- Tabs, search, sort & filter ---------- */

// Built again on every language change, not once at load: PanelFlowView.SORTS
// carries the English label, and the reader can ask for another one afterwards.
// Everything else is repainted with the grid so the controls can never disagree
// with what is on screen.
function buildSortOptions() {
  const select = $('sort');
  select.innerHTML = '';
  for (const s of PanelFlowView.SORTS) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = t('sort_' + s.id, undefined) || s.label;
    select.appendChild(opt);
  }
  select.value = view.sort;
}
buildSortOptions();
// Anything can be in localStorage — an older build's sort id, or a key somebody
// edited by hand. Nothing here is worth an exception on the first paint.
if (!PanelFlowView.SORT_IDS.includes(view.sort)) view.sort = PanelFlowView.DEFAULT_SORT;
if (!Array.isArray(view.tags)) view.tags = [];

function renderTools(shown) {
  $('sort').value = view.sort;
  const spec = PanelFlowView.SORTS.find((s) => s.id === view.sort);
  const asc = (view.dir || spec.dir) === 'asc';
  $('sort-dir').textContent = asc ? '↑' : '↓';
  $('sort-dir').title = t(asc ? 'webSortAscending' : 'webSortDescending');
  $('unread-only').checked = view.unreadOnly;

  const box = $('tag-filter');
  box.innerHTML = '';
  // Tags come from the shelf, not from a list somebody has to maintain: whatever
  // is on a series is offered, and a tag nobody uses any more stops appearing.
  const counts = PanelFlowView.tagCounts(library);
  const chosen = new Set(view.tags.map((x) => x.toLowerCase()));
  for (const name of chosen) if (!counts.some((c) => c.tag.toLowerCase() === name)) counts.push({ tag: name, count: 0 });
  for (const { tag, count } of counts) {
    const btn = document.createElement('button');
    btn.className = 'tag-chip' + (chosen.has(tag.toLowerCase()) ? ' on' : '');
    btn.textContent = count ? `${tag} ${count}` : tag;
    btn.title = t('webOnlyTagged', [tag]);
    btn.addEventListener('click', () => {
      const key = tag.toLowerCase();
      view.tags = chosen.has(key)
        ? view.tags.filter((x) => x.toLowerCase() !== key)
        : [...view.tags, tag];
      saveView();
      renderLibrary();
    });
    box.appendChild(btn);
  }

  const total = library.length;
  $('library-count').textContent = shown === total ? '' : t('webShownOfTotal', [String(shown), String(total)]);
}

$('sort').addEventListener('change', () => {
  view.sort = $('sort').value;
  // A new order arrives the way it is meant to be read — newest first, A→Z —
  // rather than inheriting the direction chosen for the previous one.
  view.dir = null;
  saveView();
  renderLibrary();
});

$('sort-dir').addEventListener('click', () => {
  const spec = PanelFlowView.SORTS.find((s) => s.id === view.sort);
  view.dir = (view.dir || spec.dir) === 'asc' ? 'desc' : 'asc';
  saveView();
  renderLibrary();
});

$('unread-only').addEventListener('change', () => {
  view.unreadOnly = $('unread-only').checked;
  saveView();
  renderLibrary();
});

/* ---------- Folders and shelves ---------- */

/**
 * Every place a folder can be picked: "All" is a tab and not a folder, so it is
 * left to the caller.
 */
function fillFolderSelect(select, { builtinOnly = false } = {}) {
  select.innerHTML = '';
  for (const f of builtinOnly ? BUILTIN : folderTabs(categories)) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = tabLabel(f);
    select.appendChild(opt);
  }
}

// The tab row, rebuilt whenever the shelves change. "All" first, then the five
// built-ins, then the user's own — and a way in to editing them, because a list
// of shelves with no way to make one is a feature nobody finds.
function renderTabs() {
  const nav = $('tabs');
  nav.innerHTML = '';
  const tabs = [{ id: 'all' }, ...folderTabs(categories)];
  // A shelf can disappear while its tab is the open one.
  if (!tabs.some((x) => x.id === activeTab)) activeTab = 'all';
  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (tab.id === activeTab ? ' active' : '');
    btn.dataset.tab = tab.id;
    btn.textContent = tabLabel(tab);
    if (tab.custom) {
      btn.classList.add('custom');
      btn.title = t('webShelfCountsAs', [statusLabel(tab.status)]);
    }
    btn.addEventListener('click', () => {
      activeTab = tab.id;
      renderTabs();
      renderLibrary();
    });
    nav.appendChild(btn);
  }
  const manage = document.createElement('button');
  manage.className = 'tab manage';
  manage.innerHTML = icon('plus') + ' ' + t('webShelves');
  manage.title = t('webMakeShelf');
  manage.addEventListener('click', openShelvesDialog);
  nav.appendChild(manage);
}

/**
 * The shelf editor. Renames and status changes save when the field is left
 * rather than behind a Save button: there is nothing else in this dialog to
 * submit, and a shelf renamed but not saved is the only way to lose work here.
 */
function openShelvesDialog() {
  $('sh-name').value = '';
  fillFolderSelect($('sh-status'), { builtinOnly: true });
  $('sh-status').value = DEFAULT_FOLDER;
  shelvesError(null);
  renderShelves();
  $('shelves-dialog').showModal();
}

const shelvesError = (message) => {
  const p = $('sh-error');
  p.hidden = !message;
  p.textContent = message ?? '';
};

// Runs an edit and repaints everything a shelf shows up in — the row it came
// from, the tab row, and every card's folder menu.
async function shelfAction(fn) {
  shelvesError(null);
  try {
    await fn();
    categories = await api('/categories');
    renderShelves();
    renderTabs();
    renderLibrary();
  } catch (err) {
    shelvesError(err.message);
    // The row still shows what the user typed; put back what the server holds.
    renderShelves();
  }
}

function renderShelves() {
  const list = $('sh-list');
  list.innerHTML = '';
  if (!categories.length) {
    const none = document.createElement('p');
    none.className = 'muted-note';
    none.textContent = t('webNoShelves');
    list.appendChild(none);
    return;
  }
  categories.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'shelf-row';

    const name = document.createElement('input');
    name.value = c.name;
    name.maxLength = PanelFlowFolders.NAME_MAX;
    name.addEventListener('change', () => {
      if (name.value.trim() === c.name) return;
      shelfAction(() => api('/categories/' + c.id, { method: 'PUT', body: { name: name.value } }));
    });

    const status = document.createElement('select');
    fillFolderSelect(status, { builtinOnly: true });
    status.value = c.status;
    status.title = t('webShelfStatusHint');
    status.addEventListener('change', () =>
      shelfAction(() => api('/categories/' + c.id, { method: 'PUT', body: { status: status.value } })));

    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '↑';
    up.title = t('webMoveUp');
    up.disabled = i === 0;
    up.addEventListener('click', () => shelfAction(() => {
      const ids = categories.map((x) => x.id);
      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      return api('/categories/order', { method: 'PUT', body: { ids } });
    }));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.innerHTML = icon('close');
    del.title = t('webShelfRemoveHint', [statusLabel(c.status)]);
    del.addEventListener('click', () => {
      const n = library.filter((e) => folderOf(e) === folderFor(c)).length;
      const moving = n
        ? '\n\n' + t(n === 1 ? 'webShelfMovesOne' : 'webShelfMovesN', [String(n), statusLabel(c.status)])
        : '';
      // Nothing is deleted here — the shelf is, and what was on it goes back to
      // the status it already counted as — but the user cannot know that.
      if (!confirm(t('webRemoveShelf', [c.name]) + moving)) return;
      shelfAction(() => api('/categories/' + c.id, { method: 'DELETE' }));
    });

    row.append(name, status, up, del);
    list.appendChild(row);
  });
}

$('sh-add').addEventListener('click', () => {
  const name = $('sh-name').value.trim();
  if (!name) return;
  shelfAction(async () => {
    await api('/categories', { method: 'POST', body: { name, status: $('sh-status').value } });
    $('sh-name').value = '';
  });
});

// Enter in the name box adds rather than submitting the form, which in a
// <dialog method="dialog"> would close it on the first shelf.
$('sh-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('sh-add').click(); }
});

$('sh-close').addEventListener('click', () => $('shelves-dialog').close());

// Debounced: renderLibrary throws the grid away and builds it again, covers
// included, so typing a six-letter title rebuilt every card six times and asked
// the proxy for its images again each time.
let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderLibrary, 120);
});
$('logout').addEventListener('click', signOut);

/* ---------- Check for new chapters ---------- */

$('check-updates').addEventListener('click', async () => {
  const btn = $('check-updates');
  const status = $('check-status');
  btn.disabled = true;
  status.textContent = t('webCheckingAll');
  try {
    const results = await api('/meta/check', { method: 'POST' });
    freshIds = new Set(results.filter((r) => r.hasNew).map((r) => r.id));
    const n = freshIds.size;
    status.textContent = n === 0
      ? t('webNoNewChapters', [String(results.length)])
      : t(n === 1 ? 'webOneHasNew' : 'webNHaveNew', [String(n)]);
    await refresh();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Add series dialog ---------- */

let scrapedLatestChapter = null;
let editingId = null;

/** `entry` omitted adds a new series; supplied edits that one. */
function openSeriesDialog(entry = null) {
  $('series-form').reset();
  editingId = entry?.id ?? null;
  scrapedLatestChapter = null;
  $('dialog-title').textContent = t(entry ? 'webEditSeries' : 'webAddSeries');
  $('f-title').value = entry?.title ?? '';
  $('f-url').value = entry?.sourceUrl ?? '';
  $('f-cover').value = entry?.coverUrl ?? '';
  fillFolderSelect($('f-status'));
  // A series added while a shelf is open lands on that shelf — which is what
  // the user was looking at when they pressed Add.
  $('f-status').value = entry ? folderOf(entry) : (activeTab === 'all' ? DEFAULT_FOLDER : activeTab);
  $('f-score').value = entry?.score ?? '';
  $('f-language').value = entry?.language ?? '';
  $('f-series-status').value = entry?.seriesStatus ?? '';
  $('f-start').value = entry?.startDate ?? '';
  $('f-finish').value = entry?.finishDate ?? '';
  $('f-rereads').value = entry?.rereads ?? '';
  $('f-tags').value = (entry?.tags ?? []).join(', ');
  $('f-note').value = entry?.note ?? '';
  $('dialog-error').hidden = true;
  $('f-scrape-status').hidden = true;
  showCoverPreview();
  $('series-dialog').showModal();
}

$('add-series').addEventListener('click', () => openSeriesDialog());

// Auto-fill title, cover and latest chapter from the series page.
$('f-url').addEventListener('change', async () => {
  const url = $('f-url').value;
  if (!url) return;
  const status = $('f-scrape-status');
  status.hidden = false;
  status.textContent = t('webFetchingPage');
  try {
    const meta = await api('/meta/scrape?url=' + encodeURIComponent(url));
    if (meta.title && !$('f-title').value) $('f-title').value = meta.title;
    if (meta.coverUrl && !$('f-cover').value) $('f-cover').value = meta.coverUrl;
    scrapedLatestChapter = meta.latestChapter;
    showCoverPreview();
    status.textContent = [
      t(meta.coverUrl ? 'webCoverFound' : 'webNoCoverFound'),
      meta.latestChapter !== null ? t('webLatestChapter', [String(meta.latestChapter)]) : null,
    ].filter(Boolean).join(' · ');
  } catch (err) {
    status.textContent = t('webPageUnreadable', [err.message]);
  }
});

function showCoverPreview() {
  const img = $('f-cover-preview');
  const url = $('f-cover').value;
  img.hidden = !url;
  if (url) img.src = url;
}
$('f-cover').addEventListener('change', showCoverPreview);

$('dialog-cancel').addEventListener('click', () => $('series-dialog').close());

// An empty field is a cleared field, not an absent one: PUT keeps what it is
// not sent, so sending null is the only way to take a score back off.
const orNull = (v) => (v === '' || v === undefined ? null : v);

$('series-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const url = new URL($('f-url').value);
    const details = {
      title: $('f-title').value.trim(),
      coverUrl: $('f-cover').value || null,
      sourceDomain: url.hostname,
      sourceUrl: url.href,
      folder: $('f-status').value,
      score: orNull($('f-score').value),
      language: orNull($('f-language').value),
      seriesStatus: orNull($('f-series-status').value),
      startDate: orNull($('f-start').value),
      finishDate: orNull($('f-finish').value),
      rereads: orNull($('f-rereads').value) ?? 0,
      note: orNull($('f-note').value.trim()),
      tags: $('f-tags').value.split(',').map((x) => x.trim()).filter(Boolean),
    };
    if (editingId) {
      // PUT cannot move a series: changing where it lives has to take the
      // bookmark with it and remember the old address, which is what migrate
      // is. Editing the URL here is therefore a one-series move.
      const before = library.find((e) => e.id === editingId);
      if (before && before.sourceUrl !== details.sourceUrl) {
        await api(`/library/${editingId}/migrate`, {
          method: 'POST',
          body: { sourceUrl: details.sourceUrl, sourceDomain: details.sourceDomain },
        });
      }
      await api('/library/' + editingId, { method: 'PUT', body: details });
    } else {
      await api('/library', {
        method: 'POST',
        body: {
          ...details,
          lastKnownChapter: scrapedLatestChapter !== null ? String(scrapedLatestChapter) : null,
        },
      });
    }
    $('series-dialog').close();
    refresh();
  } catch (err) {
    $('dialog-error').textContent = err.message;
    $('dialog-error').hidden = false;
  }
});

/* ---------- Manual progress dialog ---------- */

let progressEntry = null;

function openProgressDialog(entry) {
  progressEntry = entry;
  const prog = progressMap[entry.id];
  $('p-chapter').value = prog?.chapterLabel ?? '';
  $('p-page').value = (prog?.page ?? 0) + 1;
  $('p-url').value = prog?.chapterUrl ?? entry.sourceUrl;
  $('p-error').hidden = true;
  $('progress-dialog').showModal();
}

$('p-cancel').addEventListener('click', () => $('progress-dialog').close());

$('progress-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/progress/' + progressEntry.id, {
      method: 'PUT',
      body: {
        chapterUrl: $('p-url').value,
        chapterLabel: $('p-chapter').value || null,
        page: Math.max(0, ($('p-page').valueAsNumber || 1) - 1),
      },
    });
    freshIds.delete(progressEntry.id);
    $('progress-dialog').close();
    refresh();
  } catch (err) {
    $('p-error').textContent = err.message;
    $('p-error').hidden = false;
  }
});

/* ---------- Views ---------- */

const VIEWS = ['library', 'updates', 'stats', 'history', 'trackers', 'settings'];

$('views').addEventListener('click', (e) => {
  const tab = e.target.closest('.view-tab');
  if (!tab) return;
  showView(tab.dataset.view);
});

function showView(name) {
  activeView = VIEWS.includes(name) ? name : 'library';
  for (const v of VIEWS) $(v + '-view').hidden = v !== activeView;
  // The entering panel says "same application, other content" instead of
  // blinking — and covers the synchronous render of a couple of hundred cards,
  // which happens below while the panel is still at zero. Removed and
  // re-applied around a forced reflow, because an animation class that is
  // already on the element does not restart on its own.
  const panel = $(activeView + '-view');
  panel.classList.remove('view-enter');
  void panel.offsetWidth;
  panel.classList.add('view-enter');
  for (const el of document.querySelectorAll('.view-tab')) {
    el.classList.toggle('active', el.dataset.view === activeView);
  }
  // Search only means anything over the library grid.
  $('search').hidden = activeView !== 'library';
  // Repainted rather than loaded: the feed is worked out from the library and
  // the progress this page already holds, so it costs nothing to be current.
  if (activeView === 'updates') renderUpdates();
  if (activeView === 'stats') loadStats();
  if (activeView === 'history') loadHistory();
  if (activeView === 'trackers') loadTrackers();
  if (activeView === 'settings') loadSettings();
}

/* ---------- Settings ---------- */

// The extension's half of this page.
//
// Its settings live in chrome.storage on this machine — they have to, because
// the reader must be able to change how a chapter opens with no account and no
// network. So the extension injects a bridge into this page (see
// extension/content/site-bridge.js) and these two helpers speak to it: the
// bridge marks the document as soon as it loads, and relays a short list of
// settings messages to the service worker.
const extensionVersion = () => document.documentElement.dataset.panelflowExtension || null;

let extSeq = 0;

/**
 * One question for the extension. Resolves to its answer, or to null when
 * there is no extension here or its worker never woke — the caller draws the
 * "not installed" line either way, which is the honest thing to show when a
 * setting has nowhere to be written.
 */
function ext(type, body = {}, timeout = 4000) {
  return new Promise((resolve) => {
    if (!extensionVersion()) { resolve(null); return; }
    const id = `pf-${++extSeq}`;
    const onReply = (e) => {
      if (e.source !== window || e.data?.channel !== 'panelflow-settings' || e.data.id !== id) return;
      // Only an answer. The request below is posted into this same window, so
      // this listener sees it first — and without this line every call would
      // resolve on its own echo, before the extension had been asked anything.
      if (!('reply' in e.data)) return;
      finish(e.data.reply);
    };
    const finish = (reply) => {
      window.removeEventListener('message', onReply);
      clearTimeout(timer);
      resolve(reply && !reply.error ? reply : null);
    };
    // An MV3 service worker is stopped whenever Chrome decides it has been
    // idle. It normally wakes for the message; this is for when it does not,
    // so the page stops waiting instead of leaving live-looking controls.
    const timer = setTimeout(() => finish(null), timeout);
    window.addEventListener('message', onReply);
    window.postMessage({ channel: 'panelflow-settings', id, type, ...body }, location.origin);
  });
}

let setStatusTimer = 0;
function setStatus(text) {
  $('set-status').textContent = text;
  clearTimeout(setStatusTimer);
  if (text) setStatusTimer = setTimeout(() => { $('set-status').textContent = ''; }, 1800);
}

async function loadSettings() {
  // Before the extension is asked anything: this control is the page's own and
  // has to be right even when the answer to everything below is "no extension".
  $('set-theme').value = window.panelflowTheme.get();
  // Beside it, and above the `return` below, for the same reason: the language
  // is this page's own answer, and it has to be right in a browser that has
  // never heard of the extension. It used to be read out of the extension's
  // reply, which is why it was blank — and inert — without one.
  $('set-lang').value = PanelFlowI18n.get();

  $('set-email').textContent = user?.email ?? '';
  $('set-account-msg').hidden = true;

  const p = await ext('getPrefs');
  $('set-extension').hidden = !p;
  $('set-no-extension').hidden = !!p;
  if (!p) return;

  $('set-mode').value = p.readerMode;
  $('set-autoshow').checked = p.autoShow;
  $('set-autonext').checked = !!p.prefs.autoNext;
  $('set-hideread').checked = !!p.prefs.hideRead;
  // Absent means the pref predates the setting, and the reader was dark then.
  $('set-readerdark').checked = p.prefs.readerDark !== false;
  $('set-tapzones').value = p.prefs.tapZones;
  $('set-interval').value = String(p.checkIntervalMin);
  $('set-whitelist').value = p.whitelist.join('\n');
}

/** Saves as it is answered, the way the extension's own page does. */
function onSetting(id, patchFor) {
  $(id).addEventListener('change', async () => {
    const el = $(id);
    const reply = await ext('setPrefs', { patch: patchFor(el) });
    // Not "Saved" on a silent worker: the control would keep showing the new
    // answer over a setting that never changed.
    setStatus(t(reply ? 'statusSaved' : 'webExtensionSilent'));
  });
}

onSetting('set-mode', (el) => ({ readerMode: el.value }));
onSetting('set-autoshow', (el) => ({ autoShow: el.checked }));
onSetting('set-autonext', (el) => ({ prefs: { autoNext: el.checked } }));
onSetting('set-hideread', (el) => ({ prefs: { hideRead: el.checked } }));
onSetting('set-readerdark', (el) => ({ prefs: { readerDark: el.checked } }));
onSetting('set-tapzones', (el) => ({ prefs: { tapZones: el.value } }));
onSetting('set-interval', (el) => ({ checkIntervalMin: Number(el.value) }));
onSetting('set-whitelist', (el) => ({
  whitelist: el.value.split('\n').map((l) => l.trim()).filter(Boolean),
}));

/**
 * The language the reader chose, here, now.
 *
 * The same shape as the theme's handler below and for the same reasons: this
 * page first, because it is the one on screen and it can answer without a
 * network; the account second, because that is what carries the choice to the
 * next device; the extension last and only if there is one.
 *
 * It used to be none of that. The control sat under Reading, appeared only
 * with the extension installed, and its whole handler was one `setLanguage`
 * message — so choosing "Français" here switched the extension and left this
 * page in English, which is the disagreement this is fixing.
 */
$('set-lang').addEventListener('change', async () => {
  const lang = $('set-lang').value;
  // Redraws the annotated markup itself; the rest of the page is JS-built and
  // has to be asked. `false` means the sentences did not actually move — "same
  // as the browser" on a French browser is already French.
  if (PanelFlowI18n.set(lang)) redrawEverything();
  setStatus(t('statusSaved'));

  if (token) {
    try {
      await api('/prefs', { method: 'PUT', body: { prefs: { uiLang: lang } } });
    } catch {
      setStatus(t('webSavedHereOnly'));
    }
  }
  // Best effort, and deliberately last: there may be no extension, and this
  // page is not broken by one that does not answer.
  await ext('setLanguage', { lang });
});

/**
 * Everything on screen that i18n.apply() cannot reach.
 *
 * `apply()` fills annotated markup. The library, the shelf tabs, the stats and
 * the tracker rows are built in JS, so they carry sentences no attribute knows
 * about and have to be built again.
 */
function redrawEverything() {
  PanelFlowI18n.apply();
  buildSortOptions();
  renderContinue();
  renderTabs();
  renderLibrary();
  renderUpdates();
  if (activeView === 'stats') loadStats();
  if (activeView === 'history') loadHistory();
  if (activeView === 'trackers') loadTrackers();
}

/**
 * The account's theme and language, applied to a page already on screen.
 *
 * Not routed through the extension like everything else under Reading — this
 * page has its own token, and both have to work in a browser that has never
 * heard of the extension. Failure is silent on purpose: a page that is already
 * showing a perfectly good theme has nothing to report if asking about a better
 * one did not work.
 *
 * One request for both, because they are one row: `theme` and `uiLang` sit
 * beside each other in ACCOUNT_PREFS for the same reason they are adopted here
 * together — they are the two answers about how this reader wants to be read to.
 */
async function adoptAccountPrefs() {
  try {
    const { prefs } = await api('/prefs');
    if (window.panelflowTheme.adopt(prefs?.theme)) $('set-theme').value = prefs.theme;
    if (PanelFlowI18n.adopt(prefs?.uiLang)) {
      $('set-lang').value = PanelFlowI18n.get();
      redrawEverything();
    }
  } catch { /* the page keeps the theme and the language it was painted in */ }
}

// The theme is applied by shared/theme.js from <head>, before this file has run
// at all — so this browser is changed first and without waiting, and the
// account is told afterwards. Which is also what makes it work signed out: the
// PUT is the half that needs an account, and it is the second half.
$('set-theme').addEventListener('change', async () => {
  const theme = $('set-theme').value;
  window.panelflowTheme.set(theme);
  setStatus(t('statusSaved'));
  if (!token) return;
  try {
    await api('/prefs', { method: 'PUT', body: { prefs: { theme } } });
  } catch {
    setStatus(t('webSavedHereOnly'));
  }
});

$('set-signout').addEventListener('click', signOut);

// Changing a password takes a link in an inbox, not a form in a tab someone
// else may have left open. The route is the same one the signed-out screen
// uses, so there is one flow, one rate limit and one place to get it right.
$('set-password').addEventListener('click', async () => {
  const btn = $('set-password');
  const msg = $('set-account-msg');
  btn.disabled = true;
  try {
    const data = await api('/auth/forgot', { method: 'POST', body: { email: user.email } });
    msg.textContent = data.message ?? t('webLinkOnItsWay');
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    msg.hidden = false;
    btn.disabled = false;
  }
});

/* ---------- Statistics ---------- */

/** Seconds as something a person reads: "45s", "12 min", "3h 05". */
function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return t('durationSeconds', [String(s)]);
  const m = Math.round(s / 60);
  if (m < 60) return t('durationMinutes', [String(m)]);
  return t('durationHours', [String(Math.floor(m / 60)), String(m % 60).padStart(2, '0')]);
}

/** The reader's own calendar day, matching what the reader records against. */
function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const dayShift = (iso, n) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDay(d);
};

async function loadStats() {
  const cards = $('stat-cards');
  cards.textContent = t('webLoading');
  let stats;
  try {
    stats = await api('/history/stats');
  } catch (err) {
    cards.textContent = err.message;
    return;
  }
  renderStats(stats);
}

function renderStats(stats) {
  const cards = $('stat-cards');
  cards.innerHTML = '';
  const tiles = [
    [t('statChaptersRead'), String(stats.chapters)],
    [t('statTimeRead'), fmtDuration(stats.seconds)],
    [t('statSeriesRead'), String(stats.series)],
    [t('statCurrentStreak'), t('statDays', [String(stats.current)])],
    [t('statLongestStreak'), t('statDays', [String(stats.longest)])],
    // Per day read, not per day elapsed: dividing by the calendar would measure
    // how long the account has existed.
    [t('statPerReadingDay'), fmtDuration(stats.secondsPerDay)],
    [t('statInLibrary'), String(stats.entries)],
    [stats.scored ? t('statAverageOfN', [String(stats.scored)]) : t('statAverageScore'),
      stats.scored ? `${stats.avgScore.toFixed(1)} / 10` : '—'],
    [t('fieldRereads'), String(stats.rereads)],
    [t('statReadingSince'), stats.firstDay ?? '—'],
  ];
  for (const [label, value] of tiles) {
    const tile = document.createElement('div');
    tile.className = 'stat-card';
    const v = document.createElement('strong');
    v.textContent = value;
    const l = document.createElement('span');
    l.textContent = label;
    tile.append(v, l);
    cards.appendChild(tile);
  }

  // The chart is 30 calendar days, not the last 30 rows: a gap is the point of
  // looking at it, and skipping unread days would hide every one of them.
  const byDay = new Map(stats.days.map((d) => [d.day, d]));
  const chart = $('stat-chart');
  chart.innerHTML = '';
  const window30 = [];
  for (let i = 29; i >= 0; i--) window30.push(dayShift(localDay(), -i));
  const peak = Math.max(1, ...window30.map((d) => byDay.get(d)?.seconds ?? 0));
  for (const day of window30) {
    const d = byDay.get(day);
    const col = document.createElement('div');
    col.className = 'bar-col';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = Math.round(((d?.seconds ?? 0) / peak) * 100) + '%';
    if (!d) bar.classList.add('empty');
    col.title = d
      ? t('webChartDay', [day, String(d.chapters), fmtDuration(d.seconds)])
      : t('webChartNothing', [day]);
    col.appendChild(bar);
    chart.appendChild(col);
  }
  $('stat-empty').hidden = stats.chapters > 0;

  const top = $('stat-top');
  top.innerHTML = '';
  for (const s of stats.topSeries) {
    const li = document.createElement('li');
    li.appendChild(coverEl({ title: s.title, coverUrl: s.coverUrl }));
    const meta = document.createElement('div');
    const head = document.createElement('span');
    head.className = 'title';
    head.textContent = s.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = t('statChaptersAndTime', [String(s.chapters), fmtDuration(s.seconds)]);
    meta.append(head, sub);
    li.appendChild(meta);
    top.appendChild(li);
  }

  const folders = $('stat-folders');
  folders.innerHTML = '';
  const most = Math.max(1, ...Object.values(stats.folders));
  for (const s of STATUSES) {
    const n = stats.folders[s] ?? 0;
    const row = document.createElement('div');
    row.className = 'folder-row';
    const label = document.createElement('span');
    label.textContent = statusLabel(s);
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = Math.round((n / most) * 100) + '%';
    track.appendChild(fill);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(n);
    row.append(label, track, count);
    folders.appendChild(row);
  }
}

/* ---------- History ---------- */

async function loadHistory() {
  const list = $('history-list');
  list.textContent = t('webLoading');
  let rows;
  try {
    rows = await api('/history?limit=300');
  } catch (err) {
    list.textContent = err.message;
    return;
  }
  list.innerHTML = '';
  $('history-empty').hidden = rows.length > 0;

  let lastDay = null;
  for (const r of rows) {
    if (r.day !== lastDay) {
      lastDay = r.day;
      const h = document.createElement('h3');
      h.className = 'day-head';
      h.textContent = r.day === localDay() ? 'Today' : r.day;
      list.appendChild(h);
    }
    const row = document.createElement('a');
    row.className = 'history-row';
    row.href = r.chapterUrl;
    row.target = '_blank';
    row.rel = 'noopener';
    row.appendChild(coverEl({ title: r.title, coverUrl: r.coverUrl, sourceDomain: r.sourceDomain }));
    const meta = document.createElement('div');
    const head = document.createElement('span');
    head.className = 'title';
    // A series you removed is still a series you read — the totals count it, so
    // the list has to show it rather than quietly disagree with them.
    head.textContent = r.title + (r.removed ? ' (removed)' : '');
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = [
      r.chapterLabel || 'Chapter',
      r.pages ? `${r.pages} pages` : null,
      r.seconds ? fmtDuration(r.seconds) : null,
    ].filter(Boolean).join(' · ');
    meta.append(head, sub);
    row.appendChild(meta);
    list.appendChild(row);
  }
}

$('history-clear').addEventListener('click', () => {
  if (!confirm(t('webClearHistoryConfirm'))) return;
  // Worth saying out loud rather than swallowing: the user just confirmed a
  // deletion, and a list still on screen afterwards reads as "it did not take".
  guard(t('webClearHistoryFailed'), async () => {
    await api('/history', { method: 'DELETE' });
    await loadHistory();
  });
});

/* ---------- Trackers ---------- */

const TRACKER_NAMES = { anilist: 'AniList', mal: 'MyAnimeList', kitsu: 'Kitsu' };
const trackerName = (s) => TRACKER_NAMES[s] || s;

let trackers = { services: [], connected: [], links: [] };

function button(label, onClick, { className = '', title = '' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

const trackerStatus = (text) => { $('tracker-status').textContent = text; };

/**
 * "three days ago", from an ISO timestamp.
 *
 * A date is the wrong unit for the question these are answering — "is this
 * account still being listened to?" — because working out that 2026-08-09 was
 * last week is work the reader should not have to do.
 */
// One wording, one place: this used to be a second copy of ago() above with
// its own sentences, so the same distance in time was spelt two ways on two
// halves of the same page — and only one of them would have been translated.
const relativeTime = (iso) => ago(iso) ?? t('agoSomeTime');

async function loadTrackers() {
  trackerStatus('');
  try {
    // Three questions with one answer each: what this server can offer, what
    // the account has said yes to, and what has been matched so far.
    const [services, connected, links] = await Promise.all([
      api('/trackers/services'),
      api('/trackers'),
      api('/trackers/links'),
    ]);
    trackers = { services, connected, links };
  } catch (err) {
    trackerStatus(err.message);
    return;
  }
  renderTrackerAccounts();
  renderTrackerLinks();
}

function renderTrackerAccounts() {
  const box = $('tracker-accounts');
  box.innerHTML = '';
  for (const svc of trackers.services) {
    const live = trackers.connected.find((c) => c.service === svc.service);
    const card = document.createElement('div');
    card.className = 'tracker-card' + (live ? ' on' : '');

    const head = document.createElement('div');
    head.className = 'tracker-name';
    head.textContent = trackerName(svc.service);
    card.appendChild(head);

    const sub = document.createElement('p');
    sub.className = 'muted-note';
    if (live) {
      sub.textContent = live.remoteUser
        ? `Connected as ${live.remoteUser}`
        : 'Connected';
      // Connected and still unable to receive anything is worth saying out
      // loud, rather than leaving the user to wonder why nothing arrives.
      if (!live.canPush) sub.textContent += t('trackerNotListening');
      else if (live.lastPushAt) sub.textContent += t('trackerLastUpdate', [relativeTime(live.lastPushAt)]);
    } else if (svc.configured) {
      sub.textContent = t('trackerNotConnected');
    } else if (svc.oauth) {
      sub.textContent = t('trackerNoCredentials');
    } else {
      // Not a missing key: the service only offers a password login, which
      // PanelFlow will not ask for. No amount of configuring changes that.
      sub.textContent = t('trackerPasswordAuth');
    }
    card.appendChild(sub);

    // Progress is pushed while the reader is reading, and the answer goes into
    // a response nobody reads. An AniList token lasts a year and cannot be
    // refreshed, so this is how a connection ends: still listed, still saying
    // "Connected", quietly refusing everything. The server keeps the last
    // refusal precisely so this line can exist.
    if (live?.lastError) {
      card.classList.add('failing');
      const bad = document.createElement('p');
      bad.className = 'tracker-error';
      bad.textContent = t('trackerRefusing', [live.lastError])
        + (live.lastErrorAt ? ` (${relativeTime(live.lastErrorAt)})` : '')
        + t('webTrackerRefusingFix');
      card.appendChild(bad);
    }

    const actions = document.createElement('div');
    actions.className = 'tracker-actions';
    if (live) {
      if (svc.canPush) {
        actions.appendChild(button(t('trackerSendMyLibrary'), () => pushEverything(svc.service), {
          title: t('trackerSendMyLibraryHint'),
        }));
        actions.appendChild(button(t('trackerFetchAll'), () => pullEverything(svc.service), {
          title: t('trackerFetchAllHint'),
        }));
      }
      actions.appendChild(button(t('actionDisconnect'), () => disconnectTracker(svc.service)));
    } else if (svc.configured) {
      actions.appendChild(button(t('actionConnect'), () => connectTracker(svc.service), { className: 'primary' }));
    }
    card.appendChild(actions);
    box.appendChild(card);
  }
}

async function connectTracker(service) {
  trackerStatus('');
  try {
    const { authorizeUrl } = await api(`/trackers/${service}/connect`, { method: 'POST' });
    const win = window.open(authorizeUrl, 'panelflow-tracker', 'width=560,height=760');
    if (!win) throw new Error(t('webPopupBlocked'));
    trackerStatus(t('trackerWaitingFor', [trackerName(service)]));
    // The tracker answers on our own callback page, which closes itself. That
    // page is a different window with no channel back here, so the signal that
    // it finished is the window going away.
    await new Promise((done) => {
      let waited = 0;
      const timer = setInterval(() => {
        waited += 500;
        // A window left open for five minutes is a user who wandered off, not
        // a flow still running: stop watching and let the list speak instead.
        if (win.closed || waited > 300000) { clearInterval(timer); done(); }
      }, 500);
    });
    trackerStatus('');
    await loadTrackers();
  } catch (err) {
    trackerStatus(err.message);
  }
}

async function disconnectTracker(service) {
  if (!confirm(t('trackerDisconnectConfirm', [trackerName(service)]))) return;
  try {
    await api(`/trackers/${service}`, { method: 'DELETE' });
    await loadTrackers();
  } catch (err) {
    trackerStatus(err.message);
  }
}

async function pushEverything(service) {
  trackerStatus(t('trackerSending', [trackerName(service)]));
  try {
    const r = await api(`/trackers/${service}/push`, { method: 'POST' });
    const parts = [`${r.pushed} sent`];
    if (r.skipped) parts.push(`${r.skipped} skipped`);
    if (r.failed) parts.push(`${r.failed} failed`);
    // The backend stops on a deadline rather than being killed mid-way, so
    // there can be a remainder — and the way to finish it is to ask again.
    if (r.remaining) parts.push(t('trackerRemaining', [String(r.remaining)]));
    trackerStatus(parts.join(' · '));
    await loadTrackers();
  } catch (err) {
    trackerStatus(err.message);
  }
}

/**
 * The other direction, and the only one that can undo real damage.
 *
 * Someone with 120 chapters on AniList who opens chapter 5 here would have
 * their 120 replaced by a 5 on the first page turn if PanelFlow did not know
 * about it. Every link learns the tracker's own count, which is what the
 * forward-only rule needs in order to protect anything.
 *
 * No bookmark moves: a tracker counts chapters and a bookmark is a page on a
 * scan site, so where the tracker is further along the answer is a sentence,
 * not a change.
 */
async function pullEverything(service) {
  trackerStatus(t('trackerFetching', [trackerName(service)]));
  try {
    const r = await api(`/trackers/${service}/pull`, { method: 'POST' });
    const parts = [t('trackerFetched', [String(r.updated)])];
    if (r.ahead?.length) {
      parts.push(`${r.ahead.length} further along there than here`
        + ` (${r.ahead.slice(0, 3).map((a) => `${a.title} ch. ${a.there}`).join(', ')}`
        + `${r.ahead.length > 3 ? '…' : ''})`);
    }
    trackerStatus(parts.join(' · '));
    await loadTrackers();
  } catch (err) {
    trackerStatus(err.message);
  }
}

function renderTrackerLinks() {
  const box = $('tracker-links');
  box.innerHTML = '';
  const links = [...trackers.links].sort((a, b) => {
    // The ones needing a hand first: an unmatched series is the only row here
    // the user can do anything useful about.
    const rank = (l) => (l.state === 'unmatched' ? 0 : l.state === 'muted' ? 2 : 1);
    return rank(a) - rank(b) || String(a.title).localeCompare(String(b.title));
  });
  $('tracker-links-empty').hidden = links.length > 0;

  for (const link of links) {
    const row = document.createElement('div');
    row.className = 'tracker-link ' + link.state;

    const meta = document.createElement('div');
    const head = document.createElement('span');
    head.className = 'title';
    head.textContent = link.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = {
      linked: `${trackerName(link.service)} · ${link.remoteTitle || link.remoteId}`
        + (link.lastChapter ? t('trackerUpToChapter', [String(link.lastChapter)]) : ''),
      unmatched: t('trackerNoMatch', [trackerName(link.service)]),
      muted: `${trackerName(link.service)} · never sent`,
    }[link.state] || `${trackerName(link.service)} · ${link.state}`;
    meta.append(head, sub);
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'tracker-actions';
    actions.appendChild(button(link.state === 'linked' ? 'Change' : 'Find it', () => openLinkDialog(link)));
    // Forgetting the row is the way back from a wrong answer: the next chapter
    // resolves the title again from scratch.
    actions.appendChild(button('Forget', () => forgetLink(link), {
      title: t('trackerRematchHint'),
    }));
    row.appendChild(actions);
    box.appendChild(row);
  }
}

async function forgetLink(link) {
  try {
    await api(`/trackers/${link.service}/link/${link.libraryId}`, { method: 'DELETE' });
    await loadTrackers();
  } catch (err) {
    trackerStatus(err.message);
  }
}

/* ---------- Linking one series by hand ---------- */

let linking = null;

function openLinkDialog(link) {
  linking = link;
  $('l-sub').textContent = `${link.title} — on ${trackerName(link.service)}`;
  $('l-query').value = link.title;
  $('l-results').innerHTML = '';
  $('l-error').hidden = true;
  $('l-status').hidden = true;
  $('link-dialog').showModal();
  runLinkSearch();
}

$('l-cancel').addEventListener('click', () => $('link-dialog').close());
$('link-form').addEventListener('submit', (e) => { e.preventDefault(); runLinkSearch(); });

async function runLinkSearch() {
  const q = $('l-query').value.trim();
  const status = $('l-status');
  const results = $('l-results');
  $('l-error').hidden = true;
  results.innerHTML = '';
  if (q.length < 2) return;
  status.hidden = false;
  status.textContent = t('statusSearching');
  try {
    const hits = await api(`/trackers/${linking.service}/search?q=${encodeURIComponent(q)}`);
    status.hidden = true;
    if (!hits.length) {
      status.hidden = false;
      status.textContent = t('trackerNoResults');
      return;
    }
    for (const hit of hits) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-hit';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = hit.title;
      const alt = document.createElement('span');
      alt.className = 'sub';
      // The alternative titles are what makes two near-identical entries
      // tellable apart — a spin-off and its parent often share a romaji title.
      alt.textContent = (hit.altTitles || []).slice(0, 3).join(' · ');
      b.append(title, alt);
      b.addEventListener('click', () => chooseLink(hit));
      results.appendChild(b);
    }
  } catch (err) {
    status.hidden = true;
    $('l-error').textContent = err.message;
    $('l-error').hidden = false;
  }
}

async function chooseLink(hit) {
  try {
    await api(`/trackers/${linking.service}/link/${linking.libraryId}`, {
      method: 'PUT',
      body: { remoteId: hit.id, remoteTitle: hit.title, state: 'linked' },
    });
    $('link-dialog').close();
    await loadTrackers();
  } catch (err) {
    $('l-error').textContent = err.message;
    $('l-error').hidden = false;
  }
}

// Muting is per series and does not touch the connection: the way to keep one
// title off a tracker without giving up the others.
$('l-mute').addEventListener('click', async () => {
  try {
    await api(`/trackers/${linking.service}/link/${linking.libraryId}`, {
      method: 'PUT',
      body: { state: 'muted' },
    });
    $('link-dialog').close();
    await loadTrackers();
  } catch (err) {
    $('l-error').textContent = err.message;
    $('l-error').hidden = false;
  }
});

/* ---------- Import ---------- */

// Which connected account to read, when that is what was chosen. Null means
// the username or the file below decides, as it always did.
let importAccount = null;

$('import-open').addEventListener('click', () => {
  $('import-form').reset();
  $('i-status').hidden = true;
  $('i-error').hidden = true;
  $('i-report').hidden = true;
  $('i-run').hidden = true;
  importAccount = null;
  $('import-dialog').showModal();
  renderImportAccounts();
});
$('i-cancel').addEventListener('click', () => $('import-dialog').close());

// Typing a name or picking a file is a change of mind about where the list
// comes from, so the account stops being the answer.
for (const id of ['i-anilist', 'i-mal']) {
  $(id).addEventListener('input', () => { importAccount = null; renderImportAccounts(); });
}

// Kitsu is connectable by nobody and readable by nobody; the rest is whatever
// the account has actually said yes to.
const IMPORTABLE = ['anilist', 'mal'];

async function renderImportAccounts() {
  const box = $('i-account-list');
  const wrap = $('i-accounts');
  let connected;
  try {
    connected = await api('/trackers');
  } catch {
    // The dialog still works without this: it is the shortcut, not the road.
    wrap.hidden = true;
    return;
  }
  const usable = connected.filter((c) => IMPORTABLE.includes(c.service));
  wrap.hidden = usable.length === 0;
  box.innerHTML = '';
  for (const c of usable) {
    const label = c.remoteUser
      ? `${trackerName(c.service)} · ${c.remoteUser}`
      : trackerName(c.service);
    const b = button(label, () => {
      importAccount = c.service;
      $('i-anilist').value = '';
      $('i-mal').value = '';
      renderImportAccounts();
      $('import-form').requestSubmit();
    }, { className: importAccount === c.service ? 'primary' : '' });
    box.appendChild(b);
  }
}

// MyAnimeList hands you a gzipped XML and nothing unzips it for you.
async function readExport(file) {
  if (!/\.gz$/i.test(file.name)) return file.text();
  if (typeof DecompressionStream !== 'function') {
    throw new Error(t('webNoGunzip'));
  }
  return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

async function runImport(dryRun) {
  const username = $('i-anilist').value.trim();
  const file = $('i-mal').files[0];
  const q = dryRun ? '?dryRun=1' : '';
  // The connected account first: it was chosen by a click, and the two fields
  // below were cleared by that same click.
  if (importAccount) return api(`/import/${importAccount}/account${q}`, { method: 'POST' });
  if (!username && !file) throw new Error(t('webImportNeedsSource'));
  if (file) {
    return apiPostRaw('/import/mal' + q, await readExport(file), 'text/xml');
  }
  return api('/import/anilist' + q, { method: 'POST', body: { username } });
}

function renderReport(report) {
  const box = $('i-report');
  box.innerHTML = '';
  box.hidden = false;
  const line = (text) => {
    const p = document.createElement('p');
    p.textContent = text;
    box.appendChild(p);
  };
  line(t('webEntriesInList', [String(report.total)]));
  line(t('webPlanCounts', [String(report.added), String(report.updated), String(report.unchanged)]));
  if (report.progress) line(t('webPlanBookmarks', [String(report.progress)]));
  for (const [what, titles] of [[t('badgeNew'), report.samples.added],
    [t('webFilledIn'), report.samples.updated]]) {
    if (titles.length) line(`${what}: ${titles.join(', ')}${titles.length === 10 ? '…' : ''}`);
  }
}

$('import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('i-status');
  $('i-error').hidden = true;
  status.hidden = false;
  status.textContent = t('webReadingList');
  try {
    // Always previewed first: an import touches the whole library at once, and
    // a run nobody looked at is not something you can undo entry by entry.
    renderReport(await runImport(true));
    status.textContent = t('webNothingWritten');
    $('i-run').hidden = false;
  } catch (err) {
    status.hidden = true;
    $('i-error').textContent = err.message;
    $('i-error').hidden = false;
  }
});

$('i-run').addEventListener('click', async () => {
  const status = $('i-status');
  $('i-run').disabled = true;
  status.hidden = false;
  status.textContent = t('webImporting');
  try {
    const report = await runImport(false);
    renderReport(report);
    status.textContent = t('webImportDone', [String(report.added), String(report.updated)]);
    $('i-run').hidden = true;
    await refresh();
  } catch (err) {
    $('i-error').textContent = err.message;
    $('i-error').hidden = false;
    status.hidden = true;
  } finally {
    $('i-run').disabled = false;
  }
});

/* ---------- Export ---------- */

$('export-open').addEventListener('click', () => {
  $('export-form').reset();
  for (const id of ['x-status', 'x-error', 'x-report', 'x-run']) $(id).hidden = true;
  $('export-dialog').showModal();
});
$('x-cancel').addEventListener('click', () => $('export-dialog').close());

// An <a download> cannot carry an Authorization header, so the file is fetched
// like any other request and handed to the browser as a blob. The name comes
// from the server's Content-Disposition — it is the server that knows what it
// just wrote.
async function download(path) {
  const res = await fetch(API + '/api' + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  if (!res.ok) throw new Error(t('webExportFailed', [String(res.status)]));
  const named = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = named ? named[1] : 'panelflow-export';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Not immediately: revoking before the browser has started the download
  // cancels it in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

for (const [id, path] of [['x-json', '/export'], ['x-mal', '/export/mal'], ['x-csv', '/export/csv']]) {
  $(id).addEventListener('click', async () => {
    $('x-error').hidden = true;
    try {
      await download(path);
    } catch (err) {
      $('x-error').textContent = err.message;
      $('x-error').hidden = false;
    }
  });
}

async function runRestore(dryRun) {
  const file = $('x-file').files[0];
  if (!file) throw new Error('pick a PanelFlow backup first');
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error(t('webNotJson')); }
  // Sent raw rather than through api(): the restore route is mounted ahead of
  // the shared 1 MB parser precisely because a backup does not fit in it.
  return apiPostRaw('/import/panelflow' + (dryRun ? '?dryRun=1' : ''),
    JSON.stringify(data), 'application/json');
}

function renderRestore(report) {
  const box = $('x-report');
  box.innerHTML = '';
  box.hidden = false;
  const line = (text) => {
    const p = document.createElement('p');
    p.textContent = text;
    box.appendChild(p);
  };
  line(`${report.total} series in the backup`);
  line(t('webPlanCounts', [String(report.added), String(report.updated), String(report.unchanged)]));
  line(t('webPlanHistory', [String(report.bookmarks), String(report.reads)]));
}

$('export-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('x-error').hidden = true;
  $('x-status').hidden = false;
  $('x-status').textContent = t('webReadingBackup');
  try {
    renderRestore(await runRestore(true));
    $('x-status').textContent = t('webNothingWritten');
    $('x-run').hidden = false;
  } catch (err) {
    $('x-status').hidden = true;
    $('x-error').textContent = err.message;
    $('x-error').hidden = false;
  }
});

$('x-run').addEventListener('click', async () => {
  $('x-run').disabled = true;
  $('x-status').hidden = false;
  $('x-status').textContent = t('webRestoring');
  try {
    const report = await runRestore(false);
    renderRestore(report);
    $('x-status').textContent = t('webImportDone', [String(report.added), String(report.updated)]);
    $('x-run').hidden = true;
    await refresh();
  } catch (err) {
    $('x-error').textContent = err.message;
    $('x-error').hidden = false;
    $('x-status').hidden = true;
  } finally {
    $('x-run').disabled = false;
  }
});

/* ---------- Bulk migration ---------- */

// The "from" list, counted off the library as it stands right now.
//
// It is rebuilt rather than built once because a migration changes the very
// numbers it shows: move forty series off a site and the menu went on offering
// that site with forty beside it, and the dialog stays open afterwards to show
// what happened. Reading the counts again is the only thing that can be true
// after a move — including a site that has just emptied and should now be gone
// from the list altogether.
//
// The chosen site is kept across the rebuild when it still has series on it.
// When it does not, the selection falls back to "Every site" rather than to a
// blank menu: an option element assigned a value no option carries leaves a
// <select> showing nothing at all.
function fillMigrateSources() {
  const from = $('m-from');
  const keep = from.value;
  from.innerHTML = '';
  const counts = new Map();
  for (const e of library) counts.set(e.sourceDomain, (counts.get(e.sourceDomain) ?? 0) + 1);
  const any = document.createElement('option');
  any.value = '';
  any.textContent = t('webEverySite', [String(library.length)]);
  from.appendChild(any);
  for (const [domain, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const opt = document.createElement('option');
    opt.value = domain;
    opt.textContent = `${domain} (${n})`;
    from.appendChild(opt);
  }
  from.value = counts.has(keep) ? keep : '';
}

$('migrate-open').addEventListener('click', () => {
  $('migrate-form').reset();
  fillMigrateSources();
  $('m-status').hidden = true;
  $('m-error').hidden = true;
  $('m-plan').hidden = true;
  $('m-run').hidden = true;
  $('migrate-dialog').showModal();
});
$('m-cancel').addEventListener('click', () => $('migrate-dialog').close());

$('migrate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('m-status');
  const btn = $('m-search');
  $('m-error').hidden = true;
  $('m-plan').hidden = true;
  $('m-run').hidden = true;
  status.hidden = false;
  status.textContent = t('webMigrateSearching');
  btn.disabled = true;
  try {
    const plan = await api('/library/migrate-plan', {
      method: 'POST',
      body: { fromDomain: $('m-from').value || undefined, toDomain: $('m-to').value.trim() },
    });
    renderPlan(plan);
  } catch (err) {
    status.hidden = true;
    $('m-error').textContent = err.message;
    $('m-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

function renderPlan(plan) {
  const box = $('m-plan');
  box.innerHTML = '';
  box.hidden = false;
  const found = plan.candidates.filter((c) => c.to);
  $('m-status').textContent = [
    t('webMigrateFound', [String(found.length), String(plan.candidates.length), plan.toDomain]),
    plan.truncated ? t('webMigrateTruncated') : null,
    plan.skipped ? t('webMigrateSkipped', [String(plan.skipped)]) : null,
  ].filter(Boolean).join(' · ');

  for (const c of plan.candidates) {
    const row = document.createElement('label');
    row.className = 'plan-row' + (c.to ? '' : ' missing');
    const box2 = document.createElement('input');
    box2.type = 'checkbox';
    box2.checked = !!c.to;
    box2.disabled = !c.to;
    box2.dataset.id = c.id;
    if (c.to) {
      box2.dataset.sourceUrl = c.to.sourceUrl;
      box2.dataset.sourceDomain = c.to.sourceDomain;
    }
    const meta = document.createElement('div');
    const head = document.createElement('span');
    head.className = 'title';
    head.textContent = c.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    // The found title, not just the URL: the search matched by name and this is
    // where a wrong match shows itself before it is applied.
    sub.textContent = c.to ? `${c.to.foundTitle || c.to.sourceUrl}` : 'not found there';
    meta.append(head, sub);
    row.append(box2, meta);
    box.appendChild(row);
  }
  $('m-run').hidden = found.length === 0;
}

$('m-run').addEventListener('click', async () => {
  const picked = [...$('m-plan').querySelectorAll('input:checked')].map((b) => ({
    id: b.dataset.id,
    sourceUrl: b.dataset.sourceUrl,
    sourceDomain: b.dataset.sourceDomain,
  }));
  if (!picked.length) return;
  const btn = $('m-run');
  btn.disabled = true;
  $('m-status').textContent = t('webMoving', [String(picked.length)]);
  try {
    const r = await api('/library/migrate-bulk', { method: 'POST', body: { items: picked } });
    const failed = r.results.filter((x) => !x.ok);
    $('m-status').textContent = t('webMoved', [String(r.moved)]) +
      (failed.length ? t('webMoveRefused', [String(failed.length),
        failed.map((f) => f.title ?? f.id).join(', ')]) : '');
    $('m-plan').hidden = true;
    btn.hidden = true;
    await refresh();
    // The library the counts were read off has just changed underneath them,
    // and this dialog is still open showing the old ones.
    fillMigrateSources();
  } catch (err) {
    $('m-error').textContent = err.message;
    $('m-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Notifications while the app is closed ---------- */

// The server-side watcher has always found chapters overnight, and they have
// always waited in /api/news for a client to open and drain them — which is a
// notification about Friday's chapter, on Monday. A push subscription is the
// missing half: the server hands the payload to the browser vendor, and sw.js
// is woken with no page open at all.
//
// Everything here is best-effort and silent on failure. Push needs a secure
// context, a service worker, a browser that has the API, a server with VAPID
// keys, and a permission the reader may simply refuse — and none of those five
// missing is an error worth interrupting anyone about. The button is only shown
// once all of them but the last are known to be there.

/** base64url → the Uint8Array `applicationServerKey` insists on. */
function decodeKey(b64) {
  const pad = b64.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

let pushReg = null;

async function setupPush() {
  const btn = $('push-toggle');
  btn.hidden = true;
  $('push-test').hidden = true;
  if (!window.isSecureContext || !('serviceWorker' in navigator)
      || !('PushManager' in window) || !('Notification' in window)) return;

  // Null on a deployment with no VAPID keys, and that is a plain answer rather
  // than a failure — see the route. The catch is still here for the real thing:
  // a backend that is down, or a URL pointing at nothing.
  let key;
  try {
    key = (await api('/push/key')).key;
  } catch { return; }
  if (!key) return;

  try {
    pushReg = await navigator.serviceWorker.register('sw.js');
  } catch { return; }

  btn.hidden = false;
  const sub = await pushReg.pushManager.getSubscription();
  // Re-registering an existing subscription on every visit is the point: it is
  // how a subscription made under one account follows the account actually
  // signed in now, and how one that the server has since dropped comes back.
  if (sub) await api('/push/subscribe', { method: 'POST', body: sub.toJSON() }).catch(() => {});
  paintPush(!!sub, key);
}

function paintPush(on, key) {
  const btn = $('push-toggle');
  const denied = Notification.permission === 'denied';
  btn.innerHTML = icon(on ? 'bell' : 'bell-off');
  btn.disabled = denied && !on;
  btn.title = denied && !on
    ? t('webPushBlocked')
    : t(on ? 'webPushOnHint' : 'webPushOffHint');
  btn.onclick = () => togglePush(on, key);

  // Only while alerts are on: with them off the route answers 409, which is a
  // worse way of saying what the crossed-out bell next to it already says.
  const test = $('push-test');
  test.hidden = !on;
  test.disabled = false;
  test.onclick = testPush;
}

/**
 * What came back from `/push/test`, in a sentence.
 *
 * The last line is the whole reason the route exists: a push service accepting
 * the body is not the same as the browser showing it. A wrong key derivation
 * fails at that last step and reports nothing, anywhere.
 */
function describeTest(r) {
  // One key per count rather than a word plus an "s": every language that is
  // not English pluralises the whole sentence, not the noun at the end of it.
  const one = (c, key) => t(c === 1 ? key + 'One' : key + 'N', [String(c)]);
  const parts = [];
  if (r.sent) parts.push(one(r.sent, 'webPushTook'));
  if (r.dropped) parts.push(one(r.dropped, 'webPushExpired'));
  if (r.failed) parts.push(one(r.failed, 'webPushUnreachable'));
  const head = parts.join(', ');
  return r.sent ? head + t('webPushKeysHint') : head;
}

async function testPush() {
  const btn = $('push-test');
  const status = $('check-status');
  btn.disabled = true;
  status.textContent = t('webSendingTest');
  try {
    const r = await api('/push/test', { method: 'POST' });
    // A dropped subscription may well be this browser's own, and the server has
    // just deleted the row: the ringing bell would keep claiming alerts are on
    // with nothing left to send them to. setupPush re-subscribes if the browser
    // still has one and crosses the bell out if it does not.
    if (r.dropped) await setupPush();
    status.textContent = describeTest(r);
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function togglePush(on, key) {
  const btn = $('push-toggle');
  btn.disabled = true;
  try {
    const existing = await pushReg.pushManager.getSubscription();
    if (on) {
      // Both halves, in this order: the server stops sending first, so a race
      // cannot leave it pushing at an endpoint the browser has just discarded.
      if (existing) await api('/push/unsubscribe', { method: 'POST', body: { endpoint: existing.endpoint } });
      await existing?.unsubscribe();
      paintPush(false, key);
      return;
    }
    if (await Notification.requestPermission() !== 'granted') { paintPush(false, key); return; }
    // userVisibleOnly is not optional in Chrome: a subscription that promises
    // not to show anything is refused outright.
    const sub = existing ?? await pushReg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: decodeKey(key),
    });
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
    paintPush(true, key);
  } catch (err) {
    $('check-status').textContent = err.message;
    paintPush(false, key);
  } finally {
    btn.disabled = false;
  }
}

/** Best-effort, on the way out: a signed-out browser must stop being told. */
async function dropPush() {
  try {
    const sub = await pushReg?.pushManager.getSubscription();
    if (!sub) return;
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
  } catch { /* signing out is not allowed to fail on this */ }
}

/* ---------- Boot ---------- */

(async function boot() {
  // Before the token is consulted at all: someone who followed a reset link is
  // usually already signed in *somewhere*, and dropping them onto their shelf
  // because of it would leave them with no way to reach the form the link was
  // for. The link is why they are here.
  if (readResetHash()) return showAuth('reset');
  // The extension has no reset screen of its own — its "forgot password" link
  // lands here, and landing on the sign-in form would be landing one click short
  // of the point. The fragment goes once it has been read, so Back and reload
  // behave like the rest of the app.
  if (location.hash === '#forgot') {
    history.replaceState(null, '', location.pathname + location.search);
    return showAuth('forgot');
  }
  if (!token) { askAboutReset(); return showAuth(); }
  try {
    user = await api('/me');
  } catch {
    // The token is what failed here, so the sign-in screen is the right answer.
    return signOut();
  }
  // Past this point the account is good, and a shelf that will not load is a
  // network problem. Signing the user out over it — which is what an
  // un-awaited enterApp() amounted to once the rejection went unhandled —
  // threw away a valid session and left a blank page behind either way.
  await guard(t('webLoadFailed'), enterApp);
})();
