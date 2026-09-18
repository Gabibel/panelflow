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
    // Three, and no right-to-left pair. Those two modes were a second way to
    // say what `invertTap` in the reader already says — which side of the
    // screen moves forward — plus a page order for the rare chapter laid out
    // backwards on purpose. A stored 'rtl' from before this is not on the list,
    // so `clean` drops it and the fallback stands: vertical, the one mode that
    // cannot be backwards.
    readerMode: { of: ['vertical', 'ltr', 'spread'], fallback: 'vertical' },
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

  // --- where each setting lives on a device, and which answer wins ---------
  //
  // A settings screen draws one flat object and writes one flat patch. Behind
  // that object are three homes, and the order they are read in is the whole
  // of what makes signing in on a device that already has settings safe:
  //
  //   the account   what follows the reader between devices: the keys above.
  //                 Holds only the questions that have been answered.
  //   this device   what the injected reader reads on a page: `readerMode`,
  //                 `readerPrefs`, `autoShowDefault`. The reader never sees the
  //                 account; it looks these up in the device's store.
  //   the install   `settings` in the core: the backend URL, the check
  //                 interval, the ad-block whitelist. `backendUrl` is never on
  //                 the account, because it is the address of the server the
  //                 account is on.
  //
  // The account's answer wins where it has one. Where it has none, the key is
  // absent and the device's own answer stands. That is the difference between
  // "this account says the reader is light" and "this account has no opinion",
  // and a first sign-in must never overwrite a device's settings with a shrug.
  //
  // `project` and `split` were, until now, written twice: once in the
  // extension's worker and once in the phone's client, and the phone's copy
  // drifted (it returned the reader's four under a `reader` key while its own
  // screen read them flat; every switch drew as off). One answer here, both
  // surfaces read it, and prefs-view.test.js is the only place the rule is
  // argued about.

  /** The four the injected reader keeps in `readerPrefs`. */
  const READER_KEYS = ['autoNext', 'hideRead', 'tapZones', 'readerDark'];

  const pick = (source, keys) => Object.fromEntries(
    keys.filter((k) => k in (source || {})).map((k) => [k, source[k]]),
  );

  /**
   * Everything a settings screen draws, flat, from the three homes.
   *
   * @param {object} homes
   *   account         the account's stored prefs (answered keys only)
   *   local           the device store: readerMode, readerPrefs, autoShowDefault, uiLang
   *   install         the core's `settings`: checkIntervalMin, whitelist, autoOpenReader
   *   readerDefaults  this surface's own answers for READER_KEYS when nobody has
   *                   one (a phone chains chapters by default; a desktop does not)
   *   autoShow        a surface that does not offer the choice passes its
   *                   answer here and it wins over everything
   * @returns {object} flat: theme (null when the account has no opinion — the
   *   page's own choice stands), uiLang, readerMode, autoShow, the four
   *   READER_KEYS, checkIntervalMin, whitelist
   */
  function project({ account = {}, local = {}, install = {}, readerDefaults = {}, autoShow } = {}) {
    const readerFallbacks = Object.fromEntries(READER_KEYS.map((k) => [k, ACCOUNT_PREFS[k].fallback]));
    return {
      uiLang: account.uiLang ?? local.uiLang ?? ACCOUNT_PREFS.uiLang.fallback,
      theme: account.theme ?? null,
      readerMode: account.readerMode ?? local.readerMode ?? ACCOUNT_PREFS.readerMode.fallback,
      autoShow: autoShow ?? account.autoShow ?? local.autoShowDefault ?? !!install.autoOpenReader,
      ...readerFallbacks,
      ...readerDefaults,
      ...pick(local.readerPrefs, READER_KEYS),
      ...pick(account, READER_KEYS),
      checkIntervalMin: account.checkIntervalMin ?? install.checkIntervalMin
        ?? ACCOUNT_PREFS.checkIntervalMin.fallback,
      whitelist: account.whitelist ?? install.whitelist ?? [],
    };
  }

  /**
   * One flat patch, sorted into the three writes it has to become.
   *
   * @param {object} patch   flat, as `project` returns it
   * @param {object} opts
   *   readerPrefs    the device's current `readerPrefs`, so the merge happens
   *                  here: that object also holds brightness and the reader's
   *                  own state, written from inside the reader, and must be
   *                  merged into, never replaced
   *   pushAutoShow   false on a surface that does not offer the choice, so it
   *                  never pushes its forced answer onto an account the desktop
   *                  shares
   * @returns {{account: object, local: object, settings: object}} each possibly
   *   empty; the caller writes whichever are not
   */
  function split(patch, { readerPrefs = {}, pushAutoShow = true } = {}) {
    const p = patch || {};
    const accountKeys = KEYS.filter((k) => pushAutoShow || k !== 'autoShow');
    const account = pick(p, accountKeys);

    const local = {};
    if ('readerMode' in p) local.readerMode = p.readerMode;
    if (pushAutoShow && 'autoShow' in p) local.autoShowDefault = !!p.autoShow;
    const readerPatch = pick(p, READER_KEYS);
    if (Object.keys(readerPatch).length) local.readerPrefs = { ...readerPrefs, ...readerPatch };

    const settings = {};
    if ('checkIntervalMin' in p) settings.checkIntervalMin = Number(p.checkIntervalMin);
    if ('whitelist' in p) settings.whitelist = p.whitelist;
    if ('backendUrl' in p) settings.backendUrl = p.backendUrl;

    return { account, local, settings };
  }

  const api = {
    ACCOUNT_PREFS, KEYS, READER_KEYS, MAX_HOSTS, cleanHost, clean, withDefaults, project, split,
  };

  // Both faces, for the same reason folders.js has both: the server imports it
  // as a module, three clients load it with a <script> tag.
  root.PanelFlowPrefs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
