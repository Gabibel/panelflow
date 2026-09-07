// `t()` for pages that are not in Chrome.
//
// The second mobile-specific file in the injection set, and it exists for the
// same reason chrome-shim.js does: the extension's manifest injects
// `extension/i18n.js` ahead of detect.js, library-modal.js and reader.js, which
// call `t()` a hundred and twenty-eight times between them. That file asks
// `chrome.i18n` — an API no WebView has — so on a phone `t` was simply not
// defined, and the first label any of those three tried to draw threw.
//
// The consequence was invisible and total: detect.js loaded fine and then died
// on `t('pillReaderMode')`, so no Reader Mode pill ever appeared; reader.js and
// library-modal.js died the same way at their first label, so "Read" and "Add
// to library" did nothing at all. Nothing in the log said "translation",
// because nothing was missing at load time.
//
// So this is the placement, and only the placement. The sentences themselves
// are `messages.js`, generated from `shared/_locales/` by
// scripts/build-messages.mjs — the same catalogue the website and the app shell
// read. Injected immediately before it, and before anything that speaks.
(function (root) {
  'use strict';
  if (root.PanelFlowI18n) return;

  const MESSAGES = root.PanelFlowMessages || {};
  const DEFAULT = 'en';
  const LANGS = [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
  ];

  const known = (code) => LANGS.some((l) => l.code === code);

  /**
   * The language, in three tries, cheapest first.
   *
   * 1. `PanelFlowLang`, which a shell that already knows the answer sets on the
   *    page before this file runs. React Native does: it holds the account's
   *    language in its own process and can spell it into the injection.
   * 2. the device's, which is right for most readers and is what the extension
   *    falls back to as well.
   * 3. English.
   *
   * Then `ready` below corrects it from the account, for the shells that cannot
   * do (1) — Kotlin and Swift keep the store in a WebView they cannot read
   * synchronously.
   */
  function initial() {
    if (known(root.PanelFlowLang)) return root.PanelFlowLang;
    const tags = []
      .concat(root.navigator?.languages || [], root.navigator?.language || [])
      .map((tag) => String(tag).toLowerCase().split('-')[0]);
    return tags.find(known) || DEFAULT;
  }

  let lang = initial();

  /** `$1`…`$9`, filled from the call site — chrome.i18n's own convention. */
  const fill = (message, subs) => {
    const list = subs === undefined || subs === null ? [] : [].concat(subs);
    return message.replace(/\$([1-9])/g, (whole, n) => {
      const sub = list[Number(n) - 1];
      return sub === undefined ? whole : String(sub);
    });
  };

  /**
   * A message by key.
   *
   * Falls through to English rather than to nothing — a key a translator has
   * not reached yet is a readable sentence, where the honest answer is a blank
   * label. The key itself is the last resort, and seeing `pillReaderMode` on a
   * page means the catalogue and the source have drifted.
   */
  function t(key, subs) {
    const said = (MESSAGES[lang] && MESSAGES[lang][key]) ||
      (MESSAGES[DEFAULT] && MESSAGES[DEFAULT][key]);
    return said === undefined ? key : fill(said, subs);
  }

  /**
   * The account's answer, once the shell can be asked for it.
   *
   * reader.js awaits this before it draws (`await PanelFlowI18n.ready`), which
   * is exactly why the extension's version exposes it: the alternative is a
   * panel painted in one language and corrected in another.
   *
   * `chrome.storage.local` here is chrome-shim.js, which routes to the same
   * store the app shell reads — so the language chosen on the website reaches a
   * chapter page on the phone without anything being told twice.
   */
  const ready = new Promise((resolve) => {
    try {
      root.chrome.storage.local.get(['accountPrefs'], (values) => {
        const chosen = values && values.accountPrefs && values.accountPrefs.uiLang;
        if (known(chosen)) lang = chosen;
        resolve(lang);
      });
    } catch {
      // No shim on this page, or no answer. What the device said stands.
      resolve(lang);
    }
  });

  // Deliberately no `apply()` and no `markLanguage()`. Both belong to a page of
  // our own: this file runs inside somebody else's site, where there is no
  // annotated markup to fill and where relabelling `<html lang>` would be a
  // content script rewriting the document it was lent.
  root.PanelFlowI18n = { t, ready, LANGS };

  // The bare name, because the three files below call it hundreds of times and
  // `PanelFlowI18n.t(...)` at every call site would drown the strings it wraps.
  if (!root.t) root.t = t;
})(typeof globalThis !== 'undefined' ? globalThis : self);
