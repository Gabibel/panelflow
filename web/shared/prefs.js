// What the account remembers, as opposed to what this install remembers.
//
// There are two kinds of setting in PanelFlow and they were the same kind until
// now. `settings` in the core is about *this copy of the software* — chiefly
// `backendUrl`, which cannot possibly live on the account, because it is the
// address of the server the account is on. Everything else on the options page
// is about the person: which way a chapter opens, how dark the app is, what
// language it speaks. Those answers were being asked again on every surface,
// and a reader who set the theme in the extension found the site still light.
//
// So: this file is the list of answers that belong to the reader, with the
// values each one is allowed to take. It is the same file on the server and on
// all three clients (`scripts/sync-shared.mjs`), for the usual reason — a
// second opinion about what `tapZones` may be is how a client starts writing a
// value the server silently drops.
//
// A plain script rather than a module, like series-match.js and folders.js:
// Chrome content scripts cannot be modules, and the server re-exports it
// through backend/src/prefs.js.
(function (root) {
  'use strict';

  /**
   * Every setting the account carries, and what it may be.
   *
   * `of` is an exhaustive list; `bool` is a checkbox; `hosts` is the ad-block
   * whitelist. There is no free text here on purpose — these values are written
   * by one device and handed to another, so anything that is not on a list is a
   * string one client can make another client store.
   */
  const ACCOUNT_PREFS = {
    // The palette. 'system' is a real answer and not the absence of one: it
    // means "ask the machine I am on", which is the right answer for someone
    // who reads on a phone at night and a desk in the morning.
    theme: { of: ['system', 'light', 'dark'], fallback: 'system' },
    uiLang: { of: ['auto', 'en', 'fr'], fallback: 'auto' },
    readerMode: { of: ['vertical', 'ltr', 'rtl', 'spread', 'spread-rtl'], fallback: 'vertical' },
    tapZones: { of: ['sides', 'edges', 'off'], fallback: 'sides' },
    autoShow: { bool: true, fallback: false },
    autoNext: { bool: true, fallback: false },
    hideRead: { bool: true, fallback: false },
    readerDark: { bool: true, fallback: true },
    checkIntervalMin: { of: [60, 180, 360, 720, 1440], number: true, fallback: 360 },
    whitelist: { hosts: true, fallback: [] },
    // The sites picked in the setup tour, and the reason the tour asks. Every
    // surface has a list of domains it knows about and no way to tell which
    // ones this reader actually uses, so all of them show the same alphabet
    // soup — with this, the four sites someone reads on come first, on the
    // phone they were never chosen on. A `hosts` list like the whitelist
    // above, deduped and capped by the same code for the same reason.
    favouriteSites: { hosts: true, fallback: [] },
  };

  const KEYS = Object.keys(ACCOUNT_PREFS);

  // The whitelist is a list you scroll, not a database, and it arrives from one
  // device to be applied on another. Both caps are here so a client bug cannot
  // hand every other device a megabyte of hostnames.
  const MAX_HOSTS = 200;
  const HOST_MAX = 253;  // the length of a fully qualified domain name

  /** A hostname, lowercased and stripped of scheme and path, or null. */
  function cleanHost(value) {
    if (typeof value !== 'string') return null;
    let host = value.trim().toLowerCase();
    if (!host) return null;
    // People paste the address bar. "https://example.com/series/1" is a
    // perfectly clear way of saying example.com, and refusing it teaches
    // nothing — it just makes the box feel broken.
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0].split('?')[0];
    host = host.replace(/^www\./, '').replace(/:\d+$/, '');
    if (!host || host.length > HOST_MAX) return null;
    // No underscore: this is a hostname, not a DNS label in general.
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
      ? host
      : null;
  }

  /**
   * The storable form of one setting, or `undefined` when the value is not one
   * this setting may take.
   */
  function cleanOne(key, value) {
    const spec = ACCOUNT_PREFS[key];
    if (!spec) return undefined;
    if (spec.bool) return typeof value === 'boolean' ? value : undefined;
    if (spec.hosts) {
      if (!Array.isArray(value)) return undefined;
      // Deduped, because two devices editing the same list from either end is
      // exactly how it grows a second copy of every line.
      const hosts = [...new Set(value.map(cleanHost).filter(Boolean))];
      return hosts.slice(0, MAX_HOSTS);
    }
    if (spec.number) {
      const n = Number(value);
      return spec.of.includes(n) ? n : undefined;
    }
    return spec.of.includes(value) ? value : undefined;
  }

  /**
   * A patch as it may be stored, plus a sentence per key that was refused.
   *
   * Unknown keys are dropped rather than refused. A client from a later version
   * will send settings this one has never heard of, and answering 400 to the
   * whole patch would mean an old server rejecting a new phone's theme because
   * the same request also carried something else.
   */
  function clean(patch) {
    const prefs = {};
    const errors = [];
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in ACCOUNT_PREFS)) continue;
      const cleaned = cleanOne(key, value);
      if (cleaned === undefined) {
        const spec = ACCOUNT_PREFS[key];
        errors.push(spec.of
          ? `${key} must be one of ${spec.of.join(', ')}`
          : `${key} must be ${spec.bool ? 'true or false' : 'a list of hostnames'}`);
      } else {
        prefs[key] = cleaned;
      }
    }
    return { prefs, errors };
  }

  /**
   * What every setting is, for a reader whose account has never been asked.
   *
   * Stored prefs hold only the questions that have actually been answered — the
   * difference between "this account says the reader is light" and "this
   * account has no opinion" is the whole of what makes signing in on a device
   * that already has settings safe. So this is for drawing a control, and never
   * for deciding whether the account has something to say.
   */
  function withDefaults(stored) {
    const out = {};
    for (const key of KEYS) out[key] = ACCOUNT_PREFS[key].fallback;
    return { ...out, ...(clean(stored).prefs) };
  }

  const api = { ACCOUNT_PREFS, KEYS, MAX_HOSTS, cleanHost, clean, withDefaults };

  // Both faces, for the same reason folders.js has both: the server imports it
  // as a module, three clients load it with a <script> tag.
  root.PanelFlowPrefs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
