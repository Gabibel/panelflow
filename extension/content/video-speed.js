// Playback speed on whatever video the page is already playing — and, because
// it is the only thing here that reaches that video, the witness that says an
// episode was watched.
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

  // --- what was actually watched ---------------------------------------------
  //
  // Statistics are written by exactly one thing: `recordRead`, which until now
  // only the reader ever called. So a library could hold fifty anime and report
  // nothing read, for the honest reason that nobody had read anything — and the
  // dishonest one that watching an episode was not counted as anything at all.
  //
  // This file is where that can be fixed, and only here: it is the one thing
  // that reaches the `<video>`, which is the only witness to whether an episode
  // was watched or merely opened. That is a second job for a file whose header
  // says it does one, and it is worth the exception — the alternative is a
  // second copy of the player-finding above, which is the hard part.

  /** Real playback before an episode counts. Two minutes is past the opening. */
  const WATCHED_AFTER = 120;

  let watched = 0;
  let reported = null;

  /**
   * Count what was played, not what elapsed.
   *
   * `timeupdate` fires with the position, so the step between two of them is
   * playback — a paused tab reports nothing, and a seek reports a jump. Only
   * small forward steps are counted: a skipped opening is not watching, and a
   * tab that was asleep must not bank the hour it slept through.
   */
  function countWatching(video) {
    let last = video.currentTime;
    video.addEventListener('loadstart', () => { watched = 0; last = 0; });
    video.addEventListener('timeupdate', () => {
      const step = video.currentTime - last;
      last = video.currentTime;
      if (step <= 0 || step > 2) return;
      watched += step;
      if (watched < WATCHED_AFTER) return;
      // Once per episode. `pageMeta` is what the page worked out about itself,
      // and `meta` what it told the player's frame — which is where the video
      // usually is: counted from `pageMeta` alone, an episode played in a frame
      // was never recorded (QA, September 2026). With no episode to name there
      // is nothing to file this under.
      const about = pageMeta || meta;
      if (!about?.chapterUrl || reported === about.chapterUrl) return;
      reported = about.chapterUrl;
      chrome.runtime.sendMessage({
        type: 'recordRead',
        read: {
          sourceUrl: about.sourceUrl,
          chapterUrl: about.chapterUrl,
          chapterLabel: about.chapterLabel,
          seconds: Math.round(watched),
        },
      });
      // And the library follows. For a series already in it, this episode
      // becomes where the reader is, the way a chapter opened in the reader
      // does: the bookmark only moves forward (a rewatched episode 3 leaves
      // it at 12), and the account passes it on to AniList or MyAnimeList.
      // Until now an anime stayed at the episode it was added from, whether
      // the next one came by a new page or by the site's own "next episode"
      // on the same page (owner's report, September 2026).
      if (inLibrary()) {
        chrome.runtime.sendMessage({
          type: 'saveProgress',
          progress: { sourceUrl: about.sourceUrl, chapterUrl: about.chapterUrl, chapterLabel: about.chapterLabel },
        });
        flashSaved(about.chapterLabel);
      }
    });
  }

  /** Whether this page's series is in the library: the page judges, and tells its frames. */
  const inLibrary = () => (window.top === window ? pageAdded : frameAdded);

  /** "✓ Episode 12" in the bar for a few seconds: the library moved on, and it says so. */
  function flashSaved(label) {
    if (!host || folded) return;
    const note = document.createElement('span');
    note.className = 'pf-saved';
    note.textContent = `✓ ${label || ''}`.trim();
    note.style.cssText = 'all:unset!important;color:#8fd19e!important;'
      + 'font:600 12px/28px system-ui,sans-serif!important;padding:0 8px 0 2px!important;';
    host.appendChild(note);
    host.style.opacity = '1';
    setTimeout(() => {
      note.remove();
      if (!hovered) host.style.opacity = '.35';
    }, 3500);
  }

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
        countWatching(v);
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
    if (host || dot) place();
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
  let addBtn = null;
  let dot = null;
  let hovered = false;

  /** A small cross over the bookmark once the series is in the library. */
  function markAdded(btn, added) {
    if (!btn) return;
    let cross = btn.querySelector('.pf-added');
    if (added && !cross) {
      cross = document.createElement('span');
      cross.className = 'pf-added';
      cross.textContent = '✕';
      cross.style.cssText = 'position:absolute!important;top:-3px!important;right:-2px!important;'
        + 'width:13px!important;height:13px!important;border-radius:50%!important;'
        + 'background:#e0503c!important;color:#fff!important;font:700 9px/13px system-ui,sans-serif!important;'
        + 'text-align:center!important;pointer-events:none!important;';
      // With `!important`: the button's own `all:unset!important` resets
      // `position` too, and a plain one lost to it, so the cross hung on the
      // bar's corner instead of the bookmark's.
      btn.style.setProperty('position', 'relative', 'important');
      btn.appendChild(cross);
      btn.title = chrome.i18n.getMessage('readerAlreadyAdded') || 'Already in your library';
    } else if (!added && cross) {
      cross.remove();
      btn.title = chrome.i18n.getMessage('pillAddAnime') || 'Add to library';
    }
  }

  /** Whether the series this page is about is in the library, from this site. */
  function askAdded(m, done) {
    if (!m) return done(false);
    try {
      chrome.runtime.sendMessage({ type: 'findSimilar', meta: m }, (r) => {
        if (chrome.runtime.lastError) return done(false);
        done(!!window.PanelFlowMatch?.onThisSite(r?.matches));
      });
    } catch { done(false); }
  }

  /**
   * Shown or not, for one of our controls. `hidden` alone does nothing here:
   * the `all:unset!important` each of them carries resets `display` as well,
   * and beats the stylesheet rule that makes [hidden] disappear. So the
   * bookmark said "hidden" while it sat on screen, and on a page the bar could
   * not name (Crunchyroll) a click on it went nowhere (owner's report,
   * September 2026).
   */
  function setShown(el, on) {
    if (!el) return;
    el.hidden = !on;
    if (on) el.style.removeProperty('display');
    else el.style.setProperty('display', 'none', 'important');
  }

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
    host.addEventListener('mouseenter', () => { hovered = true; host.style.opacity = '1'; });
    host.addEventListener('mouseleave', () => { hovered = false; host.style.opacity = '.35'; });

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
    // The add button belongs beside the speed, and the two live in different
    // documents — the player's frame holds the <video>, the page around it holds
    // the title. So the bar is built here, where the video is, and the parent
    // sends it what it knows. Hidden until that arrives: a button that cannot
    // say what it would add is a button that should not be offered.
    // 🔖 and not a plus: `+` right beside it means "faster", and one symbol for
    // two unrelated actions is a bar nobody can read at a glance. It is also
    // the glyph the reader already puts on this exact action (reader.js,
    // data-act="library"), so the gesture is the same wherever it is offered.
    addBtn = button('🔖', chrome.i18n.getMessage('pillAddAnime') || 'Add to library',
      () => window.parent.postMessage({ __panelflow: 'add' }, '*'));
    // Hidden until something knows which episode this is — `meta` when the bar
    // is inside the player's frame and was told, `pageMeta` when the bar *is*
    // the page and worked it out itself.
    //
    // That second half was missing, and it is the commoner case: the only line
    // that ever revealed this button sits behind `window.top !== window`, so on
    // every site whose player is in the main document the bar appeared with no
    // way to add the series to anything. `window.parent` is `window` there, so
    // the click below already lands on the handler that opens the sheet — the
    // button simply never became visible to be pressed.
    setShown(addBtn, !!(meta || pageMeta));
    host.appendChild(addBtn);
    // A frame built after the page last offered what it knows asks for it: the
    // page sends on its own mutations, and a player that loads after the last
    // of them used to keep its button hidden for good (QA, September 2026).
    // Asked every time, because the asking is also how the page learns that
    // the player has a bar of its own to add from.
    if (window.top !== window) window.parent.postMessage({ __panelflow: 'meta?' }, '*');
    host.appendChild(button('✕', chrome.i18n.getMessage('pillHideControls') || 'Hide',
      () => collapse(true)));
    mount();
    place();
    paint();
    // The choice this site was left in, restored before the bar is ever seen —
    // folding it after a frame of being visible is its own kind of flicker.
    try {
      chrome.storage.local.get(['videoUi'], ({ videoUi }) => {
        if (chrome.runtime.lastError) return;
        if ((videoUi || {})[location.hostname.replace(/^www\./, '')]) collapse(false);
      });
    } catch (e) { /* no extension storage in this frame */ }
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

  /**
   * On the player's top-left corner, not the window's.
   *
   * In a player's own frame the two are the same place. But where the video is
   * in the page itself (Crunchyroll), the window's corner is the site's logo
   * and menu, and the bar sat on top of them (owner's report, September 2026).
   * A player scrolled out of sight takes its bar with it: there is nothing on
   * screen for it to speed up.
   */
  function place() {
    const v = videos()[0];
    const r = v?.getBoundingClientRect?.();
    // Another extension's speed control in the same corner (Video Speed
    // Controller's "1.00"): the bar steps to the right of it rather than
    // sitting on it, which hid our "−" (owner's screenshots, September 2026).
    const aside = document.querySelector('.vsc-controller') ? 64 : 0;
    for (const el of [host, dot]) {
      if (!el) continue;
      const top = r ? Math.min(Math.max(r.top + 12, 8), innerHeight - 44) : 16;
      const left = r ? Math.min(Math.max(r.left + 12 + aside, 8), innerWidth - 60) : 16 + aside;
      el.style.setProperty('top', `${Math.round(top)}px`, 'important');
      el.style.setProperty('left', `${Math.round(left)}px`, 'important');
      const gone = r && (r.bottom < 48 || r.top > innerHeight - 48);
      el.style.setProperty('visibility', gone ? 'hidden' : 'visible', 'important');
    }
  }

  let placing = 0;
  const placeSoon = () => {
    if (placing || (!host && !dot)) return;
    placing = requestAnimationFrame(() => { placing = 0; place(); });
  };
  addEventListener('scroll', placeSoon, { capture: true, passive: true });
  addEventListener('resize', placeSoon, { passive: true });

  document.addEventListener('fullscreenchange', mount);
  document.addEventListener('webkitfullscreenchange', mount);
  document.addEventListener('fullscreenchange', placeSoon);

  function paint() {
    if (readout) readout.textContent = label(rate);
  }

  // --- getting out of the way, and coming back ------------------------------
  //
  // Somebody watching an episode wants nothing on top of it, and the same person
  // ten minutes later wants to speed through a recap. So the bar folds into a
  // dot rather than disappearing: a control you cannot get back is a control you
  // uninstall the extension to be rid of.
  //
  // The choice is remembered per site and not per page — nobody wants to fold it
  // again on every episode — and in `chrome.storage.local` rather than on the
  // account, because whether a bar is in the way depends on the screen you are
  // sitting at.
  const FOLD_KEY = 'speedFolded';
  let folded = false;

  function collapse(remember) {
    folded = true;
    if (host) host.style.display = 'none';
    if (!dot) {
      dot = document.createElement('button');
      dot.type = 'button';
      dot.textContent = '⏱';
      dot.title = chrome.i18n.getMessage('pillShowControls') || 'PanelFlow';
      dot.style.cssText = 'position:fixed!important;z-index:2147483646!important;'
        + 'left:16px!important;top:16px!important;all:unset;position:fixed!important;'
        + 'left:16px!important;top:16px!important;z-index:2147483646!important;'
        // Visible, not a ghost: at 28% on a video it was missed, and a bar
        // folded on one episode stays folded on every later one of the site.
        + 'cursor:pointer!important;opacity:.75!important;font-size:16px!important;'
        + 'line-height:1!important;padding:7px!important;color:#fff!important;'
        + 'background:rgba(20,18,16,.8)!important;border-radius:999px!important;';
      dot.addEventListener('click', (e) => { e.stopPropagation(); expand(); });
    }
    (document.fullscreenElement || document.body || document.documentElement)
      .appendChild(dot);
    place();
    if (remember) save();
  }

  function expand() {
    folded = false;
    if (dot) dot.remove();
    if (host) host.style.display = 'flex';
    place();
    save();
  }

  // Unfolded from elsewhere: the popup's "show the hidden video controls".
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.videoUi || !folded) return;
      const key = location.hostname.replace(/^www\./, '');
      if (!(changes.videoUi.newValue || {})[key]) expand();
    });
  } catch (e) { /* no extension storage in this frame */ }

  const save = () => {
    try {
      chrome.storage.local.get(['videoUi'], ({ videoUi }) => {
        if (chrome.runtime.lastError) return;
        const next = { ...(videoUi || {}) };
        next[location.hostname.replace(/^www\./, '')] = folded;
        chrome.storage.local.set({ videoUi: next });
      });
    } catch (e) { /* a frame with no extension storage: the fold is this visit's */ }
  };

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
  // Only in the top frame. The player's frame holds the <video> and knows
  // nothing else: the title, the season and the episode number are all on the
  // page around it, which is where this runs.
  //
  // It builds nothing of its own beyond a button. `PanelFlowLibraryModal` is the
  // same sheet a chapter page opens — duplicate detection, the offer to migrate
  // an entry that is already filed under another site, and a row per connected
  // tracker for the matching. Writing a second sheet for anime would be writing
  // a second answer to every question that one already answers.

  // What an episode page is (the series, the season, the episode on screen):
  // read in shared/episode-page.js, which the detector's "Add to library"
  // reads too, so the two buttons cannot give the same page two titles.
  const { describe, episodeNumber, episodeSelect, looksLikeVideoPage } = window.PanelFlowEpisode || {
    describe: () => null, episodeNumber: () => null, episodeSelect: () => null, looksLikeVideoPage: () => false,
  };

  function addButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'panelflow-add-anime';
    // The "＋" is a picture, kept out of the button's name, like the pill's
    // book (QA re-test It.4, N23).
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '＋ ';
    b.append(glyph, chrome.i18n.getMessage('pillAddAnime') || 'Add to library');
    b.title = chrome.i18n.getMessage('pillAddAnimeTitle') || '';
    // A fingertip's height under a finger, as everything else PanelFlow puts
    // on a page (it was 31 px).
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    b.style.cssText = 'position:fixed!important;z-index:2147483646!important;'
      + 'left:16px!important;bottom:16px!important;'
      + 'background:rgba(20,18,16,.92)!important;color:#fff!important;border:0!important;'
      + 'border-radius:999px!important;padding:9px 14px!important;cursor:pointer!important;'
      + 'font:600 13px/1 system-ui,sans-serif!important;'
      + (coarse ? 'min-height:44px!important;padding:0 18px!important;' : '')
      + 'box-shadow:0 2px 10px rgba(0,0,0,.4)!important;';
    b.addEventListener('click', async () => {
      const modal = window.PanelFlowLibraryModal;
      if (!modal) return;
      await modal.open(describe());
    });
    return b;
  }

  // --- the two frames, and which one knows what -----------------------------
  //
  // The player's frame has the video and nothing that names it. The page around
  // it has the title, the season and the episode, and cannot reach the video at
  // all. So the parent sends what it knows downward, the bar shows the button
  // once it arrives, and a click comes back up to where the sheet can open.
  //
  // Messages are accepted from `window.parent` only, and carry a marker of ours.
  // A page could still forge one: the worst it buys is a wrong title in a sheet
  // the reader reads before saving, which is a smaller risk than a control that
  // cannot be offered at all.

  let meta = null;
  // Whether the page said its series is in the library, in a player's frame.
  let frameAdded = false;

  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || typeof data !== 'object') return;

    if (data.__panelflow === 'meta' && e.source === window.parent && window.top !== window) {
      meta = data.meta;
      frameAdded = !!data.added;
      if (addBtn) {
        setShown(addBtn, !!meta);
        markAdded(addBtn, !!data.added);
        // And the page is told, every time, that this frame has a bar to add
        // from. The one `meta?` sent when the bar was built can reach the page
        // before the page listens, and the page then put its own button up
        // beside the bar (QA re-test It.5, N-B7). An offer always reaches us
        // once the page is listening, so the answer to it cannot be missed.
        window.parent.postMessage({ __panelflow: 'bar' }, '*');
      }
      return;
    }
    // Bottom-up: the button was pressed down in the player. Only the top frame
    // answers this, and only from a frame it is actually hosting.
    if (data.__panelflow === 'add' && window.top === window) {
      const modal = window.PanelFlowLibraryModal;
      // Asked again rather than read from the last offer: the episode on
      // screen may have changed since, without a page load.
      const now = currentMeta() || pageMeta;
      if (modal && now) modal.open(now);
      return;
    }
    // A player's frame that came late, asking what the page is about, or one
    // saying it has a bar of its own. Only a frame of this document is heard.
    if ((data.__panelflow === 'meta?' || data.__panelflow === 'bar') && window.top === window
        && [...document.querySelectorAll('iframe')].some((f) => f.contentWindow === e.source)) {
      playerHasBar = true;
      document.getElementById('panelflow-add-anime')?.remove();
      if (data.__panelflow === 'meta?' && pageMeta) {
        e.source.postMessage({ __panelflow: 'meta', meta: pageMeta, added: pageAdded }, '*');
      }
    }
  });

  // Whether the player's frame has a bar of ours — which it has only when its
  // site was granted too. A streaming site is turned on site by site, and the
  // player usually lives on another one; without this the page could be on and
  // still offer no way to add the series.
  let playerHasBar = false;
  const FRAME_WAIT_MS = 2500;

  // What this page is, offered to whatever is inside it, and whether its
  // series is already in the library.
  let pageMeta = null;
  let pageAdded = false;
  // The listed streaming hosts, once the rules have answered.
  let known = null;

  /** This page as an episode the library can file, or null. */
  function currentMeta() {
    if (!known) return null;
    const host = location.hostname.replace(/^www\./, '');
    const onVideoSite = known.some((h) => host === h || host.endsWith(`.${h}`))
      || looksLikeVideoPage(known);
    // Not on the player's own page, and not on a series page: both are places
    // where there is no single episode to file.
    if (!onVideoSite || !episodeNumber()) return null;
    return describe();
  }

  /** The current answer, to every frame of the page: the player is in one of them. */
  function offer() {
    for (const f of document.querySelectorAll('iframe')) {
      try { f.contentWindow.postMessage({ __panelflow: 'meta', meta: pageMeta, added: pageAdded }, '*'); }
      catch (err) { /* a frame that is not ours to talk to yet */ }
    }
  }

  // Whether the series is already in, asked here and told to the player's
  // frame with the meta: the frame has no page to judge from.
  const refreshAdded = () => askAdded(pageMeta, (yes) => { pageAdded = yes; markAdded(addBtn, yes); offer(); });

  // No bar anywhere to add from — no video here, and no answer from the
  // player's frame: the page's own button, bottom left.
  let fallbackArmed = false;
  function armFallback() {
    if (fallbackArmed) return;
    fallbackArmed = true;
    setTimeout(() => {
      if (!pageMeta) return;
      if (playerHasBar || document.getElementById('panelflow-speed') || document.getElementById('panelflow-add-anime')) return;
      (document.body || document.documentElement).appendChild(addButton());
    }, FRAME_WAIT_MS);
  }

  /**
   * Keep the answer current.
   *
   * It used to be worked out once, when the rules arrived, and never again.
   * Crunchyroll is one page for the whole visit: its first answer was "not an
   * episode" (the player is not built yet at that moment, or the visit began
   * on the home page) and it stayed that for every episode played afterwards.
   * So it is asked again when the address changes, while the page is still
   * being built at a new address, and for as long as it is an episode, which
   * is the one state a picker changes under it. The mutations are many and the
   * asking is coalesced to a few times a second.
   */
  const SETTLE_MS = 15000;
  function watchPage() {
    let lastUrl = '';
    let urlSince = 0;
    let lastKey = '';
    const refresh = () => {
      if (location.href !== lastUrl) { lastUrl = location.href; urlSince = Date.now(); }
      const next = currentMeta();
      const key = next ? JSON.stringify(next) : '';
      const had = !!pageMeta;
      pageMeta = next;
      // This frame's own bar, where the video is in the page itself.
      if (addBtn) setShown(addBtn, !!pageMeta);
      if (!pageMeta) {
        fallbackArmed = false;
        document.getElementById('panelflow-add-anime')?.remove();
      } else {
        armFallback();
      }
      if (key !== lastKey) {
        lastKey = key;
        if (pageMeta) refreshAdded();
        else if (had) offer();
      } else if (pageMeta) {
        // Sent again as frames appear: a player iframe is often written into
        // the page well after this runs.
        offer();
      }
    };
    let timer = 0;
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        if (location.href !== lastUrl || pageMeta || Date.now() - urlSince < SETTLE_MS) refresh();
      }, 600);
    };
    refresh();
    // `src` too: a picker that changes episode swaps the player's address.
    new MutationObserver(soon).observe(document.documentElement,
      { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    addEventListener('popstate', soon);
    // An episode picked in place is a new episode to file: the meta is rebuilt
    // and offered again, so the bookmark follows the picker.
    document.addEventListener('change', (e) => { if (e.target?.tagName === 'SELECT') soon(); }, true);
    document.addEventListener('panelflow:library-changed', refreshAdded);
  }

  if (window.top === window) {
    chrome.runtime.sendMessage({ type: 'getRules' }, (resp) => {
      // No rules is not no page: with a fresh install and the server out of
      // reach this used to stop here, and the bookmark in the player never
      // appeared (QA, September 2026). The page's own shape still says
      // whether it is an episode (looksLikeVideoPage).
      if (chrome.runtime.lastError) return;
      known = Object.keys(resp?.rules?.videoDomains || {})
        .filter((k) => !k.startsWith('_'));
      watchPage();
    });
  }

  // Lifted by the tests, which cannot load a content script: the arithmetic is
  // the part worth pinning, and a second copy of it in a test file would stay
  // green while this one rotted.
  window.__panelflowSpeed = { snap, clamp, label, MIN, MAX, STEP, DEFAULT };
})();
