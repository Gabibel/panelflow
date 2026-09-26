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

  // The host's own function, taken once and kept. Looked up per message, a
  // page that wrapped `ReactNativeWebView.postMessage` after load would read
  // every request on its way out — the key chrome-shim.js signs them with
  // included. react-native-webview installs it before this script runs.
  let native = null;
  const grab = () => {
    if (!native && window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      native = window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView);
    }
    return native;
  };
  grab();

  function flush() {
    const send = grab();
    if (!send) return false;
    while (queued.length) send(queued.shift());
    return true;
  }

  const bridge = Object.freeze({
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
  });
  // Not replaceable by the page: chrome-shim.js takes `post` from here.
  try {
    Object.defineProperty(window, 'PanelFlowNative', { value: bridge, writable: false, configurable: false });
  } catch {
    // Something got there first. The shim will find no transport and answer
    // nothing, which is the safe way for this to fail.
  }
})();
