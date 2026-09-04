// PanelFlow mobile shell — the screen you land on when you tap the icon.
//
// It never talks to the backend directly: every call goes through
// `PanelFlow.send`, which reaches the same message hub the Chrome extension's
// service worker exposes. So "add to library", "migrate this series to another
// site" and "how far am I" behave identically on a phone and in the browser,
// because they are literally the same code (shared/panelflow-core.js).
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const send = (msg) => window.PanelFlow.send(msg);

  // The net under every handler on this screen. It matters more here than in
  // the browser: a WebView has no console anyone is going to open, so a tap
  // whose `async` handler threw is a tap that did nothing, reported as "the app
  // froze". `bridge.js` already names the failures the worker sends back; this
  // names the ones that never got that far.
  window.addEventListener('unhandledrejection', (ev) => {
    const err = ev && ev.reason;
    console.warn(`[panelflow] unhandled: ${(err && err.message) || err}`, err);
  });

  // The folders, from the one file that names them (shared/folders.js), plus
  // whatever shelves the account has invented. "All" is a tab and not a folder,
  // so it is added here rather than living in the shared list.
  const { BUILTIN_IDS, DEFAULT_FOLDER, folderStatus, folderTabs, folderFor } = PanelFlowFolders;
  const tabs = () => [{ id: 'all' }, ...folderTabs(state.categories)];

  // A shelf of the reader's own is called what they called it; a built-in one is
  // called what this language calls it. folderTabs() hands back the English
  // label for both, which is right for exactly one of them.
  const tabLabel = (f) => (f.custom ? f.label : t('folder_' + f.id));

  const state = {
    view: 'library',
    backendUrl: null,
    folder: 'all',
    categories: [],  // the account's own shelves, cached by the core; [] signed out
    library: [],
    progress: {},
    targets: {},   // entry id -> where its cover leads, worked out by the core
    account: null,
    results: [],
    sites: [],        // every host the rules file names, sorted; [] until loaded
    favourites: [],   // in the order they were starred — see shared/prefs.js
    sitesLoaded: false,
  };

  // --- helpers -------------------------------------------------------------

  const el = (tag, props = {}, kids = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const k of [].concat(kids)) if (k) node.append(k);
    return node;
  };

  // Everything below renders user- and site-supplied strings. Building nodes
  // and assigning textContent (never innerHTML) is what keeps a series titled
  // `<img onerror=…>` from being a scripting hole in the app shell.
  const text = (tag, cls, value) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.textContent = value ?? '';
    return n;
  };

  let toastTimer = null;
  function toast(message) {
    // Not `t`: that name belongs to the translator now, and a local one here
    // would shadow it for anything this function later wants to say.
    const box = $('#toast');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
  }

  // "3 new" on a cover means the site is ahead of the bookmark, and the series
  // is in a folder that still follows it — a Completed one keeps whatever gap
  // the last check left behind and is not news. That rule is shared/library-
  // view.js's, the same one the popup and the web shelf colour their cards
  // with; the phone used to carry its own copy of the arithmetic, which is how
  // it ended up being the surface that still shouted about finished series.
  //
  // Rounded here and not there: half a chapter behind is a real measurement and
  // "2.5 new" is not a badge.
  const unread = (entry) => Math.round(
    PanelFlowView.newChapters(entry, state.progress[entry.sourceUrl], state.categories));

  // Covers are hotlink-protected on most scan sites: loading one straight into
  // an <img> gets a 403. The backend proxies them with the site as Referer.
  function coverSrc(entry) {
    if (!entry.coverUrl) return null;
    const base = state.backendUrl;
    if (!base) return entry.coverUrl;
    return `${base}/api/cover?url=${encodeURIComponent(entry.coverUrl)}` +
      `&ref=${encodeURIComponent(entry.sourceUrl || '')}`;
  }

  // --- library -------------------------------------------------------------

  // Reading status is shown as a colour on the cover rather than a word: at
  // grid density a label does not fit, and the folder is the only thing that
  // has to be readable at a glance. The stylesheet owns the palette; this only
  // says which folder the tile belongs to, falling back the same way the grid
  // filter does so an entry with no folder is not left uncoloured.
  //
  // A shelf of the user's own has no colour of its own: it is shown as the
  // built-in folder it stands for, which is what it counts as everywhere else.
  const folderOf = (entry) => {
    const folder = String(entry.folder || DEFAULT_FOLDER);
    if (BUILTIN_IDS.includes(folder)) return folder;
    return state.categories.some((c) => folderFor(c) === folder) ? folder : DEFAULT_FOLDER;
  };
  const statusOf = (entry) => folderStatus(folderOf(entry), state.categories);

  // CSS.escape is for identifiers, not URLs — it backslashes half of every
  // href. Inside a quoted url() the only characters that can end the string
  // early are the quote, the backslash and a raw newline.
  const cssUrl = (u) => `url("${String(u).replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, '')}")`;

  function thumb(entry) {
    const box = el('div', { className: 'thumb' });
    box.dataset.status = statusOf(entry);
    const src = coverSrc(entry);
    if (src) box.style.backgroundImage = cssUrl(src);
    else box.append(text('span', 'fallback', entry.title));
    const n = unread(entry);
    if (n > 0) box.append(text('span', 'badge', t('badgeNNew', [String(n)])));
    return box;
  }

  function tile(entry) {
    const btn = el('button', { className: 'tile', type: 'button' });
    const cover = thumb(entry);
    btn.append(cover, text('div', 'title', entry.title));
    const p = state.progress[entry.sourceUrl];
    btn.append(text('div', 'sub', p?.chapterLabel || entry.sourceDomain));
    btn.addEventListener('click', () => openSheet(entry));

    // Tapping the cover keeps reading; tapping the title opens the sheet. The
    // cover is the bigger target and reading is the commoner intent, so the
    // sheet is what you get when you deliberately aim past it. stopPropagation
    // because the cover sits inside the tile's own button.
    const target = state.targets[entry.id];
    if (target?.url) {
      cover.addEventListener('click', (e) => {
        e.stopPropagation();
        open(target.url, entry);
      });
    }
    return btn;
  }

  function renderLibrary() {
    const folders = $('#folders');
    const row = tabs();
    // A shelf can be deleted on another device while its tab is the open one.
    if (!row.some((f) => f.id === state.folder)) state.folder = 'all';
    folders.replaceChildren(...row.map((f) => {
      const b = el('button', { type: 'button', textContent: tabLabel(f) });
      // The same colour the covers carry, so the cue is learnable from the row
      // above the grid instead of having to be explained somewhere.
      if (f.id !== 'all') b.dataset.status = f.status || f.id;
      if (state.folder === f.id) b.className = 'on';
      b.addEventListener('click', () => { state.folder = f.id; renderLibrary(); });
      return b;
    }));

    const shown = state.library
      .filter((e) => state.folder === 'all' || folderOf(e) === state.folder)
      .sort((a, b) => unread(b) - unread(a) ||
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    $('#grid').replaceChildren(...shown.map(tile));
    // An empty folder inside a full library used to render a blank screen with
    // nothing to explain it, because the message only ever spoke about a
    // library with nothing in it at all.
    const empty = $('#library-empty');
    empty.hidden = shown.length > 0;
    if (shown.length === 0) {
      const folder = row.find((f) => f.id === state.folder);
      empty.textContent = state.library.length > 0
        ? t('mobileNothingFiled', [folder ? tabLabel(folder) : state.folder])
        : t('mobileLibraryEmpty');
    }

    // "Continue reading" is the reason to open the app at all, so it is only
    // what you can actually resume: a bookmark pointing at a real chapter.
    const cont = state.library
      .filter((e) => state.progress[e.sourceUrl]?.chapterUrl)
      .sort((a, b) => String(state.progress[b.sourceUrl].updatedAt || '')
        .localeCompare(String(state.progress[a.sourceUrl].updatedAt || '')))
      .slice(0, 12);
    $('#continue').hidden = cont.length === 0;
    $('#continue-row').replaceChildren(...cont.map((entry) => {
      const p = state.progress[entry.sourceUrl];
      const card = el('button', { className: 'card', type: 'button' });
      // Same target as the tile above: one series cannot lead two places.
      const target = state.targets[entry.id];
      card.append(thumb(entry), text('div', 'title', entry.title),
        text('div', 'label', target?.isNew
          ? t('badgeNewChapter', [target.label])
          : (p.chapterLabel || t('actionResume'))));
      card.addEventListener('click', () => open(target?.url || p.chapterUrl, entry));
      return card;
    }));
  }

  async function loadLibrary() {
    const [lib, prog, targets, settings, cats] = await Promise.all([
      send({ type: 'getLibrary' }),
      send({ type: 'getProgressAll' }),
      send({ type: 'continueTargets' }),
      send({ type: 'getSettings' }),
      send({ type: 'getCategories' }),
    ]);
    state.categories = cats?.categories || [];
    state.library = lib?.library || [];
    state.progress = prog?.progress || {};
    state.targets = targets?.targets || {};
    state.backendUrl = settings?.settings?.backendUrl || null;
    renderLibrary();
  }

  // --- entry sheet ---------------------------------------------------------

  function openSheet(entry) {
    const sheet = $('#sheet');
    const panel = el('div', { className: 'panel' });
    const p = state.progress[entry.sourceUrl];

    panel.append(text('h3', null, entry.title));
    panel.append(text('p', 'meta', [
      entry.sourceDomain,
      entry.lastKnownChapter ? t('mobileLatestCh', [String(entry.lastKnownChapter)]) : null,
      p?.chapterLabel ? t('mobileYouAreOn', [p.chapterLabel]) : t('mobileNotStarted'),
    ].filter(Boolean).join(' · ')));

    // Same target as the cover — the sheet says out loud what the tap does.
    const target = state.targets[entry.id];
    if (target?.isNew) {
      panel.append(button('btn', t('mobileReadNew', [target.label]), () => open(target.url, entry)));
    } else if (p?.chapterUrl) {
      panel.append(button('btn', t('actionContinueChapter', [p.chapterLabel || t('actionResume')]),
        () => open(target?.url || p.chapterUrl, entry)));
    }
    panel.append(button('btn ghost', t('actionOpenSeriesPage'), () => open(entry.sourceUrl, entry)));
    panel.append(button('btn ghost', t('mobileFindElsewhere'), () => findElsewhere(entry)));
    panel.append(button('btn ghost', t('actionCheckNow'), async () => {
      toast(t('statusChecking'));
      await send({ type: 'checkNow' });
      await loadLibrary();
      toast(t('statusUpToDate'));
    }));
    panel.append(button('btn ghost danger', t('actionRemoveFromLibrary'), async () => {
      await send({ type: 'removeFromLibrary', id: entry.id });
      closeSheet();
      await loadLibrary();
      toast(t('statusRemoved'));
    }));
    panel.append(button('btn ghost', t('actionCancel'), closeSheet));

    sheet.replaceChildren(panel);
    sheet.hidden = false;
    sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
  }

  const closeSheet = () => { $('#sheet').hidden = true; };

  function button(cls, label, onClick) {
    const b = el('button', { className: cls, type: 'button', textContent: label });
    b.addEventListener('click', onClick);
    return b;
  }

  // Reading a series whose site has gone down or gone bad is the case migration
  // exists for, so the sheet offers the search rather than making the user
  // retype the title — and the result, once opened, hits the same duplicate
  // detection the extension has.
  function findElsewhere(entry) {
    closeSheet();
    showView('search');
    $('#q').value = entry.title;
    $('#scans-only').checked = true;
    runSearch();
  }

  const open = (url, entry) => {
    closeSheet();
    window.PanelFlow.openUrl(url, entry ? { entryId: entry.id, title: entry.title } : null);
  };

  // --- search --------------------------------------------------------------

  // Looked up per call rather than built into a table at load: the reader can
  // change the language after this file has run.
  const VERDICT = {
    ready: 'mobileVerdictReady',
    likely: 'mobileVerdictLikely',
    unknown: 'mobileVerdictUnknown',
    unlikely: 'mobileVerdictUnlikely',
  };

  function renderResults() {
    $('#results').replaceChildren(...state.results.map((r) => {
      const card = el('button', { className: 'result', type: 'button' });
      card.append(text('div', 'rt', r.title), text('div', 'rd', r.domain || r.url));
      if (r.compat) {
        const chip = el('div', { className: `rc ${r.compat.verdict}` });
        chip.append(text('span', null, VERDICT[r.compat.verdict]
          ? t(VERDICT[r.compat.verdict]) : r.compat.verdict));
        if (r.compat.reason) chip.append(text('span', 'why', `· ${r.compat.reason}`));
        card.append(chip);
      }
      card.addEventListener('click', () => window.PanelFlow.openUrl(r.url, null));
      return card;
    }));
  }

  async function runSearch() {
    const q = $('#q').value.trim();
    if (!q) return;
    const status = $('#search-status');
    state.results = [];
    renderResults();
    status.textContent = t('statusSearching');
    status.hidden = false;
    try {
      const resp = await send({
        type: 'search', q, scans: $('#scans-only').checked, check: true,
      });
      if (resp?.error) throw new Error(resp.error);
      state.results = resp?.results || [];
      status.textContent = state.results.length ? '' : t('searchNoResults');
      status.hidden = state.results.length > 0;
      renderResults();
    } catch (e) {
      // Search is the one feature that needs the backend, so say which half
      // failed rather than showing an empty list.
      status.textContent = state.account
        ? t('mobileSearchFailed', [e.message])
        : t('mobileSearchNeedsAccount');
      status.hidden = false;
    }
  }

  // --- stats ---------------------------------------------------------------
  // Same two sources as the extension popup: the totals belong to the account,
  // because it is the only place that holds what every device read, and the log
  // is this phone's own copy — so the tab is not empty on a plane.

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return t('durationSeconds', [String(s)]);
    const mins = Math.round(s / 60);
    if (mins < 60) return t('durationMinutes', [String(mins)]);
    return t('durationHours', [String(Math.floor(mins / 60)), String(mins % 60).padStart(2, '0')]);
  }

  /** The reader's own calendar, matching the day the core stamps reads with. */
  function localDay(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function dayShift(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  async function loadStats() {
    // The local log is a storage read and paints immediately; the stats call can
    // hang on a backend that is asleep, and must not hold the tab blank.
    send({ type: 'getHistory' }).then((r) => renderLog(r?.history || []));
    const resp = await send({ type: 'getStats' }).catch((e) => ({ error: String(e.message || e) }));
    renderStats(resp?.stats || null, resp?.error || null);
  }

  function statCard(label, value) {
    const card = el('div', { className: 'stat-card' });
    card.append(text('div', 'n', value), text('div', 'k', label));
    return card;
  }

  function renderStats(stats, error) {
    const note = $('#stats-note');
    $('#stat-chart').replaceChildren();
    $('#stat-top').replaceChildren();
    $('#stat-chart-head').hidden = true;
    $('#stat-top-head').hidden = true;

    if (!stats) {
      $('#stat-cards').replaceChildren();
      note.hidden = false;
      // Signed out and unreachable are different problems with different fixes,
      // and telling someone to sign in when they already are sends them nowhere.
      note.textContent = error
        ? t('statsLoadError', [error])
        : t('mobileStatsSignedOut');
      return;
    }
    note.hidden = true;

    $('#stat-cards').replaceChildren(
      statCard(t('statChaptersRead'), String(stats.chapters)),
      statCard(t('statTimeRead'), fmtDuration(stats.seconds)),
      statCard(t('statSeriesRead'), String(stats.series)),
      statCard(t('statPerReadingDay'), fmtDuration(stats.secondsPerDay)),
      statCard(t('statCurrentStreak'), t('statDays', [String(stats.current)])),
      statCard(t('statLongestStreak'), t('statDays', [String(stats.longest)])),
      statCard(t('statInLibrary'), String(stats.entries)),
      statCard(stats.scored ? t('statAverageOfN', [String(stats.scored)]) : t('statAverageScore'),
        stats.scored ? `${stats.avgScore.toFixed(1)} / 10` : '—'));

    // Thirty calendar days, not the last thirty days that were read: the gaps
    // are what the chart is for.
    const byDay = new Map(stats.days.map((d) => [d.day, d.seconds]));
    const window30 = Array.from({ length: 30 }, (_, i) => dayShift(localDay(), i - 29));
    const peak = Math.max(...window30.map((d) => byDay.get(d) || 0), 1);
    if (stats.chapters) {
      $('#stat-chart-head').hidden = false;
      $('#stat-chart').replaceChildren(...window30.map((day) => {
        const secs = byDay.get(day) || 0;
        const col = el('div', { className: 'bar-col' });
        const bar = el('div', {
          className: 'bar' + (secs ? '' : ' empty'),
          title: t('mobileChartDay', [day, fmtDuration(secs)]),
        });
        bar.style.height = secs ? `${Math.max(6, Math.round((secs / peak) * 100))}%` : '3px';
        col.append(bar);
        return col;
      }));
    }

    $('#stat-top-head').hidden = stats.topSeries.length === 0;
    $('#stat-top').replaceChildren(...stats.topSeries.slice(0, 5).map((s) => {
      const row = el('div', { className: 'top-row' });
      const cover = el('div', { className: 'top-thumb' });
      const src = coverSrc({ coverUrl: s.coverUrl, sourceUrl: '' });
      if (src) cover.style.backgroundImage = cssUrl(src);
      row.append(cover, text('div', 't', s.title),
        text('div', 'n', t('statChaptersAndTime', [String(s.chapters), fmtDuration(s.seconds)])));
      return row;
    }));
  }

  function renderLog(history) {
    $('#stat-log-empty').hidden = history.length > 0;

    // By day first, then by when it was touched: a row gains seconds every time
    // the chapter is reopened, so ordering on `at` alone splits a day in two.
    const rows = [...history].sort((a, b) =>
      String(b.day).localeCompare(String(a.day)) || String(b.at).localeCompare(String(a.at)));

    const today = localDay();
    const nodes = [];
    let day = null;
    for (const r of rows.slice(0, 80)) {
      if (r.day !== day) {
        day = r.day;
        nodes.push(text('div', 'log-day', day === today ? t('dayToday')
          : (day === dayShift(today, -1) ? t('dayYesterday') : day)));
      }
      const entry = state.library.find((e) => e.sourceUrl === r.sourceUrl);
      const row = el('button', { className: 'log-row', type: 'button' });
      // The chapter is its own column rather than a suffix on the title: inside
      // it, a long series name eats the ellipsis and the log stops saying which
      // chapter was read, which is most of what a log is for.
      row.append(text('span', 't', entry?.title || hostOf(r.chapterUrl)),
        text('span', 'sub', r.chapterLabel || ''),
        text('span', 'n', fmtDuration(r.seconds)));
      row.addEventListener('click', () => open(r.chapterUrl, entry));
      nodes.push(row);
    }
    $('#stat-log').replaceChildren(...nodes);
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return url || ''; }
  }

  // --- account -------------------------------------------------------------

  function renderAccount() {
    const panel = $('#account-panel');
    panel.replaceChildren();

    if (state.account) {
      const who = el('p', { className: 'who' });
      who.append(document.createTextNode(t('mobileSignedInAs')), text('b', null, state.account.email));
      panel.append(who);
      panel.append(button('btn', t('actionSyncNow'), async () => {
        toast(t('statusSyncing'));
        await send({ type: 'pullNow' });
        await send({ type: 'syncNow' });
        await loadLibrary();
        toast(t('statusSynced'));
      }));
      panel.append(button('btn ghost', t('mobileMergeDuplicates'), async () => {
        const r = await send({ type: 'dedupeLibrary' });
        await loadLibrary();
        toast(r?.removed ? t('mobileMerged', [String(r.removed)]) : t('mobileNoDuplicates'));
      }));
      panel.append(button('btn ghost', t('actionSignOut'), async () => {
        await send({ type: 'logout' });
        state.account = null;
        renderAccount();
      }));
      $('#account').textContent = state.account.email;
      return;
    }

    $('#account').textContent = t('actionSignIn');
    const email = field(t('fieldEmail'), 'email', 'email');
    const pass = field(t('fieldPassword'), 'password', 'current-password');
    const err = el('p', { className: 'err', hidden: true });
    const submit = async (kind) => {
      err.hidden = true;
      try {
        const r = await send({
          type: 'auth', kind, email: email.input.value.trim(), password: pass.input.value,
        });
        if (r?.error) throw new Error(r.error);
        state.account = r.user;
        // The hub pulls these as part of signing in and hands them back with
        // the user, so the app takes the account's theme in the same breath as
        // its library rather than a repaint later.
        adoptLook(r);
        renderAccount();
        toast(t('statusSignedIn'));
        // The sign-in itself kicks off a pull; give it a moment, then repaint.
        setTimeout(loadLibrary, 1500);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    };
    panel.append(email.wrap, pass.wrap,
      button('btn', t('actionSignIn'), () => submit('login')),
      button('btn ghost', t('actionCreateAccount'), () => submit('register')),
      err);
    panel.append(el('p', { className: 'hint', textContent: t('mobileAccountHint') }));
  }

  function field(label, type, autocomplete) {
    const wrap = el('div', { className: 'field' });
    const input = el('input', { type, autocomplete, autocapitalize: 'none', spellcheck: false });
    wrap.append(el('label', { textContent: label }), input);
    return { wrap, input };
  }

  // --- sites ---------------------------------------------------------------
  //
  // The only screen on the phone that can start a first read. Everything else
  // needs a URL you already have: the library needs an entry, search needs a
  // query that found one. A fresh install has neither, and before this tab the
  // app could not reach a scan site at all unless a link was shared into it.
  //
  // The list and its order are the same two answers the extension's popup and
  // the website's sites page give, from the same two sources — `getRules` for
  // what exists, `favouriteSites` for the sites this reader marked here or on
  // the website, which is also the order the extension's popup shows them in.

  /** `*.example.com` and `example.com` are the same site to a person. */
  const bareHost = (pattern) => String(pattern || '').replace(/^\*\./, '').trim();

  async function loadSites() {
    if (state.sitesLoaded) { renderSites(); return; }
    const note = $('#sites-note');
    note.hidden = true;
    try {
      // Asked together and failing together: half this screen is the list and
      // half is the order. The prefs call is the cached one — the pull happens
      // at boot, and a starred site has to appear under a thumb immediately.
      const [rules, prefs] = await Promise.all([
        send({ type: 'getRules' }),
        send({ type: 'getAccountPrefs' }),
      ]);
      const seen = new Set();
      for (const key of Object.keys(rules?.rules?.domains || {})) {
        const host = bareHost(key);
        if (host && !host.includes('*')) seen.add(host);
      }
      state.sites = [...seen].sort((a, b) => a.localeCompare(b));
      state.favourites = (prefs?.prefs?.favouriteSites || []).filter(Boolean);
      state.sitesLoaded = true;
    } catch {
      // Not a blank screen. The list is a convenience — the reader still works
      // on a page reached any other way, and that is the part worth saying.
      state.sites = [];
      note.hidden = false;
      note.textContent = t('webSitesUnavailable');
    }
    renderSites();
  }

  function renderSites() {
    // Starred first, in the order they were starred, and including any whose
    // tuned rule has since been retired — a site somebody said they read does
    // not stop being one because we stopped shipping a rule for it.
    const rest = state.sites.filter((host) => !state.favourites.includes(host));
    $('#sites-yours').replaceChildren(...state.favourites.map((h) => siteRow(h, true)));
    $('#sites-all').replaceChildren(...rest.map((h) => siteRow(h, false)));

    $('#sites-yours-head').hidden = state.favourites.length === 0;
    // No heading over the only list on the screen: "All sites" above the whole
    // tab is a label for nothing.
    $('#sites-all-head').hidden = state.favourites.length === 0 || rest.length === 0;
  }

  function siteRow(host, pinned) {
    const row = el('div', { className: pinned ? 'site on' : 'site' });

    const open = el('button', { className: 'site-open', type: 'button' });
    const mono = text('span', 'site-mono', host.charAt(0).toUpperCase());
    mono.setAttribute('aria-hidden', 'true');
    open.append(mono, text('span', 'site-host', host));
    // Straight into the in-app browser, with the content scripts injected —
    // the same place a shared link and a library cover land.
    open.addEventListener('click', () => window.PanelFlow.openUrl('https://' + host + '/', null));

    const star = el('button', {
      className: 'site-star', type: 'button', textContent: pinned ? '★' : '☆',
    });
    star.setAttribute('aria-pressed', String(pinned));
    star.title = t(pinned ? 'webSitesUnpin' : 'webSitesPin');
    star.addEventListener('click', () => toggleFavourite(host));

    row.append(open, star);
    return row;
  }

  async function toggleFavourite(host) {
    const was = state.favourites;
    state.favourites = was.includes(host)
      ? was.filter((h) => h !== host)
      : [...was, host];
    // Drawn first and saved after. A failed write is worth a word, but not
    // worth snapping a star back under somebody's finger — and signed out
    // there is no account to refuse it, so the answer stays on the device.
    renderSites();
    try {
      await send({ type: 'setAccountPrefs', patch: { favouriteSites: state.favourites } });
    } catch {
      state.favourites = was;
      renderSites();
      toast(t('webSitesUnavailable'));
    }
  }

  // --- views ---------------------------------------------------------------

  function showView(view) {
    state.view = view;
    for (const section of document.querySelectorAll('.view')) {
      section.hidden = section.id !== `view-${view}`;
    }
    for (const b of document.querySelectorAll('#tabs button')) {
      b.classList.toggle('on', b.dataset.view === view);
    }
    if (view === 'account') renderAccount();
    if (view === 'search') $('#q').focus();
    if (view === 'stats') loadStats();
    if (view === 'sites') loadSites();
  }

  /**
   * The hardware/gesture back button, handed down by the native shell.
   *
   * Returns true when the app consumed it. On Android, back that always meant
   * "quit" would close the whole app on the first tap out of an open sheet,
   * which is the wrong thing every time; on iOS this is the swipe-back edge.
   * Deepest layer first, and the library tab is the floor.
   */
  window.PanelFlowShell = {
    back() {
      if (!$('#sheet').hidden) { closeSheet(); return true; }
      if (state.view !== 'library') { showView('library'); return true; }
      return false;
    },
  };

  // --- boot ----------------------------------------------------------------

  /**
   * Take the account's look, if it has an opinion and it differs from this
   * device's.
   *
   * The phone has no settings screen of its own — there is nothing here to
   * change the theme or the language with, which is exactly why it has to be
   * told. Both answers are set in the extension's options or on the website and
   * arrive here; 'system' is a real answer among the three themes and means this
   * handset asks Android or iOS, and 'auto' is its equal for the language.
   *
   * shared/theme.js and shared/i18n.js have already painted the page from what
   * this device last heard, so this is a correction and never a first draw. The
   * language needs the repaint the theme does not: a stylesheet reacts to the
   * attribute on its own, and a sentence does not. See shared/prefs.js.
   */
  function adoptLook(reply) {
    window.panelflowTheme.adopt(reply?.prefs?.theme);
    if (PanelFlowI18n.adopt(reply?.prefs?.uiLang)) redrawEverything();
  }

  /**
   * Everything on screen that i18n.apply() cannot reach.
   *
   * apply() fills the annotated markup; the grid, the shelf row, the stats and
   * the account panel are built from data and carry sentences no attribute knows
   * about.
   */
  function redrawEverything() {
    renderLibrary();
    renderResults();
    renderSites();
    renderAccount();
    if (state.view === 'stats') loadStats();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    for (const b of document.querySelectorAll('#tabs button')) {
      b.addEventListener('click', () => showView(b.dataset.view));
    }
    PanelFlowI18n.apply();
    $('#account').addEventListener('click', () => showView('account'));
    $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });

    if (!window.PanelFlow.available) {
      $('#library-empty').hidden = false;
      $('#library-empty').textContent = t('mobileNoBridge');
      return;
    }

    // Coming back from the in-app browser is the moment the library is most
    // likely to be stale — the user just read a chapter.
    window.PanelFlow.on('resumed', loadLibrary);
    window.PanelFlow.on('ready', loadLibrary);

    state.account = (await send({ type: 'getAccount' }))?.authUser || null;
    // The cached answer first, and instantly: it is already on the device, and
    // the shell has been painted from this same value since <head> ran, so it
    // almost always changes nothing. Then a pull, which is the one that catches
    // a theme chosen on the desktop while the phone was in a pocket.
    adoptLook(await send({ type: 'getAccountPrefs' }));
    await loadLibrary();
    renderAccount();
    send({ type: 'pullAccountPrefs' }).then(adoptLook, () => {});
  });
})();
