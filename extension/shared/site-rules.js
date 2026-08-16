// Which reader built this page, and what does that reader call things?
//
// The generic heuristics — `extension/content/detect.js` on a live DOM,
// `shared/compat.js` on raw markup — work on a site nobody has ever seen, and
// they are what carries most of the web. What they cannot do is disagree with
// the page: image clustering picks the container holding the most panels, and on
// a page whose "you may also like" strip is bigger than the chapter, that is the
// wrong container. A per-site rule settles it.
//
// The obvious way to write one is a hostname, which is also why the rules file
// shipped for months with a single fake domain in it. There are thousands of
// scan sites, they rename themselves, and they front the same install behind
// ww1/ww3/ww6 counters: a list of hostnames is a list that is wrong by the time
// it ships, and every entry has to be verified against a site by hand.
//
// So the rules are keyed on the *engine* instead. A handful of WordPress themes
// and open-source readers sit behind most of these sites, each with markup its
// author wrote once and nobody since has touched. `.reading-content` is Madara
// wherever it turns up — on a host nobody has heard of, under a name that
// changed last week. Recognise the engine and one entry covers a thousand hosts
// nobody had to find first.
//
// `domains` stays, for the site that genuinely needs its own answer, and what it
// says wins over whatever engine it runs.
//
// Pure: a hostname, the rules file, and either a way to put a question to the
// DOM or the raw markup. No DOM, no fetch, no storage — the same file runs in
// the extension's content scripts, the phone's worker WebView and `node --test`.
(function (root) {
  'use strict';

  /**
   * Every key under `domains` that could stand for this host, most specific
   * first: the host as given, the host without `www.`, then each parent as a
   * wildcard. The wildcards are what survive a site moving to `ww6.` overnight,
   * and `*.example.com` deliberately covers the apex as well — someone writing
   * it means the site, not the subdomains of the site.
   *
   * A wildcard is never generated for a bare suffix: the loop stops one label
   * short, so `*.com` is not a key any host can match.
   */
  function hostKeys(host) {
    const raw = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!raw) return [];
    const bare = raw.replace(/^www\./, '');
    const keys = raw === bare ? [raw] : [raw, bare];
    const parts = bare.split('.');
    for (let i = 0; i < parts.length - 1; i++) keys.push(`*.${parts.slice(i).join('.')}`);
    return keys;
  }

  /** This host's own entry in the rules file, or null. */
  function domainRule(host, domains) {
    const map = domains || {};
    for (const key of hostKeys(host)) {
      if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    }
    return null;
  }

  /**
   * Which engine built this page.
   *
   * `ask` is a `(selector) => boolean` predicate over a live DOM; `html` is the
   * raw markup, for the callers that have no DOM to ask. A DOM is authoritative:
   * when one is offered and none of the engines match it, the markup is *not*
   * consulted as a second opinion — the page is simply not one of these.
   *
   * Engines are tried in the order the rules file lists them, so the file
   * controls precedence and the most distinctive markup goes first.
   */
  function sniffEngine(engines, opts) {
    const map = engines || {};
    const ask = opts && typeof opts.ask === 'function' ? opts.ask : null;
    if (ask) {
      for (const id of Object.keys(map)) {
        const selectors = (map[id] || {}).detect || [];
        // A selector the rules file got wrong is a syntax error inside
        // querySelector, and it must cost this engine its turn, not the scan.
        if (selectors.some((sel) => { try { return !!ask(sel); } catch { return false; } })) {
          return id;
        }
      }
      return null;
    }
    const markup = String((opts && opts.html) || '').toLowerCase();
    if (!markup) return null;
    for (const id of Object.keys(map)) {
      const signature = (map[id] || {}).signature || [];
      if (signature.some((s) => markup.includes(String(s).toLowerCase()))) return id;
    }
    return null;
  }

  /**
   * What this site calls things.
   *
   * @param {object} opts
   * @param {string} opts.host    the page's hostname
   * @param {object} opts.rules   the parsed `shared/detection-rules.json`
   * @param {function} [opts.ask] `(selector) => boolean` against the live DOM
   * @param {string} [opts.html]  the raw markup, when there is no DOM
   * @returns {?object} the engine's selectors with the domain's own merged over
   *   them, plus `engine` (the id, or null) and `knownDomain` (whether the rules
   *   file names this host outright). Null when nothing recognised the page,
   *   which is the case the heuristics were written for.
   */
  function resolveSite(opts) {
    const o = opts || {};
    const rules = o.rules || {};
    const engines = rules.engines || {};
    const own = domainRule(o.host, rules.domains);

    // A domain entry may name its engine outright — that is how a site whose
    // markup gives nothing away still gets the engine's selectors — and naming
    // one that does not exist falls back to sniffing rather than to nothing.
    let engine = own && own.engine ? String(own.engine) : null;
    if (engine && !engines[engine]) engine = null;
    if (!engine) engine = sniffEngine(engines, o);

    if (!own && !engine) return null;

    const site = Object.assign({}, engine ? engines[engine].rule : null, own);
    site.engine = engine;
    site.knownDomain = !!own;
    return site;
  }

  // --- what a URL calls its chapter ------------------------------------------
  //
  // Both detectors read a chapter number out of a URL or a title, and both used
  // to carry their own copy of one small regex. It moved here — the one file
  // every client loads before either of them — because the rule stopped being
  // obvious enough to duplicate.
  //
  // MangaDex addresses a chapter by UUID:
  //
  //   /chapter/3bde6546-e07c-4aca-9bb2-76764ba95ebe   ← chapter 26
  //
  // and the old pattern read "chapter", then "/", then "3", and reported
  // chapter 3. The library believed it: `chapterVisited` is forward-only, so a
  // UUID beginning with a 9 moved a reader's bookmark to chapter 9 of a series
  // they were five chapters into, and nothing in the app could move it back.
  //
  // Two guards, both cheap:
  //
  //   - the digits may not be followed by another letter or digit. A chapter
  //     number ends its token; the first digit of a hex blob does not.
  //   - the number may not reach 10000, the bound the rest of the project
  //     already uses to fend off timestamps, view counts and prices.
  //
  // The keyword needs a boundary in front of it now as well, so `ch` stops
  // matching inside `watch2` and `recherche7`.
  const CHAPTER_IN =
    /(?:^|[^a-z0-9])(?:chapter|chapitre|chap|ch|episode)[-_/ .]*(\d+(?:\.\d+)?)(?![0-9a-z])/i;

  /**
   * The chapter number a string names, spelled the way it was written ("109",
   * "109.5"), or null when it names none. A string, not a number: "07" and
   * "7" are the same chapter but not the same label, and the callers that want
   * arithmetic parse it themselves.
   */
  function chapterNumber(text) {
    const hit = String(text || '').match(CHAPTER_IN);
    if (!hit) return null;
    const n = parseFloat(hit[1]);
    return Number.isNaN(n) || n >= 10000 ? null : hit[1];
  }

  root.PanelFlowSites = {
    resolveSite, domainRule, sniffEngine, hostKeys, chapterNumber,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
