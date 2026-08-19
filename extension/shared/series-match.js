// Does this page show a work the library already has?
//
// seriesKey() answers that for one site: it reduces a URL to host + slug, so
// /manga/ao-no-hako and /chapter/ao-no-hako-109 collapse together. It cannot
// answer it across sites — the same book is /ao-no-hako on one scan site and
// /blue-box on another, and nothing in the URLs says so.
//
// So the cross-site question is answered on titles. That is fuzzy by nature
// (a site writes "Ao no Hako VF - Lecture en ligne", another writes
// "Blue Box"), which is why this module reports a confidence instead of a
// boolean: the caller asks the user before merging anything.
//
// Plain script, not a module: Chrome content scripts cannot be ESM. The copy
// under extension/shared is generated from this file — run `npm run sync:shared`
// after editing, and `shared sources are in sync` in the test suite will catch
// it if you forget.
(function (root) {
  'use strict';

  const normUrl = (u) => String(u || '').toLowerCase().replace(/\/+$/, '');

  // Path segments that name a section of the site rather than the work.
  const SECTIONS = /^(manga|manhwa|manhua|comics?|series|scan|scans|read|reader|lecture|lecture-en-ligne|chapter|chapitre|chap|ch|episode|viewer|title|webtoon)s?$/i;

  // A segment that is only a chapter counter: "chapitre-109", "vol_3", "ch.12".
  const COUNTER_SEG = /^(chapter|chapitre|chap|ch|episode|ep|tome|volume|vol|saison|season|part|partie)[-_. ]?\d+(\.\d+)?$/i;

  function seriesKey(url) {
    let u;
    try { u = new URL(url); } catch { return normUrl(url); }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const slug = u.pathname.split('/')
      .map((seg) => seg
        .replace(/\.(html?|php)$/i, '')
        // "Ao-no-Hako-Chapitre-109-FR_330666" → "Ao-no-Hako"
        .replace(/[-_.](chapter|chapitre|chap|ch|episode)[-_. ]?[\d.].*$/i, '')
        .replace(/^[-_.\s]+|[-_.\s]+$/g, '')
        .toLowerCase())
      .filter((seg) => seg && !SECTIONS.test(seg) && !COUNTER_SEG.test(seg)
        && !/^\d+(\.\d+)?$/.test(seg))
      // The work's slug is the deepest segment left: /manga/<slug>/<chapter>.
      .pop();
    return slug ? `${host}|${slug}` : normUrl(url);
  }

  function sameSeries(a, b) {
    const na = normUrl(a);
    const nb = normUrl(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    return seriesKey(a) === seriesKey(b);
  }

  // Words a scan site adds around the title: the language it was translated
  // into, the format, and the SEO tail. None of them identify the work.
  const NOISE_WORDS = [
    'vostfr', 'vf', 'vostf', 'raw', 'raws',
    'scan', 'scans', 'scanlation', 'scantrad',
    'manga', 'manhwa', 'manhua', 'webtoon', 'webtoons', 'comic', 'comics',
    'novel', 'lightnovel', 'ln', 'wn',
    'lecture en ligne', 'lire en ligne', 'read online', 'online',
    'gratuit', 'gratuitement', 'free', 'hd', 'vip', 'complet',
    'official', 'officiel', 'traduction', 'translation',
  ];
  const NOISE = new RegExp('\\b(' + NOISE_WORDS.join('|') + ')\\b', 'g');

  const COUNTER = /\b(chapitre|chapter|chap|ch|episode|episodes|ep|tome|tomes|vol|volume|volumes|saison|season|part|partie|arc)\s*\.?\s*\d+(\.\d+)?\b/g;

  // Normalising is pure but not cheap — an NFKD pass and six regexes per title
  // — and findMatches asks for the candidate's title again for every entry it
  // compares against, so a library of 200 pays for the same work 200 times.
  // Bounded so a long-running service worker cannot grow it without limit.
  const titleCache = new Map();
  const TITLE_CACHE_MAX = 1000;

  /**
   * Reduce a displayed title to the part that identifies the work.
   * "Ao no Hako VF — Chapitre 109 | Lecture en ligne" → "ao no hako"
   */
  function normalizeTitle(raw) {
    const key = typeof raw === 'string' ? raw : null;
    if (key !== null && titleCache.has(key)) return titleCache.get(key);
    const out = computeNormalizedTitle(raw);
    if (key !== null) {
      if (titleCache.size >= TITLE_CACHE_MAX) titleCache.delete(titleCache.keys().next().value);
      titleCache.set(key, out);
    }
    return out;
  }

  function computeNormalizedTitle(raw) {
    let s = String(raw ?? '')
      // Strip accents so "Bleach — Édition" and "Bleach Edition" agree.
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Apostrophes join, they do not separate: "O'Brien" is one word.
      .replace(/['’ʼ`]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Only strip noise when something identifying survives it — "Manga Dogs"
    // and "Free!" are real titles made entirely of words on that list.
    const stripped = s.replace(COUNTER, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (stripped) s = stripped;
    return s;
  }

  /* ---------- the same title, for a human ---------- */

  // Single words from NOISE (the multi-word entries are covered word by word by
  // TRAILING_EXTRA), plus the language and edition tags a site appends that are
  // deliberately NOT in NOISE: normalizeTitle also uses that list, and "fr" or
  // "en" landing inside a real title is a bet worth losing on display and not
  // worth losing on matching.
  const NOISE_SET = new Set(NOISE_WORDS.filter((w) => !w.includes(' ')));
  // `read` and `lire` are here rather than in NOISE_WORDS, where they only
  // exist inside "read online" / "lire en ligne": stripping the tail one word
  // at a time takes "Online" off first, and the "Read" left behind matched
  // nothing. They earn their place at the *head* too — "Read One Piece Manga"
  // is what MangaNato calls the page — which is why this is no longer named for
  // the tail. Both ends lean on the same two-cut rule to stay honest.
  const EXTRA_WORDS = [
    'fr', 'en', 'es', 'it', 'pt', 'de', 'id', 'ar', 'jp', 'ja', 'ko', 'zh',
    'sub', 'subbed', 'subs', 'eng', 'ita', 'esp', 'multi',
    'ligne', 'lire', 'lecture', 'read', 'serie', 'series',
    'chapitre', 'chapitres', 'chapter', 'chapters',
  ];
  const BUILTIN_FURNITURE = new Set([...NOISE_SET, ...EXTRA_WORDS]);

  // --- the same list, but changeable without a release -----------------------
  //
  // Everything above is what shipped, and it is right until a site renames its
  // tail — "Scan VF" becomes "Lecture Scan FR" — at which point a word is
  // wrong and an extension release is a very large unit of work for one word.
  // `detection-rules.json` already reaches every client on a six-hour TTL, so
  // the vocabulary rides along with it:
  //
  //   "titleNoise": { "words": [...], "keep": [...] }   at the top level
  //   "domains": { "*.example.fr": { "titleNoise": { ... } } }
  //
  // `keep` is there because the words are the dangerous half. "Sword Art
  // Online", "Manga Dogs" and "Free!" are real titles built out of listed
  // words; the two-cut rule in displayTitle is what usually saves them, and
  // when a site proves it is not enough, `keep` says so for that site alone
  // rather than by weakening the rule everywhere.
  const WORDS_MAX = 200;

  // Anything that is not a list of words contributes nothing and throws
  // nothing. A rules file is edited by hand and served to every client at
  // once, so the shape it arrives in is not something this can insist on.
  const wordList = (v) => (Array.isArray(v) ? v : [])
    .filter((w) => typeof w === 'string')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, WORDS_MAX);

  const noiseSection = (o) =>
    (o && typeof o === 'object' && !Array.isArray(o) && o.titleNoise) || null;

  // One entry, because the callers sweep a page of results or a library of one
  // host at a time. Keyed on the rules object's identity as well as the host:
  // the clients replace it wholesale when the TTL expires.
  let vocabCache = null;

  /**
   * The furniture words in force for one host: what shipped, plus the file's
   * global additions, plus that domain's own, minus everything any of them
   * asked to keep. The domain is applied last, so it wins.
   *
   * A malformed section costs its own site its extra words and nothing else —
   * not the built-in list, not the other 49 domains, and not the call.
   */
  function furnitureFor(opts) {
    const o = opts || {};
    const rules = o.rules || {};
    const host = o.host ? String(o.host) : '';
    if (vocabCache && vocabCache.host === host && vocabCache.rules === o.rules) {
      return vocabCache.words;
    }

    let own = null;
    // Which entry covers this host is site-rules.js's answer — wildcards, the
    // www. that is not part of the name, the apex a `*.` key also stands for.
    // Read off the global at call time: both are plain scripts, and a client
    // that loaded only this one must lose the per-domain list, not the title.
    const sites = root.PanelFlowSites;
    if (host && sites && typeof sites.domainRule === 'function') {
      try { own = sites.domainRule(host, rules.domains); } catch { own = null; }
    }

    const words = new Set(BUILTIN_FURNITURE);
    for (const section of [noiseSection(rules), noiseSection(own)]) {
      if (!section || typeof section !== 'object') continue;
      for (const w of wordList(section.words)) words.add(w);
      for (const w of wordList(section.keep)) words.delete(w);
    }
    vocabCache = { host, rules: o.rules, words };
    return words;
  }
  const SEP = '\\s»«|•·:,;–—\\-/()\\[\\]{}';
  const SEP_END = new RegExp(`[${SEP}.!]+$`);
  // Trimming the ends is not the same job as finding a word boundary, so it
  // works off a smaller class: a bracket at the edge belongs to the title as
  // long as its partner is still in the string. MANGA Plus prints
  // "[#002] Shunrai Table Tennis", and dropping the "[" alone left
  // "#002] Shunrai Table Tennis" — a worse title than the one we were given.
  const EDGE = '\\s»«|•·:,;–—\\-/';
  const EDGES = new RegExp(`^[${EDGE}]+|[${EDGE}]+$`, 'g');
  const PARTNER = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };

  // An orphaned bracket *is* furniture: it is what is left when the words it
  // wrapped were the site's, and it is the only thing this strips that the
  // string did not arrive with a matching half of.
  function trimEdges(str) {
    let out = String(str).replace(EDGES, '').trim();
    for (;;) {
      const open = /^([([{])/.exec(out);
      if (open && !out.includes(PARTNER[open[1]])) { out = out.slice(1).replace(EDGES, ''); continue; }
      const close = /([)\]}])$/.exec(out);
      if (close && !out.includes(PARTNER[close[1]])) { out = out.slice(0, -1).replace(EDGES, ''); continue; }
      break;
    }
    return out.trim();
  }
  // Leading separators are stripped off the smaller EDGE class, not off SEP: SEP
  // holds the brackets, and taking "[" off the front of "[#002] Shunrai" would
  // put back the very half-a-bracket trimEdges() exists to avoid.
  const SEP_START = new RegExp(`^[${EDGE}.!]+`);
  const WORD_END = new RegExp(`(^|[${SEP}])([\\p{L}\\p{N}]+)$`, 'u');
  const WORD_START = new RegExp(`^([\\p{L}\\p{N}]+)([${SEP}]|$)`, 'u');
  const COUNTER_END = new RegExp(
    `(^|[${SEP}])(chapitre|chapter|chap|ch|episode|ep|tome|vol|volume|saison|season|part|partie)\\s*\\.?\\s*\\d+(\\.\\d+)?$`,
    'iu');

  /**
   * The same title, minus the site's furniture — for display, not for matching.
   * "Blue Box Scan VF / FR Gratuit (Webtoon)" → "Blue Box"
   *
   * normalizeTitle() answers "are these the same work" and is free to lowercase
   * the string and flatten it to nothing; this one has to hand back something a
   * reader recognises, so it only removes whole words.
   *
   * Mostly from the end, which is where a site appends. But not only: MangaNato
   * titles its chapter pages "Read One Piece Manga Chapter 1140 …", and trimming
   * the tail alone left "Read One Piece Manga" on the shelf. So the head is
   * tried too, once the tail has nothing left to give.
   *
   * What keeps that honest is the count, not the word list: a *run* of furniture,
   * never one word. Plenty of real titles end — or start — with a word on the
   * list: "Sword Art Online", "Manga Dogs", "Free!". One is not evidence. Two is.
   * That deliberately leaves "Naruto Scan" alone: a conservative miss shows a
   * slightly long title, an eager one renames somebody's series.
   *
   * Never empty. A run of furniture that eats the whole string is a site whose
   * page is titled nothing but furniture, or a word list that went too far, and
   * either way the caller would rather have what it handed in: a title is the
   * only thing on a library card that cannot be worked out again afterwards.
   *
   * @param {string} raw
   * @param {object} [opts]        omitted, the built-in word list applies
   * @param {string} [opts.host]   so the site's own section is consulted
   * @param {object} [opts.rules]  the parsed detection-rules.json
   */
  function displayTitle(raw, opts) {
    const words = opts ? furnitureFor(opts) : BUILTIN_FURNITURE;
    const isFurniture = (w) => words.has(String(w).toLowerCase());
    const original = trimEdges(String(raw ?? ''));
    let s = original;
    let cut = 0;
    for (;;) {
      const trimmed = s.replace(SEP_END, '').replace(SEP_START, '');
      const counter = COUNTER_END.exec(trimmed);
      if (counter) { s = trimmed.slice(0, counter.index); cut++; continue; }
      const word = WORD_END.exec(trimmed);
      if (word && isFurniture(word[2])) { s = trimmed.slice(0, word.index); cut++; continue; }
      // The head, last: the tail is where furniture usually is, and a title that
      // opens on a listed word ("Manga Dogs") is likelier to mean it. Never the
      // last word standing — "Scan" alone is not a title, it is what is left of
      // one, and the caller would rather have the string it came in with.
      const head = WORD_START.exec(trimmed);
      if (head && isFurniture(head[1]) && trimEdges(trimmed.slice(head[1].length))) {
        s = trimmed.slice(head[1].length); cut++; continue;
      }
      s = trimmed;
      break;
    }
    const out = trimEdges(s);
    return cut >= 2 && out ? out : original;
  }

  function bigrams(s) {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  }

  /**
   * Sørensen–Dice over character bigrams: 1 for identical, 0 for unrelated.
   * Chosen over edit distance because it shrugs off word order — "Blue Box"
   * vs "Box, Blue" — and off a missing subtitle, which is the common case.
   */
  function similarity(a, b) {
    if (a === b) return a ? 1 : 0;
    if (a.length < 2 || b.length < 2) return 0;
    const A = bigrams(a);
    const B = bigrams(b);
    const counts = new Map();
    for (const g of A) counts.set(g, (counts.get(g) ?? 0) + 1);
    let hits = 0;
    for (const g of B) {
      const n = counts.get(g) ?? 0;
      if (n > 0) { counts.set(g, n - 1); hits++; }
    }
    return (2 * hits) / (A.length + B.length);
  }

  // Above STRONG the titles are the same work under two spellings; between
  // WEAK and STRONG they are close enough to be worth a question and no more.
  const STRONG = 0.9;
  const WEAK = 0.74;
  // Below this length a bigram score means nothing — "Gantz" and "Gantz:O"
  // score 0.8 but so do "Naruto" and "Narumi". Short titles must match exactly.
  const MIN_FUZZY_LEN = 8;

  const titlesOf = (x) => [x?.title, ...(x?.altTitles || []), ...(x?.alternativeTitles || [])]
    .map(normalizeTitle)
    .filter(Boolean);

  /** Best similarity across every title/alt-title pair of two works. */
  function bestTitleScore(a, b) {
    const A = titlesOf(a);
    const B = titlesOf(b);
    let best = 0;
    for (const x of A) {
      for (const y of B) {
        if (x === y) return 1;
        if (x.length < MIN_FUZZY_LEN || y.length < MIN_FUZZY_LEN) continue;
        const s = similarity(x, y);
        if (s > best) best = s;
      }
    }
    return best;
  }

  /**
   * How strongly does `candidate` look like `entry`?
   *   same-page  the very same URL
   *   same-site  same work, same site, different URL shape
   *   same-title titles are identical once normalised — a source migration
   *   likely     close enough to ask about
   *   null       unrelated
   */
  function classify(candidate, entry) {
    const cUrl = candidate?.sourceUrl;
    const eUrl = entry?.sourceUrl;
    if (cUrl && eUrl) {
      if (normUrl(cUrl) === normUrl(eUrl)) return { confidence: 'same-page', score: 1 };
      if (sameSeries(cUrl, eUrl)) return { confidence: 'same-site', score: 1 };
    }
    const score = bestTitleScore(candidate, entry);
    if (score >= STRONG) return { confidence: 'same-title', score };
    if (score >= WEAK) return { confidence: 'likely', score };
    return null;
  }

  const RANK = { 'same-page': 4, 'same-site': 3, 'same-title': 2, likely: 1 };

  /**
   * Every library entry that might already be this work, best first.
   * `library` entries need at least { title, sourceUrl }.
   */
  function findMatches(candidate, library) {
    const out = [];
    for (const entry of library || []) {
      const m = classify(candidate, entry);
      if (m) out.push({ entry, ...m });
    }
    return out.sort((a, b) => (RANK[b.confidence] - RANK[a.confidence]) || (b.score - a.score));
  }

  /** The single match worth interrupting the user for, or null. */
  function bestMatch(candidate, library) {
    return findMatches(candidate, library)[0] ?? null;
  }

  // Chapter labels are free text ("Ch. 109", "Chapitre 109 VF", "109.5"), so
  // the only comparable part is the first number in them.
  function chapterNumber(label) {
    const m = /\d+(?:\.\d+)?/.exec(String(label ?? ''));
    return m ? Number(m[0]) : null;
  }

  /**
   * The label that is furthest into the series. An unparseable label beats
   * nothing at all but never beats a real number — losing chapters to a
   * merge is worse than keeping a label nobody can sort.
   */
  function furtherChapter(...labels) {
    let best = null;
    let bestRank = -Infinity;
    for (const label of labels) {
      if (label === undefined || label === null || label === '') continue;
      const rank = chapterNumber(label) ?? -1;
      if (rank > bestRank) { bestRank = rank; best = label; }
    }
    return best;
  }

  const api = {
    normUrl, seriesKey, sameSeries,
    normalizeTitle, displayTitle, similarity, bestTitleScore,
    classify, findMatches, bestMatch,
    chapterNumber, furtherChapter,
    STRONG, WEAK, MIN_FUZZY_LEN,
  };

  root.PanelFlowMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
