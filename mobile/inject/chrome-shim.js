// `chrome.*` for pages that are not in Chrome.
//
// The detection engine, the reader, the add-to-library modal and the video
// speed control are the same files the extension ships
// (`extension/content/*.js`), injected verbatim into the in-app browser. They
// touch exactly six Chrome APIs; this file provides those six over the native
// bridge, and nothing else. Keeping the shim this
// small is deliberate — the moment it starts emulating Chrome broadly, the
// mobile behaviour and the extension behaviour drift.
//
// Must be injected BEFORE detect.js / reader.js / library-modal.js.
//
// Two modes. In the Kotlin and Swift shells the shim is published as
// `window.chrome`, as it always was. In the React Native shell it is private:
// that shell wraps every injection in `(function (__pfKey) { … })("<key>")`,
// and when a key is in scope the shim never touches `window.chrome`. The
// content scripts get it from `window.__pfPrivateChrome(key)` — a function
// that answers only the key it was given at document start — and every
// request it sends carries the key, which the shell checks before answering
// (native/src/screens/BrowserScreen.js).
//
// Why: a WebView has no isolated world. A shim on `window` answered the site's
// own scripts — its adverts included — exactly as it answered the reader, and
// a QA pass in September 2026 read the account's e-mail and every bookmark
// from a hostile page, and wrote a series into the synced library, in a few
// lines. The key never appears on `window` or in the DOM; injected source
// cannot be read back by the page.
(function () {
  'use strict';
  // eslint-disable-next-line no-undef
  const KEY = typeof __pfKey === 'string' && __pfKey ? __pfKey : null;
  if (KEY ? typeof window.__pfPrivateChrome === 'function'
    : (window.chrome && window.chrome.runtime && window.chrome.runtime.__panelflowShim)) return;

  /**
   * A property the page can neither replace nor redefine. Defined at document
   * start, before the page's own scripts; if the page somehow got there first,
   * the shim refuses to run rather than hand its answers to whatever it found.
   */
  const lock = (name, value) => {
    try {
      Object.defineProperty(window, name, { value, writable: false, configurable: false, enumerable: false });
      return window[name] === value;
    } catch {
      return false;
    }
  };

  let nextId = 1;
  const pending = new Map();
  // Captured now, not looked up per call: a page that replaced
  // JSON.stringify later would otherwise read every request, key included.
  const stringify = JSON.stringify;

  const transport = (() => {
    if (window.PanelFlowNative && window.PanelFlowNative.post) {
      // The function itself, not the property: a page that swaps
      // `window.PanelFlowNative` later must not receive the requests.
      const post = window.PanelFlowNative.post;
      return (s) => post(s);
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
      transport(stringify(KEY ? { id, msg, k: KEY } : { id, msg }));
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

  /**
   * The sixth `chrome.*` API, and the reason it is here.
   *
   * A content script declared in its own manifest block gets no `t()` — Chrome
   * hands it `chrome.i18n` instead, and `video-speed.js` labels every one of
   * its controls with it. In a WebView `chrome.i18n` is not a shim away from
   * being empty, it is `undefined`, so the first label throws and the whole
   * file dies: the same failure that kept the reader from ever drawing a pill.
   *
   * `globalThis.t` is read at call time, not captured: this file is injected
   * before `i18n.js` (the guard has to be in place before the page's own
   * scripts run) and the translator arrives with the engine afterwards.
   */
  const i18n = {
    getMessage(key, subs) {
      try {
        return globalThis.t ? globalThis.t(key, subs) : '';
      } catch {
        // The caller's own `|| 'Add to library'` is a better answer than a
        // thrown one — that fallback is why these call sites are written the
        // way they are.
        return '';
      }
    },
    getUILanguage: () => (globalThis.PanelFlowLang || 'en'),
  };

  const shim = { runtime, storage, i18n };

  /**
   * Native's handle on this page. `deliver` completes a pending sendMessage;
   * `dispatch` is how the browser toolbar's buttons reach the content scripts —
   * it stands in for the extension popup sending `toggleReader`,
   * `openLibraryModal` or `getSeriesMeta` to the active tab.
   *
   * Keyed in the React Native shell: an answer is only taken from the caller
   * that knows the key, so a page cannot resolve the reader's questions with
   * answers of its own.
   */
  const page = {
    deliver(id, body, key) {
      if (KEY && key !== KEY) return;
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
          transport(stringify({ reply: { id: replyId, body: r ?? null } }));
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

  const parse = JSON.parse;
  const safeParse = (s) => { try { return parse(s); } catch { return s; } };

  if (!KEY) {
    window.chrome = Object.assign(window.chrome || {}, shim);
    window.PanelFlowPage = page;
    return;
  }
  // Both or neither: a page handle without the private shim, or the reverse,
  // is a half-open door. Nothing on `window` is the shim itself.
  if (!lock('PanelFlowPage', Object.freeze(page))) return;
  lock('__pfPrivateChrome', (key) => (key === KEY ? shim : null));
})();
