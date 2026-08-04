'use strict';

const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const $ = (sel) => document.querySelector(sel);

const state = {
  library: [],
  progress: {},
  tab: null,
  host: null,
  detected: false,
  readerOpen: false,
};

// --- boot -------------------------------------------------------------------

async function load() {
  const [libResp, progResp, acct] = await Promise.all([
    send({ type: 'getLibrary' }),
    send({ type: 'getProgressAll' }),
    send({ type: 'getAccount' }),
  ]);
  state.library = libResp.library || [];
  state.progress = progResp.progress || {};

  // Hotlink-protected covers: have the background install per-domain Referer
  // rules before the <img> requests fire, or the CDN 403s them.
  const pairs = state.library
    .filter((e) => e.coverUrl)
    .map((e) => ({ imgUrl: e.coverUrl, siteUrl: e.sourceUrl }));
  if (pairs.length) await send({ type: 'coverRules', pairs });

  // Signed out, "local only" is a dead end: make it the way in, since nothing
  // syncs to the web app until an account exists.
  const account = $('#account');
  account.textContent = acct.authUser ? acct.authUser.email : 'local only — sign in';
  account.classList.toggle('actionable', !acct.authUser);
  account.onclick = acct.authUser ? null : () => chrome.runtime.openOptionsPage();
  renderLibrary('');
  renderRecent();
}

// The active tab drives three things: the "Add to library" / reader buttons,
// and whether the per-site settings group is shown at all.
async function loadPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;
  try {
    state.host = tab?.url ? new URL(tab.url).hostname : null;
  } catch { state.host = null; }

  // No active tab is a real state (the popup can be opened over devtools or the
  // tab strip), and reading `tab.id` off undefined threw *before* the .catch,
  // rejecting this function and leaving the auto-show controls unpainted.
  const resp = tab?.id
    ? await chrome.tabs.sendMessage(tab.id, { type: 'readerState' }).catch(() => null)
    : null;
  state.detected = !!resp?.detected;
  state.readerOpen = !!resp?.open;

  const readerBtn = $('#toggle-reader');
  readerBtn.querySelector('.label').textContent =
    state.readerOpen ? 'Hide reader' : 'Show reader';
  readerBtn.classList.toggle('is-active', state.readerOpen);
  readerBtn.disabled = !state.detected && !state.readerOpen;
  $('#add-current').disabled = !state.detected;

  if (state.host) {
    $('#site-host').textContent = state.host;
    $('#site-group').hidden = false;
  }
  await renderAutoShow();
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
    img.src = entry.coverUrl;
    img.addEventListener('error', () => img.classList.add('placeholder'), { once: true });
  } else {
    img.classList.add('placeholder');
  }
}

function renderLibrary(filter) {
  const list = $('#library-list');
  list.innerHTML = '';
  list.className = 'grid';
  const items = state.library
    .filter((e) => e.title.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  $('#library-empty').hidden = items.length > 0 || !!filter;
  // The filter box only earns its space once the list is long enough to need it.
  $('#search').hidden = state.library.length < 6;

  for (const entry of items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-art"><img alt=""><span class="card-badge"></span></div>
      <div class="card-title"></div>
      <div class="card-ch"></div>`;
    coverInto(card.querySelector('img'), entry);
    card.querySelector('.card-title').textContent = entry.title;
    card.querySelector('.card-badge').textContent = entry.folder || 'reading';

    const read = chapterNum(state.progress[entry.sourceUrl]?.chapterLabel);
    const latest = chapterNum(entry.lastKnownChapter);
    const ch = card.querySelector('.card-ch');
    ch.textContent = read !== null ? `Ch.${read}` : (latest !== null ? `Ch.${latest}` : '');
    if (read !== null && latest !== null) {
      const total = document.createElement('span');
      total.className = 'total';
      total.textContent = ` / ${latest}${entry.seriesStatus === 'ongoing' ? '+' : ''}`;
      ch.appendChild(total);
    }
    card.addEventListener('click', () => openEntry(entry.id));
    list.appendChild(card);
  }
}

// --- entry detail -----------------------------------------------------------

const FOLDERS = ['reading', 'paused', 'plan', 'completed', 'dropped'];
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
  if (onEdit) row.addEventListener('click', onEdit);
  return row;
}

function openEntry(id) {
  const entry = state.library.find((e) => e.id === id);
  if (!entry) return;
  const progress = state.progress[entry.sourceUrl];
  const body = $('#entry-body');
  // Editing any field rebuilds this panel, so the offset has to survive it:
  // rereads and the dates sit low in a scrolling sheet, and changing one used
  // to throw the reader back up to the cover.
  const prevScroll = body.scrollTop;
  body.innerHTML = '';

  const patch = async (p) => {
    await send({ type: 'updateEntry', id: entry.id, patch: p });
    Object.assign(entry, p);
    openEntry(id);
    renderLibrary($('#search').value);
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
  name.textContent = entry.title;
  const dom = document.createElement('div');
  dom.className = 'dom';
  dom.textContent = entry.sourceDomain;
  who.append(name, dom);
  hero.append(img, who);
  body.appendChild(hero);

  // progress + when
  const read = chapterNum(progress?.chapterLabel);
  const latest = chapterNum(entry.lastKnownChapter);
  const progRow = frow(ICONS.progress, 'Progress',
    read !== null
      ? `Ch. ${read}${latest !== null ? ` / ${latest}${entry.seriesStatus === 'ongoing' ? '+' : ''}` : ''}`
      : (latest !== null ? `Ch. — / ${latest}` : '—'));
  if (progress?.updatedAt) {
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = ago(progress.updatedAt);
    progRow.appendChild(when);
  }
  body.appendChild(progRow);

  body.appendChild(selectRow(ICONS.folder, 'Folder', FOLDERS, entry.folder || 'reading',
    (v) => patch({ folder: v })));
  body.appendChild(selectRow(ICONS.language, 'Language', ['—', ...LANGUAGES], entry.language || '—',
    (v) => patch({ language: v === '—' ? null : v })));
  body.appendChild(selectRow(ICONS.score, 'Score',
    ['—', ...Array.from({ length: 10 }, (_, i) => String(i + 1))],
    entry.score ? String(entry.score) : '—',
    (v) => patch({ score: v === '—' ? null : Number(v) })));

  body.appendChild(textRow(ICONS.note, 'Note', entry.note, (v) => patch({ note: v || null })));
  body.appendChild(dateRow(ICONS.date, 'Start date', entry.startDate, (v) => patch({ startDate: v })));
  body.appendChild(dateRow(ICONS.date, 'Finish date', entry.finishDate, (v) => patch({ finishDate: v })));
  body.appendChild(numRow(ICONS.rereads, 'Rereads', entry.rereads, (v) => patch({ rereads: v })));

  // tags
  const tagRow = document.createElement('div');
  tagRow.className = 'frow' + ((entry.tags || []).length ? ' set' : '');
  tagRow.appendChild(icon(ICONS.tags));
  if ((entry.tags || []).length) {
    const wrap = document.createElement('span');
    wrap.className = 'tags';
    for (const t of entry.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = t;
      wrap.appendChild(chip);
    }
    tagRow.appendChild(wrap);
  } else {
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = 'Tags';
    tagRow.appendChild(k);
  }
  body.appendChild(tagRow);

  // trackers — no OAuth yet, so these open a search rather than pretending to link
  for (const [label, url] of [
    ['MyAnimeList', 'https://myanimelist.net/manga.php?q='],
    ['AniList', 'https://anilist.co/search/manga?search='],
    ['MangaUpdates', 'https://www.mangaupdates.com/series.html?search='],
  ]) {
    const row = frow(ICONS.link, label, '', () =>
      chrome.tabs.create({ url: url + encodeURIComponent(entry.title) }));
    row.classList.add('link');
    body.appendChild(row);
  }

  // remove
  const rm = frow(ICONS.tags, 'Remove from library', '', async () => {
    await send({ type: 'removeFromLibrary', id: entry.id });
    state.library = state.library.filter((x) => x.id !== entry.id);
    $('#entry-panel').hidden = true;
    renderLibrary($('#search').value);
  });
  rm.style.color = 'var(--danger)';
  body.appendChild(rm);

  // action bar
  $('#entry-chapters').onclick = () => chrome.tabs.create({ url: entry.sourceUrl });
  const resume = $('#entry-resume');
  const target = progress?.chapterUrl || entry.sourceUrl;
  resume.textContent = read !== null ? `Ch. ${read}` : 'Open';
  resume.onclick = () => chrome.tabs.create({ url: target });

  $('#entry-panel').hidden = false;
  body.scrollTop = prevScroll;
}

// --- editable row builders --------------------------------------------------

function selectRow(iconPath, label, options, current, onChange) {
  const row = document.createElement('div');
  row.className = 'frow' + (current && current !== '—' ? ' set' : '');
  row.appendChild(icon(iconPath));
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o[0].toUpperCase() + o.slice(1);
    if (o === current) opt.selected = true;
    sel.appendChild(opt);
  }
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
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current || '';
  input.placeholder = 'none';
  // Commit on blur as well as Enter: closing the popup otherwise loses it.
  input.addEventListener('change', () => onCommit(input.value.trim()));
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
  const input = document.createElement('input');
  input.type = 'date';
  input.value = current || '';
  input.addEventListener('change', () => onCommit(input.value || null));
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
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.value = current ?? 0;
  input.style.maxWidth = '70px';
  input.addEventListener('change', () => onCommit(Number(input.value) || 0));
  row.append(k, input);
  return row;
}

function renderRecent() {
  const list = $('#recent-list');
  list.innerHTML = '';
  const items = Object.values(state.progress)
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
      <button class="remove" title="Remove from history">✕</button>`;
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
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
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

function toast(text, kind = '') {
  const el = $('#toast');
  el.hidden = !text;
  el.textContent = text;
  el.className = kind;
}

// The details sheet is rendered by the content script, on the page: a 340px
// popup is too cramped for it, and the popup closes the moment focus moves.
$('#add-current').addEventListener('click', async () => {
  const btn = $('#add-current');
  btn.disabled = true;
  toast('Reading page…');
  try {
    if (!state.tab?.id) throw new Error('no active tab');
    const resp = await chrome.tabs
      .sendMessage(state.tab.id, { type: 'openLibraryModal' })
      .catch(() => { throw new Error('Not a readable page — reload it and retry.'); });
    if (!resp?.ok) throw new Error(resp?.error || 'Could not read this page.');
    window.close();
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = !state.detected;
  }
});

$('#toggle-reader').addEventListener('click', async () => {
  if (!state.tab?.id) return;
  const resp = await chrome.tabs
    .sendMessage(state.tab.id, { type: 'toggleReader' })
    .catch(() => null);
  if (resp?.ok) window.close(); // let the reader take the stage
  else toast(resp?.error || 'Not a readable page — reload it and retry.', 'err');
});

// The web app is served by the backend, which is often simply not running.
// Probe it first rather than opening a tab onto a connection error.
$('#open-app').addEventListener('click', async () => {
  const { settings } = await chrome.storage.local.get(['settings']);
  const base = settings?.backendUrl || 'http://localhost:8787';
  toast('Connecting…');
  const reachable = await fetch(base + '/api/rules', { method: 'GET' })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    toast(`${base} is not responding — start the backend (npm start in /backend).`, 'err');
    return;
  }
  toast('');
  chrome.tabs.create({ url: base + '/' });
});

// --- compatible sites panel -------------------------------------------------
// PanelFlow detects heuristically, so there is no authoritative site list.
// What is worth showing: domains shipping tuned extraction rules, and domains
// the user already reads (proof they work).

let sites = [];

$('#open-sites').addEventListener('click', async () => {
  const { rulesCache } = await chrome.storage.local.get(['rulesCache']);
  const tuned = Object.keys(rulesCache?.rules?.domains || {});
  const known = new Map();
  for (const host of tuned) known.set(host, 'tuned');
  for (const entry of state.library) {
    if (entry.sourceDomain && !known.has(entry.sourceDomain)) {
      known.set(entry.sourceDomain, 'library');
    }
  }
  sites = [...known].map(([host, kind]) => ({ host, kind })).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'tuned' ? -1 : 1;
    return a.host.localeCompare(b.host);
  });
  renderSites('');
  $('#sites-panel').hidden = false;
  $('#sites-search').focus();
});

$('#sites-back').addEventListener('click', () => { $('#sites-panel').hidden = true; });
$('#entry-back').addEventListener('click', () => { $('#entry-panel').hidden = true; });
$('#sites-search').addEventListener('input', (e) => renderSites(e.target.value));

function renderSites(filter) {
  const list = $('#sites-list');
  list.innerHTML = '';
  const items = sites.filter((s) => s.host.includes(filter.trim().toLowerCase()));
  $('#sites-none').hidden = items.length > 0;

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
    badge.textContent = kind === 'tuned' ? 'tuned rules' : 'in library';
    badge.classList.toggle('tuned', kind === 'tuned');
    row.addEventListener('click', () => chrome.tabs.create({ url: `https://${host}/` }));
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

// --- reading stats panel ----------------------------------------------------
// Two sources, deliberately: the totals come from the account, because it holds
// what every device read; the log below is this device's local copy, so the
// panel still says something useful while signed out or offline.

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}`;
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
    // Signed out and unreachable are different problems with different fixes,
    // and telling someone to sign in when they already are sends them nowhere.
    note.textContent = error
      ? `Statistics could not be loaded: ${error}. What you read on this device is kept below.`
      : 'Statistics live on your account — sign in to see them. '
        + 'What you read on this device is kept below either way.';
    return;
  }
  note.hidden = true;

  const tiles = [
    ['Chapters read', String(stats.chapters)],
    ['Time read', fmtDuration(stats.seconds)],
    ['Series read', String(stats.series)],
    ['Per reading day', fmtDuration(stats.secondsPerDay)],
    ['Current streak', `${stats.current} d`],
    ['Longest streak', `${stats.longest} d`],
    ['In library', String(stats.entries)],
    [stats.scored ? `Average of ${stats.scored} scores` : 'Average score',
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
      bar.title = `${day} — ${fmtDuration(secs)}`;
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
      head.textContent = day === today ? 'Today'
        : (day === dayShift(today, -1) ? 'Yesterday' : day);
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
    url: 'https://github.com/panelflow/panelflow/issues/new?title=' +
      encodeURIComponent('Site issue: ' + (state.host || '')) +
      '&body=' + encodeURIComponent(`Page: ${url}\nExtension: ${chrome.runtime.getManifest().version}\n\nWhat went wrong:\n`),
  });
});

$('#search').addEventListener('input', (e) => renderLibrary(e.target.value));

$('#check-now').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Checking…';
  await send({ type: 'checkNow' });
  e.target.disabled = false;
  e.target.textContent = 'Check for new chapters';
  load();
});

$('#open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

initGroups();
load();
loadPageContext();
// Opportunistic catch-up: push local library/progress to the backend, then
// re-render with any covers/chapters the sync backfilled.
send({ type: 'syncNow' }).then(load);
