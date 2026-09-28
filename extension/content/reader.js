// PanelFlow Reader Mode overlay.
// Modes: vertical scroll, single page, double-page spread — the last two left
// to right, or right to left for manga (a setting, remembered per series).
// Key differentiator: free-form pinch-zoom/pan that NEVER snaps back —
// boundaries are elastic (resisted) but the view settles at the bound,
// not at the origin. The long strip zooms too, by widening it.
// Shortcuts: Esc close · arrows navigate · S preferences · B break 1st page.
(() => {
  'use strict';
  if (window.__panelflowReaderLoaded) return;
  window.__panelflowReaderLoaded = true;

  /**
   * Whether this page is inside one of PanelFlow's own phone shells.
   *
   * Not "is this a touch screen": a laptop with a touch screen is still a
   * laptop with a keyboard, and the two things this answer changes — the help
   * text and the hide-controls button — are about what the reader is holding.
   * The three shells install exactly one of these two globals, and a page in
   * Chrome has neither.
   */
  const inShell = () => !!(window.PanelFlowNative
    || (window.webkit && window.webkit.messageHandlers
      && window.webkit.messageHandlers.panelflow));

  /**
   * Whether the reader is held rather than pointed at: a phone shell, or any
   * screen whose main pointer is a finger.
   *
   * Three things follow from it that a mouse does not need: controls that get
   * out of the way on their own, a finger's size for every one of them, and
   * the secondary actions in the bottom bar rather than in a column over the
   * right-hand edge — which is exactly where a thumb turns the page (QA,
   * September 2026: nine taps there opened and closed the settings instead).
   */
  const touchFirst = () => inShell()
    || !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  /**
   * The reader's drawings: one stroked set in the text colour, the family the
   * website's sprite belongs to (docs/redesign.md §3.3). Emoji were a
   * different picture on every phone, two of them in colour beside five in
   * monochrome, and a red cross meant "already added" (QA, September 2026).
   * Paths only, written here: nothing from the page is ever put in one.
   */
  const ICONS = {
    close: 'M6 6l12 12M18 6L6 18',
    prevch: 'M17 6l-7 6 7 6M7 6v12',
    nextch: 'M7 6l7 6-7 6M17 6v12',
    chevron: 'M7 10l5 5 5-5',
    library: 'M7 4h10v16l-5-4-5 4z',
    offline: 'M12 4v10m0 0l-4-4m4 4l4-4M5 19h14',
    saved: 'M5 12l4 4 10-10M5 20h14',
    warn: 'M12 4l9 16H3zM12 10v4M12 17v.5',
    prefs: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    resetzoom: 'M10.5 4a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM20 20l-4.8-4.8M7.5 10.5h6',
    fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
    help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.6 9.2a2.5 2.5 0 014.9.8c0 1.7-2.5 2.2-2.5 4M12 17v.5',
    hide: 'M4 9l8-5 8 5M4 15l8 5 8-5',
    break: 'M4 5h7v14H4zM13 5h7v14h-7',
    play: 'M8 5l11 7-11 7z',
    pause: 'M9 5v14M15 5v14',
  };
  const icon = (name) => `<svg class="pf-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"/></svg>`;

  /** How long the first tap of a possible double tap is held back. */
  const DOUBLE_TAP_MS = 250;

  const PRELOAD_AHEAD = 3;
  const MIN_VISIBLE_FRACTION = 0.15; // part of the page that must stay on screen

  const DEFAULT_PREFS = {
    brightness: 100, contrast: 100, gap: 0, stripWidth: 100,
    autoNext: false, autoplaySpeed: 80, progressSize: 3,
    tapZones: 'sides',
    // Right to left, for manga: the pages, the double page, the arrows, the
    // scrubber and the sides of the screen all turn the other way. It used to
    // be a checkbox that swapped the tap sides and nothing else, so a double
    // page still read p1 | p2 and → still went forward (QA, September 2026).
    rtl: false,
    // On by default, and the default is the whole argument: a page of artwork
    // is looked at rather than read, and paper-white margins around it at night
    // are a lamp pointed at the reader. Off hands the choice to the system —
    // this runs on a scan site's origin and cannot see the settings page's.
    readerDark: true,
    // Off by default: a chapter list with holes in it is confusing until you
    // know why, and the reader who wants this is the one on chapter 400 of a
    // list of 900 — they will find the switch.
    hideRead: false,
    // Novel mode. Stored as whole numbers because every control here is a
    // range input: the line height is a percentage, applied as 1.65.
    fontSize: 18, lineHeight: 165, textWidth: 680,
  };

  // What a series is allowed to remember for itself, on top of the settings
  // above. Mihon's hierarchy: global defaults, overridden per series, and the
  // override is asked for rather than assumed.
  //
  // These three and no others, because these three are what actually differ
  // between two series read on the same evening — which way the pages go, and
  // how wide the strip or the text column is. Brightness, tap zones and
  // autoplay describe the reader and the room they are in, not the book, and a
  // reader who dims the screen for the night does not want it back at full
  // brightness because the next series remembers otherwise. `mode` is listed
  // apart because it is not in readerPrefs: it has always had storage of its own.
  const SERIES_KEYS = ['stripWidth', 'textWidth', 'rtl'];

  /**
   * Stored reader settings, read the way this version understands them.
   *
   * `invertTap` was the direction before there was one: whoever ticked it
   * wanted the left side to go forward, which is what reading right to left
   * is. Carried over once, and not written back under the old name.
   */
  function readerSettings(stored) {
    const out = { ...(stored || {}) };
    if (!('rtl' in out) && out.invertTap === true) out.rtl = true;
    delete out.invertTap;
    return out;
  }
  // A record is three numbers and a timestamp. The cap is not about bytes, it
  // is about a store nobody ever prunes: four hundred series read over a year
  // would otherwise carry four hundred rows of "and this one is right to left"
  // for ever, including for series the reader dropped in March.
  const SERIES_LIMIT = 200;

  // How much of the screen width, on each edge, turns the page. The rest of it
  // toggles the controls. `edges` is for readers who keep tapping the middle of
  // a panel to look at it and turning the page by accident; `off` is for a mouse
  // and the arrow keys, where a stray click should never move anything.
  const TAP_LAYOUTS = { sides: 0.33, edges: 0.18, off: 0 };

  // Shown for a moment when the reader opens and whenever the mode changes: the
  // direction is the one thing you must know before the first tap, and getting
  // it wrong means reading a chapter backwards before noticing.
  //
  // Read through t() at use, not once at load: this script is injected into a
  // page that may outlive a locale change, and a frozen table would keep
  // announcing the direction in the language the tab was opened in.
  const modeToast = (mode, rtl) => ({
    vertical: 'modeToastVertical',
    ltr: rtl ? 'modeToastLtrRtl' : 'modeToastLtr',
    spread: rtl ? 'modeToastSpreadRtl' : 'modeToastSpread',
  }[mode]);

  const state = {
    root: null, images: [], meta: null, rule: {}, nav: null, container: null,
    mode: 'vertical', page: 0, chromeVisible: true,
    zoom: 1, panX: 0, panY: 0,
    // The long strip's own zoom: how many times wider than it rests.
    stripZoom: 1,
    breakFirst: false, prefs: { ...DEFAULT_PREFS },
    // The settings as they are stored, kept apart from `prefs` so that a series
    // override never leaks back into them: `prefs` is what this chapter reads
    // by, `globalPrefs` is what every other series will read by tomorrow.
    globalPrefs: { ...DEFAULT_PREFS }, seriesPrefs: null, seriesAll: {},
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
    // the frame the scroll handler is waiting for. The last two are what the
    // scroll handler is allowed to touch — the rows as an array, and which of
    // them currently carries the highlight — because looking either up in the
    // DOM on a series with a thousand chapters is what stopped the wheel from
    // scrolling at all.
    chapters: [], wheelIndex: 0, wheelRaf: 0,
    wheelRows: null, wheelOn: -1,
    // The chapter fetched behind this one (see fetchAhead): its address, the
    // pages once they are known, and the promise of them meanwhile. `wanted` is
    // the chapter the reader is on its way to, so that a slow answer for a
    // chapter nobody wants any more is dropped rather than swapped in.
    ahead: null, aheadTimer: 0, wanted: null,
  };

  const $ = (sel) => state.root.querySelector(sel);

  /**
   * Ask the worker something, as a promise.
   *
   * A content script cannot load extension/send.js, so the one line it adds is
   * repeated here: the worker names which handler died (`failedAt`), and this
   * is the only place in this file that sees every answer. Without it a failed
   * download or a lost bookmark shows a ⚠ on a button and says nothing to the
   * page console, which is the one console anybody actually has open on a scan
   * site. The reply is passed through untouched.
   */
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

  /** How many units the position is counted in — page images, or screenfuls. */
  const pageTotal = () => (state.novel ? state.screens : state.images.length);

  // The one question the modes get asked all over this file, so it is asked in
  // one place. There used to be two — pairing and direction — because two of
  // the five modes were right to left. Those two are gone: which side moves
  // forward is now `invertTap`, one preference instead of a property smuggled
  // into a mode name.
  /**
   * The three modes that exist, and what a fourth one becomes.
   *
   * A phone that read a chapter in `rtl` last month still has that word in
   * storage, and another client on the account may still write it. Anything
   * unrecognised reads as vertical — which is the mode that cannot be wrong,
   * because a strip has no page order to get backwards.
   */
  const MODES = ['vertical', 'ltr', 'spread'];
  // The two right-to-left modes of before, which said a layout and a
  // direction at once: now the layout, with the direction as its own setting.
  const LEGACY_RTL = { rtl: 'ltr', 'spread-rtl': 'spread' };
  const knownMode = (mode) => (MODES.includes(mode) ? mode : LEGACY_RTL[mode] || 'vertical');

  const isSpread = () => state.mode === 'spread';

  async function open(images, meta, rule, container, paragraphs = null) {
    if (state.root) close();
    Object.assign(state, {
      images: images.slice(), meta, rule, container: container || null,
      paragraphs: paragraphs ? paragraphs.slice() : [], novel: !!paragraphs,
      screens: 1, scrollRatio: 0, readChapters: null,
      chapters: [], wheelIndex: 0, wheelRows: null, wheelOn: -1,
      // True, not false: restoreProgress can drop the reader straight at the
      // bottom of a strip they left there, and that arrival must not count as
      // reaching the end — with "auto next chapter" on it would walk the whole
      // series in one go without a page being read. Only a crossing counts.
      atEnd: true,
      page: 0, zoom: 1, panX: 0, panY: 0, stripZoom: 1,
      breakFirst: false, playing: false,
      nav: window.__panelflowDetect?.chapterNav?.() || null,
    });
    // After the state above, which callers read straight back, and before
    // anything is built: every control in here is a symbol with a title on it,
    // and a chosen language is read from storage — so building ahead of that
    // read would label the whole reader in the browser's language instead.
    await PanelFlowI18n.ready;
    // Resolved once the reader is built, not once storage was asked: a caller
    // that keeps feeding pages (detect.js, a chapter walked page by page) asks
    // isOpen() to know whether to go on, and between here and build() the
    // answer would be no for a reader that is on its way.
    await new Promise((built) => chrome.storage.local.get(['readerMode', 'readerPrefs', 'readerHelpSeen', 'readerSeries'], (v) => {
      state.seriesAll = v.readerSeries || {};
      state.seriesPrefs = state.seriesAll[state.meta.sourceUrl] || null;
      // Text has no reading direction and nothing to page through, so the mode
      // picker does not apply to it — and everything downstream that asks about
      // the mode ("can it autoplay", "do arrows scroll") wants the strip answer.
      //
      // The series' own answer comes first when it has one. That is the whole
      // of the override: a webtoon and a tankōbon read right to left have no
      // business sharing a mode, and the reader who switched for one of them
      // should not have to switch back on opening the other.
      const stored = state.seriesPrefs?.mode || v.readerMode;
      state.mode = state.novel ? 'vertical' : knownMode(stored);
      state.globalPrefs = { ...DEFAULT_PREFS, ...readerSettings(v.readerPrefs) };
      state.prefs = { ...state.globalPrefs, ...seriesPick(state.seriesPrefs) };
      if (LEGACY_RTL[stored] && !('rtl' in (state.seriesPrefs || {}))) state.prefs.rtl = true;
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
      // On a phone the bar goes by itself after a moment, as it does in every
      // reader held in one hand. It used to stay up from the second chapter on
      // — only the help list, shown once, ever started the countdown.
      if (touchFirst()) setChrome(true);
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
      built();
    }));
  }

  /**
   * The reader closed by the reader, with ✕ or Escape.
   *
   * The page comes back with its pill, so there is still a way in. It used to
   * come back with nothing — no pill, no button — and Alt+R, which nobody
   * knows, was the only way to reopen it (QA, September 2026). Not in close()
   * itself: opening the next chapter closes the reader first, and a pill that
   * flashed on every chapter change would be a pill nobody asked for.
   */
  function closeByUser() {
    close();
    window.__panelflowDetect?.showPill?.();
    // Back where the reader is entered from, which is also how it is entered
    // again (WCAG 2.4.3): the focus used to fall to the page's <body>, and a
    // keyboard had to find its way back through the whole site (QA re-test).
    document.getElementById('panelflow-pill')?.focus?.({ preventScroll: true });
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
    giveViewportBack();
    // A fetch already in flight is left to finish and be ignored; what must not
    // happen is one starting for a reader that is no longer there.
    clearTimeout(state.aheadTimer);
    state.aheadTimer = 0;
    state.ahead = null;
    state.wanted = null;

    // Free the blob URLs the detector minted for this chapter — they pin the
    // full image bytes until revoked. On a delay, not immediately: an offline
    // save started a second before closing is still reading them. The array
    // is captured here because open() calls close() and only then puts a fresh
    // one on state — by the time the timer fires this is the old chapter's.
    const stale = state.images;
    const release = window.__panelflowDetect?.releaseStable;
    if (release) setTimeout(() => release(stale), 60000);
  }

  const isOpen = () => !!state.root;

  /**
   * More pages of the chapter being read, in order, after the reader opened.
   *
   * For a chapter walked one address at a time (detect.js, walkPages): the
   * reader opens on the first pages and the rest arrive here as they are read.
   * The same door harvestLazyPages uses for a strip that grows under the
   * overlay, so a page added either way is drawn the same. A page already in
   * is not added twice, and a reader that is closed takes nothing.
   */
  function addPages(srcs) {
    if (!Array.isArray(state.images)) return;
    for (const src of srcs || []) {
      if (!src || state.images.includes(src)) continue;
      state.images.push(src);
      onImagesGrown(src);
    }
  }

  // --- DOM -----------------------------------------------------------------

  // --- the page's viewport, while the reader is over it ----------------------
  //
  // The overlay is `position: fixed; inset: 0`, which is the layout viewport —
  // and the page decides how big that is. A site with no viewport tag is laid
  // out 980 px wide and shown at 0.4 on a phone: every control a third of a
  // fingertip. A site whose pictures are wider than the phone is laid out wider
  // than the screen: the reader was 728 px across a 390 px phone, with only ✕
  // showing (QA, September 2026). So while the reader is open the page is told
  // the phone's width at a scale of one that pinching cannot change — the
  // reader zooms its own pages — and it gets its own tag back on the way out,
  // scrolled to where it was. On a desktop the tag is ignored and nothing moves.
  const READER_VIEWPORT = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  let viewportTaken = null;

  function takeViewport() {
    if (viewportTaken) return;
    const tags = [...document.querySelectorAll('meta[name="viewport" i]')];
    viewportTaken = {
      tags: tags.map((el) => ({ el, content: el.getAttribute('content') })),
      added: null, x: scrollX, y: scrollY,
    };
    for (const el of tags) el.setAttribute('content', READER_VIEWPORT);
    if (!tags.length) {
      const el = document.createElement('meta');
      el.name = 'viewport';
      el.content = READER_VIEWPORT;
      (document.head || document.documentElement).appendChild(el);
      viewportTaken.added = el;
    }
  }

  function giveViewportBack() {
    const was = viewportTaken;
    viewportTaken = null;
    if (!was) return;
    was.added?.remove();
    for (const { el, content } of was.tags) {
      if (content === null) el.removeAttribute('content');
      else el.setAttribute('content', content);
    }
    // Laid out at the phone's width while it was hidden, the page is back at
    // its own and its scroll offsets mean something else: put it where it was.
    requestAnimationFrame(() => scrollTo(was.x, was.y));
  }

  function build() {
    document.documentElement.classList.add('panelflow-noscroll');
    takeViewport();
    const root = document.createElement('div');
    root.id = 'panelflow-reader';
    // Focusable by script only: where the focus goes back to when a toast's
    // button it was on goes away, instead of the page's <body> (QA re-test
    // It.4, N19).
    root.tabIndex = -1;
    // Written with t() interpolated rather than data-i18n attributes placed
    // afterwards: this markup is built once, in one string, and a second pass
    // over it would only be a slower way of arriving at the same result. The
    // keys resolve from bundled locale files, never from the page around them.
    root.innerHTML = `
      <div class="pf-topbar pf-chrome">
        <button class="pf-btn" data-act="close" title="${t('readerClose')}" aria-label="${t('readerClose')}">${icon('close')}</button>
        <span class="pf-title"></span>
        <button class="pf-btn pf-chapnav" data-act="prevch" title="${t('readerPrevChapter')}" aria-label="${t('readerPrevChapter')}">${icon('prevch')}</button>
        <div class="pf-chapwrap" hidden>
          <button class="pf-btn pf-chapbtn" data-act="chapters" title="${t('readerChaptersTitle')}"
                  aria-haspopup="listbox" aria-expanded="false"><span class="pf-chaplabel">${t('readerChapters')}</span>${icon('chevron')}</button>
          <div class="pf-wheel" role="listbox" tabindex="-1" hidden></div>
        </div>
        <button class="pf-btn pf-chapnav" data-act="nextch" title="${t('readerNextChapter')}" aria-label="${t('readerNextChapter')}">${icon('nextch')}</button>
      </div>
      <div class="pf-stage"></div>
      <div class="pf-side pf-chrome">
        <button class="pf-btn" data-act="library" title="${t('popupAddToLibrary')}" aria-label="${t('popupAddToLibrary')}">${icon('library')}</button>
        <!-- No download: a chapter written out to a file is a copy of a
             site's pages taken away, which no store accepts and no reader
             needs to finish a chapter. Saving for offline reading stays off
             the phone for the same reason (App Store 5.2.3); in the browser
             it is a reading cache that expires, not an export. -->
        ${inShell() ? '' : `<button class="pf-btn" data-act="offline" title="${t('readerSaveOffline')}" aria-label="${t('readerSaveOffline')}">${icon('offline')}</button>`}
        <button class="pf-btn" data-act="prefs" title="${t('readerPrefs')}" aria-label="${t('readerPrefs')}">${icon('prefs')}</button>
        <button class="pf-btn pf-resetzoom" data-act="resetzoom" title="${t('readerResetZoom')}" aria-label="${t('readerResetZoom')}" hidden>${icon('resetzoom')}</button>
        <!-- Not in a phone shell: a web view has no full screen to give, and
             the app is full screen already. -->
        ${inShell() ? '' : `<button class="pf-btn" data-act="fullscreen" title="${t('readerFullscreen')}" aria-label="${t('readerFullscreen')}">${icon('fullscreen')}</button>`}
        <button class="pf-btn" data-act="help" title="${t('readerHelpTitle')}" aria-label="${t('readerHelpTitle')}">${icon('help')}</button>
        <!-- Not under a finger. Tapping the middle of the page already hides these
             controls and brings them back (see onTapZones), so the button is
             a second way to do it that looks like the only way — somebody who
             pressed it and did not know about the tap had no way back in.
             No backticks in this comment, on purpose: it lives inside a
             template literal, and one would end the string here. -->
        ${touchFirst() ? '' : `<button class="pf-btn" data-act="hide" title="${t('readerHideControls')}" aria-label="${t('readerHideControls')}">${icon('hide')}</button>`}
      </div>
      <div class="pf-prefs pf-chrome" role="group" aria-label="${t('readerPrefs')}" hidden>
        <label class="pf-only-strip">${t('readerReadingMode')}
          <select class="pf-mode">
            <option value="vertical">${t('modeShortVertical')}</option>
            <option value="ltr">${t('modeShortLtr')}</option>
            <option value="spread">${t('modeShortSpread')}</option>
          </select>
        </label>
        <label>${t('readerBrightness')} <input data-pref="brightness" type="range" min="30" max="130" step="5"></label>
        <label>${t('readerContrast')} <input data-pref="contrast" type="range" min="50" max="150" step="5"></label>
        <label class="pf-only-strip">${t('readerGapSize')} <input data-pref="gap" type="range" min="0" max="40" step="2"></label>
        <label class="pf-only-strip">${t('readerStripWidth')} <input data-pref="stripWidth" type="range" min="40" max="100" step="5"></label>
        <label class="pf-only-novel">${t('readerTextSize')} <input data-pref="fontSize" type="range" min="13" max="30" step="1"></label>
        <label class="pf-only-novel">${t('readerLineSpacing')} <input data-pref="lineHeight" type="range" min="120" max="220" step="5"></label>
        <label class="pf-only-novel">${t('readerTextWidth')} <input data-pref="textWidth" type="range" min="360" max="900" step="20"></label>
        <label>${t('readerPlaySpeed')} <input data-pref="autoplaySpeed" type="range" min="20" max="300" step="10"></label>
        <label>${t('readerProgressSize')} <input data-pref="progressSize" type="range" min="0" max="10" step="1"></label>
        <label class="pf-only-strip">${t('readerTapZones')}
          <select class="pf-select" data-pref="tapZones">
            <option value="sides">${t('readerTapSides')}</option>
            <option value="edges">${t('readerTapEdges')}</option>
            <option value="off">${t('readerTapOff')}</option>
          </select>
        </label>
        <label class="pf-check pf-only-strip"><input data-pref="rtl" type="checkbox"> ${t('readerRtl')}</label>
        <label class="pf-check"><input data-pref="autoNext" type="checkbox"> ${t('readerAutoNext')}</label>
        <label class="pf-check"><input data-pref="hideRead" type="checkbox"> ${t('readerHideRead')}</label>
        <!-- Under the settings it changes the meaning of, and set apart by a
             rule: it used to sit at the top, with its rule drawn across the
             top of the panel as a stray line (QA, September 2026). -->
        <label class="pf-check pf-seriesrow"><input class="pf-seriespref" type="checkbox"> ${t('readerSeriesPrefs')}</label>
        <!-- Fifteen sliders and six checkboxes deep, there has to be a way out
             that is not "remember what it used to be". Resets this reader's own
             answers, not the series override beside them: undoing a global
             default should not also forget that one webtoon reads vertically. -->
        <button class="pf-btn pf-resetprefs" data-act="resetprefs">${t('readerResetDefaults')}</button>
      </div>
      <div class="pf-zones" hidden></div>
      <div class="pf-toast" role="status" aria-live="polite" hidden></div>
      <div class="pf-help" hidden>
        <h3>${t('readerHelpHead')}</h3>
        <!-- The tour is not the same tour on a phone. Four of these seven
             lines are about a keyboard and a mouse wheel, and reading them on a
             touch screen is being told about a machine you are not holding.
             What replaces them is the one gesture the phone has and the desktop
             does not need explained: tap the middle. -->
        <ul>
          <li>${t('readerHelpTap')}</li>
          <li>${t('readerHelpPinch')}</li>
          <li>${t('readerHelpDoubleTap')}</li>
          ${touchFirst()
            ? `<li>${t('readerHelpToggleChrome')}</li>`
            : `<li>${t('readerHelpArrows')}</li>
          <li>${t('readerHelpWheel')}</li>
          <li>${t('readerHelpKeys1')}</li>
          <li>${t('readerHelpKeys2')}</li>`}
        </ul>
        <p class="pf-help-note">${t('readerHelpNote')}</p>
        <button class="pf-btn" data-act="help-ok">${t('actionGotIt')}</button>
      </div>
      <div class="pf-end" hidden role="group" aria-label="${t('readerEndTitle')}">
        <h3 class="pf-end-title"></h3>
        <p class="pf-end-left"></p>
        <div class="pf-end-acts">
          <button class="pf-btn pf-end-go" data-act="end-next" hidden></button>
          <button class="pf-btn" data-act="end-read"></button>
          <button class="pf-btn" data-act="end-stay">${t('readerEndStay')}</button>
        </div>
      </div>
      <div class="pf-bottombar pf-chrome">
        <span class="pf-counter"></span>
        <input class="pf-scrub" type="range" min="1" value="1" title="${t('readerCurrentPage')}" aria-label="${t('readerCurrentPage')}">
        <button class="pf-btn pf-break" data-act="break" title="${t('readerBreakFirst')}" aria-label="${t('readerBreakFirst')}">${icon('break')}</button>
        <button class="pf-btn pf-play" data-act="play" title="${t('readerAutoPlay')}" aria-label="${t('readerAutoPlay')}">${icon('play')}</button>
      </div>
      <div class="pf-progress"><div class="pf-progress-fill"></div></div>`;
    // Nothing that happens inside the reader is the page's business. Aggregator
    // sites hang "open an ad" handlers off the document, and the reader is a
    // div in their document — so pressing our own close button was firing the
    // site's pop-under handler as well as ours. Stopped here, in the bubble
    // phase, so the reader's own listeners (on these elements, and in capture
    // on the document) all still run.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click',
      'dblclick', 'auxclick', 'touchstart', 'touchend', 'contextmenu']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    document.documentElement.appendChild(root);
    state.root = root;
    if (touchFirst()) {
      // The actions join the bottom bar, as a row of their own under the
      // scrubber, and every control takes a finger's size (reader.css).
      root.classList.add('pf-touch');
      $('.pf-bottombar').appendChild($('.pf-side'));
    }

    $('.pf-title').textContent = state.meta.title;
    $('.pf-mode').value = state.mode;
    $('.pf-mode').addEventListener('change', (e) => {
      state.mode = e.target.value;
      // Same fork as every other overridable setting: this series' record when
      // it has one, the global default otherwise.
      if (state.seriesPrefs) { state.seriesPrefs.mode = state.mode; saveSeriesPrefs(); }
      else chrome.storage.local.set({ readerMode: state.mode });
      stopAutoplay();
      render();
    });
    const lock = $('.pf-seriespref');
    lock.checked = !!state.seriesPrefs;
    // Nothing to key a record on, so nothing to offer: a chapter reached without
    // a series behind it would tick the box and forget by the next page.
    if (!state.meta.sourceUrl) $('.pf-seriesrow').hidden = true;
    lock.addEventListener('change', () => toggleSeriesPrefs(lock.checked));
    root.querySelector('[data-act="end-next"]').addEventListener('click', () => {
      const url = nextChapterUrl();
      if (url) gotoChapter(url);
    });
    root.querySelector('[data-act="end-read"]').addEventListener('click', markChapterRead);
    root.querySelector('[data-act="end-stay"]').addEventListener('click', () => showEnd(false));
    root.querySelector('[data-act="close"]').addEventListener('click', closeByUser);
    root.querySelector('[data-act="library"]').addEventListener('click', addToLibrary);
    markAdded(false);
    root.querySelector('[data-act="prefs"]').addEventListener('click', togglePrefs);
    root.querySelector('[data-act="break"]').addEventListener('click', toggleBreak);
    root.querySelector('[data-act="play"]').addEventListener('click', toggleAutoplay);
    root.querySelector('[data-act="offline"]')?.addEventListener('click', toggleOffline);
    root.querySelector('[data-act="fullscreen"]')?.addEventListener('click', toggleFullscreen);
    // Absent on a phone, on purpose — see the markup. `?.` and not a branch,
    // because "this control does not exist here" is not a failure to report.
    root.querySelector('[data-act="hide"]')?.addEventListener('click', () => {
      setChrome(false);
      // Said once, on the way out: with the bar gone nothing on screen says
      // how to get it back, and "I hid the controls and cannot bring them
      // back" was the report (QA, September 2026).
      flash(t('readerControlsHiddenMouse'), 4500);
    });
    root.querySelector('[data-act="help"]').addEventListener('click', () => showHelp($('.pf-help').hidden));
    root.querySelector('[data-act="help-ok"]').addEventListener('click', () => showHelp(false));
    // Anywhere on the bar, before the button's own handler runs: reaching for
    // the settings must not be the gesture that hides the settings.
    for (const el of root.querySelectorAll('.pf-chrome')) {
      el.addEventListener('pointerdown', keepChrome, true);
    }
    root.querySelector('[data-act="resetprefs"]').addEventListener('click', resetPrefs);
    root.querySelector('[data-act="resetzoom"]').addEventListener('click', resetZoom);
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
    // Read at click time, not captured: the chapter can now change underneath
    // these buttons without the reader being rebuilt, and a handler holding the
    // nav it was born with would send you back to the chapter you just left.
    $('[data-act="prevch"]').addEventListener('click', () => state.nav?.prevUrl && gotoChapter(state.nav.prevUrl));
    $('[data-act="nextch"]').addEventListener('click', () => state.nav?.nextUrl && gotoChapter(state.nav.nextUrl));
    syncChapterNav();

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
    // Now that there is a list to move through, and not before: this is the
    // condition loadChapterInPlace works under.
    scheduleAhead();
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

  /**
   * Whether a row is the chapter on screen.
   *
   * Not a string comparison, and the comment on `fillWheel` has said why since
   * it was written: the page's own list and the address bar disagree about
   * trailing slashes, about case, and about anchors. When they did, `isHere`
   * answered false for every row — so the wheel marked nothing, `wheelIndex`
   * stayed 0, and it opened on the newest chapter instead of the one being
   * read. `normUrl` is shared/series-match.js's own answer to "two addresses
   * that mean one page", which is the question being asked here.
   */
  const sameUrl = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const norm = window.PanelFlowMatch?.normUrl;
    if (!norm) return false;
    const bare = (u) => norm(String(u).split('#')[0]);
    return bare(a) === bare(b);
  };

  const isHere = (url) => sameUrl(url, location.href) || sameUrl(url, state.meta.chapterUrl);

  /**
   * How tall one row is, asked of the row rather than assumed from the CSS.
   * Asked every time on purpose: a reader who zooms the page mid-chapter gets
   * taller rows without the wheel being rebuilt, and a remembered 32 would
   * centre the wheel on the wrong chapter for the rest of the evening.
   */
  const rowHeight = () => $('.pf-wheel .pf-wrow')?.offsetHeight || 32;

  /**
   * The wheel's rows, in order, kept rather than asked for again. `fillWheel`
   * is the only thing that changes them, and it is the only thing that clears
   * this.
   */
  const wheelRows = () => (state.wheelRows ||= [...$('.pf-wheel').children]);

  /**
   * The wheel, rebuilt rather than filtered in place: the reader's stylesheet
   * is injected into someone else's page and must not carry a bare `[hidden]`
   * rule, so rows that should not be there simply are not created.
   */
  function fillWheel() {
    const wheel = $('.pf-wheel');
    wheel.textContent = '';
    state.wheelIndex = 0;
    state.wheelRows = null;
    state.wheelOn = -1;
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
      // Read, or pointedly not. Both are said in colour because the only thing
      // anyone comes to a 1200-row wheel to find is the line between the two,
      // and a wheel where every row is the same grey makes you read labels to
      // find it. Nothing is claimed before the history has answered: until then
      // readChapters is null and every row keeps the neutral colour, rather
      // than flashing a wheel of "unread" at someone who has read all of it.
      if (state.readChapters) {
        row.classList.add(state.readChapters.has(url) ? 'pf-read' : 'pf-unread');
      }
      if (here) { row.classList.add('pf-here'); state.wheelIndex = i; }
      wheel.appendChild(row);
      i++;
    }
    if (dropped) {
      // Why the wheel is short, said in the wheel itself. No url, so it cannot
      // be picked and navigated to.
      const note = document.createElement('div');
      note.className = 'pf-wrow pf-wnote';
      // One key per plural form rather than a suffix glued on: languages do not
      // agree on where the plural lives, or on there being only two of them.
      note.textContent = t(dropped === 1 ? 'readerHiddenOne' : 'readerHiddenMany', [String(dropped)]);
      wheel.appendChild(note);
    }
    // Taken once, now that the rows exist, rather than on every scroll frame.
    state.wheelRows = [...wheel.children];
    if (!wheel.hidden) centreOn(state.wheelIndex);
  }

  /** The row currently in the middle of the wheel. */
  function centreIndex() {
    const max = wheelRows().length - 1;
    return Math.max(0, Math.min(max, Math.round($('.pf-wheel').scrollTop / rowHeight())));
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

  /**
   * Move the highlight rather than repaint it. This used to toggle `pf-on` on
   * every row on every scroll frame: on a series with a thousand chapters that
   * is a thousand class writes and a thousand style invalidations to change
   * one of them, sixty times a second — which is why the wheel appeared to
   * freeze on long-running mangas and never on a fifty-chapter webtoon.
   */
  function markCentre(i) {
    if (state.wheelOn === i) return;
    const rows = wheelRows();
    rows[state.wheelOn]?.classList.remove('pf-on');
    rows[i]?.classList.add('pf-on');
    state.wheelOn = i;
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
    const rows = wheelRows();
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

  /** The chapter buttons and the chapter's name, for the chapter showing now. */
  function syncChapterNav() {
    if (!state.root) return;
    $('[data-act="prevch"]').hidden = !state.nav?.prevUrl;
    $('[data-act="nextch"]').hidden = !state.nav?.nextUrl;
    $('.pf-chaplabel').textContent = state.meta.chapterLabel || t('readerChapters');
  }

  /** A row of the wheel, chosen. Landing on the chapter already open is not a
   *  navigation — reloading the page to stay where you are loses your place. */
  function pickChapter(url) {
    if (!url) return;
    if (isHere(url)) return openWheel(false);
    gotoChapter(url);
  }

  /**
   * The pages of another chapter, without loading its document.
   *
   * Two sources, cheapest first. Some sites hand their chapters over as JSON
   * and the core knows how to ask (`chapterPages`); everywhere else the page
   * itself fetches the next chapter's markup — from here, riding the reader's
   * own session, which is what gets past the sites that answer a server with a
   * challenge — and the app reads the strip out of it with the same analyser
   * the search results are judged by.
   *
   * `null` for "could not", which is a real answer and not a failure: the
   * caller falls back to loading the page the old way.
   */
  async function chapterImages(url) {
    const api = await send({ type: 'chapterPages', url });
    if (api?.pages?.length >= MIN_IN_PLACE) return api.pages;
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) {
        // An answer, and a refusal: the chapter is not there to load, and
        // going to its page would only show the site's error.
        state.unreachable = { url, status: resp.status };
        return null;
      }
      const html = await resp.text();
      const seen = await send({ type: 'compatHtml', html, url });
      if (!(seen?.images?.length >= MIN_IN_PLACE)) return null;
      // The markup is in hand, and it is the only place that says what comes
      // after this chapter when the series is not in the library: the derived
      // list stops at the chapter being read, so without this the reader went
      // one chapter in place and then had no "next" at all.
      state.fetchedNav = { url, ...neighboursIn(html, url) };
      return seen.images;
    } catch (e) {
      // No answer at all from the site this reader is on: it is down, or the
      // phone is offline. (From another site this is also what CORS looks
      // like, and loading the page itself may still work, so that is left to
      // the caller's fallback.)
      if (sameOrigin(url)) state.unreachable = { url, status: 0 };
      console.info('[panelflow] could not read the next chapter', e);
      return null;
    }
  }

  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
  }

  /**
   * Whether a page of this site answers at all, asked before leaving the
   * reader for it. Leaving for a page that will not load is leaving for the
   * browser's error page, with the reader closed behind it (QA, September
   * 2026). Only the reader's own site can be asked; anything else is assumed
   * to answer, which is what happened before this existed.
   */
  async function reachable(url) {
    if (!sameOrigin(url)) return true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(url, { method: 'HEAD', credentials: 'include', signal: ctl.signal });
      // A challenge page (401, 403) is something a person can get through; a
      // site that refuses HEAD (405, 501) says nothing about GET.
      return r.ok || [401, 403, 405, 501].includes(r.status);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The chapter could not be had: said, with the two ways on from here. */
  function chapterUnavailable(url) {
    flashChoices(t('readerChapterUnavailable'), [
      [t('actionRetry'), () => gotoChapter(url)],
      [t('readerOpenPage'), () => chrome.storage.local.set({ reopenReaderFor: url }, () => { location.href = url; })],
    ], 12000);
  }

  /**
   * The previous and next chapter links of a page we fetched but did not open.
   *
   * The same two patterns detect.js's `findNav` reads off a live page, applied
   * to markup parsed without running it (DOMParser runs no script and loads no
   * image). Same host only: a "next" that leaves the site is an advert.
   */
  function neighboursIn(html, url) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const base = new URL(url);
      const pick = (rel, re) => {
        const links = [...doc.querySelectorAll(`a[rel="${rel}"][href]`), ...doc.querySelectorAll('a[href]')];
        for (const a of links) {
          const text = (a.textContent || '').trim();
          if (a.getAttribute('rel') !== rel && (!text || text.length >= 30 || !re.test(text))) continue;
          const href = new URL(a.getAttribute('href'), base);
          if (href.host !== base.host || sameUrl(href.href, url)) continue;
          return href.href;
        }
        return null;
      };
      return {
        prev: pick('prev', /^(<|«|‹|←)?\s*(prev(ious)?( chapter)?|chapitre )?pr[eé]c[eé]dent|^prev/i),
        next: pick('next', /^(next( chapter)?|chapitre suivant|suivant)\s*(>|»|›|→)?$|^next/i),
      };
    } catch {
      return { prev: null, next: null };
    }
  }

  /**
   * The chapter number an address names — from its path, never its port or
   * its host ("mangakakalot.gg:43512/…/chapter-11/" is chapter 11).
   */
  function urlChapterNumber(href) {
    try {
      const path = decodeURIComponent(new URL(href, location.href).pathname);
      const named = /(?:chapter|chapitre|chap|ch|episode|ep)[-_\s.]*(\d+(?:\.\d+)?)/i.exec(path);
      if (named) return Number(named[1]);
      const all = path.match(/\d+(?:\.\d+)?/g);
      return all ? Number(all[all.length - 1]) : null;
    } catch {
      return null;
    }
  }

  /** Below this it is not a chapter, it is a banner and a logo. */
  const MIN_IN_PLACE = 3;

  /** How long a chapter gets the network to itself before the next is asked for. */
  const AHEAD_DELAY_MS = 3000;

  /**
   * The pages of a chapter, fetched behind the reader and kept.
   *
   * chapterImages is a page fetch and a parse, and on a phone on 4G that is
   * several seconds — which used to be spent looking at a dimmed reader and a
   * pill saying the chapter was loading. So the next chapter is asked for while
   * this one is being read (scheduleAhead), and its first panel is put in the
   * image cache, so that by the time the reader reaches the end "next" has
   * nothing left to wait for and lands on a page rather than a blank.
   *
   * One chapter at a time, keyed on the address: pressing next while the
   * fetch is in flight joins it instead of starting a second one, and asking
   * for a different chapter simply replaces it.
   */
  function fetchAhead(url) {
    // Joined while it is in flight or when it found the pages; asked again when
    // it came back empty-handed, or "try again" would be the same failure.
    if (state.ahead?.url === url && !(state.ahead.done && !state.ahead.images)) return state.ahead.promise;
    if (state.unreachable?.url === url) state.unreachable = null;
    const ahead = { url, images: null, promise: null, done: false };
    ahead.promise = chapterImages(url).then((images) => {
      ahead.images = images;
      ahead.done = true;
      if (images?.[0]) new Image().src = images[0];
      return images;
    });
    state.ahead = ahead;
    return ahead.promise;
  }

  /**
   * Ask for the next chapter, a few seconds from now.
   *
   * Not at once: the chapter just opened is loading its own first pages, and
   * they matter more. Not for prose or a series with no list either — those are
   * the cases loadChapterInPlace refuses, and the answer would go unused.
   */
  function scheduleAhead() {
    clearTimeout(state.aheadTimer);
    state.aheadTimer = 0;
    if (state.novel || !state.chapters.length) return;
    const url = nextChapterUrl();
    if (!url || isHere(url)) return;
    state.aheadTimer = setTimeout(() => {
      state.aheadTimer = 0;
      // Not while a chapter change is in flight: it will schedule its own.
      if (state.root && !state.wanted && nextChapterUrl() === url) fetchAhead(url);
    }, AHEAD_DELAY_MS);
  }

  /**
   * Move to another chapter of the same series without leaving the reader.
   *
   * The reader used to change chapter by changing the document: it closed, the
   * scan site flashed past, and detect.js reopened it on the other side. Two
   * seconds of somebody else's page in the middle of a book.
   *
   * Here the pages are swapped in as soon as there are enough of them — at
   * once when fetchAhead already has them, which is the common case for the
   * chapter that follows. When it does not, the reader stays readable while
   * they are fetched, with a toast rather than a veil: the page on screen is
   * still a page, and dimming it bought nothing. The address is corrected
   * afterwards so a bookmark, a page turn and the chapter list all agree about
   * where the reader is — and detect.js is told the change was ours, or its
   * one-second address check would close the reader it is watching.
   *
   * Returns false when it could not, and the caller then does what it always
   * did. Refused outright for prose, which has no strip to swap, and for a
   * series with no chapter list — after the swap the list is the only thing
   * that knows what comes next, and moving into a chapter with no way out of
   * it is worse than a reload. True, and nothing else, when the answer came
   * back for a chapter the reader had stopped waiting for: somebody who picked
   * another chapter meanwhile, or closed the reader, is not to be moved.
   */
  async function loadChapterInPlace(url) {
    if (state.novel || !state.chapters.length) return false;
    if (state.wanted === url) return true; // already on its way
    let images = state.ahead?.url === url ? state.ahead.images : null;
    if (!images) {
      state.wanted = url;
      flash(t('readerLoadingChapter'), 15000);
      images = await fetchAhead(url);
      if (!state.root || state.wanted !== url) return true;
      state.wanted = null;
      dismissToast();
    }
    if (!images) {
      // Down, rather than merely unreadable from here: stay in the reader and
      // say so, instead of following the link to an error page.
      if (state.unreachable?.url === url) {
        chapterUnavailable(url);
        return true;
      }
      return false;
    }

    // The address first: everything below reads `location.href` to work out
    // where it is, including the chapter list.
    try {
      history.pushState(null, '', url);
      window.__panelflowDetect?.claimAddress?.();
    } catch (e) {
      // A site that forbids pushState is a site we cannot stay on top of.
      console.info('[panelflow] could not take the address', e);
      return false;
    }

    // The chapter being left is banked before its name goes: the clock ran
    // while it was read, and bankRead attributes the time to state.meta. Left
    // running across the swap, a reader who went through ten chapters in place
    // ended with one history row, on the tenth, carrying every minute of the
    // other nine. The same reset open() does for a chapter opened cold.
    bankRead();
    clock.banked = 0;
    clock.day = null;

    // The chapter just arrived at, and only that one. `isHere` would also
    // accept the chapter being left (state.meta still names it until the
    // assignment below), and the list is newest first — so going *back*, the
    // chapter being left came up first: chapter 9 on screen under the name
    // "Ch. 10", a ⏮ that pointed at itself and a ⏭ that skipped a chapter.
    const i = state.chapters.findIndex((c) => sameUrl(c.url, url));
    // What the fetched page itself links to, for a list that ends here.
    const around = state.fetchedNav && sameUrl(state.fetchedNav.url, url) ? state.fetchedNav : null;
    const options = [...(state.nav?.options || [])];
    for (const link of [around?.next, around?.prev]) {
      if (!link || options.some((o) => sameUrl(o.url, link))) continue;
      const n = urlChapterNumber(link);
      if (n != null) options.push({ label: `Ch. ${n}`, url: link });
    }
    Object.assign(state, {
      images: images.slice(),
      // The list is newest first, which is why next is the row above.
      nav: {
        prevUrl: (i !== -1 && state.chapters[i + 1]?.url) || around?.prev || null,
        nextUrl: (i !== -1 && state.chapters[i - 1]?.url) || around?.next || null,
        options,
      },
      meta: {
        ...state.meta,
        chapterUrl: url,
        // The list's own name for it; failing that, the number in its address.
        // Blank rather than the name of the chapter we just left: an empty
        // chapter button says "somewhere in this series", and the old label
        // would say something false.
        chapterLabel: state.chapters[i]?.label
          ?? (urlChapterNumber(url) != null ? `Ch. ${urlChapterNumber(url)}` : ''),
      },
      // The strip on the page belongs to the chapter we just left; these images
      // came from a list, so there is nothing here to re-measure.
      container: null,
      page: 0, zoom: 1, panX: 0, panY: 0, atEnd: true, breakFirst: false,
      // Which chapters are read is a question about this series, and the answer
      // is now one chapter out of date.
      readChapters: null,
    });

    syncChapterNav();
    showEnd(false);
    render();
    // The page slider was sized for the chapter being left (paged mode resizes
    // it in render; the strip does not): "12 / 12" at two thirds of the bar.
    if (state.mode === 'vertical') $('.pf-scrub').max = pageTotal();
    // Recorded straight away rather than on the first page turn: somebody who
    // is carried into a chapter and puts the phone down has still started it.
    saveProgress();
    // And the clock starts again, on this chapter: bankRead above paused it.
    clockStart();
    scheduleAhead();
    // The wheel still marked the chapter we opened on as "here", and the list
    // around a chapter the series never reached before stopped at it. Asked
    // again for this chapter: read marks, the derived range, the neighbours.
    loadChapters();
    return true;
  }

  // One chapter change at a time. A double tap on ⏭ used to start two: the
  // second read `state.nav` a moment after the first had moved it, and the
  // reader skipped a chapter (QA, September 2026). A press while a change is
  // under way is the same press, not another one.
  let changingChapter = false;

  async function gotoChapter(url) {
    if (!url || url === location.href || changingChapter) return;
    changingChapter = true;
    // Said, not only enforced: assistive technology waits for the new chapter
    // instead of reading out the old one mid-swap.
    const root = state.root;
    root?.setAttribute('aria-busy', 'true');
    try {
      saveProgress.flush?.();
      if (await loadChapterInPlace(url)) return;
      if (!(await reachable(url))) return chapterUnavailable(url);
      // Remember to reopen the reader on the next page (same-tab navigation).
      chrome.storage.local.set({ reopenReaderFor: url }, () => { location.href = url; });
    } finally {
      // Held a beat longer than the swap itself: the second tap of a double
      // tap lands just after a fast swap has finished, sooner than anybody
      // could have seen the new chapter and meant to leave it.
      setTimeout(() => {
        changingChapter = false;
        root?.removeAttribute('aria-busy');
      }, 300);
    }
  }

  // --- what one series remembers for itself ---------------------------------

  /** The overridable half of a series record, and never anything else. */
  function seriesPick(rec) {
    const out = {};
    if (!rec) return out;
    for (const key of SERIES_KEYS) if (key in rec) out[key] = rec[key];
    return out;
  }

  /** The mode and the widths as they stand, in the shape a record is stored in. */
  function seriesSnapshot() {
    const rec = { mode: state.mode };
    for (const key of SERIES_KEYS) rec[key] = state.prefs[key];
    return rec;
  }

  /**
   * Write this series' record, or remove it, and prune the oldest.
   *
   * Keyed on sourceUrl and not on the chapter: the whole point is that it
   * survives to the next chapter. A page the reader arrived at without a series
   * behind it has nothing to key on and simply does not get to remember —
   * silently, because there is no decision to report.
   */
  function saveSeriesPrefs() {
    const key = state.meta?.sourceUrl;
    if (!key) return;
    const all = state.seriesAll || {};
    if (state.seriesPrefs) all[key] = { ...state.seriesPrefs, at: Date.now() };
    else delete all[key];
    const keys = Object.keys(all);
    if (keys.length > SERIES_LIMIT) {
      keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      for (const k of keys.slice(0, keys.length - SERIES_LIMIT)) delete all[k];
    }
    state.seriesAll = all;
    chrome.storage.local.set({ readerSeries: all });
  }

  /**
   * The switch itself. On writes what is on screen now; off removes the record
   * and puts this chapter back on the global settings *at once* — a switch
   * whose effect only shows next time is a switch you cannot tell you pressed.
   */
  function toggleSeriesPrefs(on) {
    if (on) {
      state.seriesPrefs = seriesSnapshot();
      saveSeriesPrefs();
      return flash(t('readerSeriesOn'));
    }
    state.seriesPrefs = null;
    saveSeriesPrefs();
    chrome.storage.local.get(['readerMode', 'readerPrefs'], (v) => {
      // The reader can be closed while storage is answering, and everything
      // below reaches into a DOM that would no longer be there.
      if (!state.root) return;
      state.globalPrefs = { ...DEFAULT_PREFS, ...readerSettings(v.readerPrefs) };
      state.prefs = { ...state.globalPrefs };
      syncPrefsInputs();
      applyPrefs();
      syncDirection(true);
      const mode = state.novel ? 'vertical' : knownMode(v.readerMode);
      if (mode !== state.mode) {
        state.mode = mode;
        $('.pf-mode').value = mode;
        stopAutoplay();
        render();
      }
      flash(t('readerSeriesOff'));
    });
  }

  /** Push `state.prefs` back onto the controls. Their kinds, again, from below. */
  function syncPrefsInputs() {
    for (const input of state.root.querySelectorAll('[data-pref]')) {
      const key = input.dataset.pref;
      if (input.type === 'checkbox') input.checked = !!state.prefs[key];
      else input.value = state.prefs[key];
    }
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
        // Where it lands. A width kept for a webtoon must not become the width
        // every tankōbon opens at afterwards, and the settings are written from
        // `globalPrefs` rather than from `prefs` for exactly that reason: `prefs`
        // has the override mixed into it, and storing it would launder the
        // override into the defaults on the next brightness drag.
        if (state.seriesPrefs && SERIES_KEYS.includes(key)) {
          state.seriesPrefs[key] = state.prefs[key];
          saveSeriesPrefs();
        } else {
          state.globalPrefs[key] = state.prefs[key];
          chrome.storage.local.set({ readerPrefs: state.globalPrefs });
        }
        applyPrefs();
        // Tap zones are invisible by definition, so changing them shows them.
        if (key === 'tapZones' || key === 'rtl') showZoneHint();
        if (key === 'rtl') syncDirection(true);
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
    // A different strip width is a different base for the strip's zoom.
    if (state.stripZoom > 1) setStripZoom(1);
    // Off means "let the system decide", which is all reader.css can be told
    // from here: it is on a scan site's origin and cannot read the settings.
    state.root.classList.toggle('pf-follow-system', !state.prefs.readerDark);
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
  }

  // --- full screen -----------------------------------------------------------

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else state.root.requestFullscreen?.().catch(() => {});
  }

  function syncFullscreenIcon() {
    const btn = state.root?.querySelector('[data-act="fullscreen"]');
    if (!btn) return;
    btn.classList.toggle('pf-on', !!document.fullscreenElement);
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

  /**
   * Every slider and switch in this panel, back to what it shipped as.
   *
   * The mode is deliberately not touched. It is the one setting the reader
   * chose *about this series* — the panel above puts it under a "remember for
   * this series" checkbox — and losing it to a button labelled "reading
   * settings" would be losing something the button did not name.
   */
  function resetPrefs() {
    state.globalPrefs = { ...DEFAULT_PREFS };
    state.prefs = { ...state.globalPrefs, ...seriesPick(state.seriesPrefs) };
    chrome.storage.local.set({ readerPrefs: state.globalPrefs });
    syncPrefsInputs();
    applyPrefs();
    render();
    flash(t('readerResetDefaults'));
  }

  function togglePrefs() {
    const p = $('.pf-prefs');
    p.hidden = !p.hidden;
    // On a phone the toast sat over the panel, on the very rows it opens to
    // (QA re-test It.4, N19). Its moment has passed once a panel is asked for.
    if (!p.hidden) dismissToast();
  }

  function toggleBreak() {
    state.breakFirst = !state.breakFirst;
    $('.pf-break').classList.toggle('pf-on', state.breakFirst);
    if (isSpread()) showPage(state.page);
  }

  /**
   * How long the bar stays up on a phone before it gets out of the way.
   *
   * Long enough to read the chapter number and reach a button, short enough
   * that it is gone by the time you have looked back at the page. On a desktop
   * it never leaves on its own: a mouse has no tap to bring it back, and a
   * control that vanishes from under a pointer is a control you hunt for.
   * A panel that is open holds it up, and the countdown starts again once the
   * panel is closed rather than being forgotten.
   */
  const CHROME_HIDES_AFTER = 3500;
  let chromeTimer = 0;

  /** Something is open that the reader is in the middle of using. */
  const panelOpen = () => ['.pf-prefs', '.pf-wheel', '.pf-help', '.pf-end']
    .some((sel) => state.root?.querySelector(sel)?.hidden === false);

  function setChrome(visible) {
    state.chromeVisible = visible;
    state.root.classList.toggle('pf-chrome-hidden', !visible);
    if (!visible) $('.pf-prefs').hidden = true;

    clearTimeout(chromeTimer);
    if (!visible || !touchFirst()) return;
    chromeTimer = setTimeout(function hideLater() {
      if (!state.root) return;
      // Never while a panel is open: settings, the chapter wheel and the help
      // list are all things you are reading, and taking the bar away takes them
      // with it. Asked again later instead of given up on.
      if (panelOpen()) chromeTimer = setTimeout(hideLater, CHROME_HIDES_AFTER);
      else setChrome(false);
    }, CHROME_HIDES_AFTER);
  }

  /** A page turned by hand on a phone: the bar goes, if nothing is open on it. */
  function chromeAwayForReading() {
    if (touchFirst() && state.chromeVisible && !panelOpen()) setChrome(false);
  }

  /** Touching the bar means you are using it, so the countdown starts again. */
  function keepChrome() {
    if (state.chromeVisible) setChrome(true);
  }

  // --- transient notices ----------------------------------------------------

  let toastTimer = 0;
  let toastDue = 0;      // when the one showing goes, if nothing holds it
  let toastLeft = 0;     // what it had left when it was held

  /** Take the toast down after `ms`, remembering when, so it can be held. */
  function armToast(el, ms) {
    clearTimeout(toastTimer);
    toastDue = Date.now() + ms;
    toastTimer = setTimeout(() => {
      toastTimer = 0;
      el.classList.remove('pf-on');
      setTimeout(() => { if (state.root && !el.classList.contains('pf-on')) el.hidden = true; }, 250);
    }, ms);
  }

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
    armToast(el, ms);
  }

  // A toast with a question in it waits while it is being answered: while the
  // pointer is on its button, or the keyboard is (WCAG 2.2.1). It went at ten
  // seconds whatever the reader was doing (QA re-test It.4, N19).
  const holdToast = () => {
    if (!toastTimer) return;
    clearTimeout(toastTimer);
    toastTimer = 0;
    toastLeft = Math.max(4000, toastDue - Date.now());
  };
  const releaseToast = () => {
    const el = state.root?.querySelector('.pf-toast');
    if (!el || el.hidden || toastTimer || !el.classList.contains('pf-on')) return;
    armToast(el, toastLeft || 5000);
  };

  /** The toast taken down now, for a message whose moment has passed. */
  function dismissToast() {
    const el = state.root?.querySelector('.pf-toast');
    if (!el) return;
    clearTimeout(toastTimer);
    toastTimer = 0;
    el.classList.remove('pf-on');
    el.hidden = true;
  }

  /**
   * The same toast with a way out of it. Used where the message is about
   * something the reader can fix, which a line of text they cannot click is
   * not — and where the fix lives on a page only the worker can open.
   */
  function flashAction(text, label, run, ms = 10000) {
    flashChoices(text, [[label, run]], ms);
  }

  /**
   * The same, with more than one way out: `choices` is [label, run] pairs.
   * Twenty seconds at least — a question needs the time to be read and
   * reached — and held while its buttons are being used (holdToast).
   */
  function flashChoices(text, choices, ms = 20000) {
    const el = state.root?.querySelector('.pf-toast');
    if (!el) return;
    // After flash(), not before: it writes the text, and writing textContent
    // takes any button already there with it.
    flash(text, Math.max(ms, 20000));
    for (const [label, run] of choices) {
      const btn = document.createElement('button');
      btn.className = 'pf-toastbtn';
      btn.textContent = label;
      btn.addEventListener('pointerenter', holdToast);
      btn.addEventListener('focus', holdToast);
      btn.addEventListener('pointerleave', releaseToast);
      btn.addEventListener('blur', releaseToast);
      btn.addEventListener('click', (e) => {
        // The reader lives in the page's DOM, where the page's own scripts can
        // click it: "Move the bookmark here" pressed by an ad is a fence set
        // behind the reader's back (QA re-test It.4, N-B3). A real click only,
        // as in the library sheet.
        if (!e.isTrusted) return;
        const hadFocus = document.activeElement === btn;
        clearTimeout(toastTimer);
        toastTimer = 0;
        el.classList.remove('pf-on');
        el.hidden = true;
        // The button is gone: the focus goes back into the reader, not to
        // the top of the page underneath (N19).
        if (hadFocus) state.root?.focus({ preventScroll: true });
        run();
      });
      el.appendChild(btn);
    }
  }

  /** The fraction of the width, on each side, that turns the page. */
  function tapTurnWidth() {
    const layout = TAP_LAYOUTS[state.prefs.tapZones];
    return layout === undefined ? TAP_LAYOUTS.sides : layout;
  }

  /**
   * True when tapping the right-hand side moves forward.
   *
   * Right is forward, unless the chapter is read right to left — then the
   * left edge advances, as the next page of a manga is on the left. One
   * setting says the direction for everything that has one: the sides, the
   * arrows, the double page and the scrubber.
   */
  function tapForwardRight() {
    return !state.prefs.rtl;
  }

  /** Whether the pages on screen are turned right to left. */
  const readsRtl = () => !!state.prefs.rtl && !state.novel && state.mode !== 'vertical';

  /**
   * The direction, applied to everything that shows one. `turn` is for a
   * change made while reading: the double page on screen is redrawn the other
   * way round, and the direction is said, as it is when the mode changes.
   */
  function syncDirection(turn = false) {
    if (!state.root) return;
    const rtl = readsRtl();
    $('.pf-scrub').classList.toggle('pf-rtl', rtl);
    state.root.classList.toggle('pf-dir-rtl', rtl);
    if (!turn || state.novel || state.mode === 'vertical') return;
    showPage(state.page);
    const key = modeToast(state.mode, rtl);
    if (key) flash(t(key));
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
      // The arrows stay outside the message: they point at the edge of the
      // screen the zone is on, which is a fact about the layout and not about
      // the language.
      box.appendChild(zone(0, turn, fwd ? `← ${t('zoneBack')}` : `${t('zoneNext')} →`));
      box.appendChild(zone(turn, 1 - turn * 2, t('zoneControls')));
      box.appendChild(zone(1 - turn, turn, fwd ? `${t('zoneNext')} →` : `← ${t('zoneBack')}`));
    } else {
      box.appendChild(zone(0, 1, t('zoneControlsKeys')));
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
    $('.pf-break').hidden = !isSpread();
    syncDirection();
    syncResetZoom();
    updateCounter();
    preload();
    // render() runs on open and on every mode change, which is exactly when the
    // direction is news. The help list already says it, so do not say it twice.
    if ($('.pf-help').hidden) {
      const key = modeToast(state.mode, readsRtl());
      flash(state.novel ? t('modeToastNovel') : (key ? t(key) : ''));
    }
  }

  function renderVertical(stage) {
    stage.className = 'pf-stage pf-vertical';
    state.stripZoom = 1;
    for (const src of state.images) stage.appendChild(stripImage(src, stage));
    attachStripScroll(stage);
    attachStripZoom(stage);
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
      // Half a second is long enough to close the reader or switch modes after
      // the last scroll. The strip this belongs to is then gone: the counter it
      // updates no longer exists (an uncaught TypeError on every scroll-then-
      // Escape), and a detached element scrolls at 0, which would put the new
      // layout back on page 1 and save that.
      if (!state.root || $('.pf-stage') !== stage) return;
      state.scrollRatio = ratio();
      state.page = Math.round(state.scrollRatio * (pageTotal() - 1));
      updateCounter();
      updateProgress(state.scrollRatio);
      saveProgress();
      // The bottom of a long strip is how a webtoon chapter ends, and it was
      // the one ending the reader had no answer for: `endOfChapter` was reached
      // from `step()` only, so "auto next chapter" never fired in the mode most
      // people read in. A crossing and not a state — sitting at the bottom must
      // not re-fire on every scroll event the rubber band produces.
      const room = stage.scrollHeight - stage.clientHeight;
      const atEnd = room > 0 && room - stage.scrollTop < 4;
      if (atEnd && !state.atEnd) endOfChapter();
      if (!atEnd && state.atEnd) showEnd(false);
      state.atEnd = atEnd;
    }, 500));
    let lastTap = null;
    let tapTimer = 0;
    stage.addEventListener('click', (e) => {
      // Selecting a line of prose ends in a click on it, and hiding the
      // controls under someone who was copying a quote is not what they asked.
      if (String(getSelection?.() || '')) return;
      if (!(e.target === stage || e.target.tagName === 'IMG' || e.target.closest('.pf-text'))) return;
      // Two taps close together are a zoom, not two toggles of the controls:
      // the first one is held back a beat to find out which (QA, September
      // 2026 — the help promised a double-tap zoom the strip did not have).
      const now = Date.now();
      if (!state.novel && lastTap && now - lastTap.at < DOUBLE_TAP_MS * 1.4
          && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        clearTimeout(tapTimer);
        lastTap = null;
        const r = stage.getBoundingClientRect();
        setStripZoom(state.stripZoom > 1 ? 1 : 2, e.clientX - r.left, e.clientY - r.top);
        return;
      }
      lastTap = { at: now, x: e.clientX, y: e.clientY };
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { if (state.root) setChrome(!state.chromeVisible); },
        state.novel ? 0 : DOUBLE_TAP_MS);
    });
    // Scrolling the strip by hand is reading it: on a phone the bar goes.
    stage.addEventListener('touchmove', chromeAwayForReading, { passive: true });
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
    if (!isSpread()) return n;
    if (!state.breakFirst) return n - (n % 2);
    return n === 0 ? 0 : n - ((n - 1) % 2);
  }

  function showPage(n, wrap = $('.pf-zoomwrap')) {
    // Any move within the chapter means the reader is not at the end of it any
    // more, whether they got here by a tap, a key or the scrubber.
    showEnd(false);
    const spread = isSpread();
    n = clamp(pageStart(n), 0, state.images.length - 1);
    state.page = n;
    wrap.innerHTML = '';
    const indices = (spread ? spreadIndices(n) : [n]).filter((i) => i < state.images.length);
    // A double page read right to left has its first page on the right.
    const ordered = readsRtl() ? [...indices].reverse() : indices;
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
    const stride = isSpread() ? spreadIndices(state.page).length : 1;
    const target = state.page + delta * stride;
    if (target > state.images.length - 1) return endOfChapter();
    showPage(target);
  }

  function next() { step(1); }
  function prev() { step(-1); }

  /**
   * The next chapter, preferring the site's own link.
   *
   * The merged list is the fallback and not the first answer: a derived URL is
   * a very good guess, the site's link is the address the site publishes. The
   * list runs newest first, so the chapter after this one is the row *before* it.
   */
  function nextChapterUrl() {
    if (state.nav?.nextUrl) return state.nav.nextUrl;
    const i = hereIndex();
    return i > 0 ? state.chapters[i - 1]?.url || null : null;
  }

  /** Where this chapter sits in the merged list, or -1 if it is not in it. */
  const hereIndex = () => state.chapters.findIndex((c) => isHere(c.url));

  /**
   * Reaching the end.
   *
   * "Auto next chapter" still wins, and wins first: someone who asked to be
   * carried into the next chapter did not ask to be stopped by a panel on the
   * way. Everyone else gets the panel, which exists because the alternative is
   * what PanelFlow did until now — hand the reader back to the scan site at the
   * exact moment they were deciding whether to read another one.
   */
  function endOfChapter() {
    const next = nextChapterUrl();
    if (state.prefs.autoNext && next) return gotoChapter(next);
    showEnd(true);
  }

  /**
   * The panel. Navigation and nothing else — no rating prompt, no tracker
   * nudge, no "turn on notifications". It appears at the one moment the reader
   * is most willing to say yes to something, and that is precisely why it is
   * not allowed to ask for anything.
   *
   * Not part of `.pf-chrome`: like the help list, it has to survive the
   * controls being hidden, because hiding them is how most people read.
   */
  function showEnd(show) {
    const panel = state.root?.querySelector('.pf-end');
    if (!panel) return;
    if (!show) {
      panel.classList.remove('pf-on');
      panel.hidden = true;
      return;
    }
    const url = state.meta.chapterUrl || location.href;
    panel.querySelector('.pf-end-title').textContent =
      t('readerEndOf', [state.meta.chapterLabel || t('readerEndThis')]);
    panel.querySelector('.pf-end-left').textContent = chaptersLeftText();

    const go = panel.querySelector('[data-act="end-next"]');
    const next = nextChapterUrl();
    go.hidden = !next;
    go.textContent = t('readerEndNext');

    // Already in the history — because it was read, or because this button was
    // pressed once already. Either way there is nothing left to claim.
    const mark = panel.querySelector('[data-act="end-read"]');
    const done = !!state.readChapters?.has(url);
    mark.disabled = done;
    mark.textContent = t(done ? 'readerEndMarked' : 'readerEndMarkRead');

    panel.hidden = false;
    // The fade lives on a class rather than on [hidden]: an element that is
    // display:none one frame and opaque the next has nothing to fade from.
    requestAnimationFrame(() => state.root && panel.classList.add('pf-on'));
  }

  /**
   * How much of this series is left, in words.
   *
   * "In this list" and not "in this series", because the list is what is known:
   * it stops at the last chapter the library has seen, and claiming a total the
   * reader could disprove by visiting the site would be worse than saying less.
   */
  function chaptersLeftText() {
    const i = hereIndex();
    if (i === -1 || state.chapters.length < 2) return '';
    if (i === 0) return t('readerEndCaughtUp');
    return t(i === 1 ? 'readerEndLeftOne' : 'readerEndLeftMany', [String(i)]);
  }

  /**
   * "I have read this", said by hand.
   *
   * Written as a history row, because that is already what "read" means here —
   * the wheel greys a row when the history has one for it, and a second flag
   * meaning the same thing would be a second answer to drift from the first.
   * Pages and no seconds: the chapter may have been skimmed in four, and
   * banking four seconds of reading time would put a lie in the statistics.
   */
  function markChapterRead() {
    const url = state.meta.chapterUrl || location.href;
    chrome.runtime.sendMessage({ type: 'recordRead', read: {
      sourceUrl: state.meta.sourceUrl,
      chapterUrl: url,
      chapterLabel: state.meta.chapterLabel,
      pages: pageTotal(),
      seconds: 0,
      day: clock.day || localDay(),
    }});
    // And the position, so the shelf agrees with the wheel: a chapter marked
    // read that still resumes on page 3 is two answers to one question.
    state.page = Math.max(0, pageTotal() - 1);
    state.scrollRatio = 1;
    saveProgress();
    saveProgress.flush?.();
    state.readChapters?.add(url);
    fillWheel();
    showEnd(true);
  }

  let middleTapTimer = 0;

  function onTapZones(e) {
    if (e.target.closest('.pf-chrome')) return;
    if (e.target.closest('.pf-help')) return;
    if (e.target.closest('.pf-end')) return;
    if (suppressTapUntil > Date.now()) return; // ignore tap that ended a pan
    const turn = tapTurnWidth();
    const x = e.clientX / innerWidth;
    // The direction decides which side is forward (see tapForwardRight).
    const fwd = tapForwardRight();
    // The sides turn at once, however fast they are tapped: flipping through
    // pages is several quick taps, and each one is a page.
    if (turn && x < turn) { chromeAwayForReading(); return fwd ? prev() : next(); }
    if (turn && x > 1 - turn) { chromeAwayForReading(); return fwd ? next() : prev(); }
    // The middle waits a beat: a second tap there zooms (attachZoomPan), and a
    // double tap used to show and hide the controls on its way to doing so.
    clearTimeout(middleTapTimer);
    middleTapTimer = setTimeout(() => { if (state.root) setChrome(!state.chromeVisible); }, DOUBLE_TAP_MS);
  }

  /**
   * Whether this key is being typed into something, rather than pressed at the
   * reader. The shortcuts below cancel the keys they claim — `s`, `b`, `f`,
   * `h`, `c`, `0` and `?` among them — and a cancelled keydown never becomes a
   * character, so a tag typed into the library sheet came out missing half its
   * letters.
   *
   * The sheet is a closed shadow root, which is why its host is what gets
   * checked: from this document every key pressed anywhere inside it is
   * reported on `#panelflow-libmodal` and the field itself is unreachable.
   */
  function typingInto(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === 'panelflow-libmodal') return true;
    if (el.isContentEditable) return true;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
  }

  function onKey(e) {
    if (!state.root) return;
    // The library sheet, when it is open over the reader, owns the keyboard:
    // its own Escape closes it, and this one used to close the reader too,
    // whatever had the focus (QA, September 2026).
    if (document.getElementById('panelflow-libmodal')) return;
    if (typingInto(e.target)) {
      // Escape is the one key a field does not own: it is how you leave the
      // panel the field is in, and the reader's own panels have no other way
      // out from the keyboard. The library sheet is the exception — it has its
      // own Escape, and closing the reader out from under it would take the
      // half-typed tag with it.
      if (e.key !== 'Escape' || e.target.id === 'panelflow-libmodal') return;
    }
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
      if (!$('.pf-end').hidden) return showEnd(false);
      return closeByUser();
    }
    if (e.key === '?') { e.preventDefault(); return showHelp($('.pf-help').hidden); }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); return togglePrefs(); }
    if (e.key === 'b' || e.key === 'B') { e.preventDefault(); return toggleBreak(); }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); return toggleFullscreen(); }
    if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      const show = !state.chromeVisible;
      setChrome(show);
      if (!show) flash(t('readerControlsHiddenMouse'), 4500);
      return;
    }
    if (e.key === '0') { e.preventDefault(); return resetZoom(); }
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
    // → is the next page of a book read left to right, ← of one read right to left.
    const forward = readsRtl() ? 'ArrowLeft' : 'ArrowRight';
    const back = readsRtl() ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward) { e.preventDefault(); next(); }
    if (e.key === back) { e.preventDefault(); prev(); }
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
      (state.meta.chapterLabel ? ` · ${state.meta.chapterLabel}` : '');
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
    // The detector's two answers, not a second copy of them.
    //
    // This read `src` and measured what the browser had decoded from it. On a
    // theme that parks a transparent gif in `src` and keeps the address in
    // data-src — sushiscan among them — that measured the gif: 1x1, under
    // every threshold, so each panel arriving behind a spacer was dropped in
    // silence. detect.js was fixed for exactly this and the reader was not,
    // which is the same chapter coming up short by another door. The fallbacks
    // are the old readings, for a reader running without the detector beside
    // it; on all four clients it is loaded first.
    const detect = () => window.__panelflowDetect;
    const address = (img) => detect()?.lazySrc?.(img) ?? (img.currentSrc || img.src);
    const isPanel = (img) => (detect()?.sizedImage
      ? detect().sizedImage(img)
      : (img.naturalWidth || img.width) >= 300 && (img.naturalHeight || img.height) >= 200);
    const track = (img) => {
      const add = async () => {
        const src = address(img);
        if (!src || seen.has(src)) return;
        if (!isPanel(img)) return;
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
    //
    // It stops when it stops producing, wherever it has got to — not only at
    // the bottom. A page that already holds the whole chapter has nothing left
    // to give, and a sushiscan volume is 188 panels, every one of them in the
    // DOM before the reader opens: the old rule still walked the document to
    // the end of a quarter of a million pixels, nearly two minutes of the page
    // moving under the overlay for no new panel and the scroll lock off the
    // whole time. Twelve ticks is ~5s and ~10,000px with nothing arriving,
    // which is well past any lazy loader's threshold.
    document.documentElement.classList.remove('panelflow-noscroll');
    const IDLE_TICKS = 12;
    const startY = scrollY;
    let y = startY, idleTicks = 0, bottomTicks = 0, lastCount = state.images.length;
    state.harvestTimer = setInterval(() => {
      if (!state.root) return stopHarvest();
      y += innerHeight * 0.9;
      window.scrollTo(0, y);
      const doc = document.documentElement;
      if (y >= doc.scrollHeight - innerHeight) bottomTicks++;
      if (state.images.length > lastCount) { lastCount = state.images.length; idleTicks = 0; }
      else idleTicks++;
      if (idleTicks > IDLE_TICKS || bottomTicks > 5) stopHarvest(startY);
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
    $('.pf-play').innerHTML = icon('pause');
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
    if (btn) btn.innerHTML = icon('play');
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
    syncResetZoom();
  }

  /** The reset button only earns its slot once there is something to reset. */
  function syncResetZoom() {
    const btn = state.root?.querySelector('.pf-resetzoom');
    if (!btn) return;
    const zoomed = state.mode === 'vertical' && !state.novel ? state.stripZoom > 1 : state.zoom > 1;
    btn.hidden = !zoomed;
  }

  /** Back to the whole page, or the strip at its resting width. */
  function resetZoom() {
    if (state.mode === 'vertical' && !state.novel) return setStripZoom(1);
    resetTransform();
    applyTransform();
  }

  // --- the long strip's zoom --------------------------------------------------
  //
  // The strip is a native scroller, and zooming it by transform would leave
  // the scroll positions — and so the saved place — describing a strip of
  // another size. It is zoomed by widening its pictures instead: each one's
  // resting width is noted as --pf-base, the stage carries the factor as
  // --pf-zoom, and reader.css multiplies the two. One property changes per
  // step, however long the chapter, and scrolling in both directions stays
  // the browser's own, momentum and all.

  /** A page of the strip, noting its resting width once it knows its size. */
  function stripImage(src, stage) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = src;
    img.addEventListener('load', () => {
      if (state.stripZoom > 1) img.style.setProperty('--pf-base', `${stripBase(img, stage)}px`);
    });
    return img;
  }

  /** How wide a page of the strip is at rest: reader.css's rule, worked out. */
  function stripBase(img, stage) {
    const cap = Math.min(stage.clientWidth * state.prefs.stripWidth / 100, 900);
    return Math.round(img.naturalWidth ? Math.min(img.naturalWidth, cap) : cap);
  }

  /** Zoom the strip to `z`, keeping the point (cx, cy) of the stage where it is. */
  function setStripZoom(z, cx, cy) {
    const stage = state.root?.querySelector('.pf-stage');
    if (!stage || state.mode !== 'vertical' || state.novel) return;
    const z0 = state.stripZoom || 1;
    z = clamp(z, 1, 4);
    if (Math.abs(z - z0) < 0.01) return;
    if (cx === undefined) { cx = stage.clientWidth / 2; cy = stage.clientHeight / 2; }
    const ax = stage.scrollLeft + cx;
    const ay = stage.scrollTop + cy;
    if (z0 === 1) {
      for (const img of stage.querySelectorAll('img')) {
        img.style.setProperty('--pf-base', `${stripBase(img, stage)}px`);
      }
    }
    state.stripZoom = z;
    stage.style.setProperty('--pf-zoom', String(z));
    stage.classList.toggle('pf-zoomed', z > 1);
    stage.scrollLeft = ax * z / z0 - cx;
    stage.scrollTop = ay * z / z0 - cy;
    syncResetZoom();
  }

  /**
   * Pinch, ctrl+wheel (a trackpad's pinch arrives as one) and WebKit's own
   * gesture events, on the strip. A pinch is followed at most once a frame.
   */
  function attachStripZoom(stage) {
    let queued = null;
    let raf = 0;
    const queue = (z, cx, cy) => {
      queued = [z, cx, cy];
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next = queued;
        queued = null;
        if (next) setStripZoom(...next);
      });
    };
    const at = (x, y) => {
      const r = stage.getBoundingClientRect();
      return [x - r.left, y - r.top];
    };
    stage.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      queue(state.stripZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), ...at(e.clientX, e.clientY));
    }, { passive: false });

    let pinch = null;
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      const [a, b] = e.touches;
      pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, z: state.stripZoom };
    }, { passive: true });
    stage.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      queue(pinch.z * d / pinch.d, ...at((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2));
    }, { passive: false });
    const done = (e) => { if (e.touches.length < 2) pinch = null; };
    stage.addEventListener('touchend', done);
    stage.addEventListener('touchcancel', done);

    // WebKit reports a pinch as a gesture with a scale of its own.
    let gesture = null;
    stage.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gesture = { z: state.stripZoom };
    });
    stage.addEventListener('gesturechange', (e) => {
      if (!gesture) return;
      e.preventDefault();
      queue(gesture.z * e.scale, ...at(e.clientX, e.clientY));
    });
    stage.addEventListener('gestureend', () => { gesture = null; });
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

    let swipe = null;

    stage.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        // Double tap: zoom into the tapped point, or reset if already zoomed
        // (MangaPin's "double tap to zoom"). The only ways the view recenters.
        // In the middle of the screen only: the sides turn pages, and two
        // quick taps there are two pages, not a zoom and a page (QA, September
        // 2026 — a double click on the right third did both).
        const turn = tapTurnWidth();
        const x = e.clientX / innerWidth;
        const middle = !turn || (x >= turn && x <= 1 - turn);
        if (middle && Date.now() - lastTap < 300) {
          clearTimeout(middleTapTimer);
          if (state.zoom > 1) resetTransform();
          else { state.zoom = 1; zoomAt(e.clientX, e.clientY, 2.5); }
          suppressTapUntil = Date.now() + 250;
          applyTransform();
          lastTap = 0;
        } else {
          lastTap = middle ? Date.now() : 0;
        }
        // A finger dragged sideways across a page at rest turns it.
        swipe = e.pointerType !== 'mouse' && state.zoom <= 1
          ? { x: e.clientX, y: e.clientY, at: Date.now() } : null;
      } else {
        swipe = null;
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
      if (swipe && e.type === 'pointerup' && pointers.size === 0) {
        const dx = e.clientX - swipe.x;
        const dy = e.clientY - swipe.y;
        const quick = Date.now() - swipe.at < 700;
        swipe = null;
        if (quick && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
          // Swiped towards the left is the next page of a book read left to
          // right; towards the right, of one read right to left.
          const forward = readsRtl() ? dx > 0 : dx < 0;
          suppressTapUntil = Date.now() + 300;
          chromeAwayForReading();
          if (forward) next(); else prev();
        }
      }
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

  // --- a page's bytes --------------------------------------------------------

  // Read here, not in the worker: sites like scan-manga hand pages out as
  // blob: URLs that only exist in this document, and same-origin fetches
  // carry the page's cookies/referer for free. Cross-origin CDN images that
  // CORS won't let us read fall back to the worker (DNR sets their referer).
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

  // What an image actually is, read from its first bytes rather than guessed
  // from its URL. Half the pages the detector hands over are blob: URLs, which
  // carry no extension at all — so the URL can only ever be the fallback, and
  // the offline store wants the right answer from it.
  function imageType(bytes, src) {
    const ext =
      bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' :
      bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg' :
      bytes[0] === 0x52 && bytes[1] === 0x49 ? 'webp' :
      bytes[0] === 0x47 && bytes[1] === 0x49 ? 'gif' :
      (String(src).match(/\.(jpe?g|png|webp|gif|avif)(?=$|[?#])/i) || [, 'jpg'])[1].toLowerCase();
    return { ext, mime: `image/${ext === 'jpg' ? 'jpeg' : ext}` };
  }

  /**
   * The hosts this chapter's pages sit on that PanelFlow may not read from —
   * the worker's answer, since only it can ask chrome.permissions.
   *
   * A worker that does not answer at all is taken as "no objection": an old
   * copy of the extension left running after an update should still try, and
   * fail the way it always did, rather than refuse to start.
   */
  async function blockedImageHosts(images) {
    const r = await send({ type: 'imageAccess', urls: images }).catch(() => null);
    return r?.missing || [];
  }

  /**
   * Name the hosts and offer the only thing that grants them. The permission
   * has to be asked for from an extension page, so this cannot do more than
   * open the page that asks — but the reader now knows what went wrong, which
   * is the whole of what was missing before.
   */
  function askForImageAccess(hosts) {
    flashAction(
      t('readerNeedsAccess', [hosts.slice(0, 3).join(', ')]),
      t('readerGrantAccess'),
      () => send({ type: 'openOptions' }),
    );
  }

  // --- offline ---------------------------------------------------------------
  // "Save offline" puts a chapter's pages inside PanelFlow, so it opens with no
  // network, for as long as the store keeps it (shared/offline-store.js). It is
  // a reading cache: nothing is exported, and on the phone it does not exist.
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
    btn.innerHTML = icon(saved ? 'saved' : 'offline');
    btn.title = saved ? t('readerSavedOffline') : t('readerSaveOffline');
    btn.setAttribute('aria-label', btn.title);
    btn.classList.toggle('pf-on', !!saved);
    btn.dataset.saved = saved ? '1' : '';
  }

  async function refreshOffline() {
    const url = state.meta?.chapterUrl;
    // No button on the phone, and nothing to ask about.
    if (!url || inShell()) return;
    const r = await send({ type: 'offlineHas', chapterUrl: url });
    // The answer is about the chapter that asked it. Two chapters opened one
    // after the other and the first reply lands last, painting 📗 on a chapter
    // that was never saved.
    if (state.meta?.chapterUrl === url) markOffline(!!r?.saved);
  }

  async function toggleOffline() {
    const btn = state.root.querySelector('[data-act="offline"]');
    if (!btn || inShell()) return;
    // Pinned before the first await, and checked after every one. Saving forty
    // pages takes ten seconds and clicking "next chapter" takes one, so every
    // line below can outlive the chapter it started on — and `state.meta` by
    // then is the chapter now open. Reading it each time round the loop files
    // page 30 under the next chapter's URL, silently, producing one saved
    // chapter that is two chapters interleaved.
    const url = state.meta?.chapterUrl;
    if (!url) return;
    const mine = () => state.meta?.chapterUrl === url;

    if (btn.dataset.saved) {
      await send({ type: 'offlineRemove', chapterUrl: url });
      if (mine()) markOffline(false);
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
        // Same question as the download, asked for the same reason — and here
        // it matters more: a save is all or nothing, so a chapter that cannot
        // be fetched wastes the whole loop before saying so.
        const blocked = await blockedImageHosts(images);
        if (blocked.length) { askForImageAccess(blocked); return; }
        for (let i = 0; i < images.length; i++) {
          if (!mine()) return; // moved on — and nothing has been committed
          btn.textContent = `${i + 1}/${images.length}`;
          const bytes = await fetchPageBytes(images[i]);
          // Not `continue`. A chapter that skipped page 12 commits like any
          // other, shows 📗 like any other, and opens like any other — three
          // weeks later, on a train, with nothing left to fetch the gap from.
          // Offline is a promise about the one moment when nothing can be
          // repaired, so it is the whole chapter or none of it.
          if (!bytes) throw new Error(`page ${i + 1} could not be fetched`);
          const r = await send({
            type: 'offlinePage',
            chapterUrl: url,
            index: i,
            b64: chunk(bytes),
            mime: imageType(bytes, images[i]).mime,
          });
          // The store's own sentence when it has one: "saved chapters are
          // full" is a different thing to do about than a page that failed.
          if (!r?.ok) throw new Error(r?.error || `page ${i + 1} was rejected`);
          meta.bytes += bytes.length;
        }
      }
      // Last, and only now: until this lands the chapter does not exist, which
      // is what keeps a save interrupted halfway from being offered as
      // readable. Its pages are swept at the next browser start.
      const done = await send({ type: 'offlineCommit', meta });
      if (!done?.ok) throw new Error('commit failed');
      if (mine()) markOffline(true);
    } catch (e) {
      btn.innerHTML = icon('warn');
      btn.dataset.saved = '';
      // Said out loud, not left as a glyph. A failed save is indistinguishable
      // from a slow one until it is named, and the one thing worse than not
      // having the chapter is thinking you do.
      flash(t('readerNotSaved', [String(e.message)]), 3000);
      setTimeout(() => { if (state.root && mine()) markOffline(false); }, 3000);
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

  /**
   * The bookmark filled in when this series is already in the library from
   * this site, so the reader is not offered to add what they added. It was a
   * small red cross, which reads as "error" or "remove" (QA, September 2026).
   * Asked of the library when the reader opens and again when the sheet saves;
   * the rule itself is shared/series-match.js's onThisSite. `announce` is for
   * the second time: a series that has just gone in is said to have, once.
   */
  async function markAdded(announce = true) {
    const btn = state.root?.querySelector('[data-act="library"]');
    if (!btn || !state.meta) return;
    let added = null;
    try {
      const r = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'findSimilar', meta: state.meta }, resolve));
      added = window.PanelFlowMatch?.onThisSite(r?.matches) || null;
    } catch { added = null; }
    if (!state.root) return;
    const was = !!btn.dataset.added;
    if (added) {
      btn.dataset.added = '1';
      btn.title = t('readerAlreadyAdded');
    } else {
      delete btn.dataset.added;
      btn.title = t('popupAddToLibrary');
    }
    btn.setAttribute('aria-label', btn.title);
    if (announce && added && !was) flash(t('readerAddedToLibrary'));
  }
  document.addEventListener('panelflow:library-changed', () => { markAdded(true); });

  /** Where the reader is, as the worker keeps it. */
  const progressNow = () => ({
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
  });

  const saveProgress = debounce(() => {
    if (!state.root) return;
    chrome.runtime.sendMessage({ type: 'saveProgress', progress: progressNow() });
  }, 800);

  /**
   * A chapter behind the bookmark is a reread, and a reread leaves the
   * bookmark where it was, further on — "Continue" still goes there, and the
   * unread count still starts from it. Moving it back here is the reader's
   * call, asked once, when the chapter opens (arbitrage e of the QA report,
   * September 2026). After a toast already up — the direction one, raised by
   * the first render — rather than over it.
   */
  function offerBookmarkMove(bookmark) {
    const where = bookmark.chapterLabel || t('chapterN', [String(bookmark.chapter ?? '?')]);
    const ask = () => {
      if (!state.root) return;
      flashAction(t('readerBookmarkAhead', [where]), t('readerBookmarkMove'), () => {
        if (!state.root) return;
        chrome.runtime.sendMessage({ type: 'saveProgress', progress: { ...progressNow(), moveBookmark: true } }, () => {
          if (chrome.runtime.lastError || !state.root) return;
          flash(t('readerBookmarkMoved'));
        });
      });
    };
    if (state.root?.querySelector('.pf-toast.pf-on')) setTimeout(ask, 1900);
    else ask();
  }

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
      // With the series, so the answer can say when this chapter is behind
      // the bookmark (`bookmark`), and offer to move it here.
      { type: 'getProgressFor', chapterUrl: state.meta.chapterUrl,
        sourceUrl: state.meta.sourceUrl, chapterLabel: state.meta.chapterLabel },
      (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        if (resp.bookmark?.chapterUrl) offerBookmarkMove(resp.bookmark);
        if (!resp.progress) return;
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
    let timer;
    const wrapped = (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), ms); };
    wrapped.flush = () => { clearTimeout(timer); fn(); };
    return wrapped;
  }

  // A text chapter is the same reader with paragraphs where the images go, so it
  // is the same open() — the empty image list is what everything downstream
  // (page count, download, mode picker) branches on through state.novel.
  const openText = (paragraphs, meta, rule) => open([], meta, rule, null, paragraphs);

  window.PanelFlowReader = { open, openText, close, isOpen, addPages };
})();
