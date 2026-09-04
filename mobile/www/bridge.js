// The app shell's side of the native bridge.
//
// One channel, one protocol, both platforms: everything goes out as JSON on
// `PanelFlowNative.post` (Android `@JavascriptInterface`) or
// `webkit.messageHandlers.panelflow` (iOS), and comes back through
// `PanelFlowBridge.deliver`. Native answers the handful of messages only it can
// (opening the browser, sharing, haptics) and relays the rest to the offscreen
// worker WebView, which runs the shared store core.
//
// So `PanelFlow.send({ type: 'getLibrary' })` here and
// `chrome.runtime.sendMessage({ type: 'getLibrary' })` in the extension reach
// the same code. That is the point.
(function () {
  'use strict';

  let nextId = 1;
  const pending = new Map();
  const events = new Map(); // event name -> Set<handler>

  const transport = (() => {
    if (window.PanelFlowNative && window.PanelFlowNative.post) {
      return (s) => window.PanelFlowNative.post(s);
    }
    if (window.webkit?.messageHandlers?.panelflow) {
      return (s) => window.webkit.messageHandlers.panelflow.postMessage(s);
    }
    return null; // opened in a plain browser (development)
  })();

  /** Send one message and await native's (or the worker's) reply. */
  function send(msg) {
    if (!transport) return Promise.reject(new Error('no native bridge'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      // A dropped reply must not leave a spinner up forever — surface it.
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${msg.type} timed out`));
      }, 45000);
      pending.set(id, { resolve, reject, timer });
      transport(JSON.stringify({ id, msg }));
    }).then((body) => say(msg, body));
  }

  // The phone's half of what extension/send.js does for the browser: every
  // screen asks through here, so this is the only place that sees every answer.
  // It matters more here than there — a WebView has no console anyone will
  // open, so this line is what a remote-debugged session or a `report-failure`
  // capture has to work from. The reply is passed through untouched.
  function say(msg, body) {
    if (body && body.error) {
      const at = body.failedAt ? ` in ${body.failedAt}` : '';
      const ref = body.ref ? ` ref=${body.ref}` : '';
      console.warn(`[panelflow] ${(msg && msg.type) || 'unknown'} failed${at}${ref}: ${body.error}`);
    }
    return body;
  }

  function on(event, handler) {
    if (!events.has(event)) events.set(event, new Set());
    events.get(event).add(handler);
    return () => events.get(event).delete(handler);
  }

  window.PanelFlowBridge = {
    /** Native → here, with a reply for a pending `send`. */
    deliver(id, body) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(typeof body === 'string' ? safeParse(body) : body);
    },
    /** Native → here, unprompted: 'resumed', 'progress', 'notify', 'ready'. */
    emit(event, payload) {
      for (const h of events.get(event) || []) {
        try { h(typeof payload === 'string' ? safeParse(payload) : payload); }
        catch (e) { console.warn('bridge handler failed', event, e); }
      }
    },
  };

  const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };

  window.PanelFlow = {
    send, on,
    available: !!transport,
    /** Ask native to open a page in the in-app browser (injected reader and all). */
    openUrl: (url, meta) => send({ type: 'openUrl', url, meta: meta ?? null }),
  };
})();
