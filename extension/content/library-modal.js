// PanelFlow "Add to library" sheet.
// Runs on every page (not just inside the reader) because the popup's
// "Add to library" opens it too. Everything lives in a closed shadow root:
// scan sites ship aggressive global CSS, and a leaked `* { box-sizing }` or
// `button { all: unset }` would wreck the form.
(() => {
  'use strict';
  if (window.top !== window) return;
  if (window.__panelflowLibModalLoaded) return;
  window.__panelflowLibModalLoaded = true;

  const FOLDERS = ['reading', 'paused', 'plan', 'completed', 'dropped'];
  const LANGUAGES = ['English', 'Japanese', 'Korean', 'Chinese (Simplified)', 'French'];

  // Same line as reader.js, and for the same reason: a content script cannot
  // load extension/send.js, and this modal is where a series is added, edited
  // and migrated — the three writes whose silent failure costs the reader
  // something. The reply is passed through untouched.
  //
  // A refusal the sheet already shows ("not signed in", a tracker that does not
  // know the title) is an answer, not a fault: it goes to the console as info.
  // Chrome copies every warning a content script prints onto the extension's
  // Errors page, where "no chapter to send" read as a broken build. A handler
  // that died (`failedAt`) or a server error (`ref`) is still a warning.
  const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r)).then((resp) => {
    if (resp && resp.error) {
      const fault = !!(resp.failedAt || resp.ref);
      console[fault ? 'warn' : 'info'](`[panelflow] ${(msg && msg.type) || 'unknown'} failed`
        + `${resp.failedAt ? ' in ' + resp.failedAt : ''}`
        + `${resp.ref ? ' ref=' + resp.ref : ''}: ${resp.error}`);
    }
    return resp;
  });
  // True inside the phone app, where `chrome` is the shim over the native
  // bridge rather than a real extension runtime.
  const isShim = () => !!chrome.runtime.__panelflowShim;

  let host = null;
  let form = null;

  const STYLE = `
    /* The palette, as tokens: this sheet is drawn on somebody else's page, in
       a closed shadow root that cannot link shared/theme.css, so the values
       are repeated here — the --dark-* set, and the --light-* set when the
       system is light — and backend/test/theme.test.js holds them to the
       stylesheet. It was forty-nine colours written out, dark whatever the
       reader had chosen (QA report, F-41). */
    .backdrop {
      --m-bg: #12100f; --m-surface: #1c1917; --m-surface-hi: #262220; --m-line: #38332f;
      --m-text: #fafaf9; --m-muted: #a8a29e; --m-accent: #e8613c; --m-on-accent: #12100f;
      --m-danger: #f2705f; --m-warn: #e3b341; --m-field-border: #78716c;
      --m-scrim: rgba(0, 0, 0, .6);
    }
    @media (prefers-color-scheme: light) {
      .backdrop {
        --m-bg: #f7f4ec; --m-surface: #ffffff; --m-surface-hi: #ede8dc; --m-line: #ddd5c6;
        --m-text: #1a1714; --m-muted: #6b635c; --m-accent: #b44324; --m-on-accent: #ffffff;
        --m-danger: #be3629; --m-warn: #8b600d; --m-field-border: #857c73;
        --m-scrim: rgba(26, 23, 20, .35);
      }
    }
    .sheet:focus { outline: none; }
    .sheet:focus-visible, button:focus-visible, input:focus-visible {
      outline: 2px solid var(--m-accent); outline-offset: 2px;
    }
    :host { all: initial; }
    /* A shadow root blocks the page's selectors but not inheritance: the page's
       "* { letter-spacing: 4px !important }" matches our host element and the
       inherited value flows in, beating :host in the cascade. Re-assert the
       inheritable properties sites most often force, on our own elements —
       there the page's selectors cannot reach. */
    .backdrop, .backdrop * {
      letter-spacing: normal; word-spacing: normal; text-transform: none;
      text-indent: 0; font-style: normal; font-variant: normal;
      text-shadow: none; white-space: normal; visibility: visible;
    }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      background: var(--m-scrim); padding: 16px;
    }
    .sheet {
      width: 100%; max-width: 420px; max-height: 88vh; overflow-y: auto;
      background: var(--m-surface); color: var(--m-text); border-radius: 16px;
      padding: 18px 20px 20px; box-shadow: 0 16px 48px rgba(0,0,0,.5);
      font-size: 14px; line-height: 1.4;
    }
    .head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .head h2 { flex: 1; margin: 0; font-size: 16px; text-align: center; font-weight: 650; }
    .x {
      width: 28px; height: 28px; flex: none; padding: 0; cursor: pointer;
      border: none; border-radius: 50%; background: none; color: var(--m-text); font-size: 17px;
    }
    .x:hover { background: var(--m-surface-hi); }
    .series { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
    .series img {
      width: 46px; height: 62px; flex: none; object-fit: cover;
      border-radius: 7px; background: var(--m-surface-hi);
    }
    .series .t { font-weight: 600; }
    .series .d { font-size: 12px; color: var(--m-muted); }
    h3 {
      margin: 0 0 7px; font-size: 12.5px; font-weight: 600; color: var(--m-text);
    }
    section { margin-bottom: 15px; }
    .chips { display: flex; flex-wrap: wrap; gap: 7px; }
    .chip {
      border: none; border-radius: 999px; cursor: pointer;
      background: var(--m-surface-hi); color: var(--m-text);
      font: 500 12.5px/1 system-ui, sans-serif; padding: 8px 13px;
    }
    .chip:hover { background: var(--m-line); }
    .chip[aria-pressed="true"] { background: var(--m-accent); color: var(--m-on-accent); }
    .chip .rm { margin-left: 6px; opacity: .8; }
    /* Under a finger, every control is a fingertip — 44 by 44, as in the
       reader — where the chips were 29 px tall (QA, September 2026). Fields
       at 16 px, below which iOS zooms the page into them on focus. */
    @media (pointer: coarse) {
      .chip, .tkbtn { min-height: 44px; padding-top: 0; padding-bottom: 0; }
      .chips { gap: 8px; }
      .x { width: 44px; height: 44px; }
      input[type="text"], input[type="date"] { min-height: 44px; font-size: 16px; }
    }
    input[type="text"], input[type="date"] {
      background: var(--m-surface-hi); color: var(--m-text); border: 1px solid var(--m-field-border);
      border-radius: 8px; padding: 7px 10px; font: inherit; width: 100%;
    }
    input:focus { outline: none; border-color: var(--m-accent); }
    .row { display: flex; gap: 7px; align-items: center; }
    .save {
      width: 100%; margin-top: 6px; padding: 13px; cursor: pointer;
      border: none; border-radius: 10px; background: var(--m-accent); color: var(--m-on-accent);
      font: 600 15px/1 system-ui, sans-serif;
    }
    .save:hover { background: color-mix(in srgb, var(--m-accent) 85%, var(--m-text)); }
    .save:disabled { opacity: .6; cursor: default; }
    .err { color: var(--m-danger); font-size: 12.5px; margin: 8px 0 0; }

    /* tracker strip */
    .tk {
      margin: -6px 0 16px; padding: 10px 12px; border-radius: 11px;
      background: var(--m-surface-hi); border: 1px solid var(--m-line);
    }
    .tkrow { display: flex; align-items: center; gap: 10px; }
    .tkrow + .tkrow { margin-top: 9px; }
    .tkrow.on { color: var(--m-text); }
    .tktxt { flex: 1; min-width: 0; }
    .tkname { font-size: 12.5px; font-weight: 600; }
    .tksum { font-size: 12px; color: var(--m-muted); overflow-wrap: anywhere; }
    .tkas { font-size: 11.5px; color: var(--m-muted); overflow-wrap: anywhere; }
    .tkbtn {
      flex: none; padding: 6px 12px; cursor: pointer; border-radius: 999px;
      border: 1px solid var(--m-line); background: none; color: var(--m-text);
      font: 600 12px/1 system-ui, sans-serif;
    }
    .tkbtn:hover { background: var(--m-surface-hi); }
    .tkrow.on .tkbtn { border-color: var(--m-accent); color: var(--m-accent); }
    .tknote { font-size: 12px; color: var(--m-muted); }
    .tknote + .chips { margin-top: 8px; }
    .tknote.warnish { color: var(--m-warn); }
    /* A catalogue's answers: a list to read down, not chips to scan across.
       Their titles are long and alike ("… 2nd Season", "… 2nd Season Part
       2"), and centred on two lines they could not be told apart. */
    .hitlist { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .hit {
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      width: 100%; text-align: left; cursor: pointer; padding: 8px 11px;
      border: 1px solid var(--m-line); border-radius: 10px;
      background: var(--m-surface); color: var(--m-text);
      font: 500 12.5px/1.3 system-ui, sans-serif;
    }
    .hit:hover { border-color: var(--m-accent); }
    .hit .alt { font-size: 11.5px; font-weight: 400; color: var(--m-muted); }
    .tksearch { display: flex; gap: 7px; align-items: center; margin-top: 8px; }
    .tksearch input { flex: 1; min-width: 0; }
    .hint { color: var(--m-muted); font-size: 12px; margin: 10px 0 0; text-align: center; }

    /* duplicate / migration sheet */
    .lead { margin: 0 0 16px; color: var(--m-text); font-size: 13px; }
    .cmp { display: flex; align-items: stretch; gap: 10px; margin-bottom: 6px; }
    .side {
      flex: 1; min-width: 0; background: var(--m-surface-hi); border: 1px solid var(--m-line);
      border-radius: 11px; padding: 11px 12px;
    }
    .side.to { border-color: var(--m-accent); }
    .side .cap {
      font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
      color: var(--m-muted); margin-bottom: 6px;
    }
    .side.to .cap { color: var(--m-accent); }
    .side .name {
      font-weight: 600; font-size: 13px; margin-bottom: 3px;
      overflow-wrap: anywhere;
    }
    .side .dom { font-size: 12px; color: var(--m-muted); overflow-wrap: anywhere; }
    .side .at { font-size: 12px; color: var(--m-text); margin-top: 7px; }
    .arrow { align-self: center; flex: none; color: var(--m-muted); font-size: 17px; }
    .warn {
      margin: 10px 0 0; padding: 9px 11px; border-radius: 9px;
      background: color-mix(in srgb, var(--m-warn) 14%, var(--m-surface)); color: var(--m-warn); font-size: 12.5px;
    }
    .keeps { margin: 14px 0 4px; padding: 0 0 0 17px; color: var(--m-muted); font-size: 12.5px; }
    .keeps li { margin: 3px 0; }
    .actions { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
    .ghost {
      width: 100%; padding: 12px; cursor: pointer; border-radius: 10px;
      border: 1px solid var(--m-line); background: none; color: var(--m-text);
      font: 600 14px/1 system-ui, sans-serif;
    }
    .ghost:hover { background: var(--m-surface-hi); }
    .ghost.quiet { border-color: transparent; color: var(--m-muted); font-weight: 500; }
  `;

  // --- state ----------------------------------------------------------------

  // If you are on a chapter of it, you are reading it — the form should not
  // ask. The exception is a one-shot: there is no next chapter to come back
  // for, so it lands in "plan" until you mark it finished yourself.
  const ONESHOT = /^one[-\s_]?shots?$/i;
  function defaultFolder(meta) {
    const tags = [...(meta.genres || []), ...(meta.tags || [])];
    if (tags.some((tag) => ONESHOT.test(String(tag).trim()))) return 'plan';
    return 'reading';
  }

  /**
   * The entry as the worker stores it.
   *
   * Named here because two buttons send it now: Save, and the tracker strip's
   * "Add" — which needs the series to exist locally before anything can be
   * pushed anywhere, since what reaches AniList is a bookmark on a library row.
   */
  function entryPayload(state) {
    return {
      title: state.meta.title,
      coverUrl: state.meta.coverUrl ?? null,
      sourceDomain: state.meta.sourceDomain,
      sourceUrl: state.meta.sourceUrl,
      tags: state.tags,
      lastKnownChapter: state.meta.lastKnownChapter ?? null,
      seriesStatus: state.meta.seriesStatus ?? null,
      // What kind of work this is, from whoever opened the sheet — the episode
      // page says 'anime', a chapter page says nothing and the core defaults.
      // Dropped here, an anime would be filed as a manga and its progress sent
      // to the wrong catalogue on the reader's tracker.
      medium: state.medium,
      // Only when the reader pressed a type: the core leaves an existing
      // entry's type alone otherwise, whatever the page says it is.
      mediumPicked: state.mediumPicked || undefined,
      folder: state.folder,
      language: state.language,
      score: state.score,
      startDate: state.startDate,
      // Where the user is right now. Adding a series from chapter 2 has to
      // record that, or the web app greets a brand-new entry with
      // "Not started" even though it was added mid-read.
      chapterUrl: state.meta.chapterUrl ?? null,
      chapterLabel: state.meta.chapterLabel ?? null,
    };
  }

  function initialState(meta, existing) {
    return {
      folder: existing?.folder || defaultFolder(meta),
      // What kind of work: the stored one for a series already in, the
      // detector's guess for a new one. The reader may change it.
      medium: mediumOf(existing?.medium ?? meta.medium),
      mediumPicked: false,
      // The page declares its own language; only fall back to asking when it
      // does not, and never override what the user already chose.
      language: existing ? (existing.language ?? null) : (meta.language ?? null),
      score: existing?.score ?? null,
      startDate: existing?.startDate ?? todayISO(),
      // Prefill from the page's genre links the first time only; an existing
      // entry's curated tags must not be overwritten by whatever the site lists.
      tags: existing ? (existing.tags || []).slice() : (meta.genres || []).slice(0, 8),
      meta,
      existing,
      // What the reader's own AniList / MyAnimeList already holds for this
      // series, once the answer arrives — see askTrackers(). The sheet opens
      // before it does and works without it.
      tracker: null,
      // The tracker strip's "Add" while it is happening: which service, what to
      // say about it, and the candidates to choose from when the service did
      // not recognise the title. Kept on the state because every chip click
      // rebuilds the sheet from scratch.
      addTo: null,
      appliedFrom: null,
      before: null,
      // Set by every chip and every keystroke. A prefill that lands after the
      // reader has started choosing does not touch the form; it offers.
      dirty: false,
    };
  }

  // The five built-in folders, named here for the tracker line below. Custom
  // shelves keep the name their owner typed — see folderName() in the popup for
  // the same rule stated at more length.
  const folderName = (id) => t('folder_' + id) || id;
  const TRACKER_NAME = { anilist: 'AniList', mal: 'MyAnimeList', kitsu: 'Kitsu' };
  const trackerName = (s) => TRACKER_NAME[s] || s;

  // The kinds of work, as shared/library-view.js lists them (MEDIA) — written
  // out here because this file runs as a content script, where library-view.js
  // is not loaded; backend/test/media.test.js keeps the two lists equal.
  const MEDIA = ['manga', 'webtoon', 'webnovel', 'lightnovel', 'anime'];
  const mediumOf = (m) => (MEDIA.includes(m) ? m : m === 'novel' ? 'webnovel' : 'manga');
  const isAnime = (state) => state.medium === 'anime';

  /** "Reading · 880 ch. · 8/10" — what the tracker holds, in one line. */
  function trackerSummary(entry, anime) {
    const bits = [folderName(entry.folder)];
    if (entry.chaptersRead) bits.push(t(anime ? 'episodesShort' : 'chaptersShort', [String(entry.chaptersRead)]));
    if (entry.score != null) bits.push(`${entry.score}/10`);
    if (entry.startDate) bits.push(t('sinceDate', [String(entry.startDate)]));
    return bits.join(' · ');
  }

  /**
   * Copy a tracker entry into the form.
   *
   * Progress is deliberately not copied. The tracker knows how far the reader
   * had got; the page knows where they are *now*, and it is the page they are
   * looking at — filling the form with the older number and saving it would
   * push a reader who is on chapter 883 back to 880. The count is shown in the
   * line above instead, which is the honest place for it.
   */
  function applyTracker(state, entry) {
    state.before = state.before
      ?? { folder: state.folder, score: state.score, startDate: state.startDate };
    state.folder = entry.folder || state.folder;
    if (entry.score != null) state.score = entry.score;
    if (entry.startDate) state.startDate = entry.startDate;
    state.appliedFrom = entry.service;
  }

  /** Put back what the form said before a prefill was applied. */
  function undoTracker(state) {
    if (state.before) Object.assign(state, state.before);
    state.before = null;
    state.appliedFrom = null;
  }

  const todayISO = () => new Date().toISOString().slice(0, 10);
  const shiftISO = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  // --- rendering ------------------------------------------------------------

  function chip(label, pressed, onClick, removable) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', String(!!pressed));
    b.textContent = label;
    if (removable) {
      const x = document.createElement('span');
      x.className = 'rm';
      x.textContent = '✕';
      b.appendChild(x);
    }
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * One answer from a tracker's catalogue: its title, and under it what tells
   * it from its neighbours: the English title when there is one, and the
   * format (TV, OVA, Movie).
   */
  function hitButton(hit, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hit';
    const main = document.createElement('span');
    main.textContent = hit.title;
    b.appendChild(main);
    const other = (hit.altTitles || []).find((x) => x && x !== hit.title && /[a-z]/i.test(x));
    const format = formatName(hit.format);
    if (other || format) {
      const alt = document.createElement('span');
      alt.className = 'alt';
      alt.textContent = [other, format].filter(Boolean).join(' · ');
      b.appendChild(alt);
    }
    b.addEventListener('click', onClick);
    return b;
  }

  /** "TV", "OVA", "Movie", "Light novel": a catalogue's format, as it is usually written. */
  function formatName(format) {
    const f = String(format || '').replace(/_/g, ' ').trim();
    if (!f) return '';
    if (/^(tv|ova|ona|oad|tv short)$/i.test(f)) return f.toUpperCase();
    return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
  }

  /**
   * A name for every control, the same from one draw to the next, so the one
   * that had the focus can be found again in the sheet that replaced it.
   */
  function stampKeys(sheet) {
    const seen = new Map();
    for (const el of sheet.querySelectorAll('button, input, select, textarea, a[href]')) {
      const head = el.closest('section')?.querySelector('h3')?.textContent || '';
      const base = `${head}|${el.tagName}|${el.type || ''}|${el.getAttribute('aria-label') || el.firstChild?.textContent?.trim() || ''}`;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      el.dataset.key = `${base}|${n}`;
    }
  }

  /** The shell every view shares: backdrop, sheet, close button, title. */
  function shell(root, title, close) {
    root.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    // A dialog, named by its title, that the keyboard stays inside (onKey):
    // it was a div, and Tab walked out of it into the page underneath (QA
    // report, F-41).
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'pf-modal-title');
    sheet.tabIndex = -1;
    backdrop.appendChild(sheet);
    // Click-through on the backdrop only; clicks inside must not close.
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    root.appendChild(backdrop);

    const head = document.createElement('div');
    head.className = 'head';
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.setAttribute('aria-label', t('actionClose'));
    x.addEventListener('click', close);
    const h2 = document.createElement('h2');
    h2.id = 'pf-modal-title';
    h2.textContent = title;
    head.append(x, h2);
    sheet.appendChild(head);
    return sheet;
  }

  // The series being added is already in the library under a different site.
  // Adding it again would leave two entries for one book, each with its own
  // half-finished bookmark — so ask first, and offer to move the entry over
  // rather than start a second one.
  function renderDuplicate(root, state, close) {
    const { meta, match } = state;
    const entry = match.entry;
    const sheet = shell(root, t('modalAlreadyInLibrary'), close);

    const lead = document.createElement('p');
    lead.className = 'lead';
    lead.textContent = match.confidence === 'same-title'
      ? t('modalSameTitleLead')
      : t('modalLikelyLead');
    sheet.appendChild(lead);

    const cmp = document.createElement('div');
    cmp.className = 'cmp';
    cmp.append(
      sideCard(t('modalInYourLibrary'), entry.title, entry.sourceDomain,
        state.progressLabel || entry.lastKnownChapter, false),
      Object.assign(document.createElement('div'), { className: 'arrow', textContent: '→' }),
      sideCard(t('modalThisPage'), meta.title, meta.sourceDomain,
        meta.chapterLabel || meta.lastKnownChapter, true),
    );
    sheet.appendChild(cmp);

    // A fuzzy title match is a guess. Say so, because accepting it merges two
    // entries and there is no undo.
    if (match.confidence === 'likely') {
      const warn = document.createElement('p');
      warn.className = 'warn';
      warn.textContent = t('modalCloseTitlesWarning');
      sheet.appendChild(warn);
    }

    const keeps = document.createElement('ul');
    keeps.className = 'keeps';
    for (const line of [t('modalKeepsProgress'), t('modalKeepsDate'), t('modalKeepsOldSite')]) {
      const li = document.createElement('li');
      li.textContent = line;
      keeps.appendChild(li);
    }
    sheet.appendChild(keeps);

    const err = document.createElement('p');
    err.className = 'err';
    err.hidden = true;

    const migrate = document.createElement('button');
    migrate.className = 'save';
    migrate.textContent = t('modalMigrateTo', [meta.sourceDomain || location.hostname]);
    migrate.addEventListener('click', async (e) => {
      // A real press, never a script's: the page this sheet sits on shares its
      // document, and a write it could trigger is a write it could forge.
      if (!e.isTrusted) return;
      migrate.disabled = true;
      migrate.textContent = t('modalMigrating');
      const resp = await send({ type: 'migrateEntry', id: entry.id, target: {
        sourceUrl: meta.sourceUrl,
        sourceDomain: meta.sourceDomain,
        title: meta.title,
        coverUrl: meta.coverUrl ?? null,
        lastKnownChapter: meta.lastKnownChapter ?? null,
        chapterUrl: meta.chapterUrl ?? null,
        chapterLabel: meta.chapterLabel ?? null,
      }});
      if (resp?.error || !resp?.ok) {
        err.hidden = false;
        err.textContent = resp?.error || t('modalMigrationFailed');
        migrate.disabled = false;
        migrate.textContent = t('modalMigrateTo', [meta.sourceDomain || location.hostname]);
        return;
      }
      // Land in the normal edit view on the entry that just moved, so the
      // migration is visible and still adjustable.
      Object.assign(state, initialState(meta, resp.entry),
        { view: 'form', match: null, signedIn: state.signedIn });
      render(root, state, close);
      // initialState cleared what the trackers had said, and this is a form the
      // reader has not answered yet either. Ask again rather than leave the
      // strip missing for the rest of the sheet's life.
      askTrackers(root, state, close);
    });

    const separate = document.createElement('button');
    separate.className = 'ghost';
    separate.textContent = t('modalAddSeparately');
    separate.addEventListener('click', () => {
      // The guess was wrong, or they deliberately want both. Never ask again
      // for this page within this modal.
      state.view = 'form';
      state.match = null;
      render(root, state, close);
    });

    const cancel = document.createElement('button');
    cancel.className = 'ghost quiet';
    cancel.textContent = t('actionCancel');
    cancel.addEventListener('click', close);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(migrate, separate, cancel);
    sheet.append(actions, err);

    function sideCard(cap, title, domain, at, isTo) {
      const el = document.createElement('div');
      el.className = isTo ? 'side to' : 'side';
      const c = document.createElement('div');
      c.className = 'cap';
      c.textContent = cap;
      const n = document.createElement('div');
      n.className = 'name';
      n.textContent = title || t('untitled');
      const d = document.createElement('div');
      d.className = 'dom';
      d.textContent = domain || '';
      el.append(c, n, d);
      if (at) {
        const a = document.createElement('div');
        a.className = 'at';
        a.textContent = at;
        el.appendChild(a);
      }
      return el;
    }
  }

  function render(root, state, close) {
    if (state.view === 'duplicate' && state.match) return renderDuplicate(root, state, close);

    // Every chip click rebuilds the sheet from scratch, which throws away the
    // scroll offset and the focus with it. Carried across the redraw below.
    const prevScroll = root.querySelector('.sheet')?.scrollTop ?? 0;
    // And the focus, the same way: the second draw — when the page's own
    // details arrive — and every chip replaced the element that had it, and
    // the next Tab started again from ✕ (QA re-test It.5, N28).
    const had = root.activeElement;
    const focusKey = had?.dataset?.key || (had?.classList?.contains('sheet') ? '·sheet' : null);
    const sheet = shell(root, state.existing ? t('modalEditEntry') : t('popupAddToLibrary'), close);
    // Two ways to redraw. `redraw` is what a chip, a date or a tag calls, and
    // it marks the form as touched: from then on a tracker answer that arrives
    // late may offer its values but must not install them behind the reader's
    // back. `repaint` is for everything the sheet does to itself.
    const repaint = () => render(root, state, close);
    const redraw = () => { state.dirty = true; repaint(); };

    // series identity
    const series = document.createElement('div');
    series.className = 'series';
    const img = document.createElement('img');
    // Empty rather than the file name: an <img> with an alt renders the alt in
    // place of a picture that will not load, and the placeholder behind it is
    // a better answer than the series' title written twice.
    img.alt = '';
    if (state.meta.coverUrl) {
      img.src = state.meta.coverUrl;
      // Scan-site covers are hotlink-protected often enough that this is the
      // ordinary case rather than the accident: what the reader saw was the
      // browser's broken-image icon where the cover should be.
      img.addEventListener('error', () => img.removeAttribute('src'), { once: true });
    }
    const info = document.createElement('div');
    // Named for what it is, not for its class: `t` is the translation function
    // in this file now, and a local of that name shadowing it turns the line
    // below into a call on a div.
    const titleEl = document.createElement('div');
    titleEl.className = 't';
    titleEl.textContent = state.meta.title || t('untitled');
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = state.meta.sourceDomain || '';
    info.append(titleEl, d);
    series.append(img, info);
    sheet.appendChild(series);

    // what AniList / MyAnimeList already say about this series
    const tk = trackerBlock();
    if (tk) sheet.appendChild(tk);

    // folder
    sheet.appendChild(group(t('fieldFolder'), FOLDERS.map((f) =>
      chip(folderName(f), state.folder === f, () => {
        state.folder = f;
        redraw();
      }))));

    // type — what the page is, as far as anything can tell; a web novel and a
    // light novel look the same from here, so the reader has the last word.
    sheet.appendChild(group(t('fieldMedium'), MEDIA.map((m) =>
      chip(t('medium_' + m), state.medium === m, () => {
        state.medium = m;
        state.mediumPicked = true;
        redraw();
      }))));

    // language
    // A language detected from the page may not be in the fixed list.
    const langs = state.language && !LANGUAGES.includes(state.language)
      ? [state.language, ...LANGUAGES]
      : LANGUAGES;
    const langChips = [
      chip(t('chipNone'), state.language === null, () => { state.language = null; redraw(); }),
      // Stored in English, shown in the reader's language (shared/i18n.js).
      ...langs.map((l) =>
        chip(PanelFlowI18n.languageName(l), state.language === l, () => { state.language = l; redraw(); })),
    ];
    sheet.appendChild(group(t('modalTranslatedLanguage'), langChips));

    // current progress (read-only: it comes from the page)
    if (state.meta.chapterLabel) {
      sheet.appendChild(group(t('modalCurrentProgress'), [chip(state.meta.chapterLabel, true, () => {})]));
    }

    // start date
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = state.startDate || '';
    dateInput.addEventListener('change', () => {
      state.startDate = dateInput.value || null;
      redraw();
    });
    const dateChips = document.createElement('div');
    dateChips.className = 'chips';
    dateChips.append(
      chip(t('chipNone'), state.startDate === null, () => { state.startDate = null; redraw(); }),
      chip(t('dayToday'), state.startDate === todayISO(), () => { state.startDate = todayISO(); redraw(); }),
      chip(t('dayYesterday'), state.startDate === shiftISO(-1), () => { state.startDate = shiftISO(-1); redraw(); }),
    );
    const dateSection = document.createElement('section');
    const dateTitle = document.createElement('h3');
    dateTitle.textContent = t('fieldStartDate');
    // The field is named by its heading: it had no name at all.
    dateTitle.id = 'pf-date-title';
    dateInput.setAttribute('aria-labelledby', 'pf-date-title');
    dateSection.append(dateTitle, dateChips, spacer(), dateInput);
    sheet.appendChild(dateSection);

    // score
    const scoreChips = [chip(t('chipNone'), state.score === null, () => { state.score = null; redraw(); })];
    for (let n = 1; n <= 10; n++) {
      scoreChips.push(chip(String(n), state.score === n, () => { state.score = n; redraw(); }));
    }
    sheet.appendChild(group(t('fieldScore'), scoreChips));

    // tags
    const tagChips = state.tags.map((tag) =>
      chip(tag, true, () => {
        state.tags = state.tags.filter((x) => x !== tag);
        redraw();
      }, true));
    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.placeholder = t('modalAddTagHint');
    tagInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = tagInput.value.trim();
      if (v && !state.tags.includes(v)) {
        state.tags.push(v);
        state.focus = 'tags';
        redraw();
      }
    });
    const tagSection = document.createElement('section');
    const tagTitle = document.createElement('h3');
    tagTitle.textContent = t('fieldTags');
    tagTitle.id = 'pf-tags-title';
    tagInput.setAttribute('aria-labelledby', 'pf-tags-title');
    const tagWrap = document.createElement('div');
    tagWrap.className = 'chips';
    tagWrap.append(...tagChips);
    tagSection.append(tagTitle, tagWrap, spacer(), tagInput);
    sheet.appendChild(tagSection);

    // save
    const save = document.createElement('button');
    save.className = 'save';
    save.textContent = t('actionSave');
    const err = document.createElement('p');
    err.className = 'err';
    err.hidden = true;
    save.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;   // a real press, never a script's (see migrate)
      save.disabled = true;
      save.textContent = t('statusSaving');
      const resp = await send({ type: 'addToLibrary', entry: entryPayload(state) });
      if (resp?.error) {
        err.hidden = false;
        err.textContent = resp.error;
        save.disabled = false;
        save.textContent = t('actionSave');
        return;
      }
      // The reader's bookmark and the video bar draw a cross once the series
      // is in: they listen for this rather than polling the library.
      try { document.dispatchEvent(new CustomEvent('panelflow:library-changed', { detail: resp.entry || null })); } catch { /* no DOM to tell */ }
      close();
    });
    sheet.append(save, err);

    // Saving always works locally, but without an account nothing reaches the
    // web app — and "I saved it and it isn't there" is otherwise a total
    // mystery from here.
    if (!state.signedIn) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = t('modalLocalOnlyHint');
      sheet.appendChild(hint);
    }

    // Put the reader back where they were: picking a score sits near the bottom
    // of the form and used to bounce the sheet to the top, and typing a second
    // tag meant clicking the field again because Enter redrew it away.
    sheet.scrollTop = prevScroll;
    if (state.focus === 'tags') {
      state.focus = null;
      tagInput.focus();
    }
    stampKeys(sheet);
    if (focusKey && !root.activeElement) {
      const again = focusKey === '·sheet' ? sheet : sheet.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      again?.focus({ preventScroll: true });
    }

    function group(title, chipEls) {
      const s = document.createElement('section');
      const h = document.createElement('h3');
      h.textContent = title;
      const c = document.createElement('div');
      c.className = 'chips';
      c.append(...chipEls);
      s.append(h, c);
      return s;
    }
    function spacer() {
      const s = document.createElement('div');
      s.style.height = '7px';
      return s;
    }

    /**
     * The tracker strip: what the reader's own accounts hold for this series,
     * or a way to connect one.
     *
     * Nothing is drawn until the answer arrives — the sheet must open at the
     * speed of the page, not at the speed of AniList — and nothing is drawn at
     * all without an account, because connecting a tracker goes through the
     * PanelFlow account that stores the token.
     */
    function trackerBlock() {
      if (!state.signedIn || !state.tracker) return null;
      const { entries = [], connected = [], errors = [] } = state.tracker;
      const box = document.createElement('section');
      box.className = 'tk';

      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'tkrow';
        const txt = document.createElement('div');
        txt.className = 'tktxt';
        const name = document.createElement('div');
        name.className = 'tkname';
        name.textContent = trackerName(entry.service);
        const sum = document.createElement('div');
        sum.className = 'tksum';
        sum.textContent = trackerSummary(entry, isAnime(state));
        // The title the tracker matched, when it is not the one on the page.
        // A prefill from the wrong series is the failure worth catching, and
        // the only way to catch it is to be told which series was read.
        if (entry.remoteTitle && entry.remoteTitle !== state.meta.title) {
          const as = document.createElement('div');
          as.className = 'tkas';
          as.textContent = t('modalTrackerMatchedAs', [entry.remoteTitle]);
          txt.append(name, sum, as);
        } else {
          txt.append(name, sum);
        }
        row.appendChild(txt);

        const act = document.createElement('button');
        act.type = 'button';
        act.className = 'tkbtn';
        if (state.appliedFrom === entry.service) {
          act.textContent = t('actionUndo');
          act.addEventListener('click', () => { undoTracker(state); repaint(); });
          row.classList.add('on');
        } else {
          act.textContent = t('actionUse');
          act.addEventListener('click', () => {
            applyTracker(state, entry);
            // Applying is the reader choosing. Anything that arrives later has
            // to ask, exactly as it would after a chip.
            state.dirty = true;
            repaint();
          });
        }
        row.appendChild(act);
        box.appendChild(row);
      }

      // Connected, asked, and it is not on the list.
      //
      // This used to be one sentence and a full stop, which said the lookup had
      // happened and left the reader with nowhere to go: their AniList had
      // never heard of the series they were reading and PanelFlow, which knew
      // both facts, offered no way to say so. It is a row with a button now.
      const failed = new Set(errors.map((e) => e.service));
      for (const service of connected) {
        if (entries.some((e) => e.service === service) || failed.has(service)) continue;
        box.appendChild(addRow(service));
      }

      for (const e of errors) {
        const line = document.createElement('div');
        line.className = 'tknote warnish';
        line.textContent = t('modalTrackerUnreachable', [trackerName(e.service), e.error]);
        box.appendChild(line);
      }

      // Nothing connected: the offer. Both services open their authorisation
      // page in a new tab; this sheet is a content script and cannot open one
      // itself, so the worker does it.
      //
      // The same file runs inside the phone app's in-app browser, where the
      // worker is a WebView with no tabs to open and no tracker screen behind
      // it. Offering a button there would be offering a dead end, so it says
      // where the connecting is actually done instead.
      if (!connected.length && !isShim()) {
        const note = document.createElement('div');
        note.className = 'tknote';
        note.textContent = t('modalConnectTrackerLead');
        const row = document.createElement('div');
        row.className = 'chips';
        const err2 = document.createElement('div');
        err2.className = 'tknote warnish';
        err2.hidden = true;
        for (const service of ['anilist', 'mal']) {
          row.appendChild(chip(t('modalTrackerConnect', [trackerName(service)]), false, async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            const resp = await send({ type: 'trackerConnectTab', service });
            btn.disabled = false;
            if (resp?.error) {
              err2.hidden = false;
              err2.textContent = `${trackerName(service)}: ${resp.error}`;
              return;
            }
            // The tab is open but nobody has authorised anything yet — asking
            // now would answer "not connected" and be wrong within the minute.
            // The reader comes back to this window when they are done, and
            // that is the moment to ask again.
            window.addEventListener('focus', () => {
              if (form === state && host) askTrackers(root, state, close);
            }, { once: true });
          }));
        }
        box.append(note, row, err2);
      } else if (!connected.length && isShim()) {
        const note = document.createElement('div');
        note.className = 'tknote';
        note.textContent = t('modalConnectTrackerHint');
        box.appendChild(note);
      }

      return box.childNodes.length ? box : null;

      /**
       * One service that has never heard of this series, and the button that
       * tells it.
       *
       * What the button does is save the entry, then ask the server to put it
       * on that list: on the shelf it is on here, at the chapter the reader is
       * on when there is a bookmark and at zero when there is not. It used to
       * send the bookmark through the page-turn push, which is why a series
       * with none answered "no chapter to send" (QA of 27 September).
       */
      function addRow(service) {
        const live = state.addTo?.service === service ? state.addTo : null;
        const row = document.createElement('div');
        row.className = 'tkrow';
        const txt = document.createElement('div');
        txt.className = 'tktxt';
        const name = document.createElement('div');
        name.className = 'tkname';
        name.textContent = trackerName(service);
        const sum = document.createElement('div');
        sum.className = 'tksum';
        sum.textContent = live?.note || t('modalTrackerNotListed', [trackerName(service)]);
        txt.append(name, sum);
        row.appendChild(txt);

        if (!live?.done) {
          const act = document.createElement('button');
          act.type = 'button';
          act.className = 'tkbtn';
          act.textContent = live?.busy ? t('modalTrackerAdding') : t('modalTrackerAdd');
          act.disabled = !!live?.busy;
          act.addEventListener('click', (e) => { if (e.isTrusted) addToTracker(service); });
          row.appendChild(act);
        } else {
          row.classList.add('on');
        }

        // The service searched its catalogue and did not find this title under
        // the name the site uses for it. Its own best guesses are the only
        // thing that can settle that, and the reader is the only one allowed
        // to choose between them — picking one here would write a chapter
        // count onto a stranger's series.
        if (!live?.hits?.length && !live?.searchable) return row;
        const box2 = document.createElement('div');
        box2.appendChild(row);
        if (live.hits?.length) {
          const list = document.createElement('div');
          list.className = 'hitlist';
          for (const hit of live.hits) {
            list.appendChild(hitButton(hit, (e) => { if (e.isTrusted) linkAndPush(service, hit); }));
          }
          box2.appendChild(list);
        }
        // And when none of them is it, the reader asks the catalogue
        // themselves. A title the site writes in French is one the catalogue
        // has never heard, and its guesses were all there was: five seasons
        // of the right series, none of them the one being watched (owner's
        // report, September 2026).
        if (live.searchable) box2.appendChild(searchRow(service, live));
        return box2;
      }

      /** "Not in the list? Search it": a field, and the catalogue's answers above it. */
      function searchRow(service, live) {
        const wrap = document.createElement('div');
        const lead = document.createElement('div');
        lead.className = 'tknote';
        lead.style.marginTop = '10px';
        lead.textContent = t(live.hits?.length ? 'modalTrackerSearchLead' : 'modalTrackerSearchOwn');
        const line = document.createElement('div');
        line.className = 'tksearch';
        const input = document.createElement('input');
        input.type = 'text';
        input.enterKeyHint = 'search';
        input.value = live.query || '';
        input.placeholder = t('popupSearchTracker');
        input.setAttribute('aria-label', t('popupSearchTracker'));
        input.addEventListener('input', () => { live.query = input.value; });
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          searchCatalogue(service, input.value);
        });
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'tkbtn';
        go.textContent = live.searching ? t('statusSearching') : t('mobileSearchGo');
        go.disabled = !!live.searching;
        go.addEventListener('click', () => searchCatalogue(service, input.value));
        line.append(input, go);
        wrap.append(lead, line);
        return wrap;
      }

      /** The reader's own words, to the service's catalogue; its answers replace the guesses. */
      async function searchCatalogue(service, q) {
        const query = String(q || '').trim();
        if (query.length < 2) return;
        state.addTo = { ...state.addTo, service, searchable: true, query, searching: true };
        repaint();
        const resp = await send({ type: 'trackerSearch', service, q: query, medium: state.medium });
        if (form !== state || !host) return;
        const name = trackerName(service);
        const hits = Array.isArray(resp?.hits) ? resp.hits.slice(0, 8) : [];
        state.addTo = {
          service,
          searchable: true,
          query,
          hits,
          note: resp?.error
            ? t('modalTrackerFailed', [name, resp.error])
            : hits.length ? t('modalTrackerSearchResults', [name, query]) : t('modalTrackerNoHits', [name, query]),
        };
        repaint();
      }

      /** Save the series, then tell the service where the reader is. */
      async function addToTracker(service) {
        state.addTo = { service, busy: true, note: t('modalTrackerAdding') };
        repaint();
        const saved = await send({ type: 'addToLibrary', entry: entryPayload(state) });
        if (form !== state || !host) return;
        if (saved?.error || !saved?.entry) {
          state.addTo = { service, note: saved?.error || t('modalTrackerFailed',
            [trackerName(service), 'library']) };
          return repaint();
        }
        state.existing = saved.entry;
        await addAndReport(service, saved.entry);
      }

      /** The reader picked the series themselves; that one is added. */
      async function linkAndPush(service, hit) {
        state.addTo = { service, busy: true, note: t('modalTrackerAdding') };
        repaint();
        await addAndReport(service, state.existing, hit);
      }

      /**
       * Put the series on the service's list and say, in one line, what the
       * service did with it (routes/trackers.js, `/add`).
       *
       * No bookmark is needed: a series with none goes on the shelf it is on
       * here at zero, and one the reader already has over there is left as it
       * is and said so. A title the catalogue is not sure about is a question
       * rather than an error: its guesses come back and are offered as chips.
       */
      async function addAndReport(service, entry, pick) {
        const resp = await send({
          type: 'trackerAdd', sourceUrl: entry?.sourceUrl, service,
          remoteId: pick?.id ?? null, remoteTitle: pick?.title ?? null,
        });
        if (form !== state || !host) return;
        const name = trackerName(service);
        const r = resp?.result;
        // A refusal with no reason attached is still a refusal, and saying so
        // beats a sentence that trails off after the dash.
        if (resp?.error || !r) {
          state.addTo = {
            service,
            note: t('modalTrackerFailed', [name, resp?.error || t('modalTrackerNoAnswer')]),
          };
          return repaint();
        }
        if (r.skipped === 'unmatched') {
          const hits = (r.hits || []).slice(0, 5);
          state.addTo = {
            service,
            note: hits.length
              ? t('modalTrackerPickSeries', [name])
              : t('modalTrackerNoHits', [name, state.meta.title]),
            hits,
            searchable: true,
          };
          return repaint();
        }
        state.addTo = {
          service,
          done: true,
          note: r.already
            ? t('modalTrackerAlready', [name, [r.remoteTitle, r.folder ? folderName(r.folder) : null]
              .filter(Boolean).join(' · ')])
            : r.count
              ? t(isAnime(state) ? 'modalTrackerAddedEpisode' : 'modalTrackerAdded', [name, String(r.count)])
              : t('modalTrackerAddedPlain', [name]),
        };
        return repaint();
      }
    }
  }

  /**
   * Fill in what a chapter page does not know about the series.
   *
   * A chapter page has no cover — its og:image is a panel, or the site's logo,
   * or nothing — and no genres: the only genre links on it belong to the site's
   * own menu. The series page has both, and detect.js already fetches it for
   * the popup's "add this page". The sheet used to be opened from the reader
   * with the raw chapter-page meta instead, which is why it showed a broken
   * image and offered Kingdom the tags "Romance" and "Adulte".
   *
   * Behind the sheet rather than in front of it, exactly like the tracker strip
   * below: this crosses the network to the site, and the reader pressed a
   * button on a page they are looking at. What comes back is metadata, so it
   * fills gaps and corrects the cover; the tags are only replaced while the
   * form is still untouched and new, on the same rule as a tracker prefill.
   */
  async function enrichMeta(root, state, close) {
    if (state.meta.enriched) return;
    // Promise.resolve around it: on a surface where detect.js is not running
    // there is no promise to hang a .catch on, and the sheet still has to open.
    const better = await Promise.resolve(
      window.__panelflowDetect?.enrichedMeta?.()).catch(() => null);
    if (!better || form !== state || !host) return;
    const wasSeeded = !state.dirty && !state.existing;
    // A chapter page's own reading of itself is the better one. An episode's is
    // not: video-speed.js already cleaned its title and episode label, and the
    // page's raw heading put "One Piece Saison 1 Épisode 3 VOSTFR - <site>"
    // back over "One Piece" (QA re-test It.4, N-B5). There, only what is missing.
    state.meta = state.meta.medium === 'anime' ? { ...better, ...state.meta } : { ...state.meta, ...better };
    if (wasSeeded && better.genres?.length) state.tags = better.genres.slice(0, 8);
    render(root, state, close);
  }

  /**
   * Ask the backend what the reader's trackers hold for this title, then decide
   * whether to fill the form or merely offer to.
   *
   * Auto-filling is limited to a brand-new, untouched entry. Editing an entry
   * that already exists means the values in front of the reader are their own
   * saved ones, and a remote list is not entitled to overwrite those without
   * being asked; a form the reader has started answering is theirs for the same
   * reason. In both cases the strip still appears with a "Use" button.
   */
  async function askTrackers(root, state, close) {
    // The tokens hang off the PanelFlow account, so without one there is
    // nothing to ask and nothing to offer.
    if (!state.signedIn) return;
    const resp = await send({
      type: 'trackerEntry', title: state.meta.title, medium: state.medium, host: state.meta.sourceDomain,
    });
    // The sheet may have been closed, or reopened on another series, while the
    // request was in flight.
    if (form !== state || !host) return;
    state.tracker = resp || { entries: [], connected: [] };
    const first = (state.tracker.entries || [])[0];
    if (first && !state.dirty && !state.existing) applyTracker(state, first);
    render(root, state, close);
  }

  // --- public API -----------------------------------------------------------

  function close() {
    host?.remove();
    host = null;
    form = null;
    shadow = null;
    document.removeEventListener('keydown', onKey, true);
    // Back where the reader was: the button that opened the sheet, not the
    // top of a page they had scrolled down.
    const back = returnTo;
    returnTo = null;
    if (back?.isConnected) back.focus?.({ preventScroll: true });
  }

  let shadow = null;     // the sheet's closed root, for the focus it holds
  let returnTo = null;   // what had the focus before the sheet opened

  /** What Tab may land on inside the sheet, in order. */
  const focusables = () => (shadow
    ? [...shadow.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.getClientRects().length)
    : []);

  function onKey(e) {
    if (!host) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    // Kept inside: from the last control Tab goes back to the first, and
    // Shift+Tab the other way — never out into the page under the scrim.
    if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) return;
      const at = list.indexOf(shadow.activeElement);
      const next = e.shiftKey
        ? (at <= 0 ? list[list.length - 1] : null)
        : (at === -1 || at === list.length - 1 ? list[0] : null);
      if (next) { e.preventDefault(); e.stopPropagation(); next.focus(); }
    }
  }

  // Whether an open is in flight. `open` asks three questions before it draws,
  // and a double click used to start two of them: two sheets stacked, `host`
  // pointing at the second, and the first one covering the reader with no ✕
  // that could reach it. The second press now simply lets the first finish.
  let opening = false;

  async function open(meta) {
    if (!meta?.title) return { ok: false, error: t('modalNoTitle') };
    if (opening) return { ok: true };
    opening = true;
    try {
      return await drawSheet(meta);
    } finally {
      opening = false;
    }
  }

  async function drawSheet(meta) {
    close();
    const [similar, account, stored] = await Promise.all([
      send({ type: 'findSimilar', meta }),
      send({ type: 'getAccount' }),
      send({ type: 'getProgressAll' }),
    ]);

    const best = (similar?.matches || [])[0];
    // The same page, or the same series on the same site: saving updates that
    // entry either way (background.js merges on seriesKey), so show the edit
    // form rather than pretending this is a new addition. The rule is
    // shared/series-match.js's, the same the reader's badge reads.
    const existing = window.PanelFlowMatch.onThisSite(similar?.matches) || undefined;
    const onThisSite = !!existing;
    // A title match on a *different* site is the one case worth interrupting
    // for: adding it would file the same book twice.
    const duplicate = !onThisSite && best ? best : null;

    host = document.createElement('div');
    host.id = 'panelflow-libmodal';
    // Closed: nothing on the page can reach in and restyle or read the form.
    const root = host.attachShadow({ mode: 'closed' });
    shadow = root;
    // Typing is typing. A video player's shortcuts (space, f, k, m, the
    // arrows) listen on the document, where a key pressed in one of these
    // fields arrives as a key pressed on the page: a tag or a search typed
    // over an episode could pause it or put it in full screen.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      root.addEventListener(type, (e) => {
        if (e.target?.matches?.('input, textarea')) e.stopPropagation();
      });
    }
    returnTo = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    document.documentElement.appendChild(host);
    // The title the shelf will keep, which is the one to show and to ask the
    // trackers about: the stored one for a series already in, and for a new
    // one the page's with the site's own name and slogan cut off ("Cyberpunk :
    // Edgerunners - Saison 1 | Example-Site - Streaming et catalogage…"). The
    // core cleans it again on the way in; this is the same rule, earlier.
    const shown = existing?.title
      || window.PanelFlowMatch.displayTitle(meta.title, { host: meta.sourceDomain })
      || meta.title;
    meta = { ...meta, title: shown };
    form = initialState(meta, existing);
    form.signedIn = !!account?.authUser;
    form.match = duplicate;
    form.view = duplicate ? 'duplicate' : 'form';
    // The bookmark — the furthest chapter reached — not a reread (arbitrage e).
    const kept = duplicate ? stored?.progress?.[duplicate.entry.sourceUrl] : null;
    form.progressLabel = (kept?.furthest?.chapterUrl ? kept.furthest : kept)?.chapterLabel ?? null;
    render(root, form, close);
    // The dialog takes the focus, so a screen reader starts at its title.
    root.querySelector('.sheet')?.focus({ preventScroll: true });
    document.addEventListener('keydown', onKey, true);
    // Neither of the two below is awaited, and for the same reason.
    enrichMeta(root, form, close);
    // Deliberately not awaited: this crosses the network to AniList and MAL,
    // and the reader pressed a button on a page they are looking at. The sheet
    // is complete and usable without it; the strip appears when it appears.
    askTrackers(root, form, close);
    return { ok: true };
  }

  window.PanelFlowLibraryModal = { open, close, isOpen: () => !!host };
})();
