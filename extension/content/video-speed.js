// Playback speed, on whatever video the page is already playing.
//
// PanelFlow does not ship a video player and this file is not the start of one.
// The site's player stays exactly where it is; this only reaches for the
// `<video>` element it is built on and sets `playbackRate`. That distinction is
// the whole design: replacing a player means handling sources, subtitles, DRM
// and full screen on every site that exists, while setting a rate is one
// property that every browser has implemented the same way for fifteen years.
//
// Two things make it harder than it sounds, and both are handled below.
//
// A streaming page usually builds its player *after* the document is ready, and
// often swaps the element out between episodes — so a one-shot querySelector
// finds nothing, and the version that runs a second later finds a `<video>` that
// is replaced the moment somebody clicks "next". Hence the observer, and hence
// re-applying on `loadstart` rather than once at pick-up.
//
// And the player is very often inside an `<iframe>`, which is why the manifest
// injects this into every frame. Each copy sees only its own document, finds at
// most its own video, and shows its control over it. A frame with no video does
// nothing at all and costs one observer.
(() => {
  'use strict';
  if (window.__panelflowSpeedLoaded) return;
  window.__panelflowSpeedLoaded = true;

  // 0.5 to 4, in steps of 0.5. The range is the reader's, not a technical
  // limit: browsers accept far more, but under 0.5 nothing is intelligible and
  // over 4 nothing is watchable, and offering a rate nobody can use is offering
  // a way to make the picture useless and wonder why.
  const MIN = 0.5;
  const MAX = 4;
  const STEP = 0.5;
  const DEFAULT = 1;

  // Chrome mutes audio above 4× on its own, and pitch correction gives up well
  // before that — but between 2× and 4× speech is still followable, which is the
  // whole point of the feature. So nothing is muted here: the reader asked to go
  // faster, not to go silent, and a player that quietly cuts the sound at 2.5×
  // looks broken rather than considerate.
  const clamp = (rate) => Math.min(MAX, Math.max(MIN, rate));

  /**
   * The nearest allowed rate, so a stored or read-back value cannot be off-grid.
   *
   * Absence is checked before conversion, because `Number(null)` is 0 and 0
   * would clamp to the slowest speed there is. "No answer" and "as slow as
   * possible" are not the same answer, and a player that reports nothing would
   * have put the video into slow motion.
   *
   * Anything that is not a finite number — NaN from a player that answered
   * badly, Infinity from one that answered absurdly — is no answer either.
   */
  const snap = (rate) => {
    if (rate === null || rate === undefined || rate === '') return DEFAULT;
    const n = Number(rate);
    if (!Number.isFinite(n)) return DEFAULT;
    return clamp(Math.round(n / STEP) * STEP);
  };

  /** Rounded for display: 1.5 and not 1.5000000000000002. */
  const label = (rate) => `${Math.round(rate * 10) / 10}×`;

  // What the reader last chose, applied to every video that turns up afterwards.
  // Kept for the session and not written to the account: a speed is an answer
  // about *this* video — a documentary and an episode of something are not
  // watched at the same rate — and an account-wide 3× arriving on a phone that
  // never asked for it is a setting nobody can find to turn off.
  let rate = DEFAULT;
  let host = null;

  function apply(video) {
    try {
      if (video.playbackRate !== rate) video.playbackRate = rate;
    } catch (e) {
      // A player that guards its own rate, or an element torn down mid-call.
      // Not worth a line each time: the observer will be back.
    }
  }

  /** Every video in this document, biggest first — the player, then the ads. */
  const videos = () => [...document.querySelectorAll('video')]
    .filter((v) => v.offsetWidth > 200 || v.offsetHeight > 150)
    .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));

  function applyAll() {
    const found = videos();
    for (const v of found) {
      apply(v);
      if (!v.__panelflowSpeedBound) {
        v.__panelflowSpeedBound = true;
        // The rate resets to 1 whenever a new source loads, which on a streaming
        // site is every episode and every ad break. Re-applied on the event that
        // says so rather than on a timer.
        v.addEventListener('loadstart', () => apply(v));
        v.addEventListener('ratechange', () => {
          // The site's own controls may set a rate too. Whoever moved it last
          // wins, including the page — fighting it would make the site's speed
          // menu look broken, and the reader has a control right here.
          if (Math.abs(v.playbackRate - rate) > 0.01) rate = snap(v.playbackRate);
          paint();
        });
      }
    }
    if (found.length && !host) build();
    if (!found.length && host) { host.remove(); host = null; }
  }

  function set(next) {
    rate = snap(next);
    applyAll();
    paint();
  }

  // --- the control ----------------------------------------------------------
  //
  // Every style inline and `!important`, like mobile/inject/report-failure.js
  // and for the same reason: this sits on a streaming site whose CSS is hostile
  // by accident if not by design, and a control that inherits `display: none`
  // from a stray rule is a feature that does not exist.

  let readout = null;

  function button(text, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.style.cssText = 'all:unset!important;cursor:pointer!important;padding:0 8px!important;'
      + 'font:600 15px/28px system-ui,sans-serif!important;color:#fff!important;'
      + 'min-width:20px!important;text-align:center!important;';
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function build() {
    host = document.createElement('div');
    host.id = 'panelflow-speed';
    host.style.cssText = 'position:fixed!important;z-index:2147483646!important;'
      // Top left: the player's own controls live along the bottom edge and its
      // settings gear sits bottom right, so anything of ours down there is
      // either covering a control or being covered by one.
      + 'left:16px!important;top:16px!important;display:flex!important;'
      + 'align-items:center!important;gap:2px!important;'
      + 'background:rgba(20,18,16,.88)!important;border-radius:999px!important;'
      + 'padding:2px 4px!important;box-shadow:0 2px 10px rgba(0,0,0,.4)!important;'
      + 'opacity:.35!important;transition:opacity .15s!important;'
      + 'font-family:system-ui,sans-serif!important;';
    // Faint until wanted. A permanent opaque pill over somebody's video is the
    // reason people uninstall things like this.
    host.addEventListener('mouseenter', () => { host.style.opacity = '1'; });
    host.addEventListener('mouseleave', () => { host.style.opacity = '.35'; });

    readout = document.createElement('span');
    readout.style.cssText = 'all:unset!important;color:#fff!important;'
      + 'font:600 13px/28px system-ui,sans-serif!important;min-width:34px!important;'
      + 'text-align:center!important;';
    // Back to normal speed in one click, which is the thing wanted most often
    // and the only reason a readout needs to be clickable at all.
    readout.style.cursor = 'pointer';
    readout.title = 'PanelFlow — 1×';
    readout.addEventListener('click', (e) => { e.stopPropagation(); set(DEFAULT); });

    host.append(
      button('−', `− ${STEP}`, () => set(rate - STEP)),
      readout,
      button('+', `+ ${STEP}`, () => set(rate + STEP)),
    );
    mount();
    paint();
  }

  /**
   * Where the control has to live right now.
   *
   * `position: fixed` is positioned against the viewport — except when
   * something is full screen, and then only the full-screen element and its
   * descendants are painted at all. A pill parked on `<body>` simply vanishes
   * the moment the reader goes full screen, which is when they are most likely
   * to want it. So it is re-parented onto whatever is full screen, and back
   * again on the way out.
   */
  function mount() {
    if (!host) return;
    const target = document.fullscreenElement || document.body || document.documentElement;
    // A <video> cannot hold children. When the player full-screens the element
    // itself rather than its wrapper there is nowhere to put the control, and
    // the honest answer is to leave it off until the reader comes back out.
    if (target.tagName === 'VIDEO') { host.remove(); return; }
    if (host.parentNode !== target) target.appendChild(host);
  }

  document.addEventListener('fullscreenchange', mount);
  document.addEventListener('webkitfullscreenchange', mount);

  function paint() {
    if (readout) readout.textContent = label(rate);
  }

  // --- when to look ---------------------------------------------------------

  // The player is built late and replaced between episodes, so this watches
  // instead of asking once. Coalesced into a frame: a streaming page mutates
  // constantly, and re-scanning on every mutation would spend more time looking
  // for a video than the video spends playing.
  let pending = null;
  const schedule = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = null; applyAll(); });
  };

  new MutationObserver(schedule).observe(
    document.documentElement, { childList: true, subtree: true });
  document.addEventListener('loadstart', schedule, true);
  schedule();

  // --- putting an episode in the library ------------------------------------
  //
  // Only in the top frame, and only on a site the rules file calls a video site.
  // The player's frame holds the <video> and knows nothing else: the title, the
  // season and the episode number are all on the page around it, which is where
  // this runs.
  //
  // It builds nothing of its own beyond a button. `PanelFlowLibraryModal` is the
  // same sheet a chapter page opens — duplicate detection, the offer to migrate
  // an entry that is already filed under another site, and a row per connected
  // tracker for the matching. Writing a second sheet for anime would be writing
  // a second answer to every question that one already answers.

  /** The series title, without the site's own furniture around it. */
  function pageTitle() {
    const og = document.querySelector('meta[property="og:title"]')?.content;
    const raw = (og || document.title || '').trim();
    // "Détective Conan Saison 30 Episode 3 VOSTFR - Voiranime" — the season and
    // episode are progress, not the name of the work, and the tail is the site.
    return raw
      .replace(/\s*[-–|]\s*[^-–|]*$/, '')
      .replace(/\s*(saison|season)\s*\d+.*$/i, '')
      .replace(/\s*(episode|épisode|ep\.?)\s*\d+.*$/i, '')
      .trim() || raw;
  }

  /** The episode this page is, read from the address. */
  const episodeNumber = () => {
    const m = /[/_-](?:episode|épisode|ep)[-_/ ]?(\d+(?:\.\d+)?)/i.exec(location.href);
    return m ? m[1] : null;
  };

  function addButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'panelflow-add-anime';
    b.textContent = `＋ ${chrome.i18n.getMessage('pillAddAnime') || 'Add to library'}`;
    b.title = chrome.i18n.getMessage('pillAddAnimeTitle') || '';
    b.style.cssText = 'position:fixed!important;z-index:2147483646!important;'
      + 'left:16px!important;bottom:16px!important;'
      + 'background:rgba(20,18,16,.92)!important;color:#fff!important;border:0!important;'
      + 'border-radius:999px!important;padding:9px 14px!important;cursor:pointer!important;'
      + 'font:600 13px/1 system-ui,sans-serif!important;'
      + 'box-shadow:0 2px 10px rgba(0,0,0,.4)!important;';
    b.addEventListener('click', async () => {
      const modal = window.PanelFlowLibraryModal;
      if (!modal) return;
      const episode = episodeNumber();
      await modal.open({
        title: pageTitle(),
        sourceUrl: location.origin + location.pathname,
        sourceDomain: location.hostname.replace(/^www\./, ''),
        coverUrl: document.querySelector('meta[property="og:image"]')?.content || null,
        // The whole reason the column exists: this is what a tracker routes on
        // to say episodes rather than chapters.
        medium: 'anime',
        ...(episode ? { chapterLabel: `Episode ${episode}`, chapterUrl: location.href } : {}),
      });
    });
    return b;
  }

  // Asked of the worker rather than hardcoded, so a site added to the rules file
  // is a site this works on six hours later instead of at the next release.
  if (window.top === window) {
    chrome.runtime.sendMessage({ type: 'getRules' }, (resp) => {
      if (chrome.runtime.lastError || !resp?.rules) return;
      const host = location.hostname.replace(/^www\./, '');
      const known = Object.keys(resp.rules.videoDomains || {})
        .filter((k) => !k.startsWith('_'));
      const onVideoSite = known.some((h) => host === h || host.endsWith(`.${h}`));
      // Not on the player's own page: somebody who opened vidmoly directly is
      // looking at a video with no series around it to name.
      if (!onVideoSite || !episodeNumber()) return;
      document.documentElement.appendChild(addButton());
    });
  }

  // Lifted by the tests, which cannot load a content script: the arithmetic is
  // the part worth pinning, and a second copy of it in a test file would stay
  // green while this one rotted.
  window.__panelflowSpeed = { snap, clamp, label, MIN, MAX, STEP, DEFAULT, pageTitle, episodeNumber };
})();
