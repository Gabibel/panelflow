// Which language the website and the phone are speaking, and who decided.
//
// The twin of shared/theme.js, and the same three-step story: paint what this
// device last saw, adopt the account's answer when it arrives, remember it so
// the flip happens once. `uiLang` is an account preference (shared/prefs.js),
// so choosing French on the phone has to reach the desktop — and choosing it on
// the website has to reach the website, which for a long time it did not: the
// select forwarded the answer to the extension and this page stayed English.
//
// Loaded from <head> and deliberately not deferred, next to the catalogue it
// reads. Both are synchronous on purpose: `apply()` runs against markup that
// ships empty, so anything asynchronous here is a page that draws blank labels
// first and fills them in afterwards.
//
// This is not extension/i18n.js and cannot be. That one asks Chrome for the UI
// locale, keeps the reader's override in chrome.storage, and reads `_locales`
// out of a directory no page is allowed to fetch from — three things that only
// exist inside an extension. What the two share is the answer to "what does
// this key say", the annotations below, and the file the sentences come from.
(() => {
  const root = globalThis;
  if (root.PanelFlowI18n) return;

  // Same key on every surface of this origin: the website's settings page and
  // whatever else it grows agree without anyone syncing them, exactly the way
  // `pf-theme` does. Different origins agree through the account instead.
  const KEY = 'pf-lang';

  /** What the settings control offers, beside "follow the browser". */
  const LANGS = [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
  ];

  const MESSAGES = root.PanelFlowMessages || {};
  const DEFAULT = 'en';

  // Storage throws rather than returning null when a browser is set to refuse
  // it, and a page that will not draw its own labels because it could not read
  // a preference is a worse failure than a page in the wrong language.
  const stored = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };

  /** 'auto' resolved against the browser; anything unknown falls back to en. */
  const resolve = (choice) => {
    if (LANGS.some((l) => l.code === choice)) return choice;
    const asked = [
      ...(navigator.languages || []),
      navigator.language || '',
    ].map((tag) => String(tag).toLowerCase().split('-')[0]);
    return asked.find((code) => LANGS.some((l) => l.code === code)) || DEFAULT;
  };

  let lang = resolve(stored());

  /** `$1`…`$9`, filled from the call site. */
  const fill = (message, subs) =>
    (subs ? message.replace(/\$([1-9])/g, (whole, n) => subs[n - 1] ?? whole) : message);

  /**
   * What a key says, in the language now showing.
   *
   * Falls through to English rather than to nothing: a key a translator has not
   * reached yet is an English sentence, which is readable, where the honest
   * "there is no translation" answer is a blank label. The key itself is the
   * last resort, and seeing one on screen means the locale files and the source
   * have drifted — which backend/test/i18n.test.js exists to catch first.
   */
  const t = (key, subs) => {
    const said = MESSAGES[lang]?.[key] ?? MESSAGES[DEFAULT]?.[key];
    return said === undefined ? key : fill(said, subs);
  };

  /** Which attribute each annotation fills, and what it is called in dataset. */
  const ATTRS = [
    ['data-i18n-title', 'i18nTitle', 'title'],
    ['data-i18n-placeholder', 'i18nPlaceholder', 'placeholder'],
    ['data-i18n-aria-label', 'i18nAriaLabel', 'aria-label'],
    ['data-i18n-alt', 'i18nAlt', 'alt'],
  ];

  /**
   * Fill every annotated node under `scope`.
   *
   * The same annotations the extension's pages use, so a string moved between
   * the two surfaces moves as markup rather than being rewritten. `-html` is
   * for the handful of sentences with a <kbd> or a <code> inside them; every
   * other node gets text, because a sentence going through innerHTML is a
   * sentence a translation could put a tag in.
   */
  const apply = (scope = document) => {
    for (const el of scope.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of scope.querySelectorAll('[data-i18n-html]')) {
      el.innerHTML = t(el.dataset.i18nHtml);
    }
    for (const [selector, prop, attr] of ATTRS) {
      for (const el of scope.querySelectorAll(`[${selector}]`)) {
        el.setAttribute(attr, t(el.dataset[prop]));
      }
    }
  };

  /**
   * Tell the page itself which language it is in.
   *
   * `<html lang>` is what a screen reader picks a voice from and what a browser
   * offers to translate against, and the markup ships `lang="en"` because the
   * untranslated sentences in it are English.
   */
  const markLanguage = () => { document.documentElement.lang = lang; };

  /** 'auto' removes the key: no choice recorded is not the same as English. */
  const write = (value) => {
    try {
      if (!value || value === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
    } catch { /* the language still changes for this page */ }
    lang = resolve(value);
  };

  root.PanelFlowI18n = {
    LANGS,
    /** The code actually showing — always one of LANGS. */
    lang: () => lang,
    /** What the settings control should be showing, including 'auto'. */
    get: () => stored() || 'auto',
    /**
     * The reader chose, here, now. Returns whether the sentences moved.
     *
     * "Follow the browser" on a French browser and "Français" resolve to the
     * same language, so the caller is told nothing changed and redraws nothing
     * — but the choice is still recorded, because the next browser it syncs to
     * may not be French.
     */
    set: (value) => {
      const was = lang;
      write(value);
      if (lang === was) return false;
      apply();
      markLanguage();
      return true;
    },
    /**
     * The account's answer, which arrived after this page was painted.
     *
     * Same contract as panelflowTheme.adopt: absent means the account has no
     * opinion, matching means there is nothing to do, and the write is the
     * point — it is what makes the flip happen once, on the first load on a new
     * device, and never again.
     */
    adopt: (value) => {
      if (value == null) return false;
      if (value === (stored() || 'auto')) return false;
      return root.PanelFlowI18n.set(value);
    },
    t,
    apply,
    markLanguage,
  };

  // The bare name, because `t('key')` is what the call sites read like and a
  // page full of `PanelFlowI18n.t(...)` is a page nobody wants to write.
  root.t = t;

  markLanguage();
})();
