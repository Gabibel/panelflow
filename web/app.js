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

let token = localStorage.getItem('pf.token');
let user = null;
let library = [];
let continueList = [];
let progressMap = {};          // libraryId -> progress row
let freshIds = new Set();      // entries whose latest chapter advanced at last check
let activeTab = 'all';

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
    const a = document.createElement('a');
    a.className = 'shelf-card';
    a.href = p.chapterUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.appendChild(coverEl(p));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<span class="title"></span><span class="sub"></span><span class="resume">Resume ▸</span>';
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

    const coverWrap = document.createElement('a');
    coverWrap.className = 'cover-wrap';
    coverWrap.href = entry.sourceUrl;
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

    const progLine = document.createElement('div');
    progLine.className = 'progress-line';
    const prog = progressMap[entry.id];
    if (prog) {
      const label = document.createElement('span');
      label.textContent = `${prog.chapterLabel || 'Chapter ?'} · p.${(prog.page ?? 0) + 1}${prog.pageCount ? '/' + prog.pageCount : ''}`;
      const resume = document.createElement('a');
      resume.href = prog.chapterUrl;
      resume.target = '_blank';
      resume.rel = 'noopener';
      resume.textContent = 'Resume ▸';
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
    body.append(title, sub, progLine, select);
    card.appendChild(body);
    grid.appendChild(card);
  }
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

$('add-series').addEventListener('click', () => {
  $('series-form').reset();
  $('f-status').value = activeTab === 'all' ? 'reading' : activeTab;
  $('dialog-error').hidden = true;
  $('f-scrape-status').hidden = true;
  $('f-cover-preview').hidden = true;
  scrapedLatestChapter = null;
  $('series-dialog').showModal();
});

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

$('series-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const url = new URL($('f-url').value);
    await api('/library', {
      method: 'POST',
      body: {
        title: $('f-title').value.trim(),
        coverUrl: $('f-cover').value || null,
        sourceDomain: url.hostname,
        sourceUrl: url.href,
        folder: $('f-status').value,
        lastKnownChapter: scrapedLatestChapter !== null ? String(scrapedLatestChapter) : null,
      },
    });
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
