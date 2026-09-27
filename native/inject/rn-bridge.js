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

  // Taken at document start, before the page has run a line: everything a
  // signed request passes through on its way out is used from here, never
  // looked up again. A page that wrapped Array.prototype.push, String or
  // Function.prototype.bind later would otherwise be handed each request, key
  // included (QA re-test It.5, N-B6).
  const apply = Reflect.apply;
  const every = setInterval;
  const stop = clearInterval;

  // Messages sent before the host is ready would otherwise be dropped in
  // silence. It is a small window — `ReactNativeWebView` is installed with the
  // page — but a lost `pageDetected` is a reader pill that never appears, and
  // the failure would look like a detection bug rather than a timing one.
  // No prototype, and written by index: no push or shift for a page to wrap.
  const queued = [];
  Object.setPrototypeOf(queued, null);

  // The host's own function, taken once and kept. Looked up per message, a
  // page that wrapped `ReactNativeWebView.postMessage` after load would read
  // every request on its way out — the key chrome-shim.js signs them with
  // included. react-native-webview installs it before this script runs; the
  // later look, for a host that has not, is a fallback the store app never
  // takes on iOS, where the host's script is added ahead of this one.
  let native = null;
  const grab = () => {
    if (native) return native;
    const host = window.ReactNativeWebView;
    const post = host && host.postMessage;
    if (typeof post === 'function') native = (s) => apply(post, host, [s]);
    return native;
  };
  grab();

  function flush() {
    const send = grab();
    if (!send) return false;
    for (let i = 0; i < queued.length; i++) {
      const s = queued[i];
      queued[i] = null;
      send(s);
    }
    queued.length = 0;
    return true;
  }

  const bridge = Object.freeze({
    post(payload) {
      // Already text: the shim and the failure reporter both send strings,
      // and converting anything else would call a method the page can own.
      if (typeof payload !== 'string') return;
      queued[queued.length] = payload;
      if (flush()) return;
      // Poll rather than wait on an event: there is no event for this, and the
      // alternative — losing the message — is worse than a handful of ticks.
      let tries = 0;
      const timer = every(() => {
        if (flush() || ++tries > 100) stop(timer);
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
