// Which of the two palettes in shared/theme.css is showing, and who decided.
//
// Loaded from <head>, *before* the page has a body, and deliberately not
// deferred: the choice has to be on <html> by the time the first pixel is
// painted, or the page shows the wrong theme for a frame and then blinks. That
// is why this reads localStorage rather than chrome.storage — a flash is the
// price of an asynchronous answer, and there is no version of this that is
// worth a flash.
//
// Every extension page is one origin, so the popup, the options page, the
// welcome page and the saved-chapters page share this key and agree without
// anyone syncing anything. The web app and the phone are different origins, and
// what makes them agree is the account, not this file: `adopt` below is how a
// theme chosen on one surface reaches the other two — see shared/prefs.js. What
// is in localStorage is this device's memory of that answer, kept so the page
// can be painted before anyone has been asked anything.
//
// The reader is not covered here. It is injected into someone else's page and
// cannot see this origin's storage at all — extension/content/reader.css
// answers the question itself, from prefers-color-scheme and one pref.
(() => {
  const KEY = 'pf-theme';
  const el = document.documentElement;

  // Storage throws rather than returning null when a browser is set to refuse
  // it, and a page that will not paint because the theme could not be read is
  // a worse failure than a page in the system's theme.
  const stored = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };

  /** 'light' | 'dark' pin the palette; anything else hands it back to the OS. */
  const apply = (value) => {
    if (value === 'light' || value === 'dark') el.dataset.theme = value;
    else delete el.dataset.theme;
  };

  apply(stored());

  /** 'system' removes the key: no choice recorded is not the same as "light". */
  const write = (value) => {
    try {
      if (value === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
    } catch { /* see above — the theme still changes for this page */ }
    apply(value);
  };

  window.panelflowTheme = {
    /** What the settings control should be showing. */
    get: () => stored() || 'system',
    /** The reader chose, here, now. */
    set: write,
    /**
     * The account's answer, which arrived after this page was painted.
     *
     * The theme now follows the account rather than the browser, and the
     * account's answer cannot possibly be here in time: this file runs from
     * <head> so that nothing flashes, and the network has not been asked yet.
     * So the sequence is — paint what this device last saw, then adopt.
     *
     * Writing it to localStorage is the whole point of the second step. It
     * means the flip happens once, on the first load on a new device, and
     * never again: the next cold start already knows. Returning early when it
     * matches keeps that load from touching the DOM at all.
     */
    adopt: (value) => {
      if (value == null) return false;
      const now = stored() || 'system';
      if (value === now) return false;
      write(value);
      return true;
    },
  };
})();
