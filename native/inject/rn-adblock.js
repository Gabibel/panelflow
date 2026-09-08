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
// The list is `shared/adblock-list.json`, the same file the other three read,
// baked in by scripts/build-native-inject.mjs. There is no second list here.
(function () {
  'use strict';
  if (window.__panelflowAdblock) return;
  window.__panelflowAdblock = true;

  const HOSTS = new Set(window.PanelFlowBlockedHosts || []);

  /**
   * The hosts whose *images* may also be refused, and why that is a separate
   * list rather than a rule.
   *
   * 47 of the 72 entries carry `images: false`, which the Chrome ruleset spells
   * as a shorter `resourceTypes` and Safari as `load-type`. It means: block this
   * host's scripts and frames, never its pictures. A blocker that ignores it
   * takes the panels out of chapters served from a CDN that happens to sit
   * under a domain on the list — the reader then finds no strip, decides the
   * page must be prose, and opens a manga chapter as text. That is not a
   * hypothetical; it is what this file did before it read this column.
   */
  const IMAGE_HOSTS = new Set(window.PanelFlowBlockedImageHosts || []);

  /**
   * A site the reader asked us to leave alone.
   *
   * Whitelisting is an account setting (`shared/prefs.js`), and it means "stop
   * blocking here" — the whole page, not just its own assets. So this file
   * stands down entirely rather than filtering what it stands down on.
   */
  const whitelisted = (window.PanelFlowAdblockWhitelist || []).some((host) => {
    const here = location.hostname.toLowerCase();
    return here === host || here.endsWith('.' + host);
  });

  if (!HOSTS.size || whitelisted) return;

  /**
   * Whether a URL belongs to a blocked host, for a given kind of request.
   *
   * Subdomains count — an entry is a site, and `a.ads.example.com` is that
   * site — but a suffix match alone would also block `notexample.com`, so the
   * dot is required. Anything unparseable (a data: URI, a relative path) is not
   * a third-party request and is left alone.
   */
  function blocked(url, images) {
    let host;
    try {
      host = new URL(String(url), location.href).hostname.toLowerCase();
    } catch {
      return false;
    }
    const list = images ? IMAGE_HOSTS : HOSTS;
    if (list.has(host)) return true;
    for (const h of list) if (host.endsWith('.' + h)) return true;
    return false;
  }

  // --- what the page asks for itself ----------------------------------------

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const url = (input && input.url) || input;
      if (blocked(url, false)) {
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
    if (blocked(url, false)) {
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
    // An <img> is judged against the shorter list, and a chapter's panels are
    // why. Everything else is judged against the whole one.
    if (url && blocked(url, tag === 'IMG')) node.remove();
  }

  // A <script> or <iframe> starts loading when it is inserted, so catching the
  // insertion is catching it before the request.
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
