// The transport the other injected scripts expect, spelt for react-native-webview.
//
// `chrome-shim.js` and `report-failure.js` look for one of two things on the
// page: Android's `PanelFlowNative.post` (an `@JavascriptInterface`) or iOS's
// `webkit.messageHandlers.panelflow` (a `WKScriptMessageHandler`). A WebView
// driven from React Native offers neither — it offers
// `ReactNativeWebView.postMessage`, on both platforms. So this file provides the
// Android-shaped name over that one channel, and every script after it runs
// unchanged, exactly as it does in the extension and in the two native shells.
//
// First in the injection set, before anything that might want to speak.
(function () {
  'use strict';
  if (window.PanelFlowNative && window.PanelFlowNative.post) return;

  // Messages sent before the host is ready would otherwise be dropped in
  // silence. It is a small window — `ReactNativeWebView` is installed with the
  // page — but a lost `pageDetected` is a reader pill that never appears, and
  // the failure would look like a detection bug rather than a timing one.
  const queued = [];

  function flush() {
    if (!window.ReactNativeWebView) return false;
    while (queued.length) window.ReactNativeWebView.postMessage(queued.shift());
    return true;
  }

  window.PanelFlowNative = {
    post(payload) {
      queued.push(String(payload));
      if (flush()) return;
      // Poll rather than wait on an event: there is no event for this, and the
      // alternative — losing the message — is worse than a handful of ticks.
      let tries = 0;
      const timer = setInterval(() => {
        if (flush() || ++tries > 100) clearInterval(timer);
      }, 50);
    },
  };
})();
