'use strict';

// Chrome resolves __MSG_x__ for you in the manifest and in CSS, but not in a
// page's markup — every extension has to place its own strings. This file is
// that placement, and it is deliberately the whole of it: pages keep their text
// in the HTML where it can be read and reviewed, `_locales/` stays the only
// place a translation lives, and no page has to remember more than one call.
//
// Loaded by the popup, the options page, the setup page and the content
// scripts, so it may not assume a `document` exists yet or that it is alone on
// the page — hence the guard around every global it defines.

(function (root) {
  if (root.PanelFlowI18n) return;

  // The languages the extension is translated into, in the order the settings
  // page offers them, each named in itself — a picker that says "French" to
  // someone who cannot read English has not helped them. `_locales/` is the
  // source of truth for what exists; options-page.test.js holds this list to it.
  const LANGS = [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
  ];

  // The language the reader chose, when they chose one.
  //
  // chrome.i18n answers in the browser's language and offers no way to ask for
  // another — which is not the same question. Someone reading French scans on a
  // machine that boots in English is not asking for an English extension. So a
  // chosen language is carried as a plain key→message map in storage, consulted
  // ahead of Chrome; background.js is what puts it there, because `_locales` is
  // a reserved directory and only the worker can read out of it.
  let over = null;
  let chosen = null;

  async function reload() {
    try {
      const v = await root.chrome.storage.local.get(['uiLang', 'uiMessages']);
      chosen = v.uiLang || null;
      over = (chosen && v.uiMessages) || null;
    } catch {
      // No storage in this context, or none written yet. The browser's own
      // language is the answer, and it is the right one for most readers.
      chosen = null;
      over = null;
    }
    return chosen;
  }

  // Started at load, awaited by whatever draws: the map has to be in hand
  // before the first label is written, or the page paints in one language and
  // corrects itself in another.
  const ready = reload();

  /** Fills $1…$9 the way chrome.i18n would, for messages Chrome never saw. */
  const fill = (message, subs) => {
    const list = subs === undefined || subs === null ? [] : [].concat(subs);
    return message.replace(/\$([1-9])/g, (whole, n) => {
      const sub = list[Number(n) - 1];
      return sub === undefined ? whole : String(sub);
    });
  };

  /**
   * A message by key. `subs` fills the $1…$9 placeholders declared in
   * messages.json.
   *
   * An empty answer means the key is missing from the user's locale AND from
   * the default one — Chrome falls back to the default on its own, so there is
   * no other way to get nothing. Returning the key makes that a label reading
   * `popup_openApp` instead of a blank row: visible, greppable, and impossible
   * to ship without noticing.
   */
  function t(key, subs) {
    // A key the chosen language happens to be missing falls through to Chrome
    // rather than to the key: one untranslated sentence beats a raw identifier.
    const own = over && over[key];
    if (own) return fill(own, subs);
    try {
      return root.chrome?.i18n?.getMessage(key, subs) || key;
    } catch {
      return key;
    }
  }

  // The attributes worth translating, as [markup annotation, dataset key,
  // attribute written]. textContent is the common case and has no entry here.
  const ATTRS = [
    ['data-i18n-title', 'i18nTitle', 'title'],
    ['data-i18n-placeholder', 'i18nPlaceholder', 'placeholder'],
    ['data-i18n-aria-label', 'i18nAriaLabel', 'aria-label'],
    ['data-i18n-alt', 'i18nAlt', 'alt'],
  ];

  /**
   * Fills every annotated node under `scope`. Safe to call again on a subtree
   * built later — panels that are drawn on demand call it on their own root.
   *
   * `data-i18n-html` exists for the few sentences that carry markup of their
   * own (a <kbd> around a shortcut, mostly). The alternative — splitting the
   * sentence into a before-part and an after-part — would pin the shortcut to
   * the middle of the sentence in every language, which is exactly the kind of
   * assumption translation is supposed to remove. The strings come from the
   * extension's own bundled locale files and never from a page, a server or a
   * user, so there is nothing here for innerHTML to be tricked by.
   */
  function apply(scope) {
    const el = scope || (typeof document !== 'undefined' ? document : null);
    if (!el || !el.querySelectorAll) return;
    for (const node of el.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of el.querySelectorAll('[data-i18n-html]')) {
      node.innerHTML = t(node.dataset.i18nHtml);
    }
    for (const [selector, key, attr] of ATTRS) {
      for (const node of el.querySelectorAll(`[${selector}]`)) {
        node.setAttribute(attr, t(node.dataset[key]));
      }
    }
  }

  /**
   * Marks the document as being in the language it is actually showing, which
   * is what makes a screen reader pronounce it and the browser hyphenate it
   * correctly. Only for the extension's own pages — a content script must not
   * relabel the site it was injected into.
   */
  function markLanguage() {
    try {
      const lang = chosen || root.chrome?.i18n?.getUILanguage?.();
      if (lang && typeof document !== 'undefined') document.documentElement.lang = lang;
    } catch { /* not our page to label */ }
  }

  root.PanelFlowI18n = { t, apply, markLanguage, reload, ready, LANGS };
  // Bare `t` as well: the files below call it a few hundred times between them
  // and PanelFlowI18n.t at every call site would drown the strings it wraps.
  if (!root.t) root.t = t;
}(typeof self !== 'undefined' ? self : this));
