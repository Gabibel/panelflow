'use strict';

// Same-origin when served by the backend; override with ?api=<url> for dev.
const API = new URLSearchParams(location.search).get('api') ?? '';
// The same five ids the backend validates and the extension writes. Adding one
// here without adding it there makes every PUT from this page a 400.
const STATUSES = ['reading', 'paused', 'plan', 'completed', 'dropped'];
const STATUS_LABELS = {
  reading: 'Reading', paused: 'Paused', plan: 'Plan',
  completed: 'Complete', dropped: 'Dropped',
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
let activeTab = 'all';
let activeView = 'library';

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

// Status is the `folder` column. It used to be a "status:<x>" tag here and the
// database migration promoted those tags into the column — but this page kept
// reading the tag, so it showed "Reading" for every entry the extension had
// ever added and its dropdown wrote a tag no other client looks at.
const statusOf = (entry) => {
  const s = String(entry.folder || 'reading');
  return STATUSES.includes(s) ? s : 'reading';
};

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

/* ---------- Auth ---------- */

function showAuth() {
  $('auth-view').hidden = false;
  $('app-view').hidden = true;
}

function signOut() {
  token = null;
  user = null;
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
    enterApp();
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
  await refresh();
}

async function refresh() {
  let progressRows;
  [library, continueList, progressRows] = await Promise.all([
    api('/library'),
    api('/progress/continue'),
    api('/progress'),
  ]);
  progressMap = Object.fromEntries(progressRows.map((p) => [p.libraryId, p]));
  renderContinue();
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

function renderLibrary() {
  const filter = $('search').value.toLowerCase();
  const grid = $('library-grid');
  grid.innerHTML = '';

  const items = library.filter((e) =>
    (activeTab === 'all' || statusOf(e) === activeTab) &&
    e.title.toLowerCase().includes(filter)
  );
  $('empty').hidden = items.length > 0;

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
    chip.textContent = STATUS_LABELS[statusOf(entry)];
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
    remove.addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/library/' + entry.id, { method: 'DELETE' });
      refresh();
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
    for (const s of STATUSES) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = STATUS_LABELS[s];
      select.appendChild(opt);
    }
    select.value = statusOf(entry);
    select.addEventListener('change', async () => {
      await api('/library/' + entry.id, {
        method: 'PUT',
        body: { folder: select.value },
      });
      refresh();
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

/* ---------- Tabs & search ---------- */

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  activeTab = tab.dataset.tab;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
  renderLibrary();
});

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
  $('f-status').value = entry ? statusOf(entry) : (activeTab === 'all' ? 'reading' : activeTab);
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

const VIEWS = ['library', 'stats', 'history'];

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

$('history-clear').addEventListener('click', async () => {
  if (!confirm('Delete every recorded read? Your library and bookmarks are not touched.')) return;
  await api('/history', { method: 'DELETE' });
  loadHistory();
});

/* ---------- Import ---------- */

$('import-open').addEventListener('click', () => {
  $('import-form').reset();
  $('i-status').hidden = true;
  $('i-error').hidden = true;
  $('i-report').hidden = true;
  $('i-run').hidden = true;
  $('import-dialog').showModal();
});
$('i-cancel').addEventListener('click', () => $('import-dialog').close());

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
  if (!username && !file) throw new Error('give an AniList username or pick a MyAnimeList export');
  const q = dryRun ? '?dryRun=1' : '';
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

/* ---------- Boot ---------- */

(async function boot() {
  if (!token) return showAuth();
  try {
    user = await api('/me');
    enterApp();
  } catch {
    signOut();
  }
})();
