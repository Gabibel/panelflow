// PanelFlow popup — the library, the current page, and everything reachable
// from the toolbar icon.
//
// It owns no data. Every question and every write goes to the service worker
// as one `{ type, ... }` message through `send` (extension/send.js), and the
// worker answers out of `shared/panelflow-core.js` — the same core the phones
// run. So this file is screen only: what to draw, in which order, and what to
// say when the answer does not come back.
//
// Two consequences worth knowing before editing it. A popup is *destroyed*
// every time it closes, so nothing here may be the only copy of anything —
// what has to survive is written through the worker or into
// `chrome.storage.local`. And an MV3 worker can be asleep when the popup opens:
// `send` retries the one failure that is safe to retry, and a reply of
// `undefined` means the worker never woke, not that the answer was empty.
//
// Long and sectioned, one banner per panel. To see them all:
//
//     grep -n '^// ---' extension/popup/popup.js
'use strict';

const { send } = PanelFlowSend;
const $ = (sel) => document.querySelector(sel);

// The markup ships with empty nodes and every label in this file is written by
// t() — so nothing may be drawn before the language is settled, and settling it
// means a storage read when the reader has chosen a language that is not the
// browser's. Both the static markup and the first render therefore happen in
// the boot block at the foot of this file; a panel that painted before it would
// flash blank labels, or the wrong language, and then fix itself.

// Folders come from shared/folders.js, the one file that names them.
const { BUILTIN_IDS, DEFAULT_FOLDER, folderLabel, folderTabs, folderFor } = PanelFlowFolders;

// Where an entry is filed. A shelf this device has not heard of yet — made on
// the phone a minute ago, and the category cache is one sync behind — folds to
// the default rather than leaving the badge blank and the menu on the wrong row.
const folderOf = (entry) => {
  const f = String(entry.folder || DEFAULT_FOLDER);
  if (BUILTIN_IDS.includes(f)) return f;
  return state.categories.some((c) => folderFor(c) === f) ? f : DEFAULT_FOLDER;
};

// shared/folders.js and shared/library-view.js are copied verbatim into the web
// app and the phone, neither of which has chrome.i18n — so they keep naming
// things in English and the translation happens here, at the one place the name
// is about to be drawn.
//
// Only the five built-in folders are translated. A shelf the user made is
// called what they called it, in the language they typed it in; renaming
// someone's "Weekly" because the browser is in French would be a bug.
const folderName = (folder) =>
  (BUILTIN_IDS.includes(folder) ? t('folder_' + folder) : folderLabel(folder, state.categories));

const sortName = (spec) => t('sort_' + spec.id);

// How to say a count about one series: "Ep." and "episodes" for an anime,
// through the pairs shared/library-view.js keeps, so the popup, the web app
// and the phone agree on every line that names one.
const tu = (key, entry, subs) => t(PanelFlowView.unitKey(key, entry), subs);
const mediumName = (id) => t('medium_' + id) || id;

// What the colour of a tile's chapter line means, for the hover behind it.
const STAND_LABELS = {
  [PanelFlowView.UNREAD]: t('standUnread'),
  [PanelFlowView.READING]: t('standReading'),
  [PanelFlowView.READ]: t('standRead'),
};

const state = {
  library: [],
  progress: {},
  categories: [],  // the account's own shelves, cached by the core; [] signed out
  targets: {},   // entry id -> where its cover leads, worked out by the core
  tab: null,
  host: null,
  detected: false,
  // Whether PanelFlow runs on this page at all. Adding needs only that: the
  // form it opens is filled from the page and can be corrected, so a series
  // page, or a chapter the detector did not recognise, can still be added.
  scripted: false,
  readerOpen: false,
  // Which of PAGE_STATE explains the page actions being off. 'ok' when they are
  // not off at all.
  pageState: 'ok',
  // How this device last chose to look at the shelf: `{sort, dir, tag,
  // unreadOnly}`. Stored locally, like the auto-show settings above it — a sort
  // order belongs to the screen, not to the account.
  view: { sort: PanelFlowView.DEFAULT_SORT, dir: null, tag: null, unreadOnly: false, medium: 'all' },
};

// --- boot -------------------------------------------------------------------

async function load() {
  const [libResp, progResp, targetResp, acct, catResp, stored] = await Promise.all([
    send({ type: 'getLibrary' }),
    send({ type: 'getProgressAll' }),
    send({ type: 'continueTargets' }),
    send({ type: 'getAccount' }),
    send({ type: 'getCategories' }),
    chrome.storage.local.get('libraryView'),
  ]);
  state.library = libResp.library || [];
  state.progress = progResp.progress || {};
  state.targets = targetResp?.targets || {};
  state.categories = catResp?.categories || [];
  Object.assign(state.view, stored.libraryView || {});
  if (!PanelFlowView.SORT_IDS.includes(state.view.sort)) {
    state.view.sort = PanelFlowView.DEFAULT_SORT;
  }

  // Hotlink-protected covers: have the background install per-domain Referer
  // rules before the <img> requests fire, or the CDN 403s them.
  const pairs = state.library
    .filter((e) => e.coverUrl)
    .map((e) => ({ imgUrl: e.coverUrl, siteUrl: e.sourceUrl }));
  if (pairs.length) await send({ type: 'coverRules', pairs });

  // Signed out, "local only" is a dead end: make it the way in, since nothing
  // syncs to the web app until an account exists.
  const account = $('#account');
  // Kept aside as well: the sites panel needs to know whether there is an
  // account to hang a favourite on, and it is drawn long after this runs.
  accountEmail = acct.authUser ? acct.authUser.email : null;
  account.textContent = acct.authUser ? acct.authUser.email : t('popupLocalOnly');
  account.classList.toggle('actionable', !acct.authUser);
  account.onclick = acct.authUser ? null : () => chrome.runtime.openOptionsPage();
  // The same fact, said once more where it cannot be missed. The line in the
  // header is four words in a corner, and someone who closed the setup tab
  // before it asked has no reason to read it. This is not dismissible: it is
  // showing an unfinished setup, not an explanation, and it goes away by being
  // acted on.
  $('#no-account').hidden = !!acct.authUser;
  // And why, when it was the server that ended the session: the banner used
  // to say "no account" to someone whose account had just been closed or
  // whose password had just been changed (QA re-test, September 2026).
  const ended = !acct.authUser && acct.sessionEnded;
  const deleted = ended && acct.sessionEnded.reason === 'deleted';
  const why = !ended ? '' : deleted ? t('sessionDeleted') : t('sessionExpired');
  $('#no-account-why').hidden = !why;
  $('#no-account-why').textContent = why;
  renderLibrary();
  renderRecent();
}

// Why "Add to library" and the reader button are off, when they are. Greying
// them out says the popup cannot act on this page; it does not say whether the
// page holds no chapter or whether PanelFlow was never there to look — and only
// the second one is the user's to fix. A tab that was already open when the
// extension was installed, reloaded or updated has no content script in it, so
// `readerState` goes unanswered and every page action looks permanently dead on
// a site that in fact works. Reloading the tab is the whole cure, and nothing
// said so.
//
// The four cases are told apart by what the tab is, what came back, and whether
// PanelFlow is allowed on the site at all: an answer with `detected:false`
// means the page really holds no chapter, a browser page was never in scope,
// and silence means no content script — either because the tab predates it and
// wants a reload, or because this site was never granted.
//
// That last one is new with the manifest's site list. PanelFlow no longer asks
// to read every site on the web when it is installed, so on a site nobody has
// added it is genuinely not there, and saying "reload" would be a remedy that
// changes nothing. It is also the only case here where the popup asks Chrome
// for something rather than explaining itself.
const PAGE_STATE = {
  ok: null,
  noTab: { text: t('pageStateNoTab') },
  scheme: { text: t('pageStateScheme') },
  unreachable: { text: t('pageStateUnreachable'), act: 'reload' },
  undetected: { text: t('pageStateUndetected'), act: 'sites' },
  ungranted: { text: t('pageStateUngranted'), act: 'grant' },
  // PanelFlow's own site: the library is right here, and there is nothing to
  // turn on. It offered to, and a yes put the reader into the web app (QA
  // re-test It.5, N24).
  own: { text: t('pageStateOwnSite') },
};

// Anything else — chrome://, the Web Store, the PDF viewer, a file:// path —
// refuses content scripts outright, so messaging it would reject for a reason
// the user can do nothing about.
const CONTENT_SCRIPT_SCHEME = /^https?:/i;

/**
 * Which PAGE_STATE a tab is in, given what `readerState` came back with and
 * whether this origin is one the extension may run on.
 */
function pageStateFor(tab, resp, granted, own = false) {
  if (!tab?.id) return 'noTab';
  if (!CONTENT_SCRIPT_SCHEME.test(tab.url || '')) return 'scheme';
  if (resp) return resp.detected ? 'ok' : 'undetected';
  if (own) return 'own';
  return granted ? 'unreachable' : 'ungranted';
}

function renderPageState() {
  const el = $('#page-state');
  const info = PAGE_STATE[state.pageState];
  el.hidden = !info;
  el.onclick = null;
  if (!info) return;
  el.textContent = info.text;
  // A row that cannot lead anywhere must not look like a button.
  el.disabled = !info.act;
  if (info.act === 'reload') {
    el.onclick = () => {
      chrome.tabs.reload(state.tab.id);
      window.close(); // the popup outlives nothing here; the reload is the answer
    };
  } else if (info.act === 'sites') {
    el.onclick = () => $('#open-sites').click();
  } else if (info.act === 'grant') {
    el.onclick = async () => {
      // Chrome only accepts this from a real click, which is why it is here and
      // not something the worker could have done quietly on its own. The page,
      // and in the same question the video players it frames: an episode's
      // player is nearly always another site, and the speed control, the
      // bookmark and "watched" all live in the player (QA re-test It.4, N-B4).
      const players = await playerOrigins(state.tab.id);
      const ok = await chrome.permissions
        .request({ origins: [`${state.origin}/*`, ...players] }).catch(() => false);
      if (!ok) return;
      // Granting does not inject. The worker registers the manifest's scripts
      // for the new origin and puts them into this tab as it stands, so the site
      // the reader is looking at starts working now rather than after a reload
      // nobody told them to do.
      await send({ type: 'syncSites', tabId: state.tab.id });
      window.close();
    };
  }
}

/**
 * The origins of the video players this page frames, among the ones the rules
 * know as players (`videoDomains`) — never the page's other frames, which are
 * ads as often as not and no business of this prompt. Read from the page with
 * `activeTab`, which the click that opened this popup grants; nothing when
 * that is not possible, and then the page alone is asked for.
 */
async function playerOrigins(tabId) {
  try {
    const [found] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => [...document.querySelectorAll('iframe[src]')].map((f) => f.src),
    });
    const rules = (await send({ type: 'getRules' }))?.rules;
    const hosts = Object.keys(rules?.videoDomains || {})
      .filter((k) => !k.startsWith('_')).map((k) => k.replace(/^\*\./, ''));
    const out = new Set();
    for (const src of found?.result || []) {
      let u;
      try { u = new URL(src); } catch { continue; }
      if (!/^https?:$/.test(u.protocol) || u.origin === state.origin) continue;
      if (hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) out.add(`${u.origin}/*`);
    }
    return [...out];
  } catch {
    return [];
  }
}

// The active tab drives three things: the "Add to library" / reader buttons,
// and whether the per-site settings group is shown at all.
async function loadPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;
  try {
    const url = tab?.url ? new URL(tab.url) : null;
    state.host = url ? url.hostname : null;
    state.origin = url ? url.origin : null;
  } catch { state.host = null; state.origin = null; }

  // No active tab is a real state (the popup can be opened over devtools or the
  // tab strip), and reading `tab.id` off undefined threw *before* the .catch,
  // rejecting this function and leaving the auto-show controls unpainted.
  const reachable = CONTENT_SCRIPT_SCHEME.test(tab?.url || '');
  const resp = tab?.id && reachable
    ? await chrome.tabs.sendMessage(tab.id, { type: 'readerState' }).catch(() => null)
    : null;
  state.detected = !!resp?.detected;
  state.scripted = !!resp;
  state.readerOpen = !!resp?.open;
  // Only asked when nothing answered, and true when the answer cannot be had:
  // offering to grant a site that is already granted would be a button that
  // fixes nothing, and the reload at least might.
  const granted = resp || !state.origin ? true : await chrome.permissions
    .contains({ origins: [`${state.origin}/*`] }).catch(() => true);
  state.pageState = pageStateFor(tab, resp, granted, !resp && await isOwnSite(state.origin));
  renderPageState();

  const readerBtn = $('#toggle-reader');
  readerBtn.querySelector('.label').textContent =
    t(state.readerOpen ? 'popupHideReader' : 'popupShowReader');
  readerBtn.classList.toggle('is-active', state.readerOpen);
  readerBtn.disabled = !state.detected && !state.readerOpen;
  $('#add-current').disabled = !state.scripted;

  if (state.host) {
    $('#site-host').textContent = state.host;
    $('#site-group').hidden = false;
  }
  await renderAutoShow();
}

/**
 * PanelFlow's own server: an origin the settings relay is declared on, or the
 * one this install syncs with. Chrome counts the relay's pages as granted, and
 * `permissions.contains` still says no, which is how the popup came to offer
 * to "turn PanelFlow on" there.
 */
async function isOwnSite(origin) {
  if (!origin) return false;
  const relay = (chrome.runtime.getManifest().content_scripts || [])
    .filter((c) => (c.js || []).includes('content/site-bridge.js'))
    .flatMap((c) => c.matches || []);
  if (relay.some((m) => m.replace(/\/\*$/, '') === origin)) return true;
  const { settings } = await chrome.storage.local.get(['settings']).catch(() => ({}));
  try { return !!settings?.backendUrl && new URL(settings.backendUrl).origin === origin; } catch { return false; }
}

// --- auto-show reader config ------------------------------------------------
// `autoShowDefault` is the global fallback; `autoShowSites[host]` overrides it
// per site (absent = follow the default). Same tri-state MangaPin exposes.

async function getAutoShow() {
  const v = await chrome.storage.local.get(['autoShowDefault', 'autoShowSites', 'settings']);
  return {
    // Migrate the old single global flag on first read.
    def: v.autoShowDefault ?? !!v.settings?.autoOpenReader,
    sites: v.autoShowSites || {},
  };
}

async function renderAutoShow() {
  const { def, sites } = await getAutoShow();
  paintSwitcher('#default-autoshow', def ? 'on' : 'off');
  if (!state.host) return;
  const site = sites[state.host];
  paintSwitcher('#site-autoshow', site === undefined ? 'default' : site ? 'on' : 'off');
}

function paintSwitcher(sel, value) {
  for (const b of document.querySelectorAll(`${sel} button`)) {
    b.setAttribute('aria-pressed', String(b.dataset.value === value));
  }
}

$('#default-autoshow').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  await chrome.storage.local.set({ autoShowDefault: btn.dataset.value === 'on' });
  renderAutoShow();
});

$('#site-autoshow').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn || !state.host) return;
  const { sites } = await getAutoShow();
  if (btn.dataset.value === 'default') delete sites[state.host];
  else sites[state.host] = btn.dataset.value === 'on';
  await chrome.storage.local.set({ autoShowSites: sites });
  renderAutoShow();
});

// --- lists ------------------------------------------------------------------

function coverInto(img, entry) {
  if (entry.coverUrl) {
    // The web shelf has guarded this from the start; the popup never did, and it
    // is the surface where it matters more. `renderLibrary` rebuilds every card
    // from scratch — on every keystroke in the search box, among other things —
    // so without these two attributes a library of five hundred series creates
    // five hundred loading images each time, when about a dozen are on screen.
    // `lazy` holds the fetch until the card is near the viewport; `async` keeps
    // the decode off the thread that is drawing the rest of the grid.
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = entry.coverUrl;
    img.addEventListener('error', () => img.classList.add('placeholder'), { once: true });
  } else {
    img.classList.add('placeholder');
  }
}

// The popup keys progress by source URL where the web app keys it by entry id,
// which is the whole reason the shared rule asks for a lookup instead of a map.
const progressOf = (entry) => state.progress[entry.sourceUrl];

/**
 * One card, built once and used by every shelf on this page.
 *
 * The library grid and the per-medium shelves below it draw the same thing;
 * a second copy of this would be a second place to fix the next thing wrong
 * with a cover, a badge or a continue target.
 */
function buildCard(entry) {
  const card = document.createElement('div');
  card.className = 'card';
  // Found again after a redraw: the sheet gives the focus back to the card it
  // was opened from, and a redraw replaces that card with a new one.
  card.dataset.source = entry.sourceUrl || '';
  card.innerHTML = `
    <div class="card-art"><img alt=""><span class="card-badge"></span></div>
    <div class="card-title"></div>
    <div class="card-ch"></div>`;
  coverInto(card.querySelector('img'), entry);
  card.querySelector('.card-title').textContent = entry.title;
  card.querySelector('.card-badge').textContent = folderName(folderOf(entry));

  // Read / part-way / not caught up, as a class the grid can colour. The same
  // three states the web shelf shows, from the same rule, so the popup and
  // the page never disagree about a series on the same screen.
  const stand = PanelFlowView.readState(entry, progressOf(entry), state.categories);
  card.classList.add('is-' + stand);

  // The bookmark — the furthest chapter reached — and not a reread under way.
  const read = chapterNum(PanelFlowView.bookmarkOf(progressOf(entry))?.chapterLabel);
  const latest = chapterNum(entry.lastKnownChapter);
  const ch = card.querySelector('.card-ch');
  ch.title = STAND_LABELS[stand];
  ch.textContent = read !== null ? tu('chapterBadge', entry, [String(read)])
    : (latest !== null ? tu('chapterBadge', entry, [String(latest)]) : '');
  if (read !== null && latest !== null) {
    const total = document.createElement('span');
    total.className = 'total';
    total.textContent = ` / ${latest}${entry.seriesStatus === 'ongoing' ? '+' : ''}`;
    ch.appendChild(total);
  }

  // The cover is the "keep reading" button — that is what a cover is for in
  // every reader that has one — and the text below it opens the details. The
  // badge says which chapter the cover leads to when it is not the obvious
  // one, so the jump to a chapter you have never opened is never a surprise.
  const target = state.targets[entry.id];
  const art = card.querySelector('.card-art');
  if (target?.url) {
    art.classList.add('go');
    // nothing read yet, so there is nothing to continue
    art.title = target.isNew ? tu('actionReadChapter', entry, [target.label])
      : target.label ? t('actionContinueChapter', [target.label])
      : t('actionOpenSeriesPage');
    art.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: target.url });
    });
    // A button to the keyboard too: the cards were reachable by mouse only,
    // and with them the sheet and its "Resume the reread" (QA re-test It.4,
    // N20). Named by where it goes, the words its tooltip already has.
    asButton(art, art.title, () => chrome.tabs.create({ url: target.url }));
  }
  if (target?.isNew) {
    const chip = document.createElement('span');
    chip.className = 'card-new';
    chip.textContent = target.label ? tu('badgeNewChapter', entry, [target.label]) : t('badgeNew');
    art.appendChild(chip);
  }

  card.addEventListener('click', () => openEntry(entry.id));
  // The title opens the details, from the keyboard as from the mouse.
  asButton(card.querySelector('.card-title'), t('popupDetailsOf', [entry.title]), () => openEntry(entry.id));
  return card;
}

/**
 * A div that behaves as the button it looks like: in the tab order, named,
 * and pressed with Enter or Space. The cards are drawn as divs for the grid's
 * sake; this is what makes them reachable without a mouse (N20).
 */
function asButton(el, name, press) {
  if (!el) return;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', name);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    press();
  });
}

function renderLibrary() {
  const filter = $('#search').value;
  const list = $('#library-list');
  list.innerHTML = '';
  list.className = 'grid';
  const view = state.view;
  const items = PanelFlowView.sortLibrary(
    PanelFlowView.filterLibrary(state.library, {
      query: filter,
      tags: view.tag ? [view.tag] : [],
      unreadOnly: view.unreadOnly,
      // A shelf of the user's own is judged by the status it stands for, here
      // as everywhere else.
      categories: state.categories,
      progressOf,
      medium: view.medium,
    }),
    { by: view.sort, dir: view.dir, progressOf },
  );

  $('#library-empty').hidden = items.length > 0 || !!filter;
  // The filter box only earns its space once the list is long enough to need it.
  $('#search').hidden = state.library.length < 6;
  renderLibTools();

  for (const entry of items) list.appendChild(buildCard(entry));
  renderShelves();
}

/**
 * The shelves that answer "what else do I have of this kind".
 *
 * One renderer, one card builder, one sort — the shelf below is the library
 * grid narrowed to a medium, not a second library. A section with nothing in it
 * stays hidden: a heading over an empty list is a feature the reader has to work
 * out they are not using.
 *
 * The main grid deliberately still holds everything. These are a way in, not a
 * filing cabinet somebody now has to keep tidy.
 */
const SHELVES = [
  // Web novels and light novels on one shelf: two types, one kind of reading.
  { media: ['webnovel', 'lightnovel'], list: '#novel-list', group: 'novel' },
  { media: ['webtoon'], list: '#webtoon-list', group: 'webtoon' },
];

function renderShelves() {
  for (const { media, list: sel, group } of SHELVES) {
    const rows = state.library.filter((e) => media.includes(PanelFlowView.mediumOf(e)));
    const section = document.querySelector(`[data-group="${group}"]`);
    if (section) section.hidden = rows.length === 0;
    const list = $(sel);
    if (!list) continue;
    list.innerHTML = '';
    const ordered = PanelFlowView.sortLibrary(rows, { by: state.view.sort, dir: state.view.dir, progressOf });
    for (const entry of ordered) list.appendChild(buildCard(entry));
  }
  renderWatched();
}

/**
 * What was watched, as opposed to what was read.
 *
 * A separate section rather than a heading that changes its mind: the reader
 * asked for both at once, and a list holding an episode and a chapter under one
 * word makes whichever came second look mislabelled.
 */
function renderWatched() {
  const list = $('#watched-list');
  const section = document.querySelector('[data-group="watched"]');
  if (!list) return;
  const byUrl = new Map(state.library.map((e) => [e.sourceUrl, e]));
  const items = Object.values(state.progress)
    .filter((p) => (byUrl.get(p.sourceUrl)?.medium) === 'anime')
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, 6);
  if (section) section.hidden = items.length === 0;
  list.innerHTML = '';
  for (const p of items) {
    const entry = byUrl.get(p.sourceUrl);
    if (entry) list.appendChild(buildCard(entry));
  }
}


// --- sort & filter ----------------------------------------------------------

for (const s of PanelFlowView.SORTS) {
  const opt = document.createElement('option');
  opt.value = s.id;
  opt.textContent = sortName(s);
  $('#sort').appendChild(opt);
}

const saveView = () => chrome.storage.local.set({ libraryView: state.view });

function renderLibTools() {
  const view = state.view;
  // Same threshold as the search box: five series need no machinery.
  $('#lib-tools').hidden = state.library.length < 6;

  $('#sort').value = view.sort;
  const spec = PanelFlowView.SORTS.find((s) => s.id === view.sort);
  const asc = (view.dir || spec.dir) === 'asc';
  $('#sort-dir').textContent = asc ? '↑' : '↓';

  // One tag at a time here — a popup has no room for a row of chips, and the
  // second tag is a rarer thing to want than the first.
  const sel = $('#tag-filter');
  const tags = PanelFlowView.tagCounts(state.library);
  sel.innerHTML = '';
  sel.hidden = tags.length === 0;
  for (const { tag, count } of [{ tag: t('popupAllTags'), count: 0 }, ...tags]) {
    const opt = document.createElement('option');
    opt.value = count ? tag : '';
    opt.textContent = count ? `${tag} (${count})` : tag;
    sel.appendChild(opt);
  }
  // A tag can disappear from the library while it is the one being filtered on;
  // assigning a value no option carries leaves the box blank, so fall back.
  sel.value = view.tag || '';
  if (sel.selectedIndex < 0) { sel.value = ''; view.tag = null; }

  $('#unread-only').setAttribute('aria-pressed', String(!!view.unreadOnly));

  // The type, one at a time, like the tag: a select rather than a row of chips
  // because a popup is 380 pixels wide. Offered once the library holds more
  // than one kind — a filter with one answer is not a filter.
  const med = $('#medium-filter');
  const counts = {};
  for (const e of state.library) {
    const m = PanelFlowView.mediumOf(e);
    counts[m] = (counts[m] || 0) + 1;
  }
  med.innerHTML = '';
  med.hidden = Object.keys(counts).length < 2 && view.medium === 'all';
  for (const o of [{ id: 'all', label: t('mediumAll') },
    ...PanelFlowView.MEDIA.filter((m) => counts[m.id] || view.medium === m.id)
      .map((m) => ({ id: m.id, label: `${mediumName(m.id)} (${counts[m.id] || 0})` }))]) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.label;
    med.appendChild(opt);
  }
  med.value = view.medium || 'all';
  if (med.selectedIndex < 0) { med.value = 'all'; view.medium = 'all'; }
}

$('#medium-filter').addEventListener('change', (e) => {
  state.view.medium = e.target.value || 'all';
  saveView();
  renderLibrary();
});

$('#sort').addEventListener('change', (e) => {
  state.view.sort = e.target.value;
  state.view.dir = null;   // a new order arrives the way it is meant to be read
  saveView();
  renderLibrary();
});

$('#sort-dir').addEventListener('click', () => {
  const spec = PanelFlowView.SORTS.find((s) => s.id === state.view.sort);
  state.view.dir = (state.view.dir || spec.dir) === 'asc' ? 'desc' : 'asc';
  saveView();
  renderLibrary();
});

$('#tag-filter').addEventListener('change', (e) => {
  state.view.tag = e.target.value || null;
  saveView();
  renderLibrary();
});

$('#unread-only').addEventListener('click', () => {
  state.view.unreadOnly = !state.view.unreadOnly;
  saveView();
  renderLibrary();
});

// --- entry detail -----------------------------------------------------------

const LANGUAGES = ['English', 'Japanese', 'Korean', 'Chinese (Simplified)', 'French'];

const ICONS = {
  progress: 'M12 3a9 9 0 109 9',
  folder: 'M3 7a1 1 0 011-1h5l2 2h9a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1z',
  language: 'M4 5h9M8 5v3c0 3-2 6-4 7M10 19l4-9 4 9M11.5 16h5',
  score: 'M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4 9.7l5.4-.8z',
  note: 'M4 5h11M4 10h11M4 15h7M17 13l3 3-4 4h-3v-3z',
  date: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  rereads: 'M4 9h12l-3-3M20 15H8l3 3',
  tags: 'M4 4h7l9 9-7 7-9-9zM8 8h.01',
  link: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
};

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  svg.style.width = '17px';
  svg.style.height = '17px';
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

// A row reads as its own label when empty ("Score") and as its value when set,
// which is what makes an unfilled field obviously tappable.
function frow(iconPath, label, value, onEdit) {
  const row = document.createElement('div');
  row.className = 'frow' + (value ? ' set' : '') + (onEdit ? ' editable' : '');
  row.appendChild(icon(iconPath));
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  row.appendChild(k);
  if (value) {
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = value;
    row.appendChild(v);
  }
  if (onEdit) {
    row.addEventListener('click', onEdit);
    // A row that does something is a button to the keyboard as well: the
    // tracker rows and "Remove" answered the mouse only (QA re-test It.4, N20).
    asButton(row, value ? `${label}, ${value}` : label, onEdit);
  }
  return row;
}

/**
 * The series sheet covers the popup, and behind it everything stayed in the
 * tab order: seven of the nine stops to "Resume the reread" were controls
 * nobody could see, the focus stayed on the card under the sheet, and "Back"
 * left it nowhere (QA re-test It.5, N27). Behind an open sheet the popup is
 * inert; the focus goes to the sheet's title and comes back to what opened it.
 */
let entryOpener = null;
let entrySource = null;
/** The title of a series' card on the shelf, as it is drawn now. */
const cardTitleOf = (sourceUrl) => (sourceUrl
  ? [...document.querySelectorAll('#library-list .card')].find((c) => c.dataset.source === sourceUrl)
    ?.querySelector('.card-title')
  : null);
const setBehind = (panel, off) => {
  for (const el of document.body.children) {
    // Not the other panels: they open above the sheet (the tracker link)
    // and manage their own state; a hidden one takes no focus anyway.
    if (el === panel || el.id === 'toast' || el.classList.contains('panel')) continue;
    el.inert = off;
  }
};
function closeEntry({ refocus = true } = {}) {
  const panel = $('#entry-panel');
  panel.hidden = true;
  setBehind(panel, false);
  const back = entryOpener?.isConnected ? entryOpener : cardTitleOf(entrySource);
  entryOpener = null;
  if (refocus) back?.focus();
}

function openEntry(id, { rebuild = false } = {}) {
  const entry = state.library.find((e) => e.id === id);
  if (!entry) return;
  if (!rebuild) entryOpener = document.activeElement !== document.body ? document.activeElement : null;
  entrySource = entry.sourceUrl;
  const progress = state.progress[entry.sourceUrl];
  const body = $('#entry-body');
  // Editing any field rebuilds this panel, so the offset has to survive it:
  // rereads and the dates sit low in a scrolling sheet, and changing one used
  // to throw the reader back up to the cover.
  const prevScroll = body.scrollTop;
  body.innerHTML = '';

  const patch = async (p) => {
    // The sheet is rebuilt by an edit: the field that was being changed keeps
    // the focus, rather than sending it back to the top of the popup.
    const key = document.activeElement?.dataset?.key || null;
    await send({ type: 'updateEntry', id: entry.id, patch: p });
    Object.assign(entry, p);
    openEntry(id, { rebuild: true });
    renderLibrary();
    if (key) body.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };

  // hero
  const hero = document.createElement('div');
  hero.className = 'entry-hero';
  const img = document.createElement('img');
  coverInto(img, entry);
  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('div');
  name.className = 'name';
  name.id = 'entry-title';
  // Where the focus lands when the sheet opens: the name of what it is about.
  name.tabIndex = -1;
  name.setAttribute('role', 'heading');
  name.setAttribute('aria-level', '2');
  name.textContent = entry.title;
  const dom = document.createElement('div');
  dom.className = 'dom';
  dom.textContent = entry.sourceDomain;
  who.append(name, dom);
  hero.append(img, who);
  body.appendChild(hero);

  // progress + when — the bookmark's chapter, which a reread does not move
  const mark = PanelFlowView.bookmarkOf(progress);
  const read = chapterNum(mark?.chapterLabel);
  const latest = chapterNum(entry.lastKnownChapter);
  const progRow = frow(ICONS.progress, t('fieldProgress'),
    read !== null
      ? `${tu('chapterN', entry, [String(read)])}${latest !== null ? ` / ${latest}${entry.seriesStatus === 'ongoing' ? '+' : ''}` : ''}`
      : (latest !== null ? `${tu('chapterN', entry, ['—'])} / ${latest}` : '—'));
  if (progress?.updatedAt) {
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = ago(progress.updatedAt);
    progRow.appendChild(when);
  }
  body.appendChild(progRow);

  // A reread under way, behind the bookmark: the second way back in. The
  // button below still goes to the bookmark (arbitrage e).
  const reread = state.targets[entry.id]?.reread;
  if (reread?.url) {
    const go = () => chrome.tabs.create({ url: reread.url });
    const again = frow(ICONS.rereads, t('actionResumeReread', [reread.label || tu('chapterN', entry, ['?'])]), '', go);
    again.classList.add('link');
    body.appendChild(again);
  }

  body.appendChild(selectRow(ICONS.folder, t('fieldFolder'),
    folderTabs(state.categories).map((f) => ({ value: f.id, label: folderName(f.id) })),
    folderOf(entry), (v) => patch({ folder: v })));
  // What kind of work it is, which the reader may correct: nothing on a page
  // tells a web novel from a light novel. Moving it between read and watched
  // unlinks it from the trackers on the server (routes/library.js).
  body.appendChild(selectRow(ICONS.tags, t('fieldMedium'),
    PanelFlowView.MEDIA.map((m) => ({ value: m.id, label: mediumName(m.id) })),
    PanelFlowView.mediumOf(entry), (v) => patch({ medium: v })));
  // Stored in English, shown in the reader's language (shared/i18n.js).
  body.appendChild(selectRow(ICONS.language, t('fieldLanguage'),
    ['—', ...LANGUAGES.map((l) => ({ value: l, label: PanelFlowI18n.languageName(l) }))], entry.language || '—',
    (v) => patch({ language: v === '—' ? null : v })));
  body.appendChild(selectRow(ICONS.score, t('fieldScore'),
    ['—', ...Array.from({ length: 10 }, (_, i) => String(i + 1))],
    entry.score ? String(entry.score) : '—',
    (v) => patch({ score: v === '—' ? null : Number(v) })));

  body.appendChild(textRow(ICONS.note, t('fieldNote'), entry.note, (v) => patch({ note: v || null })));
  body.appendChild(dateRow(ICONS.date, t('fieldStartDate'), entry.startDate, (v) => patch({ startDate: v })));
  body.appendChild(dateRow(ICONS.date, t('fieldFinishDate'), entry.finishDate, (v) => patch({ finishDate: v })));
  body.appendChild(numRow(ICONS.rereads, t('fieldRereads'), entry.rereads, (v) => patch({ rereads: v })));

  // tags
  const tagRow = document.createElement('div');
  tagRow.className = 'frow' + ((entry.tags || []).length ? ' set' : '');
  tagRow.appendChild(icon(ICONS.tags));
  if ((entry.tags || []).length) {
    const wrap = document.createElement('span');
    wrap.className = 'tags';
    for (const tag of entry.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = tag;
      wrap.appendChild(chip);
    }
    tagRow.appendChild(wrap);
  } else {
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = t('fieldTags');
    tagRow.appendChild(k);
  }
  body.appendChild(tagRow);

  // trackers — what this series is matched to, filled in when the account
  // answers. Nothing connected leaves the rows that open a search instead.
  const trackerBox = document.createElement('div');
  body.appendChild(trackerBox);
  renderEntryTrackers(trackerBox, entry);

  // remove — asked first, in place: the row turns into the question, with the
  // safe answer under the focus, so a stray Enter on the sheet removes nothing.
  // The Undo that follows is still there for a mind changed afterwards.
  const rm = frow(ICONS.tags, t('actionRemoveFromLibrary'), '', () => askRemove());
  const askRemove = () => {
    const strip = document.createElement('div');
    strip.className = 'confirm-strip';
    strip.setAttribute('role', 'group');
    const q = document.createElement('p');
    q.id = 'remove-question';
    q.textContent = t('confirmRemoveTitle', [entry.title || '']);
    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = t(accountEmail ? 'confirmRemoveBody' : 'confirmRemoveBodyLocal');
    strip.setAttribute('aria-labelledby', q.id);
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = t('actionCancel');
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'danger';
    yes.textContent = t('confirmRemoveAction');
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    buttons.append(no, yes);
    // "From AniList too?", one box per tracker that has the series, joined to
    // the question when the account answers. Never ticked in advance: what it
    // deletes over there, the Undo below cannot bring back.
    const choices = document.createElement('div');
    choices.className = 'choices';
    choices.hidden = true;
    strip.append(q, why, choices, buttons);
    rm.replaceWith(strip);
    send({ type: 'trackerEntry', title: entry.title, medium: PanelFlowView.mediumOf(entry), host: entry.sourceDomain })
      .then((r) => {
        const services = [...new Set((r?.entries || []).map((e) => e.service))];
        if (!services.length || !strip.isConnected) return;
        for (const service of services) {
          const label = document.createElement('label');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = service;
          const text = document.createElement('span');
          text.textContent = t('confirmRemoveTracker', [trackerName(service)]);
          label.append(box, text);
          choices.appendChild(label);
        }
        const note = document.createElement('p');
        note.className = 'why';
        note.textContent = t('confirmRemoveTrackerNote');
        choices.appendChild(note);
        choices.hidden = false;
        strip.scrollIntoView({ block: 'end' });
      })
      .catch(() => {});
    // Into view above the action bar that sits over the bottom of the sheet:
    // a question half under "Open" is a question with its answers hidden.
    no.focus({ preventScroll: true });
    strip.scrollIntoView({ block: 'end' });
    no.addEventListener('click', () => { strip.replaceWith(rm); rm.focus(); });
    strip.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); no.click(); }
    });
    yes.addEventListener('click', () => removeNow(
      [...choices.querySelectorAll('input:checked')].map((b) => b.value)));
  };
  const removeNow = async (trackers = []) => {
    const resp = await send({ type: 'removeFromLibrary', id: entry.id, trackers });
    // What happened on each list, after the removal line: "AniList could not
    // remove it" is the one thing here the reader has to go and do by hand.
    const said = (resp?.trackers || []).map((r) => t(
      !r.ok ? 'trackerRemoveFailed' : r.removed ? 'trackerRemovedFrom' : 'trackerRemoveNothing',
      [trackerName(r.service)]));
    state.library = state.library.filter((x) => x.id !== entry.id);
    // Not back to the card: it has just gone. The toast's Undo takes the focus.
    closeEntry({ refocus: false });
    renderLibrary();
    // Undone by adding it back as it was: the bookmark was never removed, and
    // the account keeps a removed series' note, score and tags (export.js),
    // which come back with it.
    toastUndo([t('libraryRemovedTitle', [entry.title || '']), ...said].join('. '), async () => {
      const { id: _id, remoteId: _remote, ...fields } = entry;
      await send({ type: 'addToLibrary', entry: fields });
      await load();
      // Back on the shelf, and the focus with it.
      cardTitleOf(entry.sourceUrl)?.focus();
    });
  };
  rm.style.color = 'var(--danger)';
  body.appendChild(rm);

  // action bar
  $('#entry-chapters').onclick = () => chrome.tabs.create({ url: entry.sourceUrl });
  const resume = $('#entry-resume');
  // The same target the cover has. A button that says "Ch. 246" while the cover
  // beside it opens 247 would be two answers to one question.
  const next = state.targets[entry.id];
  const target = next?.url || mark?.chapterUrl || entry.sourceUrl;
  resume.textContent = next?.label || (read !== null ? t('chapterN', [String(read)]) : t('actionOpen'));
  resume.classList.toggle('fresh', !!next?.isNew);
  // The "· new" after the label, in the reader's language: it was English
  // written into the stylesheet (QA report, F-37).
  resume.dataset.newTag = t('popupNewTag');
  resume.onclick = () => chrome.tabs.create({ url: target });

  const panel = $('#entry-panel');
  panel.hidden = false;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'entry-title');
  setBehind(panel, true);
  body.scrollTop = prevScroll;
  if (!rebuild) name.focus();
}

// --- editable row builders --------------------------------------------------

// A field is named by the label beside it: the lists, the note, the two dates
// and the rereads had no name at all, and the note was called by its
// placeholder (QA re-test It.5, N27). `data-key` is how a rebuilt sheet finds
// the field that had the focus.
let fieldSeq = 0;
const named = (control, k, label) => {
  control.setAttribute('aria-labelledby', k.id);
  control.dataset.key = label;
};

function selectRow(iconPath, label, options, current, onChange) {
  const row = document.createElement('div');
  row.className = 'frow' + (current && current !== '—' ? ' set' : '');
  row.appendChild(icon(iconPath));
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  k.id = `field-${++fieldSeq}`;
  const sel = document.createElement('select');
  // Options are plain strings where the value is the label — most rows here —
  // or {value, label} where they differ, as folders do ("cat:9f2…" / "Weekly").
  for (const o of options) {
    const { value, label } = typeof o === 'string'
      ? { value: o, label: o[0].toUpperCase() + o.slice(1) }
      : o;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === current) opt.selected = true;
    sel.appendChild(opt);
  }
  named(sel, k, label);
  sel.addEventListener('change', () => onChange(sel.value));
  row.append(k, sel);
  return row;
}

function textRow(iconPath, label, current, onCommit) {
  const row = document.createElement('div');
  row.className = 'frow' + (current ? ' set' : '');
  row.appendChild(icon(iconPath));
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  k.id = `field-${++fieldSeq}`;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current || '';
  input.placeholder = t('placeholderNone');
  // Commit on blur as well as Enter: closing the popup otherwise loses it.
  input.addEventListener('change', () => onCommit(input.value.trim()));
  named(input, k, label);
  row.append(k, input);
  return row;
}

function dateRow(iconPath, label, current, onCommit) {
  const row = document.createElement('div');
  row.className = 'frow' + (current ? ' set' : '');
  row.appendChild(icon(iconPath));
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  k.id = `field-${++fieldSeq}`;
  const input = document.createElement('input');
  input.type = 'date';
  input.value = current || '';
  input.addEventListener('change', () => onCommit(input.value || null));
  named(input, k, label);
  row.append(k, input);
  return row;
}

function numRow(iconPath, label, current, onCommit) {
  const row = document.createElement('div');
  row.className = 'frow' + (current ? ' set' : '');
  row.appendChild(icon(iconPath));
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  k.id = `field-${++fieldSeq}`;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.value = current ?? 0;
  input.style.maxWidth = '70px';
  input.addEventListener('change', () => onCommit(Number(input.value) || 0));
  named(input, k, label);
  row.append(k, input);
  return row;
}

function renderRecent() {
  const list = $('#recent-list');
  list.innerHTML = '';
  // Anime has its own section now, so this one is reading again — which is what
  // its heading has always said. A list that holds an episode and a chapter
  // under one word makes whichever came second look mislabelled.
  const watched = new Set(state.library
    .filter((e) => e.medium === 'anime').map((e) => e.sourceUrl));
  const items = Object.values(state.progress)
    .filter((p) => !watched.has(p.sourceUrl))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, 6);
  $('#recent-empty').hidden = items.length > 0;


  for (const p of items) {
    const entry = state.library.find((e) => e.sourceUrl === p.sourceUrl) || {};
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <img class="cover" alt="">
      <div class="meta"><span class="title"></span><span class="sub"></span></div>
      <span class="when"></span>
      <button class="remove" title="${t('popupRemoveFromHistory')}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>`;
    coverInto(row.querySelector('.cover'), entry);
    row.querySelector('.title').textContent = entry.title || hostOf(p.chapterUrl);
    row.querySelector('.sub').textContent =
      [p.chapterLabel, hostOf(p.chapterUrl)].filter(Boolean).join(' · ');
    row.querySelector('.when').textContent = ago(p.updatedAt);
    row.addEventListener('click', () => chrome.tabs.create({ url: p.chapterUrl }));
    row.querySelector('.remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      await send({ type: 'removeProgress', sourceUrl: p.sourceUrl });
      delete state.progress[p.sourceUrl];
      renderRecent();
    });
    list.appendChild(row);
  }
}

// Pull the chapter number out of a label like "Ch. 110". Stripping non-digits
// instead would leave the dot from "Ch." glued to the front (".110" → 0.11).
function chapterNum(label) {
  const m = String(label ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url || ''; }
}

function ago(iso) {
  const then = Date.parse(iso || '');
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return t('agoNow');
  if (mins < 60) return t('agoMinutes', [String(mins)]);
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('agoHours', [String(hrs)]);
  const days = Math.round(hrs / 24);
  return days < 30 ? t('agoDays', [String(days)]) : t('agoMonths', [String(Math.round(days / 30))]);
}

// --- collapsible groups (state persists across popup opens) -----------------

async function initGroups() {
  const { collapsedGroups = {} } = await chrome.storage.local.get(['collapsedGroups']);
  for (const group of document.querySelectorAll('.group')) {
    const key = group.dataset.group;
    group.classList.toggle('collapsed', !!collapsedGroups[key]);
    group.querySelector('.group-head').addEventListener('click', async () => {
      const collapsed = group.classList.toggle('collapsed');
      const { collapsedGroups: cur = {} } = await chrome.storage.local.get(['collapsedGroups']);
      cur[key] = collapsed;
      chrome.storage.local.set({ collapsedGroups: cur });
    });
  }
}

// --- actions ----------------------------------------------------------------

let toastTimer = 0;
// What holds an Undo toast while the reader is on it: listeners, not `on…`
// properties — Chrome has no `onfocusin`, and the hold on focus never armed
// (QA verification, N26).
let toastHolds = [];

function toast(text, kind = '') {
  clearTimeout(toastTimer);
  const el = $('#toast');
  // A plain line has no Undo to hold for.
  for (const [type, fn] of toastHolds) el.removeEventListener(type, fn);
  toastHolds = [];
  el.hidden = !text;
  el.textContent = text;
  el.className = kind;
}

/**
 * Where the focus goes back to on the shelf: the first card, or — the shelf
 * now empty — the search, or the shelf's own heading.
 */
const libraryFocus = () => {
  const visible = (el) => el && !el.hidden && el.getClientRects().length > 0;
  const card = $('#library-list').querySelector('[tabindex="0"], button');
  if (visible(card)) return card;
  if (visible($('#search'))) return $('#search');
  return document.querySelector('[data-group="library"] .group-head');
};

/**
 * The same line, with the way back: "Removed — Undo".
 * Removing a series was final at the first click (QA report, F-39).
 *
 * Twenty seconds, held while the pointer or the focus is on it, and the focus
 * put on "Undo" — the row that was pressed has just gone — then given back to
 * the library when the toast goes. It lasted six seconds whatever the reader
 * was doing, said nothing, and left the focus nowhere (QA re-test It.5, N26).
 */
function toastUndo(text, undo, ms = 20000) {
  toast(text);
  const el = $('#toast');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'undo';
  btn.textContent = t('actionUndo');
  const done = () => {
    const had = el.contains(document.activeElement);
    toast('');
    if (had) libraryFocus()?.focus();
  };
  const arm = () => { clearTimeout(toastTimer); toastTimer = setTimeout(done, ms); };
  const hold = () => clearTimeout(toastTimer);
  toastHolds = [
    ['pointerenter', hold],
    ['focusin', hold],
    ['pointerleave', () => { if (!el.contains(document.activeElement)) arm(); }],
    ['focusout', (e) => { if (!el.contains(e.relatedTarget)) arm(); }],
  ];
  for (const [type, fn] of toastHolds) el.addEventListener(type, fn);
  btn.addEventListener('click', async () => {
    // Hidden first, so a slow undo cannot be pressed twice; the undo then
    // puts the focus where it belongs.
    toast('');
    await undo();
  });
  el.append(' ', btn);
  arm();
  btn.focus();
}

// The details sheet is rendered by the content script, on the page: a 340px
// popup is too cramped for it, and the popup closes the moment focus moves.
$('#add-current').addEventListener('click', async () => {
  const btn = $('#add-current');
  btn.disabled = true;
  toast(t('toastReadingPage'));
  try {
    if (!state.tab?.id) throw new Error('no active tab');
    const resp = await chrome.tabs
      .sendMessage(state.tab.id, { type: 'openLibraryModal' })
      .catch(() => { throw new Error(t('toastNotReadable')); });
    if (!resp?.ok) throw new Error(resp?.error || t('toastCouldNotRead'));
    window.close();
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = !state.scripted;
  }
});

$('#toggle-reader').addEventListener('click', async () => {
  if (!state.tab?.id) return;
  const resp = await chrome.tabs
    .sendMessage(state.tab.id, { type: 'toggleReader' })
    .catch(() => null);
  if (resp?.ok) window.close(); // let the reader take the stage
  else toast(resp?.error || t('toastNotReadable'), 'err');
});

// The web app is served by the backend, which may be a deployment that is down
// or a local server that was never started. Probe it first rather than opening
// a tab onto a connection error.
$('#open-app').addEventListener('click', async () => {
  // getSettings, not raw storage: the default lives in the core and nowhere
  // else, so this cannot drift from the URL everything else is using.
  const base = (await send({ type: 'getSettings' }))?.settings?.backendUrl;
  if (!base) { toast(t('toastWakingUp'), 'err'); return; }
  toast(t('toastConnecting'));
  const reachable = await fetch(base + '/api/rules', { method: 'GET' })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    toast(t('toastBackendDown', [base]), 'err');
    return;
  }
  toast('');
  chrome.tabs.create({ url: base + '/' });
});

// --- my sites panel ---------------------------------------------------------
// The sites that are already this reader's: the ones they starred and the ones
// their library comes from. It used to open on every domain the rules tune for
// — a directory of scan and streaming sites, one click each, which is exactly
// what docs/ARCHITECTURE.md's store note rules out ("do not pre-load, suggest,
// or bundle links to any manga site") and what a Web Store review reads as
// facilitation (QA, September 2026). The rules still decide what a chapter
// looks like everywhere; they are simply not a list.

let sites = [];

/**
 * A rules key as a hostname. The rules are keyed by pattern — `*.mangadex.org`
 * covers the site and its subdomains — and every row here both asks Chrome's
 * favicon service for `https://<host>/` and opens it on click. Neither works on
 * a pattern: the whole tuned list was showing up faviconless and opening a
 * search for `*.mangadex.org`. Same helper in mobile/www/app.js.
 */
const bareHost = (pattern) => String(pattern || '').replace(/^\*\./, '').trim();

// Which of the two lists a host is on, best first: the handful this reader
// marked on the phone or on the website — the favourites travel with the
// account, so they are here without this list ever asking — then the rest of
// the sites the library comes from.
const SITE_KINDS = ['favourite', 'library'];

// The sites this reader marked, so the star can be drawn filled and toggled.
// Read when the panel opens rather than kept in `state`: the phone or the
// website may have changed it since the popup was last opened, and the popup is
// destroyed between openings anyway.
let siteFavourites = [];
// The signed-in address, or null. Set when the header is painted.
let accountEmail = null;
// host -> what it was before any star was applied, for the way back.
let siteKindBefore = new Map();

/**
 * Star or unstar a site, from the extension.
 *
 * The web app has had this since the Sites view existed, the phone has it, and
 * the extension could only *read* the answer — it ordered its list by favourites
 * and offered no way to set one. The tour asks once and that was the last word
 * this client had on it. Worse, the sentence on the website says outright:
 * "Star the ones you use and they come first here **and in the extension**."
 *
 * Drawn first and saved after, exactly like the web app's copy of this: a failed
 * write is something to retry, not a reason to snap a star back under somebody's
 * finger.
 */
async function toggleSiteFavourite(host) {
  siteFavourites = siteFavourites.includes(host)
    ? siteFavourites.filter((h) => h !== host)
    : [...siteFavourites, host];
  for (const s of sites) {
    if (s.host !== host) continue;
    s.kind = siteFavourites.includes(host)
      ? 'favourite'
      : (siteKindBefore.get(host) || 'library');
  }
  renderSites($('#sites-search').value);
  const reply = await send({ type: 'setAccountPrefs', patch: { favouriteSites: siteFavourites } });
  if (!reply || reply.error) toast(t('webSavedHereOnly'), 'err');
}

$('#open-sites').addEventListener('click', async () => {
  const { accountPrefs } = await chrome.storage.local.get(['accountPrefs']);
  const known = new Map();
  for (const entry of state.library) {
    if (entry.sourceDomain && !known.has(entry.sourceDomain)) {
      known.set(entry.sourceDomain, 'library');
    }
  }
  // Overwrites whatever the host was already down as, and adds it when no
  // series comes from it yet — a site somebody said they read is theirs.
  siteFavourites = (accountPrefs?.favouriteSites || []).filter(Boolean);
  // What each host is *before* being marked, kept beside the list rather than
  // on it: unstarring a library site has to put it back under "library"
  // instead of dropping it, and `sites` is a shape a test describes.
  siteKindBefore = new Map(known);
  for (const host of siteFavourites) known.set(host, 'favourite');
  sites = [...known].map(([host, kind]) => ({ host, kind })).sort((a, b) => {
    if (a.kind !== b.kind) return SITE_KINDS.indexOf(a.kind) - SITE_KINDS.indexOf(b.kind);
    return a.host.localeCompare(b.host);
  });
  renderSites('');
  $('#sites-panel').hidden = false;
  $('#sites-search').focus();
});

$('#sites-back').addEventListener('click', () => { $('#sites-panel').hidden = true; });
$('#entry-back').addEventListener('click', () => closeEntry());
// Escape closes the sheet, like every other dialog.
$('#entry-panel').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeEntry(); }
});
$('#sites-search').addEventListener('input', (e) => renderSites(e.target.value));

function renderSites(filter) {
  const list = $('#sites-list');
  list.innerHTML = '';
  // Nothing at all is not "nothing matched": no filter to type into, and a
  // sentence about how a site gets here instead.
  const none = sites.length === 0;
  $('#sites-search').hidden = none;
  $('#sites-lede').hidden = none;
  $('#sites-first').hidden = !none;
  const items = sites.filter((s) => s.host.includes(filter.trim().toLowerCase()));
  $('#sites-none').hidden = none || items.length > 0;

  for (const { host, kind } of items) {
    const row = document.createElement('div');
    row.className = 'site-row';
    row.innerHTML = `
      <img alt="">
      <span class="host"></span>
      <span class="badge"></span>`;
    const icon = row.querySelector('img');
    const fav = faviconUrl(host);
    if (fav) icon.src = fav;
    row.querySelector('.host').textContent = host;
    const badge = row.querySelector('.badge');
    badge.textContent = kind === 'favourite' ? t('popupBadgeFavourite') : t('popupBadgeInLibrary');
    badge.classList.toggle('favourite', kind === 'favourite');
    row.addEventListener('click', () => chrome.tabs.create({ url: `https://${host}/` }));

    // The same control the website has, under the same two sentences — a second
    // wording for one action is how two surfaces stop looking like one product.
    // Only when signed in: favourites live on the account, and a star that
    // forgets is worse than no star.
    if (accountEmail) {
      const pinned = siteFavourites.includes(host);
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'site-star';
      star.setAttribute('aria-pressed', String(pinned));
      star.title = t(pinned ? 'webSitesUnpin' : 'webSitesPin');
      star.textContent = pinned ? '★' : '☆';
      // Stops the row's own click, which would open the site in a new tab —
      // starring a site is not a way of saying "take me there".
      star.addEventListener('click', (e) => { e.stopPropagation(); toggleSiteFavourite(host); });
      row.appendChild(star);
    }
    list.appendChild(row);
  }
}

// Needs the "favicon" permission. Never let a missing icon take the list down
// with it — the row is perfectly readable without one.
function faviconUrl(host) {
  try {
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', `https://${host}/`);
    url.searchParams.set('size', '32');
    return url.toString();
  } catch {
    return null;
  }
}

// --- trackers ---------------------------------------------------------------
// The accounts progress is sent to. Everything here is the server's work — it
// holds the client secret and the tokens — so the popup only asks and draws.

const TRACKER_NAMES = { anilist: 'AniList', mal: 'MyAnimeList', kitsu: 'Kitsu' };
const trackerName = (s) => TRACKER_NAMES[s] || s;

// Where to look a title up when no tracker is connected. Not a link, but the
// only thing that helps a reader who has not connected anything.
const TRACKER_SEARCH = [
  ['MyAnimeList', 'https://myanimelist.net/manga.php?q='],
  ['AniList', 'https://anilist.co/search/manga?search='],
  ['MangaUpdates', 'https://www.mangaupdates.com/series.html?search='],
];

// Kept as the promise, not the result: the entry panel and the trackers panel
// both want this, and whichever opens second should not pay for it twice.
let trackersPromise = null;
const loadTrackerData = (force = false) => {
  if (force || !trackersPromise) trackersPromise = send({ type: 'trackers' });
  return trackersPromise;
};

const linkFor = (data, entryId, service) => (data?.links || [])
  .find((l) => l.libraryId === entryId && l.service === service) || null;

/** What a link says on one line, or '' for a row that reads as its own label. */
function linkValue(link, entry) {
  if (!link) return '';
  if (link.state === 'linked') {
    return (link.remoteTitle || `#${link.remoteId}`)
      + (link.lastChapter ? tu('trackerUpToChapter', entry, [String(link.lastChapter)]) : '');
  }
  if (link.state === 'muted') return t('trackerNeverSent', ['']).replace(/^\s*·\s*/, '');
  return t('trackerNoMatch', ['']).replace(/^\s*·\s*/, '');
}

async function renderEntryTrackers(box, entry) {
  const data = await loadTrackerData();
  // The panel may have been closed, or another entry opened, while the account
  // answered. Writing into a detached node is harmless; writing into the wrong
  // entry's panel is not.
  if (!box.isConnected) return;
  box.textContent = '';
  const connected = (data?.connected || []).filter((tk) => tk.canPush);
  if (!connected.length) {
    for (const [label, url] of TRACKER_SEARCH) {
      const row = frow(ICONS.link, label, '', () =>
        chrome.tabs.create({ url: url + encodeURIComponent(entry.title) }));
      row.classList.add('link');
      box.appendChild(row);
    }
    return;
  }
  // The server's id, not this device's: links are the account's, and they
  // name the series by the row the account holds. Asking with the local id
  // found nothing, and a pick made here answered "library entry not found".
  for (const tk of connected) {
    const link = entry.remoteId ? linkFor(data, entry.remoteId, tk.service) : null;
    const linked = link?.state === 'linked';
    // Not on that tracker's list yet: the row is the button that puts it
    // there, from the series itself, bookmark or not (routes/trackers.js,
    // `/add`). A linked one opens the picker, to change what it points at.
    const row = frow(ICONS.link, trackerName(tk.service),
      linked ? linkValue(link, entry) : t('trackerAddTo', [trackerName(tk.service)]),
      () => (linked
        ? openLinkPanel({ libraryId: entry.remoteId, entryId: entry.id, title: entry.title,
          service: tk.service, medium: PanelFlowView.mediumOf(entry) })
        : addToTrackerFromPopup(entry, tk.service, row)));
    row.classList.add('link');
    if (link && link.state === 'unmatched') row.classList.add('needs-you');
    box.appendChild(row);
  }
}

/**
 * "Add to MyAnimeList", from the series' sheet. The answer is one of three:
 * added (or already there, which is left as it is), or not sure which work it
 * is — then the picker opens on the catalogue's guesses and the reader's
 * choice is added the same way.
 */
async function addToTrackerFromPopup(entry, service, row) {
  const v = row.querySelector('.v') || row;
  v.textContent = t('modalTrackerAdding');
  const resp = await send({ type: 'trackerAdd', sourceUrl: entry.sourceUrl, service });
  const r = resp?.result;
  if (resp?.error || !r) {
    toast(t('modalTrackerFailed', [trackerName(service), resp?.error || t('modalTrackerNoAnswer')]), 'err');
    v.textContent = t('trackerAddTo', [trackerName(service)]);
    return;
  }
  const fresh = state.library.find((e) => e.id === entry.id) || entry;
  if (r.skipped === 'unmatched') {
    openLinkPanel({ libraryId: r.libraryId, entryId: entry.id, title: entry.title, service,
      medium: PanelFlowView.mediumOf(entry), adding: true, sourceUrl: entry.sourceUrl });
    return;
  }
  toast(addedLine(service, r, fresh));
  await loadTrackerData(true);
  await load();
  if (!$('#entry-panel').hidden) openEntry(entry.id, { rebuild: true });
}

function addedLine(service, r, entry) {
  if (r.already) {
    return t('modalTrackerAlready', [trackerName(service),
      [r.remoteTitle, r.folder ? folderName(r.folder) : null].filter(Boolean).join(' · ')]);
  }
  return r.count ? tu('modalTrackerAdded', entry, [trackerName(service), String(r.count)])
    : t('modalTrackerAddedPlain', [trackerName(service)]);
}

$('#open-trackers').addEventListener('click', async () => {
  $('#trackers-panel').hidden = false;
  $('#trackers-note').hidden = false;
  $('#trackers-note').textContent = t('trackerAsking');
  // Forced: this panel is where a reader lands right after connecting one in a
  // tab, and a cached "not connected" would be the first thing they read.
  renderTrackersPanel(await loadTrackerData(true));
});

$('#trackers-back').addEventListener('click', () => { $('#trackers-panel').hidden = true; });

function renderTrackersPanel(data) {
  const accounts = $('#tracker-accounts');
  const links = $('#tracker-links');
  const note = $('#trackers-note');
  accounts.textContent = '';
  links.textContent = '';
  if (!data || data.error) {
    note.hidden = false;
    note.textContent = data?.error || t('trackerUnreachable');
    $('#tracker-links-head').hidden = true;
    return;
  }
  note.hidden = true;

  for (const svc of data.services || []) {
    const live = (data.connected || []).find((c) => c.service === svc.service);
    const row = document.createElement('div');
    row.className = 'tracker-row' + (live ? ' on' : '');
    const meta = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'title';
    name.textContent = trackerName(svc.service);
    const sub = document.createElement('span');
    sub.className = 'sub';
    if (live) {
      sub.textContent = live.remoteUser ? t('trackerConnectedAs', [live.remoteUser]) : t('trackerConnected');
      if (!live.canPush) sub.textContent += t('trackerNotListening');
    } else if (svc.configured) {
      sub.textContent = t('trackerNotConnected');
    } else {
      sub.textContent = svc.oauth
        ? t('trackerNoCredentials')
        : t('trackerPasswordAuth');
    }
    meta.append(name, sub);
    // A connection that has stopped being listened to and one that is working
    // are the same row without this: the refusal happened on a page turn, in a
    // response nobody read. `lastError` is the server's copy, so it survives a
    // reinstall and a second device; `alerts` is what this device saw.
    const why = live?.lastError || data.alerts?.[svc.service]?.error;
    if (live && why) {
      row.classList.add('failing');
      const bad = document.createElement('span');
      bad.className = 'sub bad';
      bad.textContent = t('trackerRefusing', [why]);
      meta.appendChild(bad);
    }
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'tracker-actions';
    if (live) {
      if (svc.canPush) actions.appendChild(tinyButton(t('trackerSendAll'), () => pushEverything(svc.service)));
      if (svc.canPush) actions.appendChild(tinyButton(t('trackerFetch'), () => pullEverything(svc.service)));
      if (IMPORTABLE.includes(svc.service)) {
        const pending = importPending[svc.service];
        actions.appendChild(tinyButton(
          pending ? t('trackerImportPending', [String(pending.added), String(pending.updated)]) : t('trackerImportList'),
          () => importAccount(svc.service),
          pending ? 'primary' : '',
        ));
      }
      actions.appendChild(tinyButton(t('actionDisconnect'), () => disconnectTracker(svc.service)));
    } else if (svc.configured) {
      actions.appendChild(tinyButton(t('actionConnect'), () => connectTracker(svc.service), 'primary'));
    }
    row.appendChild(actions);
    accounts.appendChild(row);
  }

  const sorted = [...(data.links || [])].sort((a, b) => {
    // Unmatched first: it is the only row here anyone can act on.
    const rank = (l) => (l.state === 'unmatched' ? 0 : l.state === 'muted' ? 2 : 1);
    return rank(a) - rank(b) || String(a.title).localeCompare(String(b.title));
  });
  $('#tracker-links-head').hidden = sorted.length === 0;
  for (const link of sorted) {
    const row = document.createElement('button');
    row.className = 'tracker-row link-row ' + link.state;
    const meta = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = link.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${trackerName(link.service)} · ${linkValue(link) || link.state}`
      + (link.lastChapter ? ` · ${t('trackerUpToChapter', [String(link.lastChapter)])}` : '');
    meta.append(title, sub);
    row.appendChild(meta);
    row.addEventListener('click', () => openLinkPanel(link));
    links.appendChild(row);
  }
}

function tinyButton(label, onClick, className = '') {
  const b = document.createElement('button');
  b.className = 'tiny ' + className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

async function connectTracker(service) {
  const resp = await send({ type: 'trackerConnect', service });
  if (resp?.error || !resp?.authorizeUrl) {
    toast(resp?.error || t('err_tracker_unavailable'), 'err');
    return;
  }
  // A tab, not a window inside the popup: an OAuth page needs somewhere that
  // survives the popup closing, which it does the moment the tab takes focus.
  chrome.tabs.create({ url: resp.authorizeUrl });
}

async function disconnectTracker(service) {
  const resp = await send({ type: 'trackerDisconnect', service });
  if (resp?.error) { toast(resp.error, 'err'); return; }
  renderTrackersPanel(await loadTrackerData(true));
}

async function pushEverything(service) {
  toast(t('trackerSending', [trackerName(service)]));
  const resp = await send({ type: 'trackerPushAll', service });
  if (resp?.error) { toast(resp.error, 'err'); return; }
  const r = resp.report || {};
  const parts = [t('trackerSent', [String(r.pushed || 0)])];
  if (r.skipped) parts.push(t('trackerSkipped', [String(r.skipped)]));
  if (r.failed) parts.push(t('trackerFailed', [String(r.failed)]));
  // The server stops on a deadline rather than being cut off, so a big library
  // finishes over several presses.
  if (r.remaining) parts.push(t('trackerRemaining', [String(r.remaining)]));
  toast(parts.join(' · '));
  renderTrackersPanel(await loadTrackerData(true));
}

// The other direction. Nothing here moves a bookmark — the tracker counts
// chapters and a bookmark is a URL on a scan site — so what this changes is
// what PanelFlow believes the account already has, which is what keeps a page
// turn from reporting chapter 5 over a hundred and twenty.
async function pullEverything(service) {
  toast(t('trackerFetching', [trackerName(service)]));
  const resp = await send({ type: 'trackerPull', service });
  if (resp?.error) { toast(resp.error, 'err'); return; }
  const r = resp.report || {};
  toast(r.ahead?.length
    ? t('trackerFetchedAhead', [String(r.updated || 0), String(r.ahead.length)])
    : (r.updated === 1 ? t('trackerFetchedOne') : t('trackerFetched', [String(r.updated || 0)])));
  renderTrackersPanel(await loadTrackerData(true));
}

// --- bringing a list back the other way -------------------------------------
// Only these two can be read: Kitsu is not connected at all, and a service
// PanelFlow cannot sign a request to has no list to hand over.
const IMPORTABLE = ['anilist', 'mal'];

// What a preview found, per service, waiting for a second press. An import
// writes across the whole library at once, so it is never one click — and the
// number on the button is what that click is about to do.
const importPending = {};

async function importAccount(service) {
  const pending = importPending[service];
  const resp = await send({ type: 'trackerImport', service, dryRun: !pending });
  if (resp?.error) { toast(resp.error, 'err'); return; }
  const r = resp.report || {};
  if (!pending) {
    if (!r.added && !r.updated) {
      toast(t('trackerNothingMissing', [trackerName(service)]));
      return;
    }
    importPending[service] = { added: r.added || 0, updated: r.updated || 0 };
    toast(t('trackerImportPreview', [String(r.added), String(r.updated)]));
    renderTrackersPanel(await loadTrackerData());
    return;
  }
  delete importPending[service];
  toast(t('trackerImportDone', [String(r.added), String(r.updated)]));
  // The shelf behind the panel is now wrong, and so is every cached link.
  await load();
  renderTrackersPanel(await loadTrackerData(true));
}

// --- picking the right series by hand ---------------------------------------

let linking = null;
let linkOpener = null;

/**
 * Over whatever opened it — the series sheet included. The sheet makes the
 * rest of the popup inert while it is open, and this panel was part of the
 * rest: it opened dead, typing and "Back" did nothing (QA verification, N32).
 * So this one is live, the sheet under it is the inert one, and closing
 * reverses both and gives the focus back to the row that opened it.
 */
function openLinkPanel(target) {
  linking = target;
  linkOpener = document.activeElement !== document.body ? document.activeElement : null;
  $('#link-title').textContent = `${target.title} · ${trackerName(target.service)}`;
  $('#link-query').value = target.title;
  $('#link-results').textContent = '';
  $('#link-note').hidden = true;
  const panel = $('#link-panel');
  panel.inert = false;
  panel.hidden = false;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'link-title');
  $('#entry-panel').inert = !$('#entry-panel').hidden;
  $('#link-query').focus();
  runLinkSearch();
}

function closeLinkPanel({ refocus = true } = {}) {
  $('#link-panel').hidden = true;
  $('#entry-panel').inert = false;
  const back = linkOpener;
  linkOpener = null;
  if (refocus && back?.isConnected) back.focus();
  else if (refocus && !$('#entry-panel').hidden) $('#entry-title')?.focus();
}

$('#link-back').addEventListener('click', () => closeLinkPanel());
$('#link-panel').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeLinkPanel(); }
});
$('#link-search').addEventListener('click', runLinkSearch);
$('#link-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') runLinkSearch(); });

async function runLinkSearch() {
  const q = $('#link-query').value.trim();
  const note = $('#link-note');
  const results = $('#link-results');
  results.textContent = '';
  if (q.length < 2) return;
  note.hidden = false;
  note.textContent = t('statusSearching');
  const resp = await send({ type: 'trackerSearch', service: linking.service, q, medium: linking.medium });
  if (resp?.error) { note.textContent = resp.error; return; }
  const hits = resp.hits || [];
  if (!hits.length) { note.textContent = t('trackerNoResults'); return; }
  note.hidden = true;
  for (const hit of hits) {
    const b = document.createElement('button');
    b.className = 'tracker-row link-row';
    const meta = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = hit.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    // The alternative titles are what tells a spin-off from its parent when
    // both come back under the same romaji name.
    sub.textContent = (hit.altTitles || []).slice(0, 3).join(' · ');
    meta.append(title, sub);
    b.appendChild(meta);
    b.addEventListener('click', () => (linking.adding
      ? addPicked(hit)
      : saveLink({ remoteId: hit.id, remoteTitle: hit.title, state: 'linked' })));
    results.appendChild(b);
  }
}

// Muting is per series: the way to keep one title off a tracker without giving
// up the connection for the rest of the library.
$('#link-mute').addEventListener('click', () => saveLink({ state: 'muted' }));

/** The reader's pick, when the picker was opened by "Add": added, not just linked. */
async function addPicked(hit) {
  const resp = await send({
    type: 'trackerAdd', sourceUrl: linking.sourceUrl, service: linking.service,
    remoteId: hit.id, remoteTitle: hit.title,
  });
  const r = resp?.result;
  if (resp?.error || !r || !r.ok) {
    $('#link-note').hidden = false;
    $('#link-note').textContent = resp?.error || t('modalTrackerNoAnswer');
    return;
  }
  const entry = state.library.find((e) => e.id === linking.entryId);
  toast(addedLine(linking.service, r, entry));
  await loadTrackerData(true);
  closeLinkPanel({ refocus: false });
  if (!$('#entry-panel').hidden && entry) {
    openEntry(entry.id, { rebuild: true });
    $('#entry-title')?.focus();
  }
}

async function saveLink(patch) {
  const resp = await send({
    type: 'trackerLink', service: linking.service, libraryId: linking.libraryId, ...patch,
  });
  if (resp?.error) {
    $('#link-note').hidden = false;
    $('#link-note').textContent = resp.error;
    return;
  }
  await loadTrackerData(true);
  closeLinkPanel({ refocus: false });
  if (!$('#trackers-panel').hidden) renderTrackersPanel(await loadTrackerData());
  // The entry panel behind it is showing the old answer on its tracker row.
  // It is opened by this device's id; the link was made with the account's.
  if (!$('#entry-panel').hidden) {
    openEntry(linking.entryId
      ?? state.library.find((e) => e.remoteId === linking.libraryId)?.id, { rebuild: true });
    $('#entry-title')?.focus();
  }
}

// --- reading stats panel ----------------------------------------------------
// Two sources, deliberately: the totals come from the account, because it holds
// what every device read; the log below is this device's local copy, so the
// panel still says something useful while signed out or offline.

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const mins = Math.round(s / 60);
  if (mins < 60) return t('durationMinutes', [String(mins)]);
  return t('durationHours', [String(Math.floor(mins / 60)), String(mins % 60).padStart(2, '0')]);
}

// The reader's own calendar, matching the day the core stamps reads with.
function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayShift(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

$('#open-stats').addEventListener('click', async () => {
  $('#stats-panel').hidden = false;
  // The local log is a storage read and paints at once; the stats call may go
  // to a backend that is asleep, so it must not hold the panel closed.
  send({ type: 'getHistory' }).then((r) => renderLog(r?.history || []));
  const resp = await send({ type: 'getStats' }).catch((e) => ({ error: String(e.message || e) }));
  renderStats(resp?.stats || null, resp?.error || null);
});

$('#stats-back').addEventListener('click', () => { $('#stats-panel').hidden = true; });

function renderStats(stats, error) {
  const note = $('#stats-note');
  const cards = $('#stat-cards');
  cards.innerHTML = '';
  $('#stat-chart').innerHTML = '';
  $('#stat-top').innerHTML = '';
  $('#stat-chart-head').hidden = true;
  $('#stat-top-head').hidden = true;

  if (!stats) {
    note.hidden = false;
    note.textContent = t('statsLoadError', [String(error || '')]);
    return;
  }
  // Signed out, the figures below are this device's own — which is all there is
  // to count, and is why the panel no longer answers "sign in" about reading it
  // recorded itself. The line stays up while they are shown, because "chapters
  // read" means something narrower here than it does on an account.
  note.hidden = !stats.local;
  if (stats.local) note.textContent = t('statsLocalOnly');

  const tiles = [
    [t('statChaptersRead'), String(stats.chapters)],
    [t('statTimeRead'), fmtDuration(stats.seconds)],
    [t('statSeriesRead'), String(stats.series)],
    [t('statPerReadingDay'), fmtDuration(stats.secondsPerDay)],
    [t('statCurrentStreak'), t('statDays', [String(stats.current)])],
    [t('statLongestStreak'), t('statDays', [String(stats.longest)])],
    [t('statInLibrary'), String(stats.entries)],
    [stats.scored ? t('statAverageOfN', [String(stats.scored)]) : t('statAverageScore'),
      stats.scored ? `${stats.avgScore.toFixed(1)} / 10` : '—'],
  ];
  for (const [k, n] of tiles) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const nEl = document.createElement('div');
    nEl.className = 'n';
    nEl.textContent = n;
    const kEl = document.createElement('div');
    kEl.className = 'k';
    kEl.textContent = k;
    card.append(nEl, kEl);
    cards.appendChild(card);
  }

  // Thirty calendar days, not the last thirty days that were read: the gaps
  // are what the chart is for.
  const byDay = new Map(stats.days.map((d) => [d.day, d.seconds]));
  const chart = $('#stat-chart');
  const window30 = Array.from({ length: 30 }, (_, i) => dayShift(localDay(), i - 29));
  const peak = Math.max(...window30.map((d) => byDay.get(d) || 0), 1);
  if (stats.chapters) {
    $('#stat-chart-head').hidden = false;
    for (const day of window30) {
      const secs = byDay.get(day) || 0;
      const col = document.createElement('div');
      col.className = 'bar-col';
      const bar = document.createElement('div');
      bar.className = 'bar' + (secs ? '' : ' empty');
      bar.style.height = secs ? `${Math.max(6, Math.round((secs / peak) * 100))}%` : '3px';
      bar.title = `${day} · ${fmtDuration(secs)}`;
      col.appendChild(bar);
      chart.appendChild(col);
    }
  }

  const top = $('#stat-top');
  if (stats.topSeries.length) $('#stat-top-head').hidden = false;
  for (const s of stats.topSeries.slice(0, 5)) {
    const row = document.createElement('div');
    row.className = 'top-row';
    row.innerHTML = '<img alt=""><span class="t"></span><span class="n"></span>';
    coverInto(row.querySelector('img'), { coverUrl: s.coverUrl });
    row.querySelector('.t').textContent = s.title;
    row.querySelector('.n').textContent = `${s.chapters} ch · ${fmtDuration(s.seconds)}`;
    top.appendChild(row);
  }
}

function renderLog(history) {
  const list = $('#stat-log');
  list.innerHTML = '';
  $('#stat-log-empty').hidden = history.length > 0;

  // By day first, then by when it was touched: a row gains seconds every time
  // the chapter is reopened, so ordering on `at` alone splits a day in two.
  const rows = [...history].sort((a, b) =>
    String(b.day).localeCompare(String(a.day)) || String(b.at).localeCompare(String(a.at)));

  const today = localDay();
  let day = null;
  for (const r of rows.slice(0, 60)) {
    if (r.day !== day) {
      day = r.day;
      const head = document.createElement('div');
      head.className = 'log-day';
      head.textContent = day === today ? t('dayToday')
        : (day === dayShift(today, -1) ? t('dayYesterday') : day);
      list.appendChild(head);
    }
    const entry = state.library.find((e) => e.sourceUrl === r.sourceUrl);
    const row = document.createElement('div');
    row.className = 'log-row';
    // The chapter is its own column rather than a suffix on the title: inside
    // it, a long series name eats the ellipsis and the log stops saying which
    // chapter was read, which is most of what a log is for.
    row.innerHTML = '<span class="t"></span><span class="sub"></span><span class="n"></span>';
    row.querySelector('.t').textContent = entry?.title || hostOf(r.chapterUrl);
    row.querySelector('.sub').textContent = r.chapterLabel || '';
    row.querySelector('.n').textContent = fmtDuration(r.seconds);
    row.addEventListener('click', () => chrome.tabs.create({ url: r.chapterUrl }));
    list.appendChild(row);
  }
}

$('#report').addEventListener('click', () => {
  const url = state.tab?.url || '';
  chrome.tabs.create({
    url: 'https://github.com/Gabibel/panelflow/issues/new?title=' +
      encodeURIComponent('Site issue: ' + (state.host || '')) +
      // The title and the metadata lines stay English so an issue stays
      // triageable by whoever reads the tracker; only the line asking the
      // reader to write something is addressed to them.
      '&body=' + encodeURIComponent(
        `Page: ${url}\nExtension: ${chrome.runtime.getManifest().version}\n\n${t('reportWhatWentWrong')}\n`),
  });
});

// Coalesced rather than run per keystroke. `renderLibrary` empties the grid and
// rebuilds every card, so typing "kingdom" used to do that seven times in about
// as many hundredths of a second — six of them for a list nobody saw. One frame
// is short enough to feel instant and long enough to skip the ones in between.
let searchFrame = null;
$('#search').addEventListener('input', () => {
  if (searchFrame) cancelAnimationFrame(searchFrame);
  searchFrame = requestAnimationFrame(() => { searchFrame = null; renderLibrary(); });
});

$('#check-now').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = t('statusChecking');
  await send({ type: 'checkNow' });
  e.target.disabled = false;
  e.target.textContent = t('actionCheckNow');
  load();
});

$('#open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// "Turn on all sites", while it is off. Opens the settings on that switch
// rather than asking here: Chrome's prompt closes the popup under it, and the
// settings page is where the reader can see what they said yes to.
async function paintAllSitesTip() {
  const resp = await send({ type: 'allSitesOn' }).catch(() => null);
  // No answer is no line: better silent than wrongly nagging.
  $('#all-sites-tip').hidden = !resp || resp.on !== false;
}
$('#all-sites-tip').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#sites') });
  window.close();
});
paintAllSitesTip();

// --- the first three lines ---------------------------------------------------
//
// Local storage rather than the account, deliberately: this is about this
// browser's toolbar and this browser's install, so it has to work with no
// account -- which is the whole point of what it says -- and signing in later
// should not bring it back.
//
// It is written when the card is dismissed and not when it is shown. A popup
// closes the moment focus leaves it, which happens by accident often enough
// that "shown once" and "read once" are not the same thing.
async function showIntroOnce() {
  const { introDismissed } = await chrome.storage.local.get('introDismissed');
  if (introDismissed) return;
  $('#intro').hidden = false;
  // Placed by i18n.apply() out of the locale string, so it does not exist as an
  // element until the language has settled -- which is why this runs from the
  // boot block below and not with the listeners above.
  $('#intro-account')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $('#intro-dismiss').addEventListener('click', async () => {
    $('#intro').hidden = true;
    await chrome.storage.local.set({ introDismissed: true });
  });
}

// Saved chapters open in a tab of their own, not a panel in here: the bytes
// live in the extension's IndexedDB and a Blob cannot come back through a
// message, so the page that reads them has to be the one holding them.
// Straight to the tour, not to the options page: the tour is where the account
// step lives, with the sentence explaining what it is for.
$('#no-account-go').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  window.close();
});

$('#open-offline').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('offline/offline.html') });
  window.close();
});

// --- boot --------------------------------------------------------------------
// Everything above this line registers a handler or declares a function.
// Everything below draws, and so waits for the language.

// The theme the account settled on. shared/theme.js has already painted this
// window from localStorage — it runs from <head> and cannot wait for anything —
// so this is the correction, and it is the cached answer rather than a fetch:
// the options page can afford a round trip to the server and a toolbar window
// that pauses before it draws cannot. The cache is refilled by the periodic
// alarm in background.js, which is what lets a theme chosen on the website
// reach a browser whose options page nobody ever opens.
send({ type: 'getAccountPrefs' }).then((r) => {
  window.panelflowTheme.adopt(r?.prefs?.theme);
}, () => {});

PanelFlowI18n.ready.then(() => {
  PanelFlowI18n.apply();
  PanelFlowI18n.markLanguage();

  send({ type: 'offlineUsage' }).then((u) => {
    if (u?.chapters) $('#offline-count').textContent = String(u.chapters);
  });

  // Local, so it costs nothing and works signed out of everything: the answer
  // was stored the last time a page turn was refused.
  send({ type: 'trackerAlerts' }).then((r) => {
    const n = Object.keys(r?.alerts || {}).length;
    $('#tracker-alert').textContent = n ? String(n) : '';
    $('#tracker-alert').title = Object.entries(r?.alerts || {})
      .map(([s, a]) => `${trackerName(s)}: ${a.error}`).join('\n');
  });

  showIntroOnce();
  initGroups();
  load();
  loadPageContext();
  // Opportunistic catch-up: push local library/progress to the backend, then
  // re-render with any covers/chapters the sync backfilled.
  send({ type: 'syncNow' }).then(load);
});
