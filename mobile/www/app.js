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

  const FOLDERS = [
    { id: 'all', label: 'All' },
    { id: 'reading', label: 'Reading' },
    { id: 'plan', label: 'Plan to read' },
    { id: 'completed', label: 'Completed' },
    { id: 'paused', label: 'Paused' },
    { id: 'dropped', label: 'Dropped' },
  ];

  const EMPTY_LIBRARY =
    'Nothing here yet. Search for a series, open it, and add it from the reader.';

  const state = {
    view: 'library',
    backendUrl: null,
    folder: 'all',
    library: [],
    progress: {},
    account: null,
    results: [],
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
    const t = $('#toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  const chapterNum = (label) => {
    const m = String(label ?? '').match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : NaN;
  };

  // "3 new" on a cover means the site is ahead of the bookmark. Both numbers
  // are strings scraped off pages, so a missing or unparseable one means no
  // badge rather than a wrong one.
  function unread(entry) {
    const latest = chapterNum(entry.lastKnownChapter);
    const read = chapterNum(state.progress[entry.sourceUrl]?.chapterLabel);
    if (Number.isNaN(latest) || Number.isNaN(read)) return 0;
    return Math.max(0, Math.round(latest - read));
  }

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
  const STATUSES = new Set(FOLDERS.map((f) => f.id).filter((id) => id !== 'all'));
  const statusOf = (entry) => {
    const folder = String(entry.folder || 'reading');
    return STATUSES.has(folder) ? folder : 'reading';
  };

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
    if (n > 0) box.append(text('span', 'badge', `${n} new`));
    return box;
  }

  function tile(entry) {
    const btn = el('button', { className: 'tile', type: 'button' });
    btn.append(thumb(entry), text('div', 'title', entry.title));
    const p = state.progress[entry.sourceUrl];
    btn.append(text('div', 'sub', p?.chapterLabel || entry.sourceDomain));
    btn.addEventListener('click', () => openSheet(entry));
    return btn;
  }

  function renderLibrary() {
    const folders = $('#folders');
    folders.replaceChildren(...FOLDERS.map((f) => {
      const b = el('button', { type: 'button', textContent: f.label });
      // The same colour the covers carry, so the cue is learnable from the row
      // above the grid instead of having to be explained somewhere.
      if (f.id !== 'all') b.dataset.status = f.id;
      if (state.folder === f.id) b.className = 'on';
      b.addEventListener('click', () => { state.folder = f.id; renderLibrary(); });
      return b;
    }));

    const shown = state.library
      .filter((e) => state.folder === 'all' || (e.folder || 'reading') === state.folder)
      .sort((a, b) => unread(b) - unread(a) ||
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    $('#grid').replaceChildren(...shown.map(tile));
    // An empty folder inside a full library used to render a blank screen with
    // nothing to explain it, because the message only ever spoke about a
    // library with nothing in it at all.
    const empty = $('#library-empty');
    empty.hidden = shown.length > 0;
    if (shown.length === 0) {
      const folder = FOLDERS.find((f) => f.id === state.folder);
      empty.textContent = state.library.length > 0
        ? `Nothing filed under “${folder?.label ?? state.folder}” yet.`
        : EMPTY_LIBRARY;
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
      card.append(thumb(entry), text('div', 'title', entry.title),
        text('div', 'label', p.chapterLabel || 'Resume'));
      card.addEventListener('click', () => open(p.chapterUrl, entry));
      return card;
    }));
  }

  async function loadLibrary() {
    const [lib, prog, settings] = await Promise.all([
      send({ type: 'getLibrary' }),
      send({ type: 'getProgressAll' }),
      send({ type: 'getSettings' }),
    ]);
    state.library = lib?.library || [];
    state.progress = prog?.progress || {};
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
      entry.lastKnownChapter ? `latest Ch. ${entry.lastKnownChapter}` : null,
      p?.chapterLabel ? `you are on ${p.chapterLabel}` : 'not started',
    ].filter(Boolean).join(' · ')));

    if (p?.chapterUrl) {
      panel.append(button('btn', `Continue — ${p.chapterLabel || 'resume'}`,
        () => open(p.chapterUrl, entry)));
    }
    panel.append(button('btn ghost', 'Open series page', () => open(entry.sourceUrl, entry)));
    panel.append(button('btn ghost', 'Find it on another site', () => findElsewhere(entry)));
    panel.append(button('btn ghost', 'Check for new chapters', async () => {
      toast('Checking…');
      await send({ type: 'checkNow' });
      await loadLibrary();
      toast('Up to date');
    }));
    panel.append(button('btn ghost danger', 'Remove from library', async () => {
      await send({ type: 'removeFromLibrary', id: entry.id });
      closeSheet();
      await loadLibrary();
      toast('Removed');
    }));
    panel.append(button('btn ghost', 'Cancel', closeSheet));

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

  const VERDICT = {
    ready: 'Reader Mode works here',
    likely: 'Reader Mode will probably work',
    unknown: 'Not sure until it loads',
    unlikely: 'Reader Mode probably will not work',
  };

  function renderResults() {
    $('#results').replaceChildren(...state.results.map((r) => {
      const card = el('button', { className: 'result', type: 'button' });
      card.append(text('div', 'rt', r.title), text('div', 'rd', r.domain || r.url));
      if (r.compat) {
        const chip = el('div', { className: `rc ${r.compat.verdict}` });
        chip.append(text('span', null, VERDICT[r.compat.verdict] || r.compat.verdict));
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
    status.textContent = 'Searching…';
    status.hidden = false;
    try {
      const resp = await send({
        type: 'search', q, scans: $('#scans-only').checked, check: true,
      });
      if (resp?.error) throw new Error(resp.error);
      state.results = resp?.results || [];
      status.textContent = state.results.length ? '' : 'No results.';
      status.hidden = state.results.length > 0;
      renderResults();
    } catch (e) {
      // Search is the one feature that needs the backend, so say which half
      // failed rather than showing an empty list.
      status.textContent = state.account
        ? `Search failed: ${e.message}`
        : 'Search runs on the PanelFlow backend — sign in on the Account tab first.';
      status.hidden = false;
    }
  }

  // --- account -------------------------------------------------------------

  function renderAccount() {
    const panel = $('#account-panel');
    panel.replaceChildren();

    if (state.account) {
      const who = el('p', { className: 'who' });
      who.append(document.createTextNode('Signed in as '), text('b', null, state.account.email));
      panel.append(who);
      panel.append(button('btn', 'Sync now', async () => {
        toast('Syncing…');
        await send({ type: 'pullNow' });
        await send({ type: 'syncNow' });
        await loadLibrary();
        toast('Synced');
      }));
      panel.append(button('btn ghost', 'Merge duplicate entries', async () => {
        const r = await send({ type: 'dedupeLibrary' });
        await loadLibrary();
        toast(r?.removed ? `Merged ${r.removed} duplicate(s)` : 'No duplicates found');
      }));
      panel.append(button('btn ghost', 'Sign out', async () => {
        await send({ type: 'logout' });
        state.account = null;
        renderAccount();
      }));
      $('#account').textContent = state.account.email;
      return;
    }

    $('#account').textContent = 'Sign in';
    const email = field('Email', 'email', 'email');
    const pass = field('Password', 'password', 'current-password');
    const err = el('p', { className: 'err', hidden: true });
    const submit = async (kind) => {
      err.hidden = true;
      try {
        const r = await send({
          type: 'auth', kind, email: email.input.value.trim(), password: pass.input.value,
        });
        if (r?.error) throw new Error(r.error);
        state.account = r.user;
        renderAccount();
        toast('Signed in');
        // The sign-in itself kicks off a pull; give it a moment, then repaint.
        setTimeout(loadLibrary, 1500);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    };
    panel.append(email.wrap, pass.wrap,
      button('btn', 'Sign in', () => submit('login')),
      button('btn ghost', 'Create an account', () => submit('register')),
      err);
    panel.append(el('p', {
      className: 'hint',
      textContent: 'Your library works fully offline and signed out. An account only ' +
        'adds sync between your phone and your browser, and powers search.',
    }));
  }

  function field(label, type, autocomplete) {
    const wrap = el('div', { className: 'field' });
    const input = el('input', { type, autocomplete, autocapitalize: 'none', spellcheck: false });
    wrap.append(el('label', { textContent: label }), input);
    return { wrap, input };
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

  document.addEventListener('DOMContentLoaded', async () => {
    for (const b of document.querySelectorAll('#tabs button')) {
      b.addEventListener('click', () => showView(b.dataset.view));
    }
    $('#account').addEventListener('click', () => showView('account'));
    $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });

    if (!window.PanelFlow.available) {
      $('#library-empty').hidden = false;
      $('#library-empty').textContent =
        'Opened outside the app: there is no native bridge here, so there is no library to show.';
      return;
    }

    // Coming back from the in-app browser is the moment the library is most
    // likely to be stale — the user just read a chapter.
    window.PanelFlow.on('resumed', loadLibrary);
    window.PanelFlow.on('ready', loadLibrary);

    state.account = (await send({ type: 'getAccount' }))?.authUser || null;
    await loadLibrary();
    renderAccount();
  });
})();
