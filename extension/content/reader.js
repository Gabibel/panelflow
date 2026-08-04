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
  };

  const state = {
    root: null, images: [], meta: null, rule: {}, nav: null, container: null,
    mode: 'vertical', page: 0, chromeVisible: true,
    zoom: 1, panX: 0, panY: 0,
    breakFirst: false, prefs: { ...DEFAULT_PREFS },
    playing: false, playRaf: 0, playLastTs: 0,
    harvestObserver: null, harvestTimer: 0,
  };

  const $ = (sel) => state.root.querySelector(sel);

  function open(images, meta, rule, container) {
    if (state.root) close();
    Object.assign(state, {
      images: images.slice(), meta, rule, container: container || null,
      page: 0, zoom: 1, panX: 0, panY: 0,
      breakFirst: false, playing: false,
      nav: window.__panelflowDetect?.chapterNav?.() || null,
    });
    chrome.storage.local.get(['readerMode', 'readerPrefs'], (v) => {
      state.mode = v.readerMode || (rule.readingDirection === 'rtl' ? 'rtl' : 'vertical');
      state.prefs = { ...DEFAULT_PREFS, ...(v.readerPrefs || {}) };
      build();
      render();
      restoreProgress();
      harvestLazyPages();
    });
  }

  function close() {
    // Flushed, not scheduled. saveProgress is debounced by 800 ms and bails on
    // a closed reader, so the queued call always fired after state.root was
    // gone and did nothing — closing the reader was the one moment your
    // position was guaranteed *not* to be written down.
    saveProgress.flush();
    stopAutoplay();
    stopHarvest();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', syncFullscreenIcon);
    // Removing the element while it owns the full screen leaves the tab stuck.
    if (document.fullscreenElement === state.root) document.exitFullscreen().catch(() => {});
    state.root?.remove();
    state.root = null;
    document.documentElement.classList.remove('panelflow-noscroll');
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
        <select class="pf-chapters pf-btn" title="Select chapter"></select>
        <button class="pf-btn pf-chapnav" data-act="nextch" title="Next chapter">⏭</button>
      </div>
      <div class="pf-stage"></div>
      <div class="pf-side pf-chrome">
        <button class="pf-btn" data-act="library" title="Add to library">🔖</button>
        <button class="pf-btn" data-act="download" title="Download chapter (.cbz)">⬇</button>
        <button class="pf-btn" data-act="prefs" title="Reader preferences (S)">⚙</button>
        <button class="pf-btn pf-resetzoom" data-act="resetzoom" title="Reset zoom (0)" hidden>⊙</button>
        <button class="pf-btn" data-act="fullscreen" title="Full screen (F)">⛶</button>
        <button class="pf-btn" data-act="hide" title="Hide controls (H)">⇱</button>
      </div>
      <div class="pf-prefs pf-chrome" hidden>
        <label>Reading mode
          <select class="pf-mode">
            <option value="vertical">Long strip</option>
            <option value="ltr">Single page →</option>
            <option value="rtl">Single page ← (manga)</option>
            <option value="spread">Double page</option>
          </select>
        </label>
        <label>Brightness <input data-pref="brightness" type="range" min="30" max="130" step="5"></label>
        <label>Contrast <input data-pref="contrast" type="range" min="50" max="150" step="5"></label>
        <label>Gap size <input data-pref="gap" type="range" min="0" max="40" step="2"></label>
        <label>Strip width <input data-pref="stripWidth" type="range" min="40" max="100" step="5"></label>
        <label>Play speed <input data-pref="autoplaySpeed" type="range" min="20" max="300" step="10"></label>
        <label>Progress size <input data-pref="progressSize" type="range" min="0" max="10" step="1"></label>
        <label class="pf-check"><input data-pref="autoNext" type="checkbox"> Auto next chapter</label>
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
    root.querySelector('[data-act="fullscreen"]').addEventListener('click', toggleFullscreen);
    root.querySelector('[data-act="hide"]').addEventListener('click', () => setChrome(false));
    root.querySelector('[data-act="resetzoom"]').addEventListener('click', () => {
      resetTransform();
      applyTransform();
    });
    // Leaving full screen by Esc/F11 rather than our button must still update
    // the icon, so track the document's state instead of our own flag.
    document.addEventListener('fullscreenchange', syncFullscreenIcon);
    buildChapterNav();
    buildPrefsPanel();

    const scrub = $('.pf-scrub');
    scrub.max = state.images.length;
    scrub.addEventListener('input', () => {
      const n = parseInt(scrub.value, 10) - 1;
      if (state.mode === 'vertical') {
        const stage = $('.pf-stage');
        stage.scrollTop = (n / Math.max(1, state.images.length - 1)) *
          (stage.scrollHeight - stage.clientHeight);
      } else {
        showPage(n);
      }
    });

    document.addEventListener('keydown', onKey, true);
  }

  function buildChapterNav() {
    const sel = $('.pf-chapters');
    const nav = state.nav;
    if (!nav || !nav.options || nav.options.length < 2) {
      sel.hidden = true;
      if (!nav?.prevUrl) $('[data-act="prevch"]').hidden = true;
      if (!nav?.nextUrl) $('[data-act="nextch"]').hidden = true;
      if (!nav?.prevUrl && !nav?.nextUrl) return;
    } else {
      for (const { label, url } of nav.options) {
        const opt = document.createElement('option');
        opt.value = url;
        opt.textContent = label;
        if (url === location.href) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => gotoChapter(sel.value));
    }
    $('[data-act="prevch"]').addEventListener('click', () => nav.prevUrl && gotoChapter(nav.prevUrl));
    $('[data-act="nextch"]').addEventListener('click', () => nav.nextUrl && gotoChapter(nav.nextUrl));
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
      if (input.type === 'checkbox') input.checked = !!state.prefs[key];
      else input.value = state.prefs[key];
      input.addEventListener('input', () => {
        state.prefs[key] = input.type === 'checkbox' ? input.checked : parseInt(input.value, 10);
        chrome.storage.local.set({ readerPrefs: state.prefs });
        applyPrefs();
      });
    }
  }

  function applyPrefs() {
    const stage = $('.pf-stage');
    stage.style.filter = `brightness(${state.prefs.brightness}%) contrast(${state.prefs.contrast}%)`;
    stage.style.setProperty('--pf-gap', state.prefs.gap + 'px');
    stage.style.setProperty('--pf-width', state.prefs.stripWidth + '%');
    // 0 hides the bar entirely — some readers want nothing over the artwork.
    state.root.style.setProperty('--pf-progress-h', state.prefs.progressSize + 'px');
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
    if (state.mode === 'vertical') renderVertical(stage);
    else renderPaged(stage);
    applyPrefs();
    $('.pf-play').hidden = state.mode !== 'vertical';
    $('.pf-break').hidden = state.mode !== 'spread';
    $('.pf-scrub').classList.toggle('pf-rtl', state.mode === 'rtl');
    updateCounter();
    preload();
  }

  function renderVertical(stage) {
    stage.className = 'pf-stage pf-vertical';
    for (const src of state.images) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = src;
      stage.appendChild(img);
    }
    const scrollRatio = () =>
      stage.scrollTop / Math.max(1, stage.scrollHeight - stage.clientHeight);
    // The bar tracks the scroll live; the (costlier) counter and progress save
    // stay debounced.
    stage.addEventListener('scroll', () => updateProgress(scrollRatio()), { passive: true });
    stage.addEventListener('scroll', debounce(() => {
      state.page = Math.round(scrollRatio() * (state.images.length - 1));
      updateCounter();
      updateProgress(scrollRatio());
      saveProgress();
    }, 500));
    stage.addEventListener('click', (e) => {
      if (e.target === stage || e.target.tagName === 'IMG') setChrome(!state.chromeVisible);
    });
    // Any manual interaction pauses autoplay.
    stage.addEventListener('wheel', stopAutoplay, { passive: true });
    stage.addEventListener('pointerdown', stopAutoplay);
    // Keep the reading position across mode switches.
    if (state.page > 0) {
      scrollToRatio(stage, state.page / Math.max(1, state.images.length - 1));
    }
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
    if (suppressTapUntil > Date.now()) return; // ignore tap that ended a pan
    const x = e.clientX / innerWidth;
    const rtl = state.mode === 'rtl';
    if (x < 0.33) rtl ? next() : prev();
    else if (x > 0.67) rtl ? prev() : next();
    else setChrome(!state.chromeVisible);
  }

  function onKey(e) {
    if (!state.root) return;
    if (e.key === 'Escape') { e.preventDefault(); return close(); }
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
    $('.pf-counter').textContent =
      `${state.page + 1} / ${state.images.length}` +
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

  async function downloadChapter() {
    const btn = state.root.querySelector('[data-act="download"]');
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
      const safe = (s) => String(s || '').replace(/[<>:"/\\|?*]+/g, ' ').trim().slice(0, 80);
      const name = `${safe(state.meta.title) || 'chapter'}${state.meta.chapterLabel ? ' - ' + safe(state.meta.chapterLabel) : ''}.cbz`;
      const blobUrl = URL.createObjectURL(new Blob([zipStore(files)], { type: 'application/vnd.comicbook+zip' }));
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      btn.textContent = '✓';
    } catch {
      btn.textContent = '⚠';
    } finally {
      btn.disabled = false;
      setTimeout(() => { if (state.root) btn.textContent = '⬇'; }, 3000);
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
      pageCount: state.images.length,
      scrollPos: state.page / Math.max(1, state.images.length - 1),
    }});
  }, 800);

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
          state.page = Math.round(ratio * Math.max(0, state.images.length - 1));
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

  window.PanelFlowReader = { open, close, isOpen };
})();
