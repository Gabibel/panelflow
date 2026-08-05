// PanelFlow Reader Mode overlay.
// Modes: vertical scroll, paged LTR, paged RTL, double-page spread.
// Key differentiator: free-form pinch-zoom/pan that NEVER snaps back —
// boundaries are elastic (resisted) but the view settles at the bound,
// not at the origin.
// Shortcuts: Esc close · arrows navigate · S preferences · B break 1st page.
(() => {
  'use strict';
  if (window.__panelflowReaderLoaded) return;
  window.__panelflowReaderLoaded = true;

  const PRELOAD_AHEAD = 3;
  const MIN_VISIBLE_FRACTION = 0.15; // part of the page that must stay on screen

  const DEFAULT_PREFS = {
    brightness: 100, contrast: 100, gap: 0, stripWidth: 100,
    autoNext: false, autoplaySpeed: 80, progressSize: 3,
    tapZones: 'sides', invertTap: false,
    // Off by default: a chapter list with holes in it is confusing until you
    // know why, and the reader who wants this is the one on chapter 400 of a
    // list of 900 — they will find the switch.
    hideRead: false,
    // Novel mode. Stored as whole numbers because every control here is a
    // range input: the line height is a percentage, applied as 1.65.
    fontSize: 18, lineHeight: 165, textWidth: 680,
  };

  // How much of the screen width, on each edge, turns the page. The rest of it
  // toggles the controls. `edges` is for readers who keep tapping the middle of
  // a panel to look at it and turning the page by accident; `off` is for a mouse
  // and the arrow keys, where a stray click should never move anything.
  const TAP_LAYOUTS = { sides: 0.33, edges: 0.18, off: 0 };

  // Shown for a moment when the reader opens and whenever the mode changes: the
  // direction is the one thing you must know before the first tap, and getting
  // it wrong means reading a chapter backwards before noticing.
  const MODE_TOAST = {
    vertical: 'Long strip — scroll down',
    ltr: 'Single page — left to right →',
    rtl: 'Single page — right to left ← (manga)',
    spread: 'Double page',
  };

  const state = {
    root: null, images: [], meta: null, rule: {}, nav: null, container: null,
    mode: 'vertical', page: 0, chromeVisible: true,
    zoom: 1, panX: 0, panY: 0,
    breakFirst: false, prefs: { ...DEFAULT_PREFS },
    playing: false, playRaf: 0, playLastTs: 0,
    harvestObserver: null, harvestTimer: 0,
    // Novel mode: prose instead of pages. There is no strip to page through, so
    // position is a scroll ratio and "pages" are screenfuls of text.
    novel: false, paragraphs: [], screens: 1, scrollRatio: 0,
    // Chapters of this series already read. Null until the worker answers,
    // which is not the same as "none are read" — the list is drawn whole in the
    // meantime rather than flickering from full to filtered.
    readChapters: null,
    // The chapter wheel: every chapter of the series, the row it opens on, and
    // the frame the scroll handler is waiting for.
    chapters: [], wheelIndex: 0, wheelRaf: 0,
  };

  const $ = (sel) => state.root.querySelector(sel);

  /** Ask the worker something, as a promise. */
  const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));

  /** How many units the position is counted in — page images, or screenfuls. */
  const pageTotal = () => (state.novel ? state.screens : state.images.length);

  function open(images, meta, rule, container, paragraphs = null) {
    if (state.root) close();
    Object.assign(state, {
      images: images.slice(), meta, rule, container: container || null,
      paragraphs: paragraphs ? paragraphs.slice() : [], novel: !!paragraphs,
      screens: 1, scrollRatio: 0, readChapters: null,
      chapters: [], wheelIndex: 0,
      page: 0, zoom: 1, panX: 0, panY: 0,
      breakFirst: false, playing: false,
      nav: window.__panelflowDetect?.chapterNav?.() || null,
    });
    chrome.storage.local.get(['readerMode', 'readerPrefs', 'readerHelpSeen'], (v) => {
      // Text has no reading direction and nothing to page through, so the mode
      // picker does not apply to it — and everything downstream that asks about
      // the mode ("can it autoplay", "do arrows scroll") wants the strip answer.
      state.mode = state.novel ? 'vertical'
        : v.readerMode || (rule.readingDirection === 'rtl' ? 'rtl' : 'vertical');
      state.prefs = { ...DEFAULT_PREFS, ...(v.readerPrefs || {}) };
      build();
      // Once, on the first chapter ever opened. Everything in the reader is a
      // tap or a key with no label on it, and a reader who never finds them
      // gets a worse version of the site they came from. Before render(), which
      // is what raises the direction toast: the list already says the direction,
      // and stacking a toast under a modal explaining it reads as a bug.
      if (!v.readerHelpSeen) {
        showHelp(true);
        chrome.storage.local.set({ readerHelpSeen: true });
      }
      render();
      restoreProgress();
      // A novel is already whole: there is no lazy strip to walk the page for,
      // and scrolling the document underneath would only fight the reader.
      if (!state.novel) harvestLazyPages();
      clock.banked = 0;
      clock.day = null;
      clockStart();
      document.addEventListener('visibilitychange', onVisibility);
      // Rotating the phone reflows the prose, so the chapter that was eight
      // screens is now twelve and the scrubber is scaled to a length that no
      // longer exists. Images do not have the problem: there are still n of them.
      addEventListener('resize', measureScreens);
      // Following the chapter's own "next" link leaves the page without ever
      // closing the reader, and that is the most common way a chapter ends.
      addEventListener('pagehide', bankRead);
    });
  }

  function close() {
    // Flushed, not scheduled. saveProgress is debounced by 800 ms and bails on
    // a closed reader, so the queued call always fired after state.root was
    // gone and did nothing — closing the reader was the one moment your
    // position was guaranteed *not* to be written down.
    saveProgress.flush();
    // Same reason, and before state.root goes: the read has to be banked while
    // there is still a chapter to attribute it to.
    bankRead();
    stopAutoplay();
    stopHarvest();
    document.removeEventListener('visibilitychange', onVisibility);
    removeEventListener('resize', measureScreens);
    removeEventListener('pagehide', bankRead);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onWheelAway, true);
    document.removeEventListener('fullscreenchange', syncFullscreenIcon);
    // Removing the element while it owns the full screen leaves the tab stuck.
    if (document.fullscreenElement === state.root) document.exitFullscreen().catch(() => {});
    state.root?.remove();
    state.root = null;
    document.documentElement.classList.remove('panelflow-noscroll');

    // Free the blob URLs the detector minted for this chapter — they pin the
    // full image bytes until revoked. On a delay, not immediately: a CBZ
    // download started a second before closing is still reading them. The array
    // is captured here because open() calls close() and only then puts a fresh
    // one on state — by the time the timer fires this is the old chapter's.
    const stale = state.images;
    const release = window.__panelflowDetect?.releaseStable;
    if (release) setTimeout(() => release(stale), 60000);
  }

  const isOpen = () => !!state.root;

  // --- DOM -----------------------------------------------------------------

  function build() {
    document.documentElement.classList.add('panelflow-noscroll');
    const root = document.createElement('div');
    root.id = 'panelflow-reader';
    root.innerHTML = `
      <div class="pf-topbar pf-chrome">
        <button class="pf-btn" data-act="close" title="Close (Esc)">✕</button>
        <span class="pf-title"></span>
        <button class="pf-btn pf-chapnav" data-act="prevch" title="Previous chapter">⏮</button>
        <div class="pf-chapwrap" hidden>
          <button class="pf-btn pf-chapbtn" data-act="chapters" title="Chapters (C)"
                  aria-haspopup="listbox" aria-expanded="false">Chapters ▾</button>
          <div class="pf-wheel" role="listbox" tabindex="-1" hidden></div>
        </div>
        <button class="pf-btn pf-chapnav" data-act="nextch" title="Next chapter">⏭</button>
      </div>
      <div class="pf-stage"></div>
      <div class="pf-side pf-chrome">
        <button class="pf-btn" data-act="library" title="Add to library">🔖</button>
        <button class="pf-btn" data-act="download" title="Download chapter (.cbz)">⬇</button>
        <button class="pf-btn" data-act="offline" title="Save for offline reading">📥</button>
        <button class="pf-btn" data-act="prefs" title="Reader preferences (S)">⚙</button>
        <button class="pf-btn pf-resetzoom" data-act="resetzoom" title="Reset zoom (0)" hidden>⊙</button>
        <button class="pf-btn" data-act="fullscreen" title="Full screen (F)">⛶</button>
        <button class="pf-btn" data-act="help" title="Keys and gestures (?)">?</button>
        <button class="pf-btn" data-act="hide" title="Hide controls (H)">⇱</button>
      </div>
      <div class="pf-prefs pf-chrome" hidden>
        <label class="pf-only-strip">Reading mode
          <select class="pf-mode">
            <option value="vertical">Long strip</option>
            <option value="ltr">Single page →</option>
            <option value="rtl">Single page ← (manga)</option>
            <option value="spread">Double page</option>
          </select>
        </label>
        <label>Brightness <input data-pref="brightness" type="range" min="30" max="130" step="5"></label>
        <label>Contrast <input data-pref="contrast" type="range" min="50" max="150" step="5"></label>
        <label class="pf-only-strip">Gap size <input data-pref="gap" type="range" min="0" max="40" step="2"></label>
        <label class="pf-only-strip">Strip width <input data-pref="stripWidth" type="range" min="40" max="100" step="5"></label>
        <label class="pf-only-novel">Text size <input data-pref="fontSize" type="range" min="13" max="30" step="1"></label>
        <label class="pf-only-novel">Line spacing <input data-pref="lineHeight" type="range" min="120" max="220" step="5"></label>
        <label class="pf-only-novel">Text width <input data-pref="textWidth" type="range" min="360" max="900" step="20"></label>
        <label>Play speed <input data-pref="autoplaySpeed" type="range" min="20" max="300" step="10"></label>
        <label>Progress size <input data-pref="progressSize" type="range" min="0" max="10" step="1"></label>
        <label class="pf-only-strip">Tap zones
          <select class="pf-select" data-pref="tapZones">
            <option value="sides">Left / right thirds</option>
            <option value="edges">Narrow edges</option>
            <option value="off">Off (keys only)</option>
          </select>
        </label>
        <label class="pf-check pf-only-strip"><input data-pref="invertTap" type="checkbox"> Swap tap sides</label>
        <label class="pf-check"><input data-pref="autoNext" type="checkbox"> Auto next chapter</label>
        <label class="pf-check"><input data-pref="hideRead" type="checkbox"> Hide chapters I've read</label>
      </div>
      <div class="pf-zones" hidden></div>
      <div class="pf-toast" hidden></div>
      <div class="pf-help" hidden>
        <h3>Keys and gestures</h3>
        <ul>
          <li><b>Tap</b> a side to turn the page, the middle for the controls — long strip scrolls instead</li>
          <li><b>Pinch</b> or <b>ctrl+wheel</b> to zoom, <b>drag</b> to move — the view never snaps back</li>
          <li><b>Double tap</b> to zoom in on a panel, again to fit the page</li>
          <li><b>←</b> <b>→</b> <b>space</b> turn the page · <b>↑</b> <b>↓</b> scroll the long strip</li>
          <li><b>C</b> the chapter wheel — <b>scroll</b> or <b>↑</b> <b>↓</b> to find one, <b>enter</b> to open it</li>
          <li><b>S</b> preferences · <b>B</b> break the first page · <b>0</b> reset zoom</li>
          <li><b>F</b> full screen · <b>H</b> hide the controls · <b>?</b> this list · <b>Esc</b> close</li>
        </ul>
        <p class="pf-help-note">Reading direction, tap zones and everything else live under ⚙.</p>
        <button class="pf-btn" data-act="help-ok">Got it</button>
      </div>
      <div class="pf-bottombar pf-chrome">
        <span class="pf-counter"></span>
        <input class="pf-scrub" type="range" min="1" value="1" title="Current page">
        <button class="pf-btn pf-break" data-act="break" title="Break 1st page (B)">⤸</button>
        <button class="pf-btn pf-play" data-act="play" title="Auto play (long strip)">▶</button>
      </div>
      <div class="pf-progress"><div class="pf-progress-fill"></div></div>`;
    document.documentElement.appendChild(root);
    state.root = root;

    $('.pf-title').textContent = state.meta.title;
    $('.pf-mode').value = state.mode;
    $('.pf-mode').addEventListener('change', (e) => {
      state.mode = e.target.value;
      chrome.storage.local.set({ readerMode: state.mode });
      stopAutoplay();
      render();
    });
    root.querySelector('[data-act="close"]').addEventListener('click', close);
    root.querySelector('[data-act="library"]').addEventListener('click', addToLibrary);
    root.querySelector('[data-act="prefs"]').addEventListener('click', togglePrefs);
    root.querySelector('[data-act="break"]').addEventListener('click', toggleBreak);
    root.querySelector('[data-act="play"]').addEventListener('click', toggleAutoplay);
    root.querySelector('[data-act="download"]').addEventListener('click', downloadChapter);
    root.querySelector('[data-act="offline"]').addEventListener('click', toggleOffline);
    root.querySelector('[data-act="fullscreen"]').addEventListener('click', toggleFullscreen);
    root.querySelector('[data-act="hide"]').addEventListener('click', () => setChrome(false));
    root.querySelector('[data-act="help"]').addEventListener('click', () => showHelp($('.pf-help').hidden));
    root.querySelector('[data-act="help-ok"]').addEventListener('click', () => showHelp(false));
    root.querySelector('[data-act="resetzoom"]').addEventListener('click', () => {
      resetTransform();
      applyTransform();
    });
    // Leaving full screen by Esc/F11 rather than our button must still update
    // the icon, so track the document's state instead of our own flag.
    document.addEventListener('fullscreenchange', syncFullscreenIcon);
    buildChapterNav();
    buildPrefsPanel();
    syncPrefsRows();
    // Whether this chapter is already on the device is a question for the
    // worker, so the button starts in its unsaved state and corrects itself.
    refreshOffline();

    const scrub = $('.pf-scrub');
    scrub.max = pageTotal();
    scrub.addEventListener('input', () => {
      const n = parseInt(scrub.value, 10) - 1;
      if (state.mode === 'vertical') {
        const stage = $('.pf-stage');
        stage.scrollTop = (n / Math.max(1, pageTotal() - 1)) *
          (stage.scrollHeight - stage.clientHeight);
      } else {
        showPage(n);
      }
    });

    document.addEventListener('keydown', onKey, true);
  }

  function buildChapterNav() {
    const nav = state.nav;
    if (!nav?.prevUrl) $('[data-act="prevch"]').hidden = true;
    if (!nav?.nextUrl) $('[data-act="nextch"]').hidden = true;
    $('[data-act="prevch"]').addEventListener('click', () => nav?.prevUrl && gotoChapter(nav.prevUrl));
    $('[data-act="nextch"]').addEventListener('click', () => nav?.nextUrl && gotoChapter(nav.nextUrl));

    $('.pf-chapbtn').textContent = `${state.meta.chapterLabel || 'Chapters'} ▾`;
    $('.pf-chapbtn').addEventListener('click', () => openWheel($('.pf-wheel').hidden));
    const wheel = $('.pf-wheel');
    wheel.addEventListener('click', (e) => {
      const row = e.target.closest('.pf-wrow');
      if (row?.dataset.url) { e.stopPropagation(); pickChapter(row.dataset.url); }
    });
    // The highlight follows the middle of the wheel, not the pointer: what you
    // scrolled to the centre is what Enter picks.
    wheel.addEventListener('scroll', () => {
      if (state.wheelRaf) return;
      state.wheelRaf = requestAnimationFrame(() => {
        state.wheelRaf = 0;
        // The reader can close between the scroll and the frame it asked for.
        if (state.root) markCentre(centreIndex());
      });
    }, { passive: true });
    loadChapters();
  }

  /**
   * The two things the worker knows about this series that the page does not:
   * which chapters have already been read, and how many there are. Asked for
   * together because they are drawn together — one round trip, one repaint.
   */
  async function loadChapters() {
    const [read, range] = await Promise.all([
      send({ type: 'getReadChapters', sourceUrl: state.meta.sourceUrl }),
      send({
        type: 'chapterList',
        sourceUrl: state.meta.sourceUrl,
        chapterUrl: state.meta.chapterUrl || location.href,
        chapterLabel: state.meta.chapterLabel,
      }),
    ]);
    // The reader may have been closed while the worker was answering, and the
    // answer belongs to the chapter that asked for it.
    if (!state.root) return;
    state.readChapters = new Set(read?.chapters || []);
    state.chapters = mergeChapters(state.nav?.options || [], range?.chapters || []);
    // Nothing to pick from: no list, no site links either. The prev/next
    // buttons, if the page offered any, are the whole of the navigation.
    $('.pf-chapwrap').hidden = state.chapters.length < 2;
    fillWheel();
  }

  /**
   * The site's own chapter list, topped up with the chapters it did not link.
   *
   * A site that lists everything is left as it is. A site that lists three —
   * previous, current, next — gets the rest of the series filled in from the
   * worker's derived range. Where both have a chapter the site's own link wins:
   * it is the address the site publishes, and a derived one is only ever a very
   * good guess.
   */
  function mergeChapters(options, derived) {
    const numOf = (label) => window.PanelFlowMatch?.chapterNumber(label) ?? null;
    const byNum = new Map();
    const unnumbered = [];
    for (const { label, url } of options) {
      const n = numOf(label);
      if (n === null) unnumbered.push({ n: null, label, url });
      else if (!byNum.has(n)) byNum.set(n, { n, label, url });
    }
    for (const row of derived) if (!byNum.has(row.n)) byNum.set(row.n, row);
    // Newest first, whatever order the page listed them in.
    return [...byNum.values()].sort((a, b) => b.n - a.n).concat(unnumbered);
  }

  /** Whether a row is the chapter on screen. */
  const isHere = (url) => url === location.href || url === state.meta.chapterUrl;

  /** How tall one row is, asked of the row rather than assumed from the CSS. */
  const rowHeight = () => $('.pf-wheel .pf-wrow')?.offsetHeight || 32;

  /**
   * The wheel, rebuilt rather than filtered in place: the reader's stylesheet
   * is injected into someone else's page and must not carry a bare `[hidden]`
   * rule, so rows that should not be there simply are not created.
   */
  function fillWheel() {
    const wheel = $('.pf-wheel');
    wheel.textContent = '';
    state.wheelIndex = 0;
    let dropped = 0;
    let i = 0;
    for (const { label, url } of state.chapters) {
      // The chapter being read stays, read or not: a wheel whose current row is
      // missing opens somewhere else entirely and looks like it jumped. Either
      // url counts, because they are not always the same string — the page's
      // list may carry a trailing slash or a #anchor the address bar does not.
      const here = isHere(url);
      if (state.prefs.hideRead && !here && state.readChapters?.has(url)) { dropped++; continue; }
      const row = document.createElement('div');
      row.className = 'pf-wrow';
      row.setAttribute('role', 'option');
      row.dataset.url = url;
      row.textContent = label;
      if (state.readChapters?.has(url)) row.classList.add('pf-read');
      if (here) { row.classList.add('pf-here'); state.wheelIndex = i; }
      wheel.appendChild(row);
      i++;
    }
    if (dropped) {
      // Why the wheel is short, said in the wheel itself. No url, so it cannot
      // be picked and navigated to.
      const note = document.createElement('div');
      note.className = 'pf-wrow pf-wnote';
      note.textContent = `— ${dropped} read chapter${dropped === 1 ? '' : 's'} hidden —`;
      wheel.appendChild(note);
    }
    if (!wheel.hidden) centreOn(state.wheelIndex);
  }

  /** The row currently in the middle of the wheel. */
  function centreIndex() {
    const wheel = $('.pf-wheel');
    const max = wheel.querySelectorAll('.pf-wrow').length - 1;
    return Math.max(0, Math.min(max, Math.round(wheel.scrollTop / rowHeight())));
  }

  /**
   * Put row `i` in the middle. The wheel is padded by half its own height at
   * both ends, so a row's scroll position is simply its index times its height
   * — which is what makes the first and last chapter reachable at the centre.
   */
  function centreOn(i, smooth = false) {
    const wheel = $('.pf-wheel');
    const top = i * rowHeight();
    if (smooth) wheel.scrollTo({ top, behavior: 'smooth' });
    else wheel.scrollTop = top;
    markCentre(i);
  }

  function markCentre(i) {
    const rows = $('.pf-wheel').querySelectorAll('.pf-wrow');
    rows.forEach((r, n) => r.classList.toggle('pf-on', n === i));
  }

  /**
   * A press anywhere but the wheel closes it — including on the page behind the
   * reader, which is why this is on the document and in the capture phase. One
   * function, added and removed rather than made fresh each time, so an evening
   * of opening and closing the wheel does not leave a stack of them behind.
   */
  function onWheelAway(e) {
    if (!state.root) return document.removeEventListener('pointerdown', onWheelAway, true);
    if (e.target.closest('.pf-chapwrap')) return;
    openWheel(false);
  }

  function openWheel(show) {
    $('.pf-wheel').hidden = !show;
    $('.pf-chapbtn').setAttribute('aria-expanded', String(!!show));
    document.removeEventListener('pointerdown', onWheelAway, true);
    if (!show) return;
    // Offsets are all zero while the element is hidden, so the scroll position
    // can only be set once it is on screen.
    centreOn(state.wheelIndex);
    document.addEventListener('pointerdown', onWheelAway, true);
  }

  /**
   * Keys while the wheel is open, which take precedence over the reader's own:
   * up and down are how you search a wheel, and turning the page underneath
   * instead would be the opposite of what was asked for.
   */
  function onWheelKey(e) {
    const rows = $('.pf-wheel').querySelectorAll('.pf-wrow');
    if (!rows.length) return false;
    const i = centreIndex();
    const go = (n) => centreOn(Math.max(0, Math.min(rows.length - 1, n)), true);
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i - 1); break;
      case 'PageDown': go(i + 5); break;
      case 'PageUp': go(i - 5); break;
      case 'Home': go(0); break;
      case 'End': go(rows.length - 1); break;
      case 'Enter': pickChapter(rows[i]?.dataset.url); break;
      case 'Escape': openWheel(false); break;
      default: return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  /** A row of the wheel, chosen. Landing on the chapter already open is not a
   *  navigation — reloading the page to stay where you are loses your place. */
  function pickChapter(url) {
    if (!url) return;
    if (isHere(url)) return openWheel(false);
    gotoChapter(url);
  }

  function gotoChapter(url) {
    if (!url || url === location.href) return;
    saveProgress.flush?.();
    // Remember to reopen the reader on the next page (same-tab navigation).
    chrome.storage.local.set({ reopenReaderFor: url }, () => { location.href = url; });
  }

  function buildPrefsPanel() {
    for (const input of state.root.querySelectorAll('[data-pref]')) {
      const key = input.dataset.pref;
      // Three kinds of control, and the value has to come back the way it went
      // in: parseInt on a select's value is NaN, which storage keeps happily and
      // the next open reads back as a broken preference.
      const kind = input.tagName === 'SELECT' ? 'select' : input.type;
      if (kind === 'checkbox') input.checked = !!state.prefs[key];
      else input.value = state.prefs[key];
      input.addEventListener('input', () => {
        state.prefs[key] = kind === 'checkbox' ? input.checked
          : kind === 'select' ? input.value
          : parseInt(input.value, 10);
        chrome.storage.local.set({ readerPrefs: state.prefs });
        applyPrefs();
        // Tap zones are invisible by definition, so changing them shows them.
        if (key === 'tapZones' || key === 'invertTap') showZoneHint();
        // Not in applyPrefs: that runs on every slider drag, and rebuilding the
        // chapter list under an open select is not something to do 60 times a
        // second for a brightness change.
        if (key === 'hideRead') fillWheel();
      });
    }
  }

  function applyPrefs() {
    const stage = $('.pf-stage');
    stage.style.filter = `brightness(${state.prefs.brightness}%) contrast(${state.prefs.contrast}%)`;
    stage.style.setProperty('--pf-gap', state.prefs.gap + 'px');
    stage.style.setProperty('--pf-width', state.prefs.stripWidth + '%');
    stage.style.setProperty('--pf-font', state.prefs.fontSize + 'px');
    stage.style.setProperty('--pf-lh', state.prefs.lineHeight / 100);
    stage.style.setProperty('--pf-textw', state.prefs.textWidth + 'px');
    // 0 hides the bar entirely — some readers want nothing over the artwork.
    state.root.style.setProperty('--pf-progress-h', state.prefs.progressSize + 'px');
    // Text reflows when any of the three above change, so what was one screen
    // is now two and the position the reader is about to save is stale.
    if (state.novel) measureScreens();
  }

  /** Controls that only mean something for one kind of chapter. */
  function syncPrefsRows() {
    const drop = state.novel ? 'pf-only-strip' : 'pf-only-novel';
    for (const row of state.root.querySelectorAll('.pf-only-strip, .pf-only-novel')) {
      row.hidden = row.classList.contains(drop);
    }
    // A .cbz of a text chapter is nothing; the text itself is a plain file.
    const dl = state.root.querySelector('[data-act="download"]');
    dl.title = state.novel ? 'Download chapter (.txt)' : 'Download chapter (.cbz)';
  }

  // --- full screen -----------------------------------------------------------

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else state.root.requestFullscreen?.().catch(() => {});
  }

  function syncFullscreenIcon() {
    const btn = state.root?.querySelector('[data-act="fullscreen"]');
    if (!btn) return;
    const on = !!document.fullscreenElement;
    btn.textContent = on ? '⛶' : '⛶';
    btn.classList.toggle('pf-on', on);
  }

  // --- progress bar ----------------------------------------------------------
  // Deliberately outside .pf-chrome: it stays visible with the controls hidden,
  // so the reader always knows how far along the chapter it is.

  function updateProgress(ratio) {
    const fill = state.root?.querySelector('.pf-progress-fill');
    if (!fill) return;
    if (ratio === undefined) {
      ratio = state.images.length > 1
        ? state.page / (state.images.length - 1)
        : 1;
    }
    fill.style.width = `${clamp(ratio, 0, 1) * 100}%`;
  }

  function togglePrefs() {
    const p = $('.pf-prefs');
    p.hidden = !p.hidden;
  }

  function toggleBreak() {
    state.breakFirst = !state.breakFirst;
    $('.pf-break').classList.toggle('pf-on', state.breakFirst);
    if (state.mode === 'spread') showPage(state.page);
  }

  function setChrome(visible) {
    state.chromeVisible = visible;
    state.root.classList.toggle('pf-chrome-hidden', !visible);
    if (!visible) $('.pf-prefs').hidden = true;
  }

  // --- transient notices ----------------------------------------------------

  let toastTimer = 0;

  function flash(text, ms = 1600) {
    const el = state.root?.querySelector('.pf-toast');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    // The class drives the fade, and it only animates from an opacity the
    // browser has already computed — hence the forced reflow between the two.
    // A requestAnimationFrame would read better and never run in a background
    // tab, which is exactly where a chapter opened in a second tab lives.
    void el.offsetWidth;
    el.classList.add('pf-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('pf-on');
      setTimeout(() => { if (state.root) el.hidden = true; }, 250);
    }, ms);
  }

  /** The fraction of the width, on each side, that turns the page. */
  function tapTurnWidth() {
    const layout = TAP_LAYOUTS[state.prefs.tapZones];
    return layout === undefined ? TAP_LAYOUTS.sides : layout;
  }

  /** True when tapping the right-hand side moves forward. */
  function tapForwardRight() {
    return (state.mode === 'rtl') === !!state.prefs.invertTap;
  }

  let zoneTimer = 0;

  function showZoneHint(ms = 1400) {
    const box = state.root?.querySelector('.pf-zones');
    if (!box) return;
    const turn = tapTurnWidth();
    const fwd = tapForwardRight();
    const zone = (left, width, label) => {
      const el = document.createElement('div');
      el.className = 'pf-zone';
      el.style.left = `${left * 100}%`;
      el.style.width = `${width * 100}%`;
      el.textContent = label;
      return el;
    };
    box.textContent = '';
    if (turn) {
      box.appendChild(zone(0, turn, fwd ? '← Back' : 'Next →'));
      box.appendChild(zone(turn, 1 - turn * 2, 'Controls'));
      box.appendChild(zone(1 - turn, turn, fwd ? 'Next →' : '← Back'));
    } else {
      box.appendChild(zone(0, 1, 'Controls — keys turn the page'));
    }
    box.hidden = false;
    void box.offsetWidth;   // same reason as flash(): fade from a known opacity
    box.classList.add('pf-on');
    clearTimeout(zoneTimer);
    zoneTimer = setTimeout(() => {
      box.classList.remove('pf-on');
      setTimeout(() => { if (state.root) box.hidden = true; }, 250);
    }, ms);
  }

  function showHelp(show) {
    const help = state.root?.querySelector('.pf-help');
    if (!help) return;
    help.hidden = !show;
    // The controls are what the list talks about; hiding them under it makes
    // half of it unverifiable.
    if (show) setChrome(true);
  }

  // --- rendering -----------------------------------------------------------

  function render() {
    // A fresh element, not an emptied one. Both mode renderers attach their
    // handlers as closures — the pan/pinch pair and the scroll pair are new
    // functions every call, so addEventListener cannot deduplicate them.
    // Re-rendering onto the same node stacked a second copy of each: after two
    // mode switches a one-finger drag moved the page twice as far as the
    // finger, and every scroll saved progress twice.
    const stage = document.createElement('div');
    $('.pf-stage').replaceWith(stage);
    resetTransform();
    if (state.novel) renderNovel(stage);
    else if (state.mode === 'vertical') renderVertical(stage);
    else renderPaged(stage);
    applyPrefs();
    $('.pf-play').hidden = state.mode !== 'vertical';
    $('.pf-break').hidden = state.mode !== 'spread';
    $('.pf-scrub').classList.toggle('pf-rtl', state.mode === 'rtl');
    updateCounter();
    preload();
    // render() runs on open and on every mode change, which is exactly when the
    // direction is news. The help list already says it, so do not say it twice.
    if ($('.pf-help').hidden) {
      flash(state.novel ? 'Text chapter — scroll down' : MODE_TOAST[state.mode] || '');
    }
  }

  function renderVertical(stage) {
    stage.className = 'pf-stage pf-vertical';
    for (const src of state.images) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = src;
      stage.appendChild(img);
    }
    attachStripScroll(stage);
    // Keep the reading position across mode switches.
    if (state.page > 0) {
      scrollToRatio(stage, state.page / Math.max(1, state.images.length - 1));
    }
  }

  // Prose. The page's own markup never enters the overlay — every paragraph is
  // set as text, so a chapter body carrying scripts, styles, iframes or an ad
  // slot arrives here as the words it was supposed to be.
  function renderNovel(stage) {
    stage.className = 'pf-stage pf-vertical pf-novel';
    const article = document.createElement('article');
    article.className = 'pf-text';
    for (const para of state.paragraphs) {
      const p = document.createElement('p');
      p.textContent = para;
      article.appendChild(p);
    }
    stage.appendChild(article);
    measureScreens();
    attachStripScroll(stage);
    if (state.scrollRatio > 0) scrollToRatio(stage, state.scrollRatio);
  }

  // A novel has no pages, so a screenful is the unit: it is what the scrubber
  // steps through and what "how far in" is counted in.
  function measureScreens() {
    const stage = state.root?.querySelector('.pf-stage');
    if (!stage || !state.novel) return;
    state.screens = Math.max(1, Math.round(stage.scrollHeight / Math.max(1, stage.clientHeight)));
    const scrub = state.root.querySelector('.pf-scrub');
    if (scrub) scrub.max = state.screens;
  }

  function attachStripScroll(stage) {
    const ratio = () =>
      stage.scrollTop / Math.max(1, stage.scrollHeight - stage.clientHeight);
    // The bar tracks the scroll live; the (costlier) counter and progress save
    // stay debounced.
    stage.addEventListener('scroll', () => {
      state.scrollRatio = ratio();
      updateProgress(state.scrollRatio);
    }, { passive: true });
    stage.addEventListener('scroll', debounce(() => {
      state.scrollRatio = ratio();
      state.page = Math.round(state.scrollRatio * (pageTotal() - 1));
      updateCounter();
      updateProgress(state.scrollRatio);
      saveProgress();
    }, 500));
    stage.addEventListener('click', (e) => {
      // Selecting a line of prose ends in a click on it, and hiding the
      // controls under someone who was copying a quote is not what they asked.
      if (String(getSelection?.() || '')) return;
      if (e.target === stage || e.target.tagName === 'IMG' || e.target.closest('.pf-text')) {
        setChrome(!state.chromeVisible);
      }
    });
    // Any manual interaction pauses autoplay.
    stage.addEventListener('wheel', stopAutoplay, { passive: true });
    stage.addEventListener('pointerdown', stopAutoplay);
  }

  // Images size in asynchronously, so a strip that has not laid out yet has no
  // height to scroll into and every seek silently lands on page 1. Retry until
  // it has one, and stop if the reader closed or re-rendered underneath.
  function scrollToRatio(stage, ratio) {
    let tries = 0;
    const attempt = () => {
      if (!state.root || $('.pf-stage') !== stage) return;
      const max = stage.scrollHeight - stage.clientHeight;
      if (max > 0) stage.scrollTop = ratio * max;
      else if (++tries < 20) setTimeout(attempt, 150);
    };
    setTimeout(attempt, 50);
  }

  function renderPaged(stage) {
    stage.className = 'pf-stage pf-paged';
    const wrap = document.createElement('div');
    wrap.className = 'pf-zoomwrap';
    stage.appendChild(wrap);
    attachZoomPan(stage, wrap);
    stage.addEventListener('click', onTapZones);
    showPage(state.page, wrap);
  }

  // Spread pairing honours "break 1st page": cover pages stand alone so the
  // following spreads align the way the book was printed (MangaPin's B key).
  function spreadIndices(n) {
    if (!state.breakFirst) return [n, n + 1];
    if (n === 0) return [0];
    return [n, n + 1];
  }

  function pageStart(n) {
    // Align to spread boundaries so stepping lands on pair starts.
    if (state.mode !== 'spread') return n;
    if (!state.breakFirst) return n - (n % 2);
    return n === 0 ? 0 : n - ((n - 1) % 2);
  }

  function showPage(n, wrap = $('.pf-zoomwrap')) {
    const spread = state.mode === 'spread';
    n = clamp(pageStart(n), 0, state.images.length - 1);
    state.page = n;
    wrap.innerHTML = '';
    const indices = (spread ? spreadIndices(n) : [n]).filter((i) => i < state.images.length);
    const ordered = state.mode === 'rtl' ? indices.slice().reverse() : indices;
    for (const i of ordered) {
      const img = document.createElement('img');
      img.src = state.images[i];
      wrap.appendChild(img);
    }
    // Deliberately DO NOT reset zoom/pan here: the user's framing survives
    // page turns (the anti-snap-back differentiator). Zoom persists; only
    // an explicit double-tap resets it.
    applyTransform();
    updateCounter();
    preload();
    saveProgress();
  }

  function step(delta) {
    const stride = state.mode === 'spread' ? spreadIndices(state.page).length : 1;
    const target = state.page + delta * stride;
    if (target > state.images.length - 1) return endOfChapter();
    showPage(target);
  }

  function next() { step(1); }
  function prev() { step(-1); }

  // Reaching the end: honor "auto next chapter" when a next chapter exists.
  function endOfChapter() {
    if (state.prefs.autoNext && state.nav?.nextUrl) gotoChapter(state.nav.nextUrl);
  }

  function onTapZones(e) {
    if (e.target.closest('.pf-chrome')) return;
    if (e.target.closest('.pf-help')) return;
    if (suppressTapUntil > Date.now()) return; // ignore tap that ended a pan
    const turn = tapTurnWidth();
    const x = e.clientX / innerWidth;
    // The mode decides which side is forward; the preference only swaps it, so
    // a manga reader who prefers "right = next" keeps it across both directions.
    const fwd = tapForwardRight();
    if (turn && x < turn) return fwd ? prev() : next();
    if (turn && x > 1 - turn) return fwd ? next() : prev();
    setChrome(!state.chromeVisible);
  }

  function onKey(e) {
    if (!state.root) return;
    // The wheel is on top and gets first refusal: while it is open, up and down
    // search the chapter list rather than turning pages behind it.
    if (!$('.pf-wheel').hidden && onWheelKey(e)) return;
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      if (!$('.pf-chapwrap').hidden) return openWheel($('.pf-wheel').hidden);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc dismisses what is on top first. Closing the reader out from under
      // someone who only wanted the help list gone loses their place.
      if (!$('.pf-help').hidden) return showHelp(false);
      return close();
    }
    if (e.key === '?') { e.preventDefault(); return showHelp($('.pf-help').hidden); }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); return togglePrefs(); }
    if (e.key === 'b' || e.key === 'B') { e.preventDefault(); return toggleBreak(); }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); return toggleFullscreen(); }
    if (e.key === 'h' || e.key === 'H') { e.preventDefault(); return setChrome(!state.chromeVisible); }
    if (e.key === '0') { e.preventDefault(); resetTransform(); return applyTransform(); }
    if (state.mode === 'vertical') {
      const stage = $('.pf-stage');
      if (e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault(); stopAutoplay();
        stage.scrollBy({ top: innerHeight * 0.8, behavior: 'smooth' });
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); stopAutoplay();
        stage.scrollBy({ top: -innerHeight * 0.8, behavior: 'smooth' });
      }
      return;
    }
    const rtl = state.mode === 'rtl';
    if (e.key === 'ArrowRight') { e.preventDefault(); rtl ? prev() : next(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); rtl ? next() : prev(); }
    if (e.key === ' ') { e.preventDefault(); next(); }
  }

  function updateCounter() {
    // "Page 3 of 14" means nothing for prose, where the pages are screenfuls of
    // whatever text size happens to be set. How far in you are does mean
    // something, and it is the number a novel reader looks for.
    $('.pf-counter').textContent =
      (state.novel
        ? `${Math.round(state.scrollRatio * 100)}%`
        : `${state.page + 1} / ${state.images.length}`) +
      (state.meta.chapterLabel ? ` — ${state.meta.chapterLabel}` : '');
    const scrub = $('.pf-scrub');
    if (scrub) scrub.value = state.page + 1;
    updateProgress();
  }

  function preload() {
    for (let i = state.page + 1; i <= state.page + PRELOAD_AHEAD && i < state.images.length; i++) {
      const im = new Image();
      im.src = state.images[i];
    }
  }

  // --- lazy page harvesting ------------------------------------------------
  // Most readers load pages as you scroll, so at open time only the first few
  // exist. Scroll the (hidden) page behind the overlay to make it load
  // everything, and append each new image to the reader live. This is how a
  // generic reader gets the full chapter without MangaPin's per-site specs.

  function harvestLazyPages() {
    const container = state.container;
    if (!container || !document.contains(container)) return;
    const seen = new Set(state.images);
    const track = (img) => {
      const add = async () => {
        const src = img.currentSrc || img.src;
        if (!src || seen.has(src)) return;
        if ((img.naturalWidth || img.width) < 300 || (img.naturalHeight || img.height) < 200) return;
        seen.add(src);
        // Snapshot blob: URLs before the site revokes them (scan-manga does).
        const stab = window.__panelflowDetect?.stableImageSrc;
        const finalSrc = stab ? await stab(img) : src;
        if (!state.root) return; // reader closed while snapshotting
        state.images.push(finalSrc);
        onImagesGrown(finalSrc);
      };
      if (img.complete && img.naturalWidth) add();
      else img.addEventListener('load', add, { once: true });
    };
    state.harvestObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.target.tagName === 'IMG') track(m.target);
        for (const n of m.addedNodes || []) {
          if (n.tagName === 'IMG') track(n);
          else if (n.querySelectorAll) n.querySelectorAll('img').forEach(track);
        }
      }
    });
    state.harvestObserver.observe(container, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src'],
    });

    // Drive the page's lazy loading: scroll the document under the overlay.
    document.documentElement.classList.remove('panelflow-noscroll');
    const startY = scrollY;
    let y = startY, idleTicks = 0, lastCount = state.images.length;
    state.harvestTimer = setInterval(() => {
      if (!state.root) return stopHarvest();
      y += innerHeight * 0.9;
      window.scrollTo(0, y);
      if (state.images.length > lastCount) { lastCount = state.images.length; idleTicks = 0; }
      const doc = document.documentElement;
      if (y >= doc.scrollHeight - innerHeight) idleTicks++;
      if (idleTicks > 5) stopHarvest(startY); // bottom reached, nothing new
    }, 400);
    state.harvestRestoreY = startY;
  }

  function stopHarvest(restoreY = state.harvestRestoreY) {
    if (state.harvestTimer) { clearInterval(state.harvestTimer); state.harvestTimer = 0; }
    if (state.harvestObserver) { state.harvestObserver.disconnect(); state.harvestObserver = null; }
    if (restoreY !== undefined) window.scrollTo(0, restoreY);
    if (state.root) document.documentElement.classList.add('panelflow-noscroll');
  }

  function onImagesGrown(src) {
    if (!state.root) return;
    $('.pf-scrub').max = state.images.length;
    if (state.mode === 'vertical') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = src;
      $('.pf-stage').appendChild(img);
    }
    updateCounter();
  }

  // --- autoplay (long strip) ----------------------------------------------

  function toggleAutoplay() {
    state.playing ? stopAutoplay() : startAutoplay();
  }

  function startAutoplay() {
    if (state.mode !== 'vertical' || state.playing) return;
    state.playing = true;
    $('.pf-play').textContent = '⏸';
    state.playLastTs = 0;
    const stage = $('.pf-stage');
    // Track position as a float: incremental += gets truncated to whole
    // physical pixels, so slow speeds would never move at all.
    let pos = stage.scrollTop;
    const tick = (ts) => {
      if (!state.playing || !state.root) return;
      if (state.playLastTs) {
        pos += (state.prefs.autoplaySpeed * (ts - state.playLastTs)) / 1000;
        stage.scrollTop = pos;
        if (stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2) {
          stopAutoplay();
          return endOfChapter();
        }
      }
      state.playLastTs = ts;
      state.playRaf = requestAnimationFrame(tick);
    };
    state.playRaf = requestAnimationFrame(tick);
  }

  function stopAutoplay() {
    if (!state.playing) return;
    state.playing = false;
    cancelAnimationFrame(state.playRaf);
    const btn = state.root?.querySelector('.pf-play');
    if (btn) btn.textContent = '▶';
  }

  // --- zoom & pan (no snap-back) ------------------------------------------

  let suppressTapUntil = 0;

  function resetTransform() {
    state.zoom = 1; state.panX = 0; state.panY = 0;
  }

  function applyTransform() {
    const wrap = $('.pf-zoomwrap');
    if (wrap) wrap.style.transform =
      `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    // The reset button only earns its slot once there is something to reset.
    const btn = state.root?.querySelector('.pf-resetzoom');
    if (btn) btn.hidden = state.zoom <= 1;
  }

  // Clamp so at least MIN_VISIBLE_FRACTION of the content stays in view —
  // the page can be pushed mostly off-screen but never lost entirely, and it
  // is never recentered behind the user's back.
  function clampPan() {
    const wrap = $('.pf-zoomwrap');
    if (!wrap) return;
    const w = wrap.offsetWidth * state.zoom;
    const h = wrap.offsetHeight * state.zoom;
    const keepX = Math.max(innerWidth, w) * MIN_VISIBLE_FRACTION;
    const keepY = Math.max(innerHeight, h) * MIN_VISIBLE_FRACTION;
    state.panX = clamp(state.panX, -(w - keepX), innerWidth - keepX);
    state.panY = clamp(state.panY, -(h - keepY), innerHeight - keepY);
  }

  function attachZoomPan(stage, wrap) {
    const pointers = new Map();
    let lastDist = 0, lastMid = null, panning = false, lastTap = 0;

    stage.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && state.mode === 'vertical') return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    stage.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        // Double tap: zoom into the tapped point, or reset if already zoomed
        // (MangaPin's "double tap to zoom"). The only ways the view recenters.
        if (Date.now() - lastTap < 300) {
          if (state.zoom > 1) resetTransform();
          else { state.zoom = 1; zoomAt(e.clientX, e.clientY, 2.5); suppressTapUntil = Date.now() + 250; }
          applyTransform();
        }
        lastTap = Date.now();
      }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        lastDist = Math.hypot(a.x - b.x, a.y - b.y);
        lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      stage.setPointerCapture(e.pointerId);
    });

    stage.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (lastDist > 0) zoomAt(mid.x, mid.y, dist / lastDist);
        state.panX += mid.x - lastMid.x;
        state.panY += mid.y - lastMid.y;
        lastDist = dist; lastMid = mid;
        applyTransform();
      } else if (pointers.size === 1 && state.zoom > 1) {
        if (Math.abs(dx) + Math.abs(dy) > 2) panning = true;
        state.panX += dx; state.panY += dy;
        applyTransform();
      }
    });

    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      lastDist = 0;
      if (pointers.size === 0) {
        if (panning) suppressTapUntil = Date.now() + 200;
        panning = false;
        // Settle to the nearest legal bound — elastic, not a reset.
        clampPan();
        wrap.style.transition = 'transform 120ms ease-out';
        applyTransform();
        setTimeout(() => { wrap.style.transition = ''; }, 140);
      }
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);

    function zoomAt(cx, cy, factor) {
      const newZoom = clamp(state.zoom * factor, 1, 8);
      const applied = newZoom / state.zoom;
      // Keep the focal point stationary while zooming.
      state.panX = cx - (cx - state.panX) * applied;
      state.panY = cy - (cy - state.panY) * applied;
      state.zoom = newZoom;
      if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
      applyTransform();
    }
  }

  // --- download ------------------------------------------------------------

  // Built here, not in the worker: sites like scan-manga hand pages out as
  // blob: URLs that only exist in this document, and same-origin fetches
  // carry the page's cookies/referer for free. Cross-origin CDN images that
  // CORS won't let us read fall back to the worker (DNR sets their referer).
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipStore(files) { // [{name, bytes}] -> Uint8Array (no compression)
    const chunks = [], central = [];
    let offset = 0;
    const le16 = (v) => [v & 255, (v >> 8) & 255];
    const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    for (const { name, bytes } of files) {
      const nameB = new TextEncoder().encode(name);
      const crc = crc32(bytes);
      const head = new Uint8Array([
        ...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
        ...le32(crc), ...le32(bytes.length), ...le32(bytes.length), ...le16(nameB.length), ...le16(0),
      ]);
      chunks.push(head, nameB, bytes);
      central.push(new Uint8Array([
        ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
        ...le32(crc), ...le32(bytes.length), ...le32(bytes.length), ...le16(nameB.length),
        ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset),
      ]), nameB);
      offset += head.length + nameB.length + bytes.length;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const end = new Uint8Array([
      ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length),
      ...le32(centralSize), ...le32(centralStart), ...le16(0),
    ]);
    const all = [...chunks, ...central, end];
    const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
    let pos = 0;
    for (const c of all) { out.set(c, pos); pos += c.length; }
    return out;
  }

  async function fetchPageBytes(src) {
    try {
      const resp = await fetch(src, { credentials: 'include' });
      if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
    } catch { /* CORS or network — try the worker */ }
    const resp = await new Promise((r) =>
      chrome.runtime.sendMessage({ type: 'fetchImage', url: src, siteUrl: location.href }, r));
    if (!resp?.b64) return null;
    const bin = atob(resp.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** `Title - Ch. 5` with everything a file name cannot hold taken out. */
  function chapterFileName(ext) {
    const safe = (s) => String(s || '').replace(/[<>:"/\\|?*]+/g, ' ').trim().slice(0, 80);
    return `${safe(state.meta.title) || 'chapter'}` +
      `${state.meta.chapterLabel ? ' - ' + safe(state.meta.chapterLabel) : ''}.${ext}`;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function downloadChapter() {
    const btn = state.root.querySelector('[data-act="download"]');
    // A text chapter is already in hand — there is nothing to fetch, and a
    // .cbz of it would be an archive of nothing.
    if (state.novel) {
      const head = [state.meta.title, state.meta.chapterLabel].filter(Boolean).join(' — ');
      // CRLF: the file lands in Notepad as often as anywhere else.
      const body = [head, ...state.paragraphs].join('\r\n\r\n');
      saveBlob(new Blob([body], { type: 'text/plain;charset=utf-8' }), chapterFileName('txt'));
      btn.textContent = '✓';
      setTimeout(() => { if (state.root) btn.textContent = '⬇'; }, 3000);
      return;
    }
    btn.disabled = true;
    try {
      const images = state.images.slice();
      const files = [];
      for (let i = 0; i < images.length; i++) {
        btn.textContent = `${i + 1}/${images.length}`;
        const bytes = await fetchPageBytes(images[i]);
        if (!bytes) continue;
        // blob:/data: URLs carry no extension — sniff the magic bytes.
        const ext =
          bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' :
          bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg' :
          bytes[0] === 0x52 && bytes[1] === 0x49 ? 'webp' :
          bytes[0] === 0x47 && bytes[1] === 0x49 ? 'gif' :
          (images[i].match(/\.(jpe?g|png|webp|gif|avif)(?=$|[?#])/i) || [, 'jpg'])[1];
        files.push({ name: String(i + 1).padStart(3, '0') + '.' + ext, bytes });
      }
      if (!files.length) throw new Error('no pages');
      saveBlob(
        new Blob([zipStore(files)], { type: 'application/vnd.comicbook+zip' }),
        chapterFileName('cbz'),
      );
      btn.textContent = '✓';
    } catch {
      btn.textContent = '⚠';
    } finally {
      btn.disabled = false;
      setTimeout(() => { if (state.root) btn.textContent = '⬇'; }, 3000);
    }
  }

  // --- offline ---------------------------------------------------------------
  // "Download" writes a .cbz to the user's disk, which is theirs to keep and
  // nothing here ever reads again. "Save offline" puts the same pages inside
  // PanelFlow, so the chapter opens with no network. Two different wants, two
  // buttons.
  //
  // The pages cannot be stored from here. A content script runs on the site's
  // origin, so its IndexedDB is the *site's* — a library kept there would be
  // invisible to the extension and cleared with that site's data. So the bytes
  // go to the service worker, which owns the extension's own origin, one page
  // per message because chrome messaging is JSON and a Blob is not.

  const chunk = (bytes) => {
    let bin = '';
    // 0x8000 at a time: `apply` on a 5 MB array overflows the argument stack.
    for (let p = 0; p < bytes.length; p += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(p, p + 0x8000));
    }
    return btoa(bin);
  };

  /** The saved/not-saved state of the open chapter, on the button. */
  function markOffline(saved) {
    const btn = state.root?.querySelector('[data-act="offline"]');
    if (!btn) return;
    btn.textContent = saved ? '📗' : '📥';
    btn.title = saved ? 'Saved offline — click to remove' : 'Save for offline reading';
    btn.dataset.saved = saved ? '1' : '';
  }

  async function refreshOffline() {
    if (!state.meta?.chapterUrl) return;
    const r = await send({ type: 'offlineHas', chapterUrl: state.meta.chapterUrl });
    markOffline(!!r?.saved);
  }

  async function toggleOffline() {
    const btn = state.root.querySelector('[data-act="offline"]');
    if (btn.dataset.saved) {
      await send({ type: 'offlineRemove', chapterUrl: state.meta.chapterUrl });
      markOffline(false);
      return;
    }
    btn.disabled = true;
    try {
      const meta = {
        ...state.meta,
        kind: state.novel ? 'text' : 'images',
        // Prose is small enough to travel in the metadata, so a text chapter is
        // saved by the commit alone — there is nothing to fetch.
        paragraphs: state.novel ? state.paragraphs.slice() : undefined,
        bytes: 0,
      };
      if (!state.novel) {
        const images = state.images.slice();
        for (let i = 0; i < images.length; i++) {
          btn.textContent = `${i + 1}/${images.length}`;
          const bytes = await fetchPageBytes(images[i]);
          if (!bytes) continue;
          const r = await send({
            type: 'offlinePage',
            chapterUrl: state.meta.chapterUrl,
            index: i,
            b64: chunk(bytes),
            mime: `image/${(images[i].match(/\.(jpe?g|png|webp|gif|avif)(?=$|[?#])/i) || [, 'jpeg'])[1]
              .replace(/^jpg$/i, 'jpeg')}`,
          });
          if (!r?.ok) throw new Error('page rejected');
          meta.bytes += bytes.length;
        }
      }
      // Last, and only now: until this lands the chapter does not exist, which
      // is what keeps a save interrupted halfway from being offered as readable.
      const done = await send({ type: 'offlineCommit', meta });
      if (!done?.ok) throw new Error('commit failed');
      markOffline(true);
    } catch {
      btn.textContent = '⚠';
      setTimeout(() => { if (state.root) markOffline(false); }, 3000);
    } finally {
      btn.disabled = false;
    }
  }

  // --- library & progress --------------------------------------------------

  // Opens the details sheet rather than adding blind, so folder/score/tags are
  // captured while the series is in front of you.
  function addToLibrary() {
    window.PanelFlowLibraryModal?.open(state.meta);
  }

  const saveProgress = debounce(() => {
    if (!state.root) return;
    chrome.runtime.sendMessage({ type: 'saveProgress', progress: {
      sourceUrl: state.meta.sourceUrl,
      chapterUrl: state.meta.chapterUrl,
      chapterLabel: state.meta.chapterLabel,
      page: state.page,
      pageCount: pageTotal(),
      // A novel's position is the scroll itself, not a page derived from it:
      // rounding to the nearest screenful of a fifteen-screen chapter drops the
      // reader up to half a screen from where they stopped.
      scrollPos: state.novel ? state.scrollRatio
        : state.page / Math.max(1, state.images.length - 1),
    }});
  }, 800);

  // --- how long this chapter was actually read -----------------------------
  //
  // Wall clock between opening and closing is not reading time: a chapter left
  // open in a background tab overnight would claim eight hours, and the whole
  // point of the statistics is that they are not made up. The clock runs only
  // while this tab is visible and the reader is open, and it is banked on every
  // pause so a tab closed without an unload event still counts what it saw.

  const clock = { since: 0, banked: 0, day: null };

  function clockStart() {
    if (clock.since || !state.root || document.hidden) return;
    clock.since = Date.now();
    clock.day ??= localDay();
  }

  function clockPause() {
    if (!clock.since) return;
    clock.banked += Math.round((Date.now() - clock.since) / 1000);
    clock.since = 0;
  }

  // A chapter read across midnight is banked under the day it started: it is
  // one sitting, and splitting it would invent a second read out of a clock.
  const localDay = (ts = Date.now()) => {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  function bankRead() {
    clockPause();
    if (clock.banked < 5) return;   // a glance at the wrong chapter is not a read
    chrome.runtime.sendMessage({ type: 'recordRead', read: {
      sourceUrl: state.meta.sourceUrl,
      chapterUrl: state.meta.chapterUrl,
      chapterLabel: state.meta.chapterLabel,
      pages: state.page + 1,
      seconds: clock.banked,
      day: clock.day,
    }});
    clock.banked = 0;
  }

  const onVisibility = () => (document.hidden ? bankRead() : clockStart());

  function restoreProgress() {
    chrome.runtime.sendMessage(
      { type: 'getProgressFor', chapterUrl: state.meta.chapterUrl },
      (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.progress) return;
        const p = resp.progress;
        if (state.mode === 'vertical') {
          // This runs while the strip is still empty of laid-out images, so the
          // scroll has to wait for a height like the mode switch does — it used
          // to multiply by zero and drop the reader at the top of the chapter,
          // in the one mode that is the default.
          const ratio = Number(p.scrollPos);
          if (!Number.isFinite(ratio) || ratio <= 0) return;
          state.scrollRatio = ratio;
          state.page = Math.round(ratio * Math.max(0, pageTotal() - 1));
          updateCounter();
          scrollToRatio($('.pf-stage'), ratio);
        } else if (p.page > 0) {
          showPage(p.page);
        }
      });
  }

  // --- utils ---------------------------------------------------------------

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function debounce(fn, ms) {
    let t;
    const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    wrapped.flush = () => { clearTimeout(t); fn(); };
    return wrapped;
  }

  // A text chapter is the same reader with paragraphs where the images go, so it
  // is the same open() — the empty image list is what everything downstream
  // (page count, download, mode picker) branches on through state.novel.
  const openText = (paragraphs, meta, rule) => open([], meta, rule, null, paragraphs);

  window.PanelFlowReader = { open, openText, close, isOpen };
})();
