// Runs at document_start. Blocks the popup/redirect hijacks common on manga
// aggregator sites: window.open calls not triggered by a real user gesture,
// window.open calls that spend a real gesture on somebody else's domain, and
// programmatic clicks on injected anchors targeting new windows.
//
// The manifest puts this one file in the MAIN world, and it has to stay there.
// A content script's default isolated world has its own `window`, so the
// reassignment below used to replace a `window.open` no page script could ever
// reach: every ad tab still opened, and nothing about the code looked wrong.
// The click listener worked all along — DOM events are shared between the
// worlds — so exactly half of this file was doing anything.
//
// The price of the main world is no `chrome.*` here. Nothing in this file wants
// it; if that changes, the new part belongs in an isolated script that talks to
// this one through the DOM, not in a second copy of the guard.
(() => {
  'use strict';
  let userGestureUntil = 0;
  const GESTURE_WINDOW_MS = 1000;

  // Clicks on PanelFlow's own overlay are not a gesture the page may spend.
  // The reader and the library sheet are elements in the site's document, so a
  // press on the close button or the chapter list looks to the page exactly
  // like a press on the page — and the pop-under scripts these sites run are
  // waiting for precisely that. Reading a chapter should not cost a tab of
  // advertising per button pressed, so the window never opens for our own.
  //
  // The sheet is a closed shadow root and the reader is not, so `closest` from
  // the event's target answers for both: inside the sheet every event is
  // reported on its host, and inside the reader on the button itself.
  const ours = (e) => {
    const el = e.target;
    return !!(el && el.closest
      && el.closest('#panelflow-reader, #panelflow-libmodal, #panelflow-pill'));
  };

  const markGesture = (e) => {
    if (ours(e)) return;
    userGestureUntil = Date.now() + GESTURE_WINDOW_MS;
  };
  addEventListener('pointerdown', markGesture, true);
  addEventListener('keydown', markGesture, true);

  // The registrable domain, near enough for this one decision. The real answer
  // needs the public suffix list, which is a megabyte we are not shipping into
  // every page at document_start; the last two labels are right for the .com,
  // .fr and .to domains these sites live on, and TWO_PART is the bounded list
  // of second-level labels under which a country hands out domains (the
  // "x.co.uk", "x.ne.jp", "x.com.br" shapes), held to a table of hosts by
  // navigation-policy.test.js. Being wrong here means treating two domains as
  // one site, which loses a block, never a page the reader wanted.
  const TWO_PART = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'mil', 'sch', 'nom', 'web']);
  const site = (host) => {
    const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
    if (parts.length < 3) return parts.join('.');
    return parts.slice(TWO_PART.has(parts[parts.length - 2]) ? -3 : -2).join('.');
  };

  // A real click on the site's own "next chapter" control is a real gesture,
  // so the gesture window above cannot tell it apart from a real click that
  // the page answers by opening an advertiser. What tells them apart is where
  // the tab is going: a scan site opens its own pages — the next chapter, the
  // series index, its Discord invite is an <a> the reader can see — and never
  // needs script to open somebody else's domain in a new tab.
  //
  // No URL at all is the pop-under proper: open a blank tab now, keep the
  // handle, and navigate it once the gesture is spent and nobody is watching.
  const sameSite = (url) => {
    if (url === undefined || url === null || url === '') return false;
    let u;
    try { u = new URL(String(url), location.href); } catch (e) { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return site(u.hostname) === site(location.hostname);
  };

  const nativeOpen = window.open;
  window.open = function (...args) {
    if (Date.now() > userGestureUntil) {
      console.debug('[PanelFlow] blocked window.open without user gesture:', args[0]);
      return null;
    }
    if (!sameSite(args[0])) {
      console.debug('[PanelFlow] blocked window.open to another site:', args[0]);
      return null;
    }
    return nativeOpen.apply(this, args);
  };

  // Neutralize "click anywhere opens an ad tab" overlays: synthetic clicks
  // (isTrusted === false) on anchors with target=_blank are cancelled.
  addEventListener('click', (e) => {
    if (e.isTrusted) return;
    const a = e.target.closest && e.target.closest('a[target="_blank"]');
    if (a) {
      e.preventDefault();
      e.stopImmediatePropagation();
      console.debug('[PanelFlow] blocked synthetic click on', a.href);
    }
  }, true);

  // The link that changes its mind between the finger landing and the click.
  //
  // A real tap on a real link is the one thing the two rules above let
  // through, and the OnClick networks know it: on pointerdown they rewrite the
  // pressed anchor's href to the advertiser, the click that follows is trusted
  // and goes there, and the original address is put back afterwards. Play
  // buttons on anime sites are the usual victim, because that is where every
  // tap lands. So the address is noted when the finger lands and compared when
  // the click arrives: a link that now points off-site and did not a moment
  // ago is not a link the reader chose.
  let pressed = null;
  addEventListener('pointerdown', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    pressed = a ? { a, href: a.href } : null;
  }, true);
  addEventListener('click', (e) => {
    if (!e.isTrusted || !pressed) return;
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a && a === pressed.a && a.href !== pressed.href && !sameSite(a.href)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      console.debug('[PanelFlow] blocked a link whose address changed under the tap:', a.href);
    }
    pressed = null;
  }, true);

  // AdCash, by name.
  //
  // Its loader (acscdn.com/script/aclib.js) puts one object on the window and
  // the page calls `aclib.runPop({zoneId})` — which installs the tap listener
  // everything above is defending against. The list-based blockers do not
  // reliably stop the loader (it is `async`, and removing a script that has
  // started fetching does not always stop it running), so the object is put
  // there first, frozen, with every entry point a no-op. The loader's own
  // assignment then fails or is ignored, and the page's call lands on nothing.
  // Named rather than generic because it is the one network whose global is
  // stable; the others hide behind random domains and random names, and are
  // what the rules above and navigation-policy.js are for.
  try {
    const noop = () => {};
    Object.defineProperty(window, 'aclib', {
      value: Object.freeze({
        runPop: noop, runAutoTag: noop, runBanner: noop, runInterstitial: noop,
        runInPagePush: noop, runVideoSlider: noop, runInPageBanner: noop,
      }),
      writable: false,
      configurable: false,
    });
  } catch (e) { /* already defined by a page script that ran first; nothing to do */ }
})();
