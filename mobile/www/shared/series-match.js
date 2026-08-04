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
  const NOISE = new RegExp(
    '\\b(' + [
      'vostfr', 'vf', 'vostf', 'raw', 'raws',
      'scan', 'scans', 'scanlation', 'scantrad',
      'manga', 'manhwa', 'manhua', 'webtoon', 'webtoons', 'comic', 'comics',
      'novel', 'lightnovel', 'ln', 'wn',
      'lecture en ligne', 'lire en ligne', 'read online', 'online',
      'gratuit', 'gratuitement', 'free', 'hd', 'vip', 'complet',
      'official', 'officiel', 'traduction', 'translation',
    ].join('|') + ')\\b', 'g');

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
    normalizeTitle, similarity, bestTitleScore,
    classify, findMatches, bestMatch,
    chapterNumber, furtherChapter,
    STRONG, WEAK, MIN_FUZZY_LEN,
  };

  root.PanelFlowMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
