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
    /[/_-](chapter|chapitre|chap|ch|capitulo)[-_/ ]?\d/i,
    /[/_-]episodes?[-_/]?\d/i,
    // webtoons.com: /season-1-ep-0/viewer?title_no=95&episode_no=1
    /[/_-]ep[-_/]?\d/i,
    /[?&]episode_no=\d/i,
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
  // `ads?` needs a boundary in front: without one, every WordPress upload
  // (/wp-content/uploads/) read as an advert, and a Madara site's whole
  // chapter counted as zero page images here.
  const CHROME_SRC = /(sprite|logo|icon|avatar|banner|button|emoji|flag|(?:^|[^a-z])ads?[-_./]|pixel|blank|spacer|placeholder|loading)/i;
  /** A tag whose class or alt says it is chrome, whatever its address. */
  const CHROME_TAG = /(?:class|alt|id)=["'][^"']*(?:logo|icon|avatar|sprite|emoji)/i;
  const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif|bmp)(\?|#|$)/i;

  // What a page of a chapter is not: a picture declared narrower than the
  // detector's own floor (detection-rules.json, minImageWidth), a file named
  // for a small size, or anything kept in a covers folder. The next chapter
  // read in place on scan-vf came with three covers of other series from the
  // "related" row under it (QA, September 2026) — 250 px wide, and saying so.
  const MIN_PAGE_WIDTH = 400;
  const SMALL_BY_NAME = /[_-](\d{2,4})x\d{2,4}\.[a-z]+(\?|#|$)/i;
  const COVER_DIR = /\/covers?\//i;
  const declaredWidth = (tag) => {
    const m = /\bwidth\s*=\s*["']?(\d+)(?:px)?["'\s>/]/i.exec(tag);
    return m ? Number(m[1]) : null;
  };

  /** Every plausible page image URL in the markup, in document order. */
  function pageImages(html, baseUrl) {
    const out = [];
    const seen = new Set();
    for (const tag of html.match(IMG_TAG) || []) {
      const declared = declaredWidth(tag);
      if (declared !== null && declared < MIN_PAGE_WIDTH) continue;
      for (const re of SRC_ATTRS) {
        const m = re.exec(tag);
        if (!m) continue;
        // srcset is "url 1x, url 2x" — the first URL is enough to judge it.
        const raw = m[1].trim().split(/[\s,]+/)[0];
        if (!raw || raw.startsWith('data:')) continue;
        if (CHROME_SRC.test(raw)) continue;
        if (COVER_DIR.test(raw)) continue;
        const named = SMALL_BY_NAME.exec(raw);
        if (named && Number(named[1]) < MIN_PAGE_WIDTH) continue;
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

  // --- a chapter's pages, read out of its markup -------------------------------
  //
  // The reader changes chapter without leaving the page: it fetches the next
  // chapter's markup and asks this file for its pages. It used to be handed
  // `images`, the first sixty pictures of the page whatever they were, which is
  // a search result's preview and not a chapter. Measured on real sites: every
  // chapter past sixty pages came back cut at sixty (H11); asurascans gained its
  // series cover as a page; rizzfables an avatar and an unrelated upload;
  // mangaread forty pages and twenty stickers and covers; manhuaplus, whose
  // pages are drawn by a script, eight covers of other series and nothing else
  // (RS-1).
  //
  // What tells a chapter's pages from the rest of a page is where a site files
  // them. Every chapter of a series is filed the same way: the same host, the
  // same depth of folders, the same words in them, only the parts that number
  // the chapter (and sometimes date its upload) changing. The pages already on
  // screen show exactly that shape, so the next chapter's pages are the images
  // filed in it: /asura-images/chapters/<series>/8/ beside .../7/, never
  // /asura-images/covers/. With no page on screen to compare (the reader's own
  // pages were blob: addresses), the biggest folder of files not named like
  // furniture stands in. Too few either way is an empty answer, and the reader
  // then loads the chapter the old way rather than showing something else.

  /** Names a page of a chapter is never given, and a site's furniture is. */
  const FURNITURE_FILE = /cover|thumb|avatar|pfp|profile|gravatar|logo|icon|banner|sprite|emoji|emote|sticker|badge|achievement|award|medal|flag|button|placeholder|spacer|blank|loading/i;

  /** WordPress's resized copy of an upload ("-193x278.jpg"): a theme's thumbnail, never a page as uploaded. */
  const RESIZED = /-\d{2,4}x\d{2,4}\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i;

  /** Where an address is filed: its host, the site it belongs to, its folders. */
  function shapeOf(url) {
    let u;
    try { u = new root.URL(url); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/');
    return {
      host,
      // cdn1.example.com and cdn2.example.com are one site handing out files
      // from two machines; a page and its next chapter may come from either.
      site: host.split('.').slice(-2).join('.'),
      dirs: parts.slice(1, -1),
      file: parts[parts.length - 1] || '',
    };
  }

  const hasDigit = (s) => /\d/.test(s);

  /**
   * Whether two addresses are filed the same way: same site, same depth, and
   * the same folder names but for the last one (the chapter's own folder) and
   * any that carry digits (a chapter number, an upload date, an id).
   */
  function sameShape(a, b) {
    if (a.site !== b.site || a.dirs.length !== b.dirs.length) return false;
    const last = a.dirs.length - 1;
    return a.dirs.every((d, i) => d === b.dirs[i] || i === last || (hasDigit(d) && hasDigit(b.dirs[i])));
  }

  /**
   * The pages of the chapter in this markup, in order and in full, or [].
   *
   * @param {string[]} candidates every page-like image address of the markup
   *   (pageImages), in document order
   * @param {string[]} [like] addresses of pages of the chapter on screen
   */
  function stripPages(candidates, like) {
    const shapes = (like || []).map(shapeOf).filter(Boolean);
    let pages;
    if (shapes.length) {
      pages = candidates.filter((url) => {
        const s = shapeOf(url);
        if (!s || !shapes.some((l) => sameShape(s, l))) return false;
        // In the very folder of a page on screen, a file is a page whatever its
        // name. One folder over, a cover or a resized thumbnail is still what
        // its name says it is.
        if (shapes.some((l) => l.host === s.host && l.dirs.join('/') === s.dirs.join('/'))) return true;
        return !FURNITURE_FILE.test(s.file) && !RESIZED.test(url);
      });
    } else {
      const folders = new Map();
      for (const url of candidates) {
        const s = shapeOf(url);
        if (!s || FURNITURE_FILE.test(s.file) || RESIZED.test(url)) continue;
        const key = `${s.host}/${s.dirs.join('/')}`;
        if (!folders.has(key)) folders.set(key, []);
        folders.get(key).push(url);
      }
      pages = [];
      for (const list of folders.values()) if (list.length > pages.length) pages = list;
    }
    return pages.length >= MIN_GALLERY_IMAGES ? pages : [];
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

  // --- the cover, from markup --------------------------------------------------
  //
  // og:image answers on most sites and on none of the ones that mattered: an
  // old chapter page (lelscans), a mobile novel page (m.webnovel.com), an
  // anime page. Those tiles stayed grey for weeks, and the reader's word was
  // "take the header or whatever the site has, every time". So the meta tag
  // is the first of six looks, and the last is the first picture on the page
  // that is not chrome: a logo is worse than nothing, but a page of the
  // chapter itself is a fine cover for a series whose site offers no other.
  //
  // Sizes cannot be measured here (no DOM): width/height attributes are read
  // when a tag carries them, the file name otherwise. detect.js's coverGuess
  // does the same job on the live page with real sizes.

  /** The address an <img> tag really shows, lazy attributes first. */
  const imgSrc = (tag) => {
    for (const re of SRC_ATTRS) {
      const m = re.exec(tag);
      if (m) {
        const raw = m[1].trim().split(/[\s,]+/)[0];
        if (raw && !raw.startsWith('data:')) return raw;
      }
    }
    return null;
  };
  const attrNum = (tag, name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(tag);
    return m ? Number(m[1]) : null;
  };
  /** A tag whose declared size says "icon". Undeclared sizes are not held against it. */
  const tinyByAttr = (tag) => {
    const w = attrNum(tag, 'width');
    const h = attrNum(tag, 'height');
    return (w !== null && w < 80) || (h !== null && h < 80);
  };
  const COVERISH = /cover|poster|thumb|affiche|wp-post-image|jaquette|visuel|portrait|summary_image|series-img|manga-img|anime-img|book-img|novel-img/i;

  function coverFromMarkup(html, baseUrl) {
    html = String(html || '');
    // 1. What the site tells crawlers to show for this page.
    const og = /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["']/i.exec(html)
      || /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/i.exec(html);
    if (og) return absolute(og[1].trim(), baseUrl);
    // 2. The older spelling of the same thing.
    const rel = /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i.exec(html);
    if (rel) return absolute(rel[1].trim(), baseUrl);
    // 3. Structured data: "image": "…" or "image": { "url": "…" }.
    const ld = /"image"\s*:\s*(?:\{[^}]*"url"\s*:\s*)?"(https?:[^"]+\.(?:jpe?g|png|webp|avif|gif)[^"]*)"/i.exec(html);
    if (ld) return absolute(ld[1], baseUrl);
    // 4 to 6. The page's own pictures, best first.
    const tags = html.match(IMG_TAG) || [];
    const pictures = [];
    for (const tag of tags) {
      const src = imgSrc(tag);
      if (!src || CHROME_SRC.test(src) || CHROME_TAG.test(tag) || tinyByAttr(tag)) continue;
      if (!IMAGE_EXT.test(src) && !/\/\d{1,4}(\?|#|$)/.test(src) && !/\?/.test(src)) continue;
      pictures.push({ tag, src });
    }
    // 4. One that says it is a cover.
    const said = pictures.find(({ tag, src }) => COVERISH.test(`${tag} ${src}`));
    if (said) return absolute(said.src, baseUrl);
    // 5. One drawn portrait, by its declared size.
    const portrait = pictures.find(({ tag }) => {
      const w = attrNum(tag, 'width');
      const h = attrNum(tag, 'height');
      return w !== null && h !== null && h >= w * 1.2 && h <= w * 2.2;
    });
    if (portrait) return absolute(portrait.src, baseUrl);
    // 6. The first picture at all.
    return pictures.length ? absolute(pictures[0].src, baseUrl) : null;
  }

  /** Kept under its old name for the callers that had it. */
  const coverOf = coverFromMarkup;

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
    return text.split('\n').map((s) => s.trim()).filter((s) => proseLength(s) >= PROSE_MIN_LINE);
  }

  /**
   * A line's length as prose. The rule is shared/site-rules.js's, so that this
   * file and detect.js weigh a line of Japanese the same way (a character of a
   * script written without spaces counts as three, see proseLength there).
   * Plain length when that file is not loaded.
   */
  const proseLength = (s) => (root.PanelFlowSites && root.PanelFlowSites.proseLength
    ? root.PanelFlowSites.proseLength(s) : String(s || '').length);

  const readsLikeProse = (lines) =>
    lines.length >= PROSE_MIN_LINES &&
    lines.reduce((n, s) => n + proseLength(s), 0) >= PROSE_MIN_CHARS;

  /**
   * @param {string} html      the page's markup
   * @param {string} [url]     the page's URL — used for URL heuristics and to
   *                           absolutise image sources
   * @param {object} [opts]
   * @param {object} [opts.rules] the parsed `shared/detection-rules.json`
   * @param {string[]} [opts.like] addresses of pages of the chapter the reader
   *                           is on, which `pages` is held to (see stripPages)
   * @returns {{verdict: 'ready'|'likely'|'unknown'|'unlikely', score: number,
   *            signals: string[], reason: string, images: string[],
   *            pages: string[], imageCount: number, title: ?string,
   *            coverUrl: ?string, chapterLabel: ?string, latestChapter: ?string,
   *            knownDomain: boolean, engine: ?string}}
   *
   * `images` is a preview, sixty at most, of whatever pictures the page has;
   * `pages` is the chapter itself, uncapped, or [] when the markup does not
   * carry it. A reader changing chapter reads `pages`.
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
      reason = `text chapter (${prose.length} paragraphs of prose)`;
    } else if (scripted) {
      verdict = 'unknown';
      reason = 'the reader builds its pages in JavaScript, so open it to find out';
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
      pages: stripPages(images, opts.like),
      imageCount: images.length,
      title: titleOf(html),
      coverUrl: coverOf(html, url),
      chapterLabel: chapterLabel(url, titleOf(html)),
      latestChapter: latestChapter(html, url),
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
  function latestChapter(html, url) {
    const link = /(?:href|value|data-href|data-url)=["']([^"']+)["']/gi;
    const sites = root.PanelFlowSites;
    const slug = sites && url ? sites.seriesSlug(url) : null;
    // This series' own links first (the sidebar links other series' latest
    // chapters, which can run into the thousands); every link only when the
    // site's chapter addresses name no series.
    const scan = (keep) => {
      let max = null;
      for (const m of String(html || '').matchAll(link)) {
        if (!keep(m[1])) continue;
        const found = chapterNumber(m[1]);
        if (found === null || found === undefined) continue;
        const n = parseFloat(found);
        if (max === null || n > max) max = n;
      }
      return max;
    };
    const max = (slug ? scan((h) => sites.sameSeriesLink(h, slug)) : null) ?? scan(() => true);
    return max === null ? null : String(max);
  }

  root.PanelFlowCompat = {
    analyze, pageImages, stripPages, chapterLabel, latestChapter, coverFromMarkup,
    WEIGHTS, THRESHOLD, MIN_GALLERY_IMAGES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
