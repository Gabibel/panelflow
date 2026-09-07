// Ad blocking, from inside the page, because this shell has no way to do it
// from outside.
//
// The other three surfaces block requests before they are made: Chrome compiles
// `shared/adblock-list.json` into a declarativeNetRequest ruleset, iOS into a
// WKContentRuleList, Android matches hostnames in `shouldInterceptRequest`.
// React Native's WebView exposes no subresource hook at all —
// `onShouldStartLoadWithRequest` only sees main-frame navigations — so the only
// place left to stand is the page itself.
//
// That is a weaker position and it is worth being honest about which parts it
// costs: a request this file cannot see is a request it cannot stop. What it
// can do is refuse the three ways a scan site actually loads its advertising —
// a <script> or <iframe> put into the document, a fetch, an XMLHttpRequest —
// and that is most of the weight and nearly all of the latency.
//
// The host list is `shared/adblock-list.json`, the same file the other three
// read, baked in as `PanelFlowBlockedHosts` by scripts/build-native-inject.mjs.
// Editing the list updates four platforms; there is no second list here.
(function () {
  'use strict';
  if (window.__panelflowAdblock) return;
  window.__panelflowAdblock = true;

  const HOSTS = new Set(window.PanelFlowBlockedHosts || []);
  if (!HOSTS.size) return;

  /**
   * Whether a URL belongs to a blocked host.
   *
   * Subdomains count — an entry is a site, and `a.ads.example.com` is that
   * site — but a suffix match alone would also block `notexample.com`, so the
   * dot is required. Anything unparseable (a data: URI, a relative path) is not
   * a third-party request and is left alone.
   */
  function blocked(url) {
    let host;
    try {
      host = new URL(String(url), location.href).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (HOSTS.has(host)) return true;
    for (const h of HOSTS) if (host.endsWith('.' + h)) return true;
    return false;
  }

  // --- what the page asks for itself ----------------------------------------

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const url = (input && input.url) || input;
      if (blocked(url)) {
        // A rejected promise, not a hang: a tracker whose fetch never settles
        // can hold a page's own `Promise.all` open forever, and the site is not
        // ours to freeze.
        return Promise.reject(new TypeError('blocked by PanelFlow'));
      }
      return nativeFetch.call(this, input, init);
    };
  }

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (blocked(url)) {
      // Pointed at nothing rather than thrown: a synchronous throw from `open`
      // lands in the page's own code, and some ad loaders take an exception
      // there as a reason to retry in a loop.
      return open.call(this, method, 'about:blank', ...rest);
    }
    return open.call(this, method, url, ...rest);
  };

  // --- what the page puts into the document ---------------------------------

  const SRC = ['src', 'href', 'data-src'];

  /** The address an element would load, whichever attribute it keeps it in. */
  function addressOf(el) {
    for (const attr of SRC) {
      const value = el.getAttribute && el.getAttribute(attr);
      if (value) return value;
    }
    return null;
  }

  function inspect(node) {
    if (!node || node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag !== 'SCRIPT' && tag !== 'IFRAME' && tag !== 'IMG' && tag !== 'LINK') return;
    const url = addressOf(node);
    if (url && blocked(url)) node.remove();
  }

  // A <script> or <iframe> starts loading when it is inserted, so catching the
  // insertion is catching it before the request. An <img> has usually already
  // started — removing it still stops the decode and the layout, which on a
  // chapter page full of them is the part that is felt.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        inspect(node);
        if (node.querySelectorAll) {
          for (const child of node.querySelectorAll('script,iframe,img,link')) inspect(child);
        }
      }
    }
  });

  observer.observe(document.documentElement || document, { childList: true, subtree: true });
})();
