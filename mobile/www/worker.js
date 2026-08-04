// Boots the shared store core inside the offscreen worker WebView and wires it
// to the native shell.
//
// Storage is this WebView's own localStorage. That looks casual for a library
// the user cares about, but the WebView data store is app-private, survives
// updates, and is backed up with the app on both platforms — and crucially it
// keeps the store on the same side of the bridge as the code that mutates it.
// Round-tripping every read through native would make a merge a dozen async
// hops and give the two platforms two different failure modes.
(function () {
  'use strict';

  const KEY_PREFIX = 'pf:';

  const storage = {
    async get(keys) {
      const list = keys === null || keys === undefined
        ? Object.keys(localStorage).filter((k) => k.startsWith(KEY_PREFIX))
          .map((k) => k.slice(KEY_PREFIX.length))
        : (Array.isArray(keys) ? keys : [keys]);
      const out = {};
      for (const k of list) {
        const raw = localStorage.getItem(KEY_PREFIX + k);
        if (raw === null) continue;
        try { out[k] = JSON.parse(raw); } catch { /* corrupt key: treat as unset */ }
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) localStorage.removeItem(KEY_PREFIX + k);
        else localStorage.setItem(KEY_PREFIX + k, JSON.stringify(v));
      }
    },
  };

  // Whatever the shell was built against, passed in on the worker's own URL so
  // both platforms can set it without editing a shared file. It is only a
  // *default*: once the user points the app at their own server, `setSettings`
  // stores that and it wins on every later launch.
  const defaults = {
    backendUrl: new URLSearchParams(location.search).get('backend') ||
      (typeof PANELFLOW_BACKEND === 'string' && PANELFLOW_BACKEND) ||
      'https://panelflow-backend.vercel.app',
  };

  const post = (payload) => {
    const s = JSON.stringify(payload);
    if (window.PanelFlowNative && window.PanelFlowNative.post) window.PanelFlowNative.post(s);
    else if (window.webkit?.messageHandlers?.panelflow) {
      window.webkit.messageHandlers.panelflow.postMessage(s);
    }
  };

  const core = globalThis.PanelFlowCore.createCore({
    storage,
    fetch: (...args) => fetch(...args),
    defaults,
    // Notifications are the one thing a WebView genuinely cannot do, so this is
    // handed to native, which owns the OS permission.
    notify: (n) => post({ event: 'notify', notification: n }),
  });

  // Saved chapters. Not localStorage: a chapter is tens of megabytes of image,
  // and localStorage is a string store with a quota measured in single digits.
  // This WebView's IndexedDB is app-private in exactly the same way, and it is
  // the same origin the injected reader's save messages arrive on.
  const offline = globalThis.PanelFlowOffline.createOfflineStore(
    globalThis.PanelFlowOffline.idbBackend(indexedDB),
  );

  const hub = globalThis.PanelFlowCore.createHub(core, {
    ...globalThis.PanelFlowOffline.offlineMessages(offline),
    // The injected content scripts read and write chrome.storage.local for
    // reader preferences and per-site auto-open. They land in the same store
    // the shell uses, so a preference set in the reader is visible everywhere.
    storageGet: async (msg) => ({ values: await storage.get(msg.keys ?? null) }),
    storageSet: async (msg) => { await storage.set(msg.values || {}); return { ok: true }; },
    storageRemove: async (msg) => {
      const keys = Array.isArray(msg.keys) ? msg.keys : [msg.keys];
      await storage.set(Object.fromEntries(keys.map((k) => [k, undefined])));
      return { ok: true };
    },
    // Compatibility can also be judged locally, without spending a server
    // round-trip, when the caller already has the markup (the browser WebView
    // hands over the page it just loaded).
    compatHtml: async (msg) => ({
      ...globalThis.PanelFlowCompat.analyze(msg.html || '', msg.url || '',
        { domains: (await core.getRules())?.domains || {} }),
      url: msg.url || '',
    }),
  });

  /**
   * Native calls this with a request id and the message. The reply goes back
   * over the same `post` channel, tagged with the id, and native routes it to
   * whichever WebView asked.
   */
  window.PanelFlowWorker = {
    async handle(id, json) {
      let reply;
      try {
        reply = await hub(typeof json === 'string' ? JSON.parse(json) : json);
      } catch (e) {
        reply = { error: String((e && e.message) || e) };
      }
      post({ reply: { id, body: reply } });
    },
    /** Native's startup hook: settle the local store against the account. */
    async boot() {
      await core.dedupeLibrary().catch(() => {});
      await core.pullLibrary().catch(() => {});
      await core.syncAll().catch(() => {});
      post({ event: 'ready' });
    },
  };

  post({ event: 'loaded' });
})();
