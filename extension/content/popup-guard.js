// Runs at document_start. Blocks the popup/redirect hijacks common on manga
// aggregator sites: window.open calls not triggered by a real user gesture,
// and programmatic clicks on injected anchors targeting new windows.
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

  const nativeOpen = window.open;
  window.open = function (...args) {
    if (Date.now() > userGestureUntil) {
      console.debug('[PanelFlow] blocked window.open without user gesture:', args[0]);
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
})();
