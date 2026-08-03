// Runs at document_start. Blocks the popup/redirect hijacks common on manga
// aggregator sites: window.open calls not triggered by a real user gesture,
// and programmatic clicks on injected anchors targeting new windows.
(() => {
  'use strict';
  let userGestureUntil = 0;
  const GESTURE_WINDOW_MS = 1000;

  const markGesture = () => { userGestureUntil = Date.now() + GESTURE_WINDOW_MS; };
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
