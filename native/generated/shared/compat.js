// "Will PanelFlow's reader work on this page?" — answered from HTML alone.
//
// `extension/content/detect.js` answers the same question from a live DOM, and
// it is the authority: it can measure rendered image sizes and see what
// JavaScript built. But the mobile app has to answer *before* opening a page —
// in a search-results list, or when the user pastes a link — and there is no DOM
// there. So this file re-derives the same verdict from raw markup, deliberately
// using the same weights and thresholds as `detection-rules.json` so the two
// agree in the cases where both can look.
//
// It errs toward "unknown" rather than "no": a reader that renders its pages
// from JavaScript is invisible here but works fine once loaded, and telling a
// user a site is unsupported when it is not is the worse mistake.
//
// Plain IIFE, no DOM, no Node built-ins — runs in the backend, the mobile
// worker WebView and `node --test` unchanged.
(function (root) {
  'use strict';

  const WEIGHTS = {
    imageGallery: 40,
    urlPattern: 20,
    chapterNav: 20,
    lowTextDensity: 10,
    // Recognising the engine is evidence, not proof: `.reading-content` is
    // Madara on its home page too. Deliberately below the threshold on its own,
    // where naming the host outright is deliberately above it.
    knownEngine: 40,
    knownDomain: 100,
  };
  const THRESHOLD = 50;
  const MIN_GALLERY_IMAGES = 3;

  // The delimiter before the chapter word is `[/_-]`, not `/`: the default
  // permalink of both engines this project sees most often is
  // `/one-piece-chapter-1100/`, and a pattern that insists on a slash scores
  // zero on the single most common chapter URL in the niche.
  const URL_PATTERNS = [
    /\/(manga|manhwa|manhua|comic|scan|webtoon)s?\//i,
    /[/_-](chapter|chapitre|chap|ch)[-_/ ]?\d/i,
    /[/_-]episode[-_/]?\d/i,
    /\/read(er)?(\/|$)/i,
  ];

  const NAV_PATTERN =
    /(next|previous|prev)\s+(chapter|chap|episode)|chapitre\s+(suivant|pr[eé]c[eé]dent)|次の話|前の話/i;

  // Lazy-loading readers put the real page URL in a data- attribute and leave
  // `src` on a 1px placeholder, so both have to count as an image.
  const IMG_TAG = /<img\b[^>]*>/gi;
  // Deliberately one regex per attribute, tried in this order, rather than one
  // alternation: a lazy-loading tag carries both, `src` on a placeholder and the
  // real page in `data-src`, and an alternation matches whichever appears first
  // in the markup — which is the placeholder, so every page would be discarded.
  const SRC_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'srcset', 'src']
    .map((name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));

  // A page image looks like a page: a real file, not an icon, avatar, logo or
  // tracking pixel. This is the same shape check detect.js makes with
  // naturalWidth, done on the URL because that is all there is here.
  const CHROME_SRC = /(sprite|logo|icon|avatar|banner|button|emoji|flag|ads?[-_./]|pixel|blank|spacer|placeholder|loading)/i;
  const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif|bmp)(\?|#|$)/i;

  /** Every plausible page image URL in the markup, in document order. */
  function pageImages(html, baseUrl) {
    const out = [];
    const seen = new Set();
    for (const tag of html.match(IMG_TAG) || []) {
      for (const re of SRC_ATTRS) {
        const m = re.exec(tag);
        if (!m) continue;
        // srcset is "url 1x, url 2x" — the first URL is enough to judge it.
        const raw = m[1].trim().split(/[\s,]+/)[0];
        if (!raw || raw.startsWith('data:')) continue;
        if (CHROME_SRC.test(raw)) continue;
        // Reader pages are numbered files; a site that serves them extensionless
        // through a proxy is common enough that a missing extension is not a
        // veto, but a URL with no path at all is.
        if (!IMAGE_EXT.test(raw) && !/\/\d{1,4}(\?|#|$)/.test(raw) && !/\?/.test(raw)) continue;
        const abs = absolute(raw, baseUrl);
        if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
        break; // one image per tag, from its best attribute
      }
    }
    return out;
  }

  function absolute(src, baseUrl) {
    if (!baseUrl) return src;
    try { return new root.URL(src, baseUrl).href; } catch { return src; }
  }

  const stripTags = (html) => html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const titleOf = (html) => {
    const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (og) return og[1].trim();
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return t ? stripTags(t[1]) : null;
  };

  const coverOf = (html, baseUrl) => {
    const m = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i.exec(html);
    return m ? absolute(m[1].trim(), baseUrl) : null;
  };

  // Some readers are canvas-only or build every <img> from JS. Their markup has
  // no page images at all, so scoring would call them unsupported — but they
  // work once loaded. Spot the tell and downgrade to "unknown" instead.
  const SCRIPTED_READER =
    /<canvas\b|reader\.(?:js|bundle)|window\.__(?:NUXT|NEXT|INITIAL)|chapter[_-]?(?:images|pages|data)\s*[:=]|"pages"\s*:\s*\[/i;

  // Text chapters. The reader takes web novels too, so a page with no images at
  // all is not automatically "no" — and saying it is would be the worse mistake
  // twice over, because a novel scores zero here by construction: every weight
  // above is an image signal.
  //
  // Same floors as detect.js's prose gate, measured on markup rather than a DOM.
  const PROSE_MIN_LINE = 60;
  const PROSE_MIN_LINES = 5;
  const PROSE_MIN_CHARS = 1200;

  /** The page's long, link-free lines — what a chapter of prose is made of. */
  function proseLines(html) {
    const text = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      // Link text is dropped rather than counted. A table of contents, a comment
      // thread and a sidebar are all long and all mostly links; this is the same
      // job detect.js does with link density, done where there is no DOM to ask.
      .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' ')
      // Every block boundary becomes a line break, so one <p> — or one run
      // between two <br>s, which is how the older novel sites do it — is one
      // line to measure.
      .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|blockquote|section|article)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ')
      .replace(/[^\S\n]+/g, ' ');
    return text.split('\n').map((s) => s.trim()).filter((s) => s.length >= PROSE_MIN_LINE);
  }

  const readsLikeProse = (lines) =>
    lines.length >= PROSE_MIN_LINES &&
    lines.reduce((n, s) => n + s.length, 0) >= PROSE_MIN_CHARS;

  /**
   * @param {string} html      the page's markup
   * @param {string} [url]     the page's URL — used for URL heuristics and to
   *                           absolutise image sources
   * @param {object} [opts]
   * @param {object} [opts.rules] the parsed `shared/detection-rules.json`
   * @returns {{verdict: 'ready'|'likely'|'unknown'|'unlikely', score: number,
   *            signals: string[], reason: string, images: string[],
   *            imageCount: number, title: ?string, coverUrl: ?string,
   *            chapterLabel: ?string, latestChapter: ?string,
   *            knownDomain: boolean, engine: ?string}}
   */
  function analyze(html, url, opts = {}) {
    html = String(html || '');
    const path = pathOf(url);
    const signals = [];
    let score = 0;

    // Which site this is, from the markup — the same question detect.js puts to
    // the live DOM, answered by the same file (shared/site-rules.js) so a page
    // checked here and then opened is judged to be the same site both times.
    const host = hostOf(url);
    const site = root.PanelFlowSites
      ? root.PanelFlowSites.resolveSite({ host, rules: opts.rules, html })
      : null;
    const knownDomain = !!(site && site.knownDomain);
    if (knownDomain) {
      score += WEIGHTS.knownDomain; signals.push('known-domain');
    } else if (site && site.engine) {
      score += WEIGHTS.knownEngine; signals.push('known-engine');
    }

    const images = pageImages(html, url);
    const gallery = images.length >= MIN_GALLERY_IMAGES;
    if (gallery) { score += WEIGHTS.imageGallery; signals.push('image-gallery'); }

    if (path && URL_PATTERNS.some((re) => re.test(path))) {
      score += WEIGHTS.urlPattern; signals.push('url-pattern');
    }

    const text = stripTags(html);
    if (NAV_PATTERN.test(text)) { score += WEIGHTS.chapterNav; signals.push('chapter-nav'); }

    if (gallery && text.length / images.length < 800) {
      score += WEIGHTS.lowTextDensity; signals.push('low-text-density');
    }

    const scripted = !gallery && SCRIPTED_READER.test(html);
    if (scripted) signals.push('scripted-reader');

    // Prose on its own is an article; prose on a page that names its chapter is
    // a chapter. detect.js draws the line in the same place, and for the same
    // reason: "Chapter 3" is a normal thing for a blog post to be called.
    const prose = gallery ? [] : proseLines(html);
    const textChapter = !gallery && readsLikeProse(prose) &&
      (signals.includes('url-pattern') || signals.includes('chapter-nav'));
    if (textChapter) signals.push('text-chapter');

    let verdict, reason;
    if (score >= THRESHOLD && gallery) {
      // Reading strip vs. cover carousel is a layout question, and layout is
      // exactly what markup does not carry — detect.js settles it on the live
      // page. "ready" here means the reader will very probably open, not that
      // it is guaranteed to.
      verdict = images.length >= 6 || signals.includes('chapter-nav') ? 'ready' : 'likely';
      reason = `${images.length} page images and ${signals.length} matching signals`;
    } else if (textChapter) {
      // The one case that can be answered outright: the words are in the
      // markup, so there is nothing left for the live page to reveal.
      verdict = 'ready';
      reason = `text chapter — ${prose.length} paragraphs of prose`;
    } else if (scripted) {
      verdict = 'unknown';
      reason = 'the reader builds its pages in JavaScript — open it to find out';
    } else if (score >= THRESHOLD) {
      verdict = 'likely';
      reason = 'reads like a chapter page, but no images were found in the markup';
    } else if (gallery) {
      verdict = 'likely';
      reason = `${images.length} images found, but this does not look like a chapter page`;
    } else {
      verdict = 'unlikely';
      reason = 'no image gallery and nothing that identifies a chapter';
    }

    return {
      verdict, score, signals, reason,
      images: images.slice(0, 60),
      imageCount: images.length,
      title: titleOf(html),
      coverUrl: coverOf(html, url),
      chapterLabel: chapterLabel(url, titleOf(html)),
      latestChapter: latestChapter(html),
      knownDomain,
      engine: site ? site.engine : null,
    };
  }

  const hostOf = (url) => {
    try { return new root.URL(url).hostname; } catch { return null; }
  };
  const pathOf = (url) => {
    try { const u = new root.URL(url); return u.pathname + u.search; } catch { return url || ''; }
  };

  // Which chapter a URL or a title names. The rule itself lives in
  // site-rules.js — the file both detectors are guaranteed to have loaded — so
  // that a page checked here and then opened in detect.js reports one label and
  // not two. Read through `root` for the same reason resolveSite is.
  const chapterNumber = (text) =>
    (root.PanelFlowSites ? root.PanelFlowSites.chapterNumber(text) : null);

  /** The chapter this URL *is*, normalised to "Ch. 109". */
  function chapterLabel(url, title) {
    const found = chapterNumber(pathOf(url)) ?? chapterNumber(title);
    return found === null || found === undefined ? null : `Ch. ${found}`;
  }

  // Highest chapter number linked from the page — its chapter list, if it has
  // one. The attribute is pulled out first and judged second, rather than
  // matched in one pass: the judging is the shared rule, and a URL that names
  // its chapter by id must come back empty here exactly as it does there.
  function latestChapter(html) {
    const link = /(?:href|value|data-href|data-url)=["']([^"']+)["']/gi;
    let max = null;
    for (const m of String(html || '').matchAll(link)) {
      const found = chapterNumber(m[1]);
      if (found === null || found === undefined) continue;
      const n = parseFloat(found);
      if (max === null || n > max) max = n;
    }
    return max === null ? null : String(max);
  }

  root.PanelFlowCompat = {
    analyze, pageImages, chapterLabel, latestChapter,
    WEIGHTS, THRESHOLD, MIN_GALLERY_IMAGES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
