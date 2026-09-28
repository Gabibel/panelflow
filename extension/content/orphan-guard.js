'use strict';

// What is left in a page after the extension is reloaded or updated.
//
// Chrome does not take a content script out of the tabs it is already in when
// the extension behind it goes away: reloading PanelFlow from chrome://extensions,
// installing a new build, or Chrome updating it leaves every open reading tab
// with the old copy still running. That copy has nothing behind it any more,
// and every chrome.* call it makes throws "Extension context invalidated" —
// from a scroll that saves progress, a page mutation that re-runs the detector,
// the website asking for its settings. Each throw is an uncaught error, listed
// on chrome://extensions under the extension's name (owner's QA, September
// 2026), for something that is not a fault and that a reload of the tab ends.
//
// So this runs first in each group of content scripts, in the isolated world
// they share, and wraps the few calls they make. While the extension is there
// the calls go through untouched. Once it is gone they do nothing: a callback
// is not called and a promise never settles, so the old copy simply goes quiet
// instead of carrying on with answers it never got. The fresh copy that the
// next page load brings has a fresh `chrome` and is not affected.
//
// Not in the phone app: its `chrome` is a shim (mobile/inject/chrome-shim.js)
// that has an id for as long as the page exists, and there is no reload to
// outlive. Not in popup-guard.js either, which runs in the page's own world,
// where there is no `chrome.runtime` to guard.
(() => {
  if (typeof chrome === 'undefined' || !chrome.runtime || chrome.runtime.__panelflowShim) return;
  if (chrome.runtime.__panelflowGuarded) return;

  /** Whether the extension this copy belongs to is still installed and running. */
  const alive = () => {
    try { return !!chrome.runtime.id; } catch { return false; }
  };

  const wrap = (owner, name, gone) => {
    const real = owner && owner[name];
    if (typeof real !== 'function') return;
    owner[name] = function guarded(...args) {
      if (!alive()) return gone(args);
      try {
        return real.apply(this, args);
      } catch (err) {
        // Gone between the check and the call: the same quiet answer. Any other
        // failure is a real one and is left to the caller.
        if (!alive()) return gone(args);
        throw err;
      }
    };
  };

  // A call made with a callback returns nothing and never calls back; one made
  // without gets a promise that never settles. Either way the code waiting on
  // it stops where it is, rather than reading `undefined` as an answer.
  const silent = (args) => (typeof args[args.length - 1] === 'function'
    ? undefined
    : new Promise(() => {}));

  wrap(chrome.runtime, 'sendMessage', silent);
  wrap(chrome.runtime, 'getURL', () => '');
  wrap(chrome.i18n, 'getMessage', () => '');
  if (chrome.storage) {
    // `local` is the only area a content script uses.
    for (const name of ['get', 'set', 'remove']) wrap(chrome.storage.local, name, silent);
    if (chrome.storage.onChanged) wrap(chrome.storage.onChanged, 'addListener', () => undefined);
  }
  try {
    Object.defineProperty(chrome.runtime, '__panelflowGuarded', { value: true });
  } catch { /* the guard is in place either way */ }
})();
