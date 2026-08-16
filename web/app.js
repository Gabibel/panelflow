'use strict';

// Same-origin when served by the backend; override with ?api=<url> for dev.
const API = new URLSearchParams(location.search).get('api') ?? '';
// The folders, from the one file that names them (shared/folders.js). This page
// used to keep its own list and spelt "complete" where the column says
// "completed", which quietly turned every status change into a 400.
const { BUILTIN, BUILTIN_IDS: STATUSES, folderStatus, folderLabel, folderTabs,
  folderFor, DEFAULT_FOLDER } = PanelFlowFolders;
const STATUS_LABELS = Object.fromEntries(BUILTIN.map((f) => [f.id, f.label]));

// What the coloured dot on a card means, for the hover that has to explain it.
const STAND_LABELS = {
  [PanelFlowView.UNREAD]: 'Not caught up — there is something here to read',
  [PanelFlowView.READING]: 'Part-way through a chapter',
  [PanelFlowView.READ]: 'Caught up',
};

const LANGUAGES = {
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', en: 'English', fr: 'French', es: 'Spanish',
};

let token = localStorage.getItem('pf.token');
let user = null;
let library = [];
let continueList = [];
let progressMap = {};          // libraryId -> progress row
let freshIds = new Set();      // entries whose latest chapter advanced at last check
let categories = [];           // the account's own shelves, [] when it has none
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
    throw new Error('session expired');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `request failed (${res.status})`);
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

function showAuth() {
  $('auth-view').hidden = false;
  $('app-view').hidden = true;
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
  showAuth();
}

$('auth-switch').addEventListener('click', (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  const toRegister = btn.dataset.mode === 'login';
  btn.dataset.mode = toRegister ? 'register' : 'login';
  btn.textContent = toRegister ? 'Create account' : 'Sign in';
  $('auth-switch-label').textContent = toRegister ? 'Already registered?' : 'No account yet?';
  $('auth-switch').textContent = toRegister ? 'Sign in' : 'Create one';
  $('auth-error').hidden = true;
});

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
    await guard('Could not load your library', enterApp);
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  }
});

/* ---------- App ---------- */

async function enterApp() {
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  $('account-email').textContent = user.email;
  // Not awaited: it asks the server for a key and registers a worker, and the
  // shelf below has no reason to wait for either.
  setupPush();
  await refresh();
}

async function refresh() {
  let progressRows;
  [library, continueList, progressRows, categories] = await Promise.all([
    api('/library'),
    api('/progress/continue'),
    api('/progress'),
    api('/categories'),
  ]);
  progressMap = Object.fromEntries(progressRows.map((p) => [p.libraryId, p]));
  renderContinue();
  // Before the grid: a card's folder menu and the tab it is filtered by both
  // come from this list.
  renderTabs();
  renderLibrary();
}

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

function fallbackCover(title) {
  const div = document.createElement('div');
  div.className = 'cover-fallback';
  div.textContent = (title || '?').trim().charAt(0).toUpperCase();
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
    meta.innerHTML = '<span class="title"></span><span class="sub"></span><span class="resume">Resume ▸</span>';
    if (target.isNew) meta.querySelector('.resume').textContent = `${target.label} ▸`;
    meta.querySelector('.title').textContent = p.title;
    meta.querySelector('.sub').textContent =
      `${p.chapterLabel || 'Chapter'} · p.${(p.page ?? 0) + 1}${p.pageCount ? '/' + p.pageCount : ''}`;
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
    // away on the ✎ panel, and it is what a series with no bookmark falls to.
    const target = continueTarget(entry, progressMap[entry.id]);
    const coverWrap = document.createElement('a');
    coverWrap.className = 'cover-wrap';
    coverWrap.href = target.url || entry.sourceUrl;
    coverWrap.title = target.isNew
      ? `Read ${target.label}`
      : target.label ? `Continue — ${target.label}` : 'Open the series page';
    coverWrap.target = '_blank';
    coverWrap.rel = 'noopener';
    coverWrap.appendChild(coverEl(entry));

    const chip = document.createElement('span');
    chip.className = 'status-chip';
    // The shelf it is on, which for a built-in folder is the status itself —
    // and for a shelf of the user's own is the name they gave it, with the
    // status it stands for one hover away.
    chip.textContent = folderLabel(folderOf(entry), categories);
    chip.title = STATUS_LABELS[statusOf(entry)];
    coverWrap.appendChild(chip);

    if (hasNewChapter(entry)) {
      const newChip = document.createElement('span');
      newChip.className = 'new-chip';
      // The chip can be earned by the periodic check alone (freshIds), and a
      // label is free text — "Nouveau chapitre" has no number in it. Say so
      // without the "ch. null" this used to print.
      const n = chapterNum(entry.lastKnownChapter);
      newChip.textContent = n === null ? 'New' : 'New · ch. ' + n;
      newChip.title = 'A chapter you have not read yet is out';
      coverWrap.appendChild(newChip);
    }

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = 'Remove from library';
    remove.textContent = '✕';
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      guard(`Could not remove ${entry.title}`, async () => {
        await api('/library/' + entry.id, { method: 'DELETE' });
        await refresh();
      });
    });
    coverWrap.appendChild(remove);

    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.title = 'Edit details';
    edit.textContent = '✎';
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
    const stand = PanelFlowView.readState(entry, prog);
    card.classList.add('is-' + stand);
    const dot = document.createElement('span');
    dot.className = 'state-dot';
    dot.title = STAND_LABELS[stand];
    progLine.appendChild(dot);
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
      label.textContent = 'Not started';
      progLine.appendChild(label);
    }
    const editProg = document.createElement('button');
    editProg.className = 'edit-progress';
    editProg.title = 'Set reading progress';
    editProg.textContent = '✎';
    editProg.addEventListener('click', () => openProgressDialog(entry));
    progLine.appendChild(editProg);
    const select = document.createElement('select');
    fillFolderSelect(select);
    select.value = folderOf(entry);
    select.addEventListener('change', () => {
      const wanted = select.value;
      guard(`Could not move ${entry.title}`, async () => {
        await api('/library/' + entry.id, { method: 'PUT', body: { folder: wanted } });
        await refresh();
      // The <select> already shows the new shelf; without this it keeps showing
      // it after a failed save, and the card sits under a tab the server has
      // never heard of until the next reload.
      }).then((ok) => { if (!ok) select.value = folderOf(entry); });
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
  if (entry.score != null) out.push({ text: `★ ${entry.score}`, title: `Your score: ${entry.score}/10` });
  if (entry.language) {
    out.push({
      text: entry.language.toUpperCase(),
      title: LANGUAGES[entry.language] ?? entry.language,
    });
  }
  if (entry.seriesStatus) {
    out.push({
      text: entry.seriesStatus === 'completed' ? 'Finished' : 'Ongoing',
      title: entry.seriesStatus === 'completed'
        ? 'The series itself is finished' : 'The series is still being published',
    });
  }
  if (entry.rereads > 0) {
    out.push({ text: `↻ ${entry.rereads}`, title: `Read through ${entry.rereads + 1} times` });
  }
  const span = [entry.startDate, entry.finishDate].filter(Boolean);
  if (span.length) out.push({ text: span.join(' → '), title: 'Started / finished' });
  for (const tag of entry.tags ?? []) out.push({ text: tag, title: 'Tag' });
  return out;
}

/* ---------- Tabs, search, sort & filter ---------- */

// The <select> is built once; everything else is repainted with the grid so the
// controls can never disagree with what is on screen.
for (const s of PanelFlowView.SORTS) {
  const opt = document.createElement('option');
  opt.value = s.id;
  opt.textContent = s.label;
  $('sort').appendChild(opt);
}
// Anything can be in localStorage — an older build's sort id, or a key somebody
// edited by hand. Nothing here is worth an exception on the first paint.
if (!PanelFlowView.SORT_IDS.includes(view.sort)) view.sort = PanelFlowView.DEFAULT_SORT;
if (!Array.isArray(view.tags)) view.tags = [];

function renderTools(shown) {
  $('sort').value = view.sort;
  const spec = PanelFlowView.SORTS.find((s) => s.id === view.sort);
  const asc = (view.dir || spec.dir) === 'asc';
  $('sort-dir').textContent = asc ? '↑' : '↓';
  $('sort-dir').title = asc ? 'Ascending — click for descending' : 'Descending — click for ascending';
  $('unread-only').checked = view.unreadOnly;

  const box = $('tag-filter');
  box.innerHTML = '';
  // Tags come from the shelf, not from a list somebody has to maintain: whatever
  // is on a series is offered, and a tag nobody uses any more stops appearing.
  const counts = PanelFlowView.tagCounts(library);
  const chosen = new Set(view.tags.map((t) => t.toLowerCase()));
  for (const t of chosen) if (!counts.some((c) => c.tag.toLowerCase() === t)) counts.push({ tag: t, count: 0 });
  for (const { tag, count } of counts) {
    const btn = document.createElement('button');
    btn.className = 'tag-chip' + (chosen.has(tag.toLowerCase()) ? ' on' : '');
    btn.textContent = count ? `${tag} ${count}` : tag;
    btn.title = `Show only series tagged ${tag}`;
    btn.addEventListener('click', () => {
      const key = tag.toLowerCase();
      view.tags = chosen.has(key)
        ? view.tags.filter((t) => t.toLowerCase() !== key)
        : [...view.tags, tag];
      saveView();
      renderLibrary();
    });
    box.appendChild(btn);
  }

  const total = library.length;
  $('library-count').textContent = shown === total ? '' : `${shown} of ${total}`;
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
    opt.textContent = f.label;
    select.appendChild(opt);
  }
}

// The tab row, rebuilt whenever the shelves change. "All" first, then the five
// built-ins, then the user's own — and a way in to editing them, because a list
// of shelves with no way to make one is a feature nobody finds.
function renderTabs() {
  const nav = $('tabs');
  nav.innerHTML = '';
  const tabs = [{ id: 'all', label: 'All' }, ...folderTabs(categories)];
  // A shelf can disappear while its tab is the open one.
  if (!tabs.some((t) => t.id === activeTab)) activeTab = 'all';
  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (t.id === activeTab ? ' active' : '');
    btn.dataset.tab = t.id;
    btn.textContent = t.label;
    if (t.custom) {
      btn.classList.add('custom');
      btn.title = `Your shelf — counts as ${STATUS_LABELS[t.status]}`;
    }
    btn.addEventListener('click', () => {
      activeTab = t.id;
      renderTabs();
      renderLibrary();
    });
    nav.appendChild(btn);
  }
  const manage = document.createElement('button');
  manage.className = 'tab manage';
  manage.textContent = '＋ Shelves';
  manage.title = 'Make a shelf of your own';
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
    none.textContent = 'No shelves yet.';
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
    status.title = 'What this shelf counts as: whether its series are watched '
      + 'for new chapters, and what they export as';
    status.addEventListener('change', () =>
      shelfAction(() => api('/categories/' + c.id, { method: 'PUT', body: { status: status.value } })));

    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '↑';
    up.title = 'Move up';
    up.disabled = i === 0;
    up.addEventListener('click', () => shelfAction(() => {
      const ids = categories.map((x) => x.id);
      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      return api('/categories/order', { method: 'PUT', body: { ids } });
    }));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '✕';
    del.title = `Remove this shelf — its series move to ${STATUS_LABELS[c.status]}`;
    del.addEventListener('click', () => {
      const n = library.filter((e) => folderOf(e) === folderFor(c)).length;
      const moving = n
        ? `\n\n${n} ${n === 1 ? 'series moves' : 'series move'} to ${STATUS_LABELS[c.status]}.`
        : '';
      // Nothing is deleted here — the shelf is, and what was on it goes back to
      // the status it already counted as — but the user cannot know that.
      if (!confirm(`Remove the shelf “${c.name}”?${moving}`)) return;
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
  status.textContent = 'Checking every series…';
  try {
    const results = await api('/meta/check', { method: 'POST' });
    freshIds = new Set(results.filter((r) => r.hasNew).map((r) => r.id));
    const n = freshIds.size;
    status.textContent = n === 0
      ? `No new chapters (${results.length} series checked)`
      : `${n} series ${n === 1 ? 'has' : 'have'} new chapters!`;
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
  $('dialog-title').textContent = entry ? 'Edit series' : 'Add series';
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
  status.textContent = 'Fetching page info…';
  try {
    const meta = await api('/meta/scrape?url=' + encodeURIComponent(url));
    if (meta.title && !$('f-title').value) $('f-title').value = meta.title;
    if (meta.coverUrl && !$('f-cover').value) $('f-cover').value = meta.coverUrl;
    scrapedLatestChapter = meta.latestChapter;
    showCoverPreview();
    status.textContent = [
      meta.coverUrl ? 'cover found' : 'no cover found',
      meta.latestChapter !== null ? `latest chapter: ${meta.latestChapter}` : null,
    ].filter(Boolean).join(' · ');
  } catch (err) {
    status.textContent = `Could not read the page (${err.message}) — fill in manually.`;
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
      tags: $('f-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
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

const VIEWS = ['library', 'stats', 'history', 'trackers'];

$('views').addEventListener('click', (e) => {
  const tab = e.target.closest('.view-tab');
  if (!tab) return;
  showView(tab.dataset.view);
});

function showView(name) {
  activeView = VIEWS.includes(name) ? name : 'library';
  for (const v of VIEWS) $(v + '-view').hidden = v !== activeView;
  for (const t of document.querySelectorAll('.view-tab')) {
    t.classList.toggle('active', t.dataset.view === activeView);
  }
  // Search only means anything over the library grid.
  $('search').hidden = activeView !== 'library';
  if (activeView === 'stats') loadStats();
  if (activeView === 'history') loadHistory();
  if (activeView === 'trackers') loadTrackers();
}

/* ---------- Statistics ---------- */

/** Seconds as something a person reads: "45s", "12 min", "3h 05". */
function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}`;
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
  cards.textContent = 'Loading…';
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
    ['Chapters read', String(stats.chapters)],
    ['Time read', fmtDuration(stats.seconds)],
    ['Series read', String(stats.series)],
    ['Current streak', stats.current + (stats.current === 1 ? ' day' : ' days')],
    ['Longest streak', stats.longest + (stats.longest === 1 ? ' day' : ' days')],
    // Per day read, not per day elapsed: dividing by the calendar would measure
    // how long the account has existed.
    ['Per reading day', fmtDuration(stats.secondsPerDay)],
    ['In the library', String(stats.entries)],
    [stats.scored ? `Average of ${stats.scored} scores` : 'Average score',
      stats.scored ? `${stats.avgScore.toFixed(1)} / 10` : '—'],
    ['Rereads', String(stats.rereads)],
    ['Reading since', stats.firstDay ?? '—'],
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
      ? `${day} · ${d.chapters} ch · ${fmtDuration(d.seconds)}`
      : `${day} · nothing read`;
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
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = s.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${s.chapters} chapters · ${fmtDuration(s.seconds)}`;
    meta.append(t, sub);
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
    label.textContent = STATUS_LABELS[s];
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
  list.textContent = 'Loading…';
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
    const t = document.createElement('span');
    t.className = 'title';
    // A series you removed is still a series you read — the totals count it, so
    // the list has to show it rather than quietly disagree with them.
    t.textContent = r.title + (r.removed ? ' (removed)' : '');
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = [
      r.chapterLabel || 'Chapter',
      r.pages ? `${r.pages} pages` : null,
      r.seconds ? fmtDuration(r.seconds) : null,
    ].filter(Boolean).join(' · ');
    meta.append(t, sub);
    row.appendChild(meta);
    list.appendChild(row);
  }
}

$('history-clear').addEventListener('click', () => {
  if (!confirm('Delete every recorded read? Your library and bookmarks are not touched.')) return;
  // Worth saying out loud rather than swallowing: the user just confirmed a
  // deletion, and a list still on screen afterwards reads as "it did not take".
  guard('Could not clear your history', async () => {
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
      if (!live.canPush) sub.textContent += ' — but nothing can be sent to it yet';
    } else if (svc.configured) {
      sub.textContent = 'Not connected';
    } else if (svc.oauth) {
      sub.textContent = 'This PanelFlow server has no credentials for it';
    } else {
      // Not a missing key: the service only offers a password login, which
      // PanelFlow will not ask for. No amount of configuring changes that.
      sub.textContent = 'It asks for a password rather than a permission page, so PanelFlow does not connect it';
    }
    card.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'tracker-actions';
    if (live) {
      if (svc.canPush) {
        actions.appendChild(button('Send my library now', () => pushEverything(svc.service), {
          title: 'Bring the tracker up to date with every bookmark you already have',
        }));
      }
      actions.appendChild(button('Disconnect', () => disconnectTracker(svc.service)));
    } else if (svc.configured) {
      actions.appendChild(button('Connect', () => connectTracker(svc.service), { className: 'primary' }));
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
    if (!win) throw new Error('the browser blocked the window — allow popups for this site');
    trackerStatus(`Waiting for ${trackerName(service)}…`);
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
  if (!confirm(`Disconnect ${trackerName(service)}?\n\nNothing is removed from your `
    + 'tracker. PanelFlow forgets which series matched which, so reconnecting '
    + 'starts the matching over.')) return;
  try {
    await api(`/trackers/${service}`, { method: 'DELETE' });
    await loadTrackers();
  } catch (err) {
    trackerStatus(err.message);
  }
}

async function pushEverything(service) {
  trackerStatus(`Sending your library to ${trackerName(service)}…`);
  try {
    const r = await api(`/trackers/${service}/push`, { method: 'POST' });
    const parts = [`${r.pushed} sent`];
    if (r.skipped) parts.push(`${r.skipped} skipped`);
    if (r.failed) parts.push(`${r.failed} failed`);
    // The backend stops on a deadline rather than being killed mid-way, so
    // there can be a remainder — and the way to finish it is to ask again.
    if (r.remaining) parts.push(`${r.remaining} left — press again to carry on`);
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
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = link.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = {
      linked: `${trackerName(link.service)} · ${link.remoteTitle || link.remoteId}`
        + (link.lastChapter ? ` · sent up to chapter ${link.lastChapter}` : ''),
      unmatched: `${trackerName(link.service)} · no match found — pick it yourself`,
      muted: `${trackerName(link.service)} · never sent`,
    }[link.state] || `${trackerName(link.service)} · ${link.state}`;
    meta.append(t, sub);
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'tracker-actions';
    actions.appendChild(button(link.state === 'linked' ? 'Change' : 'Find it', () => openLinkDialog(link)));
    // Forgetting the row is the way back from a wrong answer: the next chapter
    // resolves the title again from scratch.
    actions.appendChild(button('Forget', () => forgetLink(link), {
      title: 'Match this one again from scratch on the next chapter you read',
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
  status.textContent = 'Searching…';
  try {
    const hits = await api(`/trackers/${linking.service}/search?q=${encodeURIComponent(q)}`);
    status.hidden = true;
    if (!hits.length) {
      status.hidden = false;
      status.textContent = 'Nothing came back for that.';
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
    throw new Error('this browser cannot unzip .gz — unzip the export first');
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
  if (!username && !file) throw new Error('give an AniList username or pick a MyAnimeList export');
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
  line(`${report.total} entries in the list`);
  line(`${report.added} to add · ${report.updated} to fill in · ${report.unchanged} already up to date`);
  if (report.progress) line(`${report.progress} will get a chapter bookmark`);
  for (const [what, titles] of [['New', report.samples.added], ['Filled in', report.samples.updated]]) {
    if (titles.length) line(`${what}: ${titles.join(', ')}${titles.length === 10 ? '…' : ''}`);
  }
}

$('import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('i-status');
  $('i-error').hidden = true;
  status.hidden = false;
  status.textContent = 'Reading the list…';
  try {
    // Always previewed first: an import touches the whole library at once, and
    // a run nobody looked at is not something you can undo entry by entry.
    renderReport(await runImport(true));
    status.textContent = 'Nothing has been written yet.';
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
  status.textContent = 'Importing…';
  try {
    const report = await runImport(false);
    renderReport(report);
    status.textContent = `Done — ${report.added} added, ${report.updated} updated.`;
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
  if (!res.ok) throw new Error(`export failed (${res.status})`);
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
  try { data = JSON.parse(await file.text()); } catch { throw new Error('that file is not JSON'); }
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
  line(`${report.added} to add · ${report.updated} to fill in · ${report.unchanged} already up to date`);
  line(`${report.bookmarks} bookmarks · ${report.reads} reads in the history`);
}

$('export-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('x-error').hidden = true;
  $('x-status').hidden = false;
  $('x-status').textContent = 'Reading the backup…';
  try {
    renderRestore(await runRestore(true));
    $('x-status').textContent = 'Nothing has been written yet.';
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
  $('x-status').textContent = 'Restoring…';
  try {
    const report = await runRestore(false);
    renderRestore(report);
    $('x-status').textContent = `Done — ${report.added} added, ${report.updated} updated.`;
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

$('migrate-open').addEventListener('click', () => {
  $('migrate-form').reset();
  const from = $('m-from');
  from.innerHTML = '';
  const counts = new Map();
  for (const e of library) counts.set(e.sourceDomain, (counts.get(e.sourceDomain) ?? 0) + 1);
  const any = document.createElement('option');
  any.value = '';
  any.textContent = `Every site (${library.length} series)`;
  from.appendChild(any);
  for (const [domain, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const opt = document.createElement('option');
    opt.value = domain;
    opt.textContent = `${domain} (${n})`;
    from.appendChild(opt);
  }
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
  status.textContent = 'Searching the new site for each series — this takes a while…';
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
    `${found.length} of ${plan.candidates.length} found on ${plan.toDomain}`,
    plan.truncated ? 'the search ran out of time — run it again for the rest' : null,
    plan.skipped ? `${plan.skipped} not searched` : null,
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
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = c.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    // The found title, not just the URL: the search matched by name and this is
    // where a wrong match shows itself before it is applied.
    sub.textContent = c.to ? `${c.to.foundTitle || c.to.sourceUrl}` : 'not found there';
    meta.append(t, sub);
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
  $('m-status').textContent = `Moving ${picked.length} series…`;
  try {
    const r = await api('/library/migrate-bulk', { method: 'POST', body: { items: picked } });
    const failed = r.results.filter((x) => !x.ok);
    $('m-status').textContent = `${r.moved} moved` +
      (failed.length ? ` · ${failed.length} refused: ${failed.map((f) => f.title ?? f.id).join(', ')}` : '');
    $('m-plan').hidden = true;
    btn.hidden = true;
    await refresh();
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

  let key;
  try {
    key = (await api('/push/key')).key;   // 503 on a deployment with no keys
  } catch { return; }

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
  btn.textContent = on ? '🔔' : '🔕';
  btn.disabled = denied && !on;
  btn.title = denied && !on
    ? 'This browser is blocking notifications for PanelFlow — allow them in the site settings'
    : on
      ? 'New chapters are announced even when PanelFlow is closed. Click to stop.'
      : 'Be told about new chapters even when PanelFlow is closed';
  btn.onclick = () => togglePush(on, key);

  // Only while alerts are on: with them off the route answers 409, which is a
  // worse way of saying what the 🔕 next to it already says.
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
  const n = (c, word) => `${c} ${word}${c === 1 ? '' : 's'}`;
  const parts = [];
  if (r.sent) parts.push(`${n(r.sent, 'browser')} took it`);
  if (r.dropped) {
    parts.push(`${n(r.dropped, 'subscription')} had expired and ${r.dropped === 1 ? 'was' : 'were'} removed`);
  }
  if (r.failed) parts.push(`${n(r.failed, 'browser')} could not be reached — try again later`);
  const head = parts.join(', ');
  return r.sent ? `${head}. If no notification appears, the server's keys are wrong.` : head;
}

async function testPush() {
  const btn = $('push-test');
  const status = $('check-status');
  btn.disabled = true;
  status.textContent = 'Sending a test notification…';
  try {
    const r = await api('/push/test', { method: 'POST' });
    // A dropped subscription may well be this browser's own, and the server has
    // just deleted the row: the 🔔 would keep claiming alerts are on with
    // nothing left to send them to. setupPush re-subscribes if the browser
    // still has one and paints 🔕 if it does not.
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
  if (!token) return showAuth();
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
  await guard('Could not load your library', enterApp);
})();
