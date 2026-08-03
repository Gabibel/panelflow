// `chrome.*` for pages that are not in Chrome.
//
// The detection engine, the reader and the add-to-library modal are the same
// files the extension ships (`extension/content/*.js`), injected verbatim into
// the in-app browser. They touch exactly five Chrome APIs; this file provides
// those five over the native bridge, and nothing else. Keeping the shim this
// small is deliberate — the moment it starts emulating Chrome broadly, the
// mobile behaviour and the extension behaviour drift.
//
// Must be injected BEFORE detect.js / reader.js / library-modal.js.
(function () {
  'use strict';
  if (window.chrome && window.chrome.runtime && window.chrome.runtime.__panelflowShim) return;

  let nextId = 1;
  const pending = new Map();

  const transport = (() => {
    if (window.PanelFlowNative && window.PanelFlowNative.post) {
      return (s) => window.PanelFlowNative.post(s);
    }
    if (window.webkit && window.webkit.messageHandlers &&
        window.webkit.messageHandlers.panelflow) {
      return (s) => window.webkit.messageHandlers.panelflow.postMessage(s);
    }
    return null;
  })();

  function request(msg) {
    return new Promise((resolve) => {
      if (!transport) return resolve(undefined);
      const id = nextId++;
      // Resolving with `undefined` on timeout rather than rejecting: that is
      // what a Chrome content script sees when the worker is gone, and the
      // callers already handle it (they check chrome.runtime.lastError).
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve(undefined);
      }, 45000);
      pending.set(id, { resolve, timer });
      transport(JSON.stringify({ id, msg }));
    });
  }

  const pageListeners = [];

  const runtime = {
    __panelflowShim: true,
    // Chrome sets `lastError` only inside a failed callback. Nothing in the
    // content scripts writes it, and they only ever read it to detect a dead
    // worker, so a permanent null is honest here.
    lastError: null,
    id: 'panelflow-mobile',
    sendMessage(msg, callback) {
      const p = request(msg);
      if (typeof callback === 'function') { p.then(callback); return undefined; }
      return p;
    },
    onMessage: {
      addListener: (fn) => pageListeners.push(fn),
      removeListener: (fn) => {
        const i = pageListeners.indexOf(fn);
        if (i !== -1) pageListeners.splice(i, 1);
      },
    },
  };

  // The content scripts use chrome.storage.local only for reader preferences
  // and the auto-open-per-site settings; it lands in the same store the rest of
  // the app uses, so a preference set in the reader is visible to the shell.
  const storage = {
    local: {
      get(keys, callback) {
        const p = request({ type: 'storageGet', keys: keys ?? null })
          .then((r) => (r && r.values) || {});
        if (typeof callback === 'function') { p.then(callback); return undefined; }
        return p;
      },
      set(obj, callback) {
        const p = request({ type: 'storageSet', values: obj }).then(() => undefined);
        if (typeof callback === 'function') { p.then(callback); return undefined; }
        return p;
      },
      remove(keys, callback) {
        const p = request({ type: 'storageRemove', keys }).then(() => undefined);
        if (typeof callback === 'function') { p.then(callback); return undefined; }
        return p;
      },
    },
  };

  window.chrome = Object.assign(window.chrome || {}, { runtime, storage });

  /**
   * Native's handle on this page. `deliver` completes a pending sendMessage;
   * `dispatch` is how the browser toolbar's buttons reach the content scripts —
   * it stands in for the extension popup sending `toggleReader`,
   * `openLibraryModal` or `getSeriesMeta` to the active tab.
   */
  window.PanelFlowPage = {
    deliver(id, body) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(typeof body === 'string' ? safeParse(body) : body);
    },
    dispatch(msg, replyId) {
      const parsed = typeof msg === 'string' ? safeParse(msg) : msg;
      let answered = false;
      const respond = (r) => {
        if (answered) return;
        answered = true;
        if (replyId != null && transport) {
          transport(JSON.stringify({ reply: { id: replyId, body: r ?? null } }));
        }
      };
      for (const fn of pageListeners.slice()) {
        try { fn(parsed, {}, respond); } catch (e) { console.warn('page listener failed', e); }
      }
      return answered;
    },
    // The in-app browser's "is there a chapter here?" indicator, and the source
    // of the compatibility verdict once a page has actually loaded — which
    // beats the markup-only guess the search list showed.
    state() {
      const d = window.__panelflowDetect;
      return {
        url: location.href,
        title: document.title,
        detected: !!(d && d.detection),
        readerOpen: !!(window.PanelFlowReader && window.PanelFlowReader.isOpen &&
          window.PanelFlowReader.isOpen()),
        meta: d && d.detection ? d.seriesMeta() : null,
      };
    },
  };

  const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };
})();
