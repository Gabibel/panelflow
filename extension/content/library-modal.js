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

  const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));

  let host = null;
  let form = null;

  const STYLE = `
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
      background: rgba(0, 0, 0, .6); padding: 16px;
    }
    .sheet {
      width: 100%; max-width: 420px; max-height: 88vh; overflow-y: auto;
      background: #1c1917; color: #fafaf9; border-radius: 16px;
      padding: 18px 20px 20px; box-shadow: 0 16px 48px rgba(0,0,0,.5);
      font-size: 14px; line-height: 1.4;
    }
    .head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .head h2 { flex: 1; margin: 0; font-size: 16px; text-align: center; font-weight: 650; }
    .x {
      width: 28px; height: 28px; flex: none; padding: 0; cursor: pointer;
      border: none; border-radius: 50%; background: none; color: #fafaf9; font-size: 17px;
    }
    .x:hover { background: #34302d; }
    .series { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
    .series img {
      width: 46px; height: 62px; flex: none; object-fit: cover;
      border-radius: 7px; background: #34302d;
    }
    .series .t { font-weight: 600; }
    .series .d { font-size: 12px; color: #a8a29e; }
    h3 {
      margin: 0 0 7px; font-size: 12.5px; font-weight: 600; color: #d6d3d1;
    }
    section { margin-bottom: 15px; }
    .chips { display: flex; flex-wrap: wrap; gap: 7px; }
    .chip {
      border: none; border-radius: 999px; cursor: pointer;
      background: #34302d; color: #e7e5e4;
      font: 500 12.5px/1 system-ui, sans-serif; padding: 8px 13px;
    }
    .chip:hover { background: #443f3b; }
    .chip[aria-pressed="true"] { background: #c25d33; color: #fff; }
    .chip .rm { margin-left: 6px; opacity: .8; }
    input[type="text"], input[type="date"] {
      background: #34302d; color: #fafaf9; border: 1px solid #443f3b;
      border-radius: 8px; padding: 7px 10px; font: inherit; width: 100%;
    }
    input:focus { outline: none; border-color: #e87f56; }
    .row { display: flex; gap: 7px; align-items: center; }
    .save {
      width: 100%; margin-top: 6px; padding: 13px; cursor: pointer;
      border: none; border-radius: 10px; background: #b8552c; color: #fff;
      font: 600 15px/1 system-ui, sans-serif;
    }
    .save:hover { background: #c25d33; }
    .save:disabled { opacity: .6; cursor: default; }
    .err { color: #f2705f; font-size: 12.5px; margin: 8px 0 0; }
    .hint { color: #a8a29e; font-size: 12px; margin: 10px 0 0; text-align: center; }

    /* duplicate / migration sheet */
    .lead { margin: 0 0 16px; color: #d6d3d1; font-size: 13px; }
    .cmp { display: flex; align-items: stretch; gap: 10px; margin-bottom: 6px; }
    .side {
      flex: 1; min-width: 0; background: #262220; border: 1px solid #3a3532;
      border-radius: 11px; padding: 11px 12px;
    }
    .side.to { border-color: #b8552c; }
    .side .cap {
      font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
      color: #a8a29e; margin-bottom: 6px;
    }
    .side.to .cap { color: #e87f56; }
    .side .name {
      font-weight: 600; font-size: 13px; margin-bottom: 3px;
      overflow-wrap: anywhere;
    }
    .side .dom { font-size: 12px; color: #a8a29e; overflow-wrap: anywhere; }
    .side .at { font-size: 12px; color: #d6d3d1; margin-top: 7px; }
    .arrow { align-self: center; flex: none; color: #a8a29e; font-size: 17px; }
    .warn {
      margin: 10px 0 0; padding: 9px 11px; border-radius: 9px;
      background: #3a2f22; color: #f0c99a; font-size: 12.5px;
    }
    .keeps { margin: 14px 0 4px; padding: 0 0 0 17px; color: #a8a29e; font-size: 12.5px; }
    .keeps li { margin: 3px 0; }
    .actions { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
    .ghost {
      width: 100%; padding: 12px; cursor: pointer; border-radius: 10px;
      border: 1px solid #443f3b; background: none; color: #e7e5e4;
      font: 600 14px/1 system-ui, sans-serif;
    }
    .ghost:hover { background: #2a2624; }
    .ghost.quiet { border-color: transparent; color: #a8a29e; font-weight: 500; }
  `;

  // --- state ----------------------------------------------------------------

  // If you are on a chapter of it, you are reading it — the form should not
  // ask. The exception is a one-shot: there is no next chapter to come back
  // for, so it lands in "plan" until you mark it finished yourself.
  const ONESHOT = /^one[-\s_]?shots?$/i;
  function defaultFolder(meta) {
    const tags = [...(meta.genres || []), ...(meta.tags || [])];
    if (tags.some((t) => ONESHOT.test(String(t).trim()))) return 'plan';
    return 'reading';
  }

  function initialState(meta, existing) {
    return {
      folder: existing?.folder || defaultFolder(meta),
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
    };
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
    backdrop.appendChild(sheet);
    // Click-through on the backdrop only; clicks inside must not close.
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    root.appendChild(backdrop);

    const head = document.createElement('div');
    head.className = 'head';
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.addEventListener('click', close);
    const h2 = document.createElement('h2');
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
    const sheet = shell(root, 'Already in your library', close);

    const lead = document.createElement('p');
    lead.className = 'lead';
    lead.textContent = match.confidence === 'same-title'
      ? 'You already follow this series on another site.'
      : 'This looks like a series you already follow.';
    sheet.appendChild(lead);

    const cmp = document.createElement('div');
    cmp.className = 'cmp';
    cmp.append(
      sideCard('In your library', entry.title, entry.sourceDomain,
        state.progressLabel || entry.lastKnownChapter, false),
      Object.assign(document.createElement('div'), { className: 'arrow', textContent: '→' }),
      sideCard('This page', meta.title, meta.sourceDomain,
        meta.chapterLabel || meta.lastKnownChapter, true),
    );
    sheet.appendChild(cmp);

    // A fuzzy title match is a guess. Say so, because accepting it merges two
    // entries and there is no undo.
    if (match.confidence === 'likely') {
      const warn = document.createElement('p');
      warn.className = 'warn';
      warn.textContent = 'The titles are close but not identical — check this is '
        + 'really the same series before migrating.';
      sheet.appendChild(warn);
    }

    const keeps = document.createElement('ul');
    keeps.className = 'keeps';
    for (const line of ['Your progress, score, notes and tags',
                        'The date you added it',
                        'The old site, kept in the entry’s history']) {
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
    migrate.textContent = `Migrate to ${meta.sourceDomain || 'this site'}`;
    migrate.addEventListener('click', async () => {
      migrate.disabled = true;
      migrate.textContent = 'Migrating…';
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
        err.textContent = resp?.error || 'Migration failed.';
        migrate.disabled = false;
        migrate.textContent = `Migrate to ${meta.sourceDomain || 'this site'}`;
        return;
      }
      // Land in the normal edit view on the entry that just moved, so the
      // migration is visible and still adjustable.
      Object.assign(state, initialState(meta, resp.entry),
        { view: 'form', match: null, signedIn: state.signedIn });
      render(root, state, close);
    });

    const separate = document.createElement('button');
    separate.className = 'ghost';
    separate.textContent = 'Add as a separate series';
    separate.addEventListener('click', () => {
      // The guess was wrong, or they deliberately want both. Never ask again
      // for this page within this modal.
      state.view = 'form';
      state.match = null;
      render(root, state, close);
    });

    const cancel = document.createElement('button');
    cancel.className = 'ghost quiet';
    cancel.textContent = 'Cancel';
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
      n.textContent = title || '(untitled)';
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

    const sheet = shell(root, state.existing ? 'Edit library entry' : 'Add to library', close);
    const redraw = () => render(root, state, close);

    // series identity
    const series = document.createElement('div');
    series.className = 'series';
    const img = document.createElement('img');
    if (state.meta.coverUrl) img.src = state.meta.coverUrl;
    const info = document.createElement('div');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = state.meta.title || '(untitled)';
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = state.meta.sourceDomain || '';
    info.append(t, d);
    series.append(img, info);
    sheet.appendChild(series);

    // folder
    sheet.appendChild(group('Folder', FOLDERS.map((f) =>
      chip(f[0].toUpperCase() + f.slice(1), state.folder === f, () => {
        state.folder = f;
        redraw();
      }))));

    // language
    // A language detected from the page may not be in the fixed list.
    const langs = state.language && !LANGUAGES.includes(state.language)
      ? [state.language, ...LANGUAGES]
      : LANGUAGES;
    const langChips = [
      chip('None', state.language === null, () => { state.language = null; redraw(); }),
      ...langs.map((l) =>
        chip(l, state.language === l, () => { state.language = l; redraw(); })),
    ];
    sheet.appendChild(group('Translated language', langChips));

    // current progress (read-only: it comes from the page)
    if (state.meta.chapterLabel) {
      sheet.appendChild(group('Current progress', [chip(state.meta.chapterLabel, true, () => {})]));
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
      chip('None', state.startDate === null, () => { state.startDate = null; redraw(); }),
      chip('Today', state.startDate === todayISO(), () => { state.startDate = todayISO(); redraw(); }),
      chip('Yesterday', state.startDate === shiftISO(-1), () => { state.startDate = shiftISO(-1); redraw(); }),
    );
    const dateSection = document.createElement('section');
    const dateTitle = document.createElement('h3');
    dateTitle.textContent = 'Start date';
    dateSection.append(dateTitle, dateChips, spacer(), dateInput);
    sheet.appendChild(dateSection);

    // score
    const scoreChips = [chip('None', state.score === null, () => { state.score = null; redraw(); })];
    for (let n = 1; n <= 10; n++) {
      scoreChips.push(chip(String(n), state.score === n, () => { state.score = n; redraw(); }));
    }
    sheet.appendChild(group('Score', scoreChips));

    // tags
    const tagChips = state.tags.map((tag) =>
      chip(tag, true, () => {
        state.tags = state.tags.filter((x) => x !== tag);
        redraw();
      }, true));
    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.placeholder = 'Add a tag and press Enter';
    tagInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = tagInput.value.trim();
      if (v && !state.tags.includes(v)) {
        state.tags.push(v);
        redraw();
      }
    });
    const tagSection = document.createElement('section');
    const tagTitle = document.createElement('h3');
    tagTitle.textContent = 'Tags';
    const tagWrap = document.createElement('div');
    tagWrap.className = 'chips';
    tagWrap.append(...tagChips);
    tagSection.append(tagTitle, tagWrap, spacer(), tagInput);
    sheet.appendChild(tagSection);

    // save
    const save = document.createElement('button');
    save.className = 'save';
    save.textContent = 'Save';
    const err = document.createElement('p');
    err.className = 'err';
    err.hidden = true;
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.textContent = 'Saving…';
      const resp = await send({ type: 'addToLibrary', entry: {
        title: state.meta.title,
        coverUrl: state.meta.coverUrl ?? null,
        sourceDomain: state.meta.sourceDomain,
        sourceUrl: state.meta.sourceUrl,
        tags: state.tags,
        lastKnownChapter: state.meta.lastKnownChapter ?? null,
        seriesStatus: state.meta.seriesStatus ?? null,
        folder: state.folder,
        language: state.language,
        score: state.score,
        startDate: state.startDate,
        // Where the user is right now. Adding a series from chapter 2 has to
        // record that, or the web app greets a brand-new entry with
        // "Not started" even though it was added mid-read.
        chapterUrl: state.meta.chapterUrl ?? null,
        chapterLabel: state.meta.chapterLabel ?? null,
      }});
      if (resp?.error) {
        err.hidden = false;
        err.textContent = resp.error;
        save.disabled = false;
        save.textContent = 'Save';
        return;
      }
      close();
    });
    sheet.append(save, err);

    // Saving always works locally, but without an account nothing reaches the
    // web app — and "I saved it and it isn't there" is otherwise a total
    // mystery from here.
    if (!state.signedIn) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'Saved on this device only — sign in from the PanelFlow '
        + 'extension settings to see it in the web app.';
      sheet.appendChild(hint);
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
  }

  // --- public API -----------------------------------------------------------

  function close() {
    host?.remove();
    host = null;
    form = null;
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape' && host) { e.stopPropagation(); close(); }
  }

  async function open(meta) {
    if (!meta?.title) return { ok: false, error: 'Could not read a title on this page.' };
    close();
    const [similar, account, stored] = await Promise.all([
      send({ type: 'findSimilar', meta }),
      send({ type: 'getAccount' }),
      send({ type: 'getProgressAll' }),
    ]);

    const best = (similar?.matches || [])[0];
    // The same page, or the same series on the same site: saving updates that
    // entry either way (background.js merges on seriesKey), so show the edit
    // form rather than pretending this is a new addition.
    const onThisSite = best && (best.confidence === 'same-page' || best.confidence === 'same-site');
    const existing = onThisSite ? best.entry : undefined;
    // A title match on a *different* site is the one case worth interrupting
    // for: adding it would file the same book twice.
    const duplicate = !onThisSite && best ? best : null;

    host = document.createElement('div');
    host.id = 'panelflow-libmodal';
    // Closed: nothing on the page can reach in and restyle or read the form.
    const root = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    form = initialState(meta, existing);
    form.signedIn = !!account?.authUser;
    form.match = duplicate;
    form.view = duplicate ? 'duplicate' : 'form';
    form.progressLabel = duplicate
      ? stored?.progress?.[duplicate.entry.sourceUrl]?.chapterLabel ?? null
      : null;
    render(root, form, close);
    document.addEventListener('keydown', onKey, true);
    return { ok: true };
  }

  window.PanelFlowLibraryModal = { open, close, isOpen: () => !!host };
})();
