// PanelFlow detection engine (content script, document_idle).
//
// The product's central bet lives here: PanelFlow works on **any** manga site,
// not on a list of them. This file decides, from the page alone, whether what
// the reader is looking at is a chapter — and if it is, offers a pill. It never
// switches by itself. That single rule is what makes a wrong answer cost an
// ordinary browser tab and nothing else, and it is why the heuristics below are
// allowed to be heuristics.
//
// **How the answer is reached.** A page scores against
// `shared/detection-rules.json` and passes at 50:
//
//     knownDomain    100   someone looked at this site and wrote a rule
//     imageGallery    40   several big images clustered in one container
//     knownEngine     40   the markup of a CMS theme (Madara, Themesia, …)
//     urlPattern      20   /chapitre-109/, /read/, …
//     chapterNav      20   a "next chapter" link
//     lowTextDensity  10   pictures, not an article
//
// `knownEngine` is 40 and not 50 on purpose: a theme's own home page is built
// from that theme too, so recognising the engine must not be enough on its own.
//
// **Reading order.** Six sections, and they are a pipeline:
//
//   which site is this?   → asks shared/site-rules.js; never a hostname test
//   scoring               → galleryImages() and the weights above
//   is this a chapter?    → the veto: a catalogue also has big images
//   prose chapters        → light novels, where there are no images at all
//   pill UI               → the offer, and only ever an offer
//   scan orchestration    → when to re-run: SPA navigation, lazy loading
//
//     grep -n '^\s*// ---' extension/content/detect.js
//
// **Before changing anything here, ask whether the fix belongs in
// `shared/detection-rules.json` instead.** A site that stopped working is
// almost always a selector, and that file reaches every client within six hours
// with no release. Code changes here ship on the store's schedule.
//
// Dependency-free and guarded (`window.__panelflowDetectLoaded`) so it can be
// injected repeatedly; the phones inject this exact file through a `chrome.*`
// shim. There is no mobile fork.
(() => {
  'use strict';
  if (window.top !== window) return; // top frame only
  if (window.__panelflowDetectLoaded) return;
  window.__panelflowDetectLoaded = true;

  const FALLBACK_RULES = {
    heuristics: {
      scoreThreshold: 50,
      minGalleryImages: 3,
      minImageWidth: 400,
      urlPatterns: [
        '/(manga|manhwa|manhua|comic|scan|webtoon)s?/',
        '[/_-](chapter|chapitre|chap|ch)[-_/ ]?\\d+',
        '/read(er)?/',
      ],
      navTextPatterns: ['next chapter', 'previous chapter', 'chapitre suivant'],
      weights: {
        imageGallery: 40, urlPattern: 20, chapterNav: 20, lowTextDensity: 10,
        knownEngine: 40, knownDomain: 100,
      },
    },
    engines: {},
    domains: {},
  };

  let rules = FALLBACK_RULES;
  let detection = null; // { score, container, images, domainRule }
  // What this site calls things, once something recognises it — see siteFor().
  let site = null;
  // Up here, not next to scheduleScan() 550 lines down: the getRules callback
  // below is the first thing to call it, and a host that answers synchronously
  // (a shim, a mock) would hit the dead zone of a `let` further down the file
  // and take the whole detector out with a ReferenceError.
  let scanTimer = null;

  chrome.runtime.sendMessage({ type: 'getRules' }, (resp) => {
    if (!chrome.runtime.lastError && resp && resp.rules) {
      rules = resp.rules;
      site = null; // whatever the fallback rules concluded was answered blind
    }
    scheduleScan();
  });

  // --- which site is this? -------------------------------------------------

  /** The first match for a selector, without letting a bad one throw at us. */
  const firstMatch = (sel) => {
    try { return sel ? document.querySelector(sel) : null; } catch { return null; }
  };

  // Which chapter a URL or a title names — see shared/site-rules.js, which owns
  // the rule so that this file and compat.js cannot disagree about it. Read
  // through the global rather than assumed: site-rules.js is injected first
  // everywhere (a test enforces the order), but the phone shells wrap each
  // injected file in its own try/catch, and one that failed to parse must cost
  // a chapter label, not the whole detector.
  const chapterNumber = (text) => window.PanelFlowSites?.chapterNumber?.(text) ?? null;
  const volumeNumber = (text) => window.PanelFlowSites?.volumeNumber?.(text) ?? null;

  /**
   * What this site calls things: its own entry in the rules file, or the reader
   * engine its markup gives away (shared/site-rules.js). Kept once found —
   * scan() runs again on every mutation of an infinite-scrolling reader, and
   * this is a handful of querySelector calls each time. A miss is deliberately
   * not cached: the engine's markup may simply not have been built yet.
   */
  function siteFor() {
    if (!site && window.PanelFlowSites) {
      site = window.PanelFlowSites.resolveSite({
        host: location.hostname,
        rules,
        ask: (sel) => !!firstMatch(sel),
      });
    }
    return site;
  }

  // --- scoring -------------------------------------------------------------

  function galleryImages() {
    const h = rules.heuristics;
    // When the engine names the reading strip, look inside it and nowhere else.
    // Clustering below picks the container holding the most panels, and on a
    // page whose "you may also like" carousel is bigger than the chapter, that
    // is the wrong container. Additive, never subtractive: a selector that has
    // stopped matching — or that holds nothing yet — hands the document back.
    const scope = firstMatch(siteFor()?.imageContainer);
    let imgs = [...(scope ? scope.querySelectorAll('img') : document.images)].filter(sizedImage);
    if (scope && imgs.length < h.minGalleryImages) {
      imgs = [...document.images].filter(sizedImage);
    }
    if (imgs.length < h.minGalleryImages) return null;

    // Group candidate images by ancestor container (up to 4 levels up) and
    // pick the container holding the most of them — that's the reading strip.
    // An image walks its own ancestors, each of them once, so a list can never
    // hold the same image twice and appending beats rebuilding the array on
    // every step: a 200-panel strip copied 800 arrays to learn nothing.
    const counts = new Map();
    for (const img of imgs) {
      let node = img.parentElement;
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        const list = counts.get(node);
        if (list) list.push(img);
        else counts.set(node, [img]);
      }
    }
    let best = null;
    for (const [node, list] of counts) {
      if (list.length >= h.minGalleryImages && (!best || list.length > best.images.length)) {
        best = { container: node, images: list };
      }
    }
    if (!best) return null;
    best.images.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    return best;
  }

  /** An image big enough, and laid out enough, to be a page of a chapter. */
  function sizedImage(img) {
    const h = rules.heuristics;
    const r = img.getBoundingClientRect();
    // Nothing decoded yet, so there is nothing to measure but the room the page
    // has made for it. A panel-width box with an address in it is a page on its
    // way, and judging it on the height it does not have yet is how we used to
    // lose whole chapters: mangas-origines holds back everything past page 2
    // (.ori-planche-attente, rendered height 0) and natomanga holds back all 25
    // for the first second, so both sites had two candidates and no reader.
    //
    // What the browser decoded is not always the panel either. A lazy-loading
    // theme (sushiscan.net among them) parks a spacer gif in `src` and keeps
    // the address in data-src, so naturalWidth answers for the spacer: every
    // panel below the fold failed the width test and the reader opened on the
    // four that happened to be on screen. Whenever lazySrc() would hand back
    // some other address, the decoded size is the wrong thing to measure.
    const address = lazySrc(img);
    if (!img.naturalWidth || address !== (img.currentSrc || img.src)) {
      return r.width >= h.minImageWidth && Boolean(address);
    }
    if (img.naturalWidth < h.minImageWidth || img.naturalHeight < 200) return false;
    // One collapsed dimension is a layout choice; both collapsed is display:none,
    // and that one still means no.
    return r.width > 0 || r.height > 0;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // --- is this page actually a chapter? ------------------------------------
  //
  // Scoring alone cannot tell a reading strip from a catalogue: a home page's
  // cover carousel is also "several big images in one container", and on a
  // wide screen it clears the threshold outright. Two structural gates below
  // decide it instead, both measured on the live sites:
  //   chapter  /comics/…/chapter/270  → 20 images, all x=273 w=720, y climbing
  //   carousel /                      → 3+ images, all y≈250, x climbing
  //
  // How many distinct horizontal bands the images occupy. A carousel is one
  // band however many covers it holds; a reading strip is one band per panel.
  // A fixed tolerance, not one scaled to the image: panels run to 12800px tall
  // and a proportional window would let one swallow every row below it. Items
  // sharing a band are top-aligned within a few pixels either way.
  const ROW_TOLERANCE = 40;

  function rowCount(images) {
    const tops = [];
    for (const img of images) {
      const top = img.getBoundingClientRect().top;
      if (!tops.some((t) => Math.abs(t - top) < ROW_TOLERANCE)) tops.push(top);
    }
    return tops.length;
  }

  // "Next" on its own is a carousel arrow. Only the full phrase means the page
  // has chapter navigation, which is the thing a catalogue never has.
  const STRONG_NAV =
    /(next|previous|prev)\s+(chapter|chap|episode)|chapitre\s+(suivant|pr[eé]c[eé]dent)|次の話|前の話/i;

  // The first 400 clickable things on the page, walked without ever building
  // the other several thousand. `[...querySelectorAll(…)].slice(0, 400)` spreads
  // the whole list first, and the pages this runs on — a catalogue, an
  // infinite-scrolling reader — are exactly the pages with thousands of links,
  // on a scan that repeats until a detection sticks.
  const CLICKABLE_SCAN = 400;
  function someClickable(fn) {
    const found = document.querySelectorAll('a, button');
    const end = Math.min(found.length, CLICKABLE_SCAN);
    for (let i = 0; i < end; i++) if (fn(found[i])) return true;
    return false;
  }

  function hasChapterNav() {
    return someClickable((a) => {
      const t = (a.textContent || '').trim();
      return t.length < 40 && STRONG_NAV.test(t);
    });
  }

  // A chapter page names its chapter — in the URL or the <title> — or carries
  // prev/next chapter links. A home page or a series listing does neither.
  function chapterEvidence() {
    if (location.pathname === '/') return false; // a home page is never a chapter
    if (chapterLabelHere()) return true;
    if (/\/read(er)?(\/|$)/i.test(location.pathname)) return true;
    return hasChapterNav();
  }

  // --- prose chapters ------------------------------------------------------
  //
  // Plenty of what people follow is text: web novels, light-novel translations,
  // the novel half of sites that carry both. None of it has a reading strip, so
  // everything above rejects it, and the reader — bookmark, progress, history,
  // reading clock — never applies to a series that happens not to be drawn.
  //
  // The container is found the way the gallery is: group the candidates by
  // parent and take the parent holding the most. Prose is the one thing a page
  // has a lot of, so the risk is not missing it, it is claiming a comment
  // thread or an article. Hence the length floors, the link-density check, and
  // a caller that will not accept this without chapter evidence in the URL or
  // in prev/next links.

  const MIN_NOVEL_CHARS = 1200;
  const MIN_NOVEL_PARAS = 5;
  // Where a chapter body lives when the site does not use <p> at all — a single
  // block of text broken by <br>, which is most of the older novel sites.
  const NOVEL_CONTAINERS =
    '#chapter-content, .chapter-content, .entry-content, .reading-content, ' +
    '.text-content, .chapter-c, .novel-content, article, main';

  /** Text that reads like a chapter: a run of long, mostly link-free lines. */
  function novelContent() {
    const fromParagraphs = paragraphContainer();
    if (fromParagraphs) return fromParagraphs;
    for (const el of [...document.querySelectorAll(NOVEL_CONTAINERS)].slice(0, 20)) {
      if (!isVisible(el)) continue;
      const paras = splitLines(el.innerText || '');
      if (!longEnough(paras) || linkDensity(el) > 0.25) continue;
      return { container: el, paragraphs: paras };
    }
    return null;
  }

  function paragraphContainer() {
    const counts = new Map();
    for (const p of document.querySelectorAll('p')) {
      const text = (p.innerText || '').trim();
      // Short <p>s are bylines, captions, ad slots and cookie notices. A novel
      // has plenty of one-line dialogue, but never five hundred of them alone.
      if (text.length < 60 || !isVisible(p)) continue;
      const parent = p.parentElement;
      if (!parent) continue;
      const list = counts.get(parent);
      if (list) list.push(p);
      else counts.set(parent, [p]);
    }
    let best = null;
    for (const [container, ps] of counts) {
      const chars = ps.reduce((n, p) => n + p.innerText.length, 0);
      if (ps.length >= MIN_NOVEL_PARAS && chars >= MIN_NOVEL_CHARS &&
          (!best || chars > best.chars) && linkDensity(container) <= 0.25) {
        best = { container, chars, paragraphs: ps.flatMap((p) => splitLines(p.innerText)) };
      }
    }
    return best && longEnough(best.paragraphs) ? best : null;
  }

  // A <br>-separated body arrives as one string; a <p> can hold line breaks of
  // its own. Both come out as one paragraph per line either way.
  const splitLines = (text) => String(text || '')
    .split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 1);

  const longEnough = (paras) =>
    paras.length >= MIN_NOVEL_PARAS &&
    paras.reduce((n, s) => n + s.length, 0) >= MIN_NOVEL_CHARS;

  // A chapter body is prose with the odd link in it. A table of contents, a
  // comment thread and a sidebar are mostly links, and all three are long.
  function linkDensity(el) {
    const total = (el.innerText || '').length;
    if (!total) return 1;
    let linked = 0;
    for (const a of el.querySelectorAll('a')) linked += (a.innerText || '').length;
    return linked / total;
  }

  function scorePage() {
    const h = rules.heuristics;
    const w = h.weights;
    let score = 0;
    // Naming the host outright clears the threshold on its own; recognising the
    // engine does not, because `.reading-content` is Madara on its home page too.
    const domainRule = siteFor();
    if (domainRule) score += domainRule.knownDomain ? w.knownDomain : (w.knownEngine || 0);

    const gallery = galleryImages();
    if (gallery) score += w.imageGallery;

    const path = location.pathname + location.search;
    if (h.urlPatterns.some((p) => { try { return new RegExp(p, 'i').test(path); } catch { return false; } })) {
      score += w.urlPattern;
    }

    const navPat = h.navTextPatterns.map((t) => t.toLowerCase());
    if (someClickable((a) => {
      const t = (a.textContent || '').trim().toLowerCase();
      return t.length < 40 && navPat.some((p) => t.includes(p));
    })) score += w.chapterNav;

    // Text density, last and only when it can still change the verdict.
    // `innerText` is the most expensive line in the whole detector: it forces a
    // layout of the entire document and walks it, and this runs again on every
    // mutation of a page that has not settled yet. A known domain is already
    // past the threshold on its own, and a page too far below it cannot be
    // rescued by ten points — in both cases the answer is the same either way,
    // so it is not worth asking the question.
    if (gallery && score < h.scoreThreshold && score + w.lowTextDensity >= h.scoreThreshold) {
      const textLen = (document.body.innerText || '').length;
      if (textLen / gallery.images.length < 800) score += w.lowTextDensity;
    }

    return { score, gallery, domainRule };
  }

  // --- pill UI -------------------------------------------------------------

  function showPill() {
    if (document.getElementById('panelflow-pill')) return;
    const pill = document.createElement('button');
    pill.id = 'panelflow-pill';
    pill.textContent = `📖 ${t('pillReaderMode')}`;
    pill.title = t('pillReaderModeTitle');
    // The pill goes away when the reader is up, not when the click lands: if the
    // panels are not ready the open is a no-op, and a pill removed anyway leaves
    // the page with no visible way in.
    pill.addEventListener('click', (e) => {
      // Not the page's click. The pill sits in the site's document, so without
      // this the "click anywhere" pop-under handlers these sites hang off the
      // document fire on the one button PanelFlow puts on their page — an ad
      // tab as the price of opening the reader.
      e.stopPropagation();
      openReader().then((ok) => { if (ok) pill.remove(); });
    });
    document.documentElement.appendChild(pill);
  }

  // The rule is a parameter so the track-only path can pass its own: that path
  // deliberately leaves `detection` unset, and reading the site's heading with
  // no rule would fall back to <title> on the sites that need the rule most.
  function seriesMeta(domainRule) {
    const rule = domainRule || detection?.domainRule;
    // A heading is usually the series and the chapter in one element, so cut
    // everything from the chapter counter onwards ("Blue Box Chapter 5 —
    // SushiScan" → "Blue Box"). That is a position, not a vocabulary, which is
    // why it stays here.
    //
    // The words are not here any more. This used to carry its own regex of
    // four SEO words, frozen into a file that only changes when the extension
    // is republished; the list now lives in detection-rules.json and reaches
    // every client on a TTL, so the site's own hostname and the rules we
    // already fetched go along for the site-specific half of it.
    const clean = (s) => {
      const cut = String(s || '')
        .replace(/\s*(chapter|chapitre|ch\.?|episode|volume|tome|vol\.?)\s*[\d.]+.*$/i, '')
        .replace(/^[\s»«|•·:—–-]+|[\s»«|•·:—–-]+$/g, '')
        .trim();
      const opts = { host: location.hostname, rules };
      return window.PanelFlowMatch?.displayTitle
        ? window.PanelFlowMatch.displayTitle(cut, opts) : cut;
    };
    let title = null;
    // The engine's own heading, put through that same cleaner rather than taken
    // as it stands: most of these readers use one element for the series and the
    // chapter, so what it holds here is "Blue Box Chapter 5" and the series is
    // called Blue Box. A heading that cleans away to nothing falls through.
    if (rule && rule.title) title = clean(firstMatch(rule.title)?.textContent);
    if (!title) {
      // Falling back to the raw <title> would reintroduce the very chevrons
      // and separators we just stripped, so clean the fallback too.
      title = clean(document.title) || clean(document.title.replace(/[|–—:].*$/, '')) ||
        document.title.replace(/^[\s»«|•·:—–-]+|[\s»«|•·:—–-]+$/g, '').trim();
    }
    return {
      title,
      sourceDomain: location.hostname,
      sourceUrl: seriesUrlFromDom(title) || seriesUrlGuess(),
      chapterUrl: location.href,
      chapterLabel: chapterLabelHere(),
      coverUrl: coverGuess(),
      lastKnownChapter: latestChapterInDom(),
      genres: genresInDom(),
      language: languageGuess(),
      seriesStatus: statusGuess(),
    };
  }

  // Genre links are the one piece of catalogue metadata almost every scan site
  // exposes the same way: anchors pointing at a /genre/ or /tag/ listing.
  // Used to prefill the tag chips when adding to the library.
  //
  // Two kinds of genre link had to be told apart from the series' own, and
  // neither was. Every page of a scan site carries the site's genre *menu* in
  // its header, and most carry a "you may also like" rail whose cards link to
  // genres of their own. Kingdom — a war manga running since 2006 — was offered
  // "Romance" and "Adulte" as its tags, because those are two entries of
  // sushiscan's own dropdown and the dropdown is on every page of the site.
  //
  // So the site's furniture is skipped, and a page that offers more genres than
  // any one series has is read as a catalogue rather than as a description.
  const SITE_CHROME = 'nav, header, footer, aside, form, [role="navigation"],'
    + ' [role="banner"], [role="contentinfo"], .menu, .menus, .nav, .navbar,'
    + ' .navigation, .site-header, .site-footer, .mega-menu, .dropdown, .submenu';

  // Eight is the cap the library sheet applies anyway; twelve is the point at
  // which a list has stopped describing one book. Sushiscan's menu holds forty.
  const GENRE_CEILING = 12;

  function genresInDom(root = document) {
    const seen = new Set();
    for (const a of root.querySelectorAll('a[href*="/genre" i], a[href*="/tag" i], a[rel~="tag"]')) {
      // `closest` is missing on the elements some of our own tests hand in, and
      // on nothing a browser produces; no ancestor to check is not a menu.
      if (a.closest && a.closest(SITE_CHROME)) continue;
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      // Genre labels are short words, never sentences or chapter titles.
      if (!text || text.length > 24 || /\d{2,}/.test(text)) continue;
      if (CHAPTERISH.test(text)) continue;
      seen.add(text);
      // A menu this file failed to recognise, or the site's own genre index.
      // Nothing on such a page belongs to the series being read, and the wrong
      // eight out of forty is worse than none at all: no tags is a form the
      // reader fills in, wrong tags is one they have to notice first.
      if (seen.size > GENRE_CEILING) return [];
    }
    return [...seen];
  }

  // Latest chapter = max over the page's actual chapter links/dropdown
  // (a whole-page number max returns the chapter being read or a view count
  // instead of the real latest).
  //
  // Two passes over those elements, never one. A link's href names the series it
  // belongs to; its text does not, and the "you may also like" cards are links
  // too — theirs read "Hajime no Ippo Chapitre 1515". Taking href-or-text per
  // element and one maximum over the lot let a carousel that rotates on every
  // load answer for the series being looked at: 1515 on a page whose own
  // chapters stop at 125, and a different number a reload later.
  function latestChapterInDom(root = document) {
    const els = root.querySelectorAll('a[href], option');
    const scan = (textOf) => {
      let max = null;
      for (const el of els) {
        const found = chapterNumber(textOf(el));
        if (found === null) continue;
        const n = parseFloat(found);
        if (max === null || n > max) max = n;
      }
      return max;
    };
    const max = scan((el) => el.getAttribute('href') || el.getAttribute('value'))
      ?? scan((el) => (el.textContent || '').slice(0, 80));
    return max !== null ? String(max) : null;
  }

  // The chapter this page IS, normalised to "Ch. 109". Reads the URL first
  // (unambiguous), then falls back to the <title>; a bare number found loose
  // in the page is not trustworthy enough to label a chapter with.
  //
  // The fallback is what carries a site that addresses chapters by id rather
  // than by number: MangaDex's path says nothing chapterNumber will accept, and
  // its <title> says "Chapter 26".
  //
  // A volume is the fallback, never the winner: a page that says "Volume 3,
  // Chapter 21" is chapter 21. It is labelled "Vol. 3" and not "Ch. 3" on
  // purpose — see volumeNumber() in shared/site-rules.js for what reads these
  // labels back and why a volume must not answer to a chapter's number.
  function chapterLabelHere() {
    const path = location.pathname + location.search;
    const fromUrl = chapterNumber(path);
    const fromTitle = chapterNumber(document.title);
    // "/bleach-chapitre-686-5/" spells the decimal with a hyphen, which the
    // pattern reads as the end of chapter 686 — and 686 is a chapter of its
    // own, five days older. When the title agrees on the whole number and
    // knows a decimal too, it is the one that saw the point.
    const chapter = fromUrl !== null && fromTitle !== null && fromTitle.startsWith(`${fromUrl}.`)
      ? fromTitle
      : fromUrl ?? fromTitle;
    if (chapter !== null) return `Ch. ${chapter}`;
    const volume = volumeNumber(path) ?? volumeNumber(document.title);
    return volume === null ? null : `Vol. ${volume}`;
  }

  function coverGuess(root = document) {
    const og = root.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content;
    if (og) return og;
    // Series pages without og:image: look for an <img> that smells like a cover.
    //
    // Read through lazySrc(), for the same reason panels are. A theme that
    // parks a transparent gif in `src` and keeps the address in data-src used
    // to have that gif filed as the cover — and unlike a panel, a cover is
    // written to the library once and shown on every card afterwards. An <img>
    // with no address behind it at all is not a cover either, whatever its
    // class says, so it does not get to win over the ones below it.
    const imgs = [...root.querySelectorAll('img')];
    const cand = imgs.find((img) => {
      const address = lazySrc(img);
      if (!address
        || !/cover|poster|thumb|affiche|wp-post-image/i.test(
          img.className + ' ' + address + ' ' + (img.alt || ''))) return false;
      // Only measure the element when what is decoded is the address itself.
      // Behind a spacer it is a 1x1 gif, and on a page we fetched and parsed
      // nothing is decoded at all; both are "no size yet", not "too small".
      if (address !== (img.currentSrc || img.src)) return true;
      return (img.naturalWidth || img.width || 100) >= 80;
    });
    if (cand) return absolute(lazySrc(cand));
    // Last resort: the tallest portrait image on the page. Covers are portrait;
    // chapter pages and banners are not.
    let best = null;
    for (const img of imgs) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h || w < 80 || h < w * 1.2 || h > w * 2.2) continue;
      if (!lazySrc(img)) continue;
      if (!best || h > best.h) best = { h, img };
    }
    return best ? absolute(lazySrc(best.img)) : null;
  }

  const absolute = (src) => {
    try { return src ? new URL(src, location.href).href : null; } catch { return src || null; }
  };

  // Which language the scan is in. The page itself declares this far more
  // reliably than any guess from the title, so preselect it in the add form.
  const LANG_NAMES = {
    en: 'English', ja: 'Japanese', ko: 'Korean',
    zh: 'Chinese (Simplified)', fr: 'French',
  };

  function languageGuess(root = document) {
    const raw =
      root.documentElement?.getAttribute('lang') ||
      root.querySelector('meta[property="og:locale"]')?.content ||
      root.querySelector('html')?.getAttribute('lang') ||
      '';
    const code = String(raw).toLowerCase().split(/[-_]/)[0];
    return LANG_NAMES[code] || null;
  }

  // "Ongoing" vs "Completed" decides whether the chapter count gets a "+".
  function statusGuess(root = document) {
    // innerText is empty on a detached DOMParser document, so fall back to
    // textContent when reading a fetched series page.
    const body = root.body?.innerText || root.body?.textContent || '';
    // Look near a Status/Statut label so a stray "completed" elsewhere on the
    // page cannot flip an ongoing series.
    const m = body.match(/(status|statut|état|state)\s*[:\-]?\s*([A-Za-zéèêç ]{3,20})/i);
    const value = (m ? m[2] : '').toLowerCase();
    if (/complete|completed|finished|terminé|termine|fini/.test(value)) return 'completed';
    if (/ongoing|publishing|en cours|releasing/.test(value)) return 'ongoing';
    return null;
  }

  // The page usually links to the series' real page (header title link,
  // breadcrumb). A real link beats any URL we could fabricate — fabricated
  // ones 404 on sites like scan-manga whose URL scheme is opaque.
  function seriesUrlFromDom(title) {
    const chapterish = /(chapter|chapitre|chap|ch|episode)[-_/ .]?\d/i;
    const candidate = (a) =>
      a.host === location.host && a.href !== location.href &&
      !chapterish.test(a.pathname) && a.protocol.startsWith('http');
    if (title && title.trim().length >= 4) {
      const t = title.trim().replace(/\s+/g, ' ').toLowerCase();
      let prefix = null;
      for (const a of document.querySelectorAll('a[href]')) {
        if (!candidate(a)) continue;
        const text = (a.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
        if (!text) continue;
        if (text === t) return a.href;
        // scan-manga-style: the series link's text starts with the title
        // ("Ao no Hako Vol. 13 • Ch. 109 - 15 Janvier").
        if (!prefix && (text.startsWith(t) || (text.length >= 6 && t.startsWith(text)))) {
          prefix = a.href;
        }
      }
      if (prefix) return prefix;
    }
    // Slug match: sites routinely put the series under a different path than
    // its chapters ("/chapter/erk-chapter-110/" vs "/manga/erk/"), so no URL
    // surgery can derive one from the other — but they share the slug.
    const slug = location.pathname
      .replace(/\/$/, '').split('/').pop()
      .replace(/[-_.](chapter|chapitre|chap|ch|episode)[-_. ]?[\d.].*$/i, '')
      .toLowerCase();
    if (slug.length >= 5) {
      for (const a of document.querySelectorAll('a[href]')) {
        if (!candidate(a)) continue;
        if (a.pathname.toLowerCase().includes(slug)) return a.href;
      }
    }

    const crumbs = [...document.querySelectorAll(
      '[class*="breadcrumb" i] a[href], [itemtype*="Breadcrumb"] a[href]'
    )].filter(candidate);
    return crumbs.length ? crumbs[crumbs.length - 1].href : null;
  }

  // Chapter navigation for the reader: the chapter list (dropdown or links)
  // plus prev/next targets, straight from the page's own DOM — the same data
  // MangaPin's per-site specs extract, discovered heuristically.
  const CHAPTERISH = /(chapter|chapitre|chap|ch|episode)[-_/ .]?\d/i;
  // NaN is "this link does not name a chapter", and every caller below already
  // treats it that way — which is what keeps MangaDex's `/chapter/<uuid>` links
  // out of the chapter wheel instead of filling it with numbers read out of a
  // UUID. CHAPTERISH above stays deliberately loose; this is the gate.
  const chapNum = (s) => {
    const found = chapterNumber(s);
    return found === null ? NaN : parseFloat(found);
  };

  // Words a site puts on a link that moves you one chapter, in place of the
  // chapter's name. Fine on the page, where the link sits next to the chapter
  // you are reading; useless in a dropdown, where "Next" is not an answer to
  // "which chapters are there".
  const NAV_WORD = /^(next|prev|previous|suivant(e)?|pr[eé]c[eé]dent(e)?|chapter|chapitre|chap|ch|episode|read|lire)$/i;

  /**
   * Whether a label is made of nothing but those words and punctuation. Word by
   * word rather than as one pattern, because the order is per-language: English
   * puts the direction last ("Next chapter"), French first ("Chapitre suivant"),
   * and a pattern written for one silently lets the other through. A label with
   * no letters at all — "«", "→" — is nav too: every() is true of nothing.
   */
  const isNavLabel = (s) =>
    s.split(/[^\p{L}]+/u).filter(Boolean).every((w) => NAV_WORD.test(w));

  /**
   * What to write in the chapter list for one entry. The number comes from the
   * URL, which every site agrees on; the site's own text is kept only when it
   * says something the number does not.
   */
  const optionLabel = (text, n) => {
    const label = String(text || '').trim().slice(0, 60);
    if (/\d/.test(label)) return label;      // already names its chapter
    if (Number.isNaN(n)) return label;       // nothing better to offer
    if (isNavLabel(label)) return `Ch. ${n}`;
    return `Ch. ${n} — ${label}`;            // a real name: "Prologue"
  };

  function chapterNav() {
    let options = [];
    // Which chapter this page is, needed twice below: to put it back into a
    // list that does not contain it, and to find its neighbours.
    const cur = chapNum(location.pathname + location.search);
    // 1. A <select> whose options carry chapter URLs (many readers have one).
    for (const sel of document.querySelectorAll('select')) {
      const opts = [...sel.options].filter((o) => {
        const v = o.value || '';
        return (v.startsWith('http') || v.startsWith('/')) &&
          (CHAPTERISH.test(v) || CHAPTERISH.test(o.textContent));
      });
      if (opts.length >= 3 && opts.length > options.length) {
        options = opts.map((o) => {
          const n = chapNum(o.value) || chapNum(o.textContent);
          return {
            label: optionLabel(o.textContent, n),
            url: new URL(o.value, location.href).href,
            n,
          };
        });
      }
    }
    // 2. Otherwise chapter links sharing this page's URL shape — and its series.
    // Every chapter-ish link on the page used to qualify, which is fine on a
    // reader that links nothing but its own chapters and wrong everywhere else:
    // MangaNato lists other series down the side, so the wheel for One Piece
    // 1139 read 1141, 1140, 1139, then 165, 150, 89, 63, 48, 28, 13, 9.
    //
    // seriesKey() is the reducer the library already matches URLs with, so a
    // site whose slugs it collapses cannot disagree with itself here. When it
    // cannot find a slug it hands back the whole URL; filtering on that would
    // match nothing at all, so an unkeyed page stays unfiltered as before.
    if (options.length < 3) {
      const key = window.PanelFlowMatch?.seriesKey?.(location.href);
      const wanted = typeof key === 'string' && key.includes('|') ? key : null;
      const seen = new Set();
      const fromLinks = [];
      for (const a of document.querySelectorAll('a[href]')) {
        if (a.host !== location.host || !CHAPTERISH.test(a.pathname + a.search)) continue;
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        if (wanted && window.PanelFlowMatch.seriesKey(a.href) !== wanted) continue;
        const n = chapNum(a.pathname + a.search);
        if (Number.isNaN(n)) continue;
        // The label matters most here: on a lot of sites the only chapter-ish
        // links on a chapter page are its own prev/next arrows, so this branch
        // is where a list of "Next / Prev" comes from.
        fromLinks.push({ label: optionLabel(a.textContent, n), url: a.href, n });
      }
      if (fromLinks.length >= 2) options = fromLinks;
    }
    // 3. Numeric-ID selects (scan-manga style): the selected option's value is
    // embedded in the chapter URL — swap it, plus the chapter number in the
    // slug, to build every chapter's URL. Verified against the live site.
    if (options.length < 3) {
      const curNum = chapNum(location.pathname);
      for (const sel of document.querySelectorAll('select')) {
        const cur = sel.selectedOptions[0];
        if (!cur || sel.options.length < 3 || !/^\d+$/.test(cur.value)) continue;
        if (!location.href.includes(cur.value)) continue;
        options = [...sel.options]
          .filter((o) => /^\d+$/.test(o.value))
          .map((o) => {
            const n = parseFloat(o.textContent); // labels like "110 - Interview"
            let url = location.href.replace(cur.value, o.value);
            if (!Number.isNaN(curNum) && !Number.isNaN(n)) {
              url = url.replace(
                new RegExp('((?:chapter|chapitre|chap|ch|episode)[-_ ]?)' +
                  String(curNum).replace('.', '\\.'), 'i'),
                '$1' + n);
            }
            return { label: optionLabel(o.textContent, n), url, n };
          });
        break;
      }
    }
    // When the list was built from this page's own prev/next links, the one
    // chapter missing from it is the one you are reading — and a select whose
    // value is absent displays whatever comes first, so the dropdown would
    // claim you were on the next chapter.
    if (!Number.isNaN(cur) && !options.some((o) => o.n === cur || o.url === location.href)) {
      options.push({ label: `Ch. ${cur}`, url: location.href, n: cur });
    }

    options.sort((a, b) => (b.n || 0) - (a.n || 0)); // newest first, like the sites
    if (options.length > 400) options = options.slice(0, 400);

    // prev/next: the engine's own arrows first — they are the one thing these
    // readers all place in the same element and label differently, sometimes
    // with nothing but an icon. Then explicit rel/text links, then neighbours in
    // the list. `el.href` is checked because a rule selector is free to land on
    // something that is not a link at all.
    const arrows = siteFor() || {};
    const findNav = (rel, textRe, named) => {
      const el = firstMatch(named) || document.querySelector(`a[rel="${rel}"]`) ||
        [...document.querySelectorAll('a[href]')].find((a) =>
          a.host === location.host && textRe.test((a.textContent || '').trim()) &&
          (a.textContent || '').trim().length < 30 && CHAPTERISH.test(a.pathname + a.search));
      return el && el.href && el.href !== location.href ? el.href : null;
    };
    let prevUrl = findNav('prev',
      /^(<|«|‹|←)?\s*(prev(ious)?( chapter)?|chapitre )?pr[eé]c[eé]dent|^prev/i, arrows.prevChapter);
    let nextUrl = findNav('next',
      /^(next( chapter)?|chapitre suivant|suivant)\s*(>|»|›|→)?$|^next/i, arrows.nextChapter);
    if ((!prevUrl || !nextUrl) && !Number.isNaN(cur) && options.length >= 2) {
      const idx = options.findIndex((o) => o.n === cur || o.url === location.href);
      if (idx !== -1) {
        if (!nextUrl && idx > 0) nextUrl = options[idx - 1].url; // newest-first
        if (!prevUrl && idx < options.length - 1) prevUrl = options[idx + 1].url;
      }
    }
    return { options, prevUrl, nextUrl };
  }

  function seriesUrlGuess() {
    // Series page ≈ chapter URL with the trailing chapter segment removed.
    // Cutting mid-segment leaves the separator behind (".../Ao-no-Hako-"),
    // which 404s, so always trim trailing separators off the result.
    const trim = (p) => p.replace(/[-_.\s]+$/, '');
    const attempts = [
      // Chapter token buried inside the last segment, e.g. scan-manga's
      // ".../Ao-no-Hako-Chapitre-109-FR_330666.html" → ".../Ao-no-Hako".
      // Tried first: it is the precise pattern, and the generic one below
      // would otherwise cut it at "Chapitre" and strand the separator.
      /[-_.](chapter|chapitre|chap|ch|episode)[-_. ]?[\d.][^/]*\/?$/i,
      // Chapter as its own trailing path segment: ".../erk/chapter-109".
      /\/((chapter|chapitre|chap|ch|episode)[-_ ]?[\d.]+[^/]*)\/?$/i,
    ];
    for (const re of attempts) {
      const stripped = trim(location.pathname.replace(re, ''));
      // A bare "/" or "" means we ate the whole path — not a series URL.
      if (stripped && stripped !== trim(location.pathname) && stripped !== '/') {
        return location.origin + stripped;
      }
    }
    return location.href;
  }

  // Every blob URL minted below. An object URL pins its bytes until it is
  // revoked, so without this a long session held every page of every chapter it
  // had ever opened — forty full-size images per chapter, for the life of the
  // tab. The reader hands the list back when it closes.
  const minted = new Set();
  const mint = (blob) => {
    const url = URL.createObjectURL(blob);
    minted.add(url);
    return url;
  };

  // Only ours: anything else in the list is the site's own URL or a plain http
  // src, and revoking one of those would break the page underneath.
  function releaseStable(urls) {
    for (const url of urls || []) {
      if (minted.delete(url)) URL.revokeObjectURL(url);
    }
  }

  // blob: page URLs die when the site revokes them (scan-manga revokes pages
  // you scrolled past). Copy the bytes into our own blob URL that we control;
  // if the original is already dead, rescue the decoded pixels off the <img>.
  // Where a page's address is when the <img> has not been given one yet. Lazy
  // loaders park it in a data- attribute and move it to src as you scroll, so
  // by reading the attribute we get pages the reader would otherwise have to
  // wait for the user to scroll past — which, inside our own reader, never
  // happens. Measured on sushiscan.net: 9 pages in src, 11 in data-src.
  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-lazy'];
  // A `data:` src too short to be a page of anything. Lazy-loading themes park
  // a transparent gif in `src` and keep the real address in `data-src`; the few
  // readers that inline a panel produce thousands of characters of base64.
  // Under half a kilobyte it is furniture, not a chapter.
  const SPACER_MAX = 512;
  const isSpacer = (src) => src.startsWith('data:') && src.length < SPACER_MAX;

  function lazySrc(img) {
    const src = img.currentSrc || img.src;
    // The loop below has always known a `data:` attribute is not an address and
    // this line did not, so on a theme that parks a spacer in `src` and the
    // address in `data-src`, the spacer won: the reader opened on seventy
    // copies of a transparent pixel, which is exactly what "the extension
    // activates and I cannot read the chapter" looks like from the outside.
    if (src && !isSpacer(src)) return src;
    for (const name of LAZY_ATTRS) {
      const v = img.getAttribute(name);
      if (v && !v.startsWith('data:')) return new URL(v, location.href).href;
    }
    // srcset without src: take the first candidate, dropping its descriptor.
    const set = (img.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0];
    if (set) return new URL(set, location.href).href;
    // Nothing but the spacer, and a spacer is not something to show anybody.
    // Every gate here reads '' as "no page behind this element".
    return '';
  }

  async function stableImageSrc(img) {
    const src = lazySrc(img);
    if (!src || !src.startsWith('blob:')) return src;
    try {
      const blob = await fetch(src).then((r) => r.blob());
      return mint(blob);
    } catch {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        if (blob) return mint(blob);
      } catch { /* fall through */ }
      return src;
    }
  }

  // The strip as it is now, not as it was when detection fired.
  //
  // Two things go stale between the two moments. The container can be the wrong
  // one outright: on natomanga the chapter's 25 <img> have no decoded size for
  // the first second, so the only cluster of big images on the page is the "you
  // may also like" carousel, and the reader opened on seven covers of other
  // people's series. And the right container can be half full: a paginated
  // reader keeps appending, and the snapshot took what had arrived.
  //
  // So the search is run again — it is one pass over the images — and its answer
  // is taken when it finds more than detection did. Then the winning container
  // is re-read directly: an <img> still loading counts as long as it has an
  // address to load from, because it is a page on its way, while one that has
  // finished loading small is an icon and is dropped. Nothing here ever returns
  // fewer panels than detection found; a page that has moved on under us is a
  // reason to fall back on the snapshot, not to lose the chapter.
  function currentStrip(gallery) {
    const fresh = galleryImages();
    const best = fresh && fresh.images.length > gallery.images.length ? fresh : gallery;
    const found = best.container?.querySelectorAll?.('img');
    if (!found) return best;
    const images = [...found].filter((img) =>
      (img.complete && img.naturalWidth ? sizedImage(img) : Boolean(lazySrc(img))));
    return images.length >= best.images.length ? { container: best.container, images } : best;
  }

  /** How many panels the page is offering right now. Nothing to count is 0. */
  function panelCount() {
    return detection?.gallery ? currentStrip(detection.gallery).images.length : 0;
  }

  /** Opens the reader. Resolves false when there was nothing to open with. */
  async function openReader() {
    if (!detection) return false;
    if (detection.novel) {
      window.PanelFlowReader.openText(
        detection.novel.paragraphs, seriesMeta(), detection.domainRule || {});
      return true;
    }
    // Panels that came from the site's API, not from the page: there is no
    // strip on screen to hand over, and nothing to re-measure — the list is
    // already the whole chapter, in order.
    if (detection.pages) {
      window.PanelFlowReader.open(detection.pages, seriesMeta(), detection.domainRule || {}, null);
      return true;
    }
    if (!detection.gallery) return false;
    const strip = currentStrip(detection.gallery);
    const srcs = (await Promise.all(strip.images.map(stableImageSrc))).filter(Boolean);
    // A panel still loading has no address to hand over yet, and a reader opened
    // on what is left is a near-blank page with no way back — the caller that
    // thought this worked has already taken the pill away. Detection needs the
    // same count to fire at all, so a page that got here can reach it.
    if (srcs.length < rules.heuristics.minGalleryImages) return false;
    window.PanelFlowReader.open(srcs, seriesMeta(), detection.domainRule || {}, strip.container);
    return true;
  }

  // --- scan orchestration --------------------------------------------------

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 600);
  }

  // A tab opened in the background is not laid out: Chrome never brings its
  // lazy images into a viewport, so they have no size, and everything here
  // measures sizes. On natomanga that turned the whole chapter invisible and
  // left the "you may also like" covers as the only cluster of images on the
  // page — the reader opened on seven covers of other people's series, in the
  // one habit manga readers have most, middle-clicking a stack of chapters open.
  // Nothing is lost by waiting: nobody is reading a tab they cannot see, and the
  // page is measured for the first time at the moment it is first looked at.
  let waitingForView = false;
  function scanWhenSeen() {
    if (waitingForView) return;
    waitingForView = true;
    const onShow = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onShow);
      waitingForView = false;
      scheduleScan();
    };
    document.addEventListener('visibilitychange', onShow);
  }

  function scan() {
    if (document.hidden) return scanWhenSeen();
    const result = scorePage();
    // Both gates are veto-only: a page that clears the score still has to look
    // like a chapter and read like one, or the reader stays out of the way.
    if (result.gallery &&
        (rowCount(result.gallery.images) < 3 || !chapterEvidence())) return;
    if (result.score >= rules.heuristics.scoreThreshold && result.gallery) {
      detection = result;
      accept();
      return;
    }
    // No strip: the page may still be a chapter, in prose. The score is built
    // out of image signals and a novel clears none of them, so structure has to
    // carry it — and on its own it would fire on any long article. A chapter
    // number in the URL or real prev/next links is what an article never has;
    // a chapter number in the title alone is not enough, because "Chapter 3" is
    // a normal thing for a blog post to be called.
    if (!result.gallery && (urlLooksLikeChapter() || hasChapterNav()) && chapterEvidence()) {
      const novel = novelContent();
      if (!novel) return askForPages(result) || trackOnly(result);
      detection = { ...result, novel };
      accept();
    }
  }

  // A chapter whose panels are not on the page at all. MangaDex shows one at a
  // time and keeps three <img> around — the one being read and two preloads
  // with no box yet — so there is no strip to lift, and no amount of waiting
  // for the DOM produces one. Its rule names the API that lists them instead
  // (`pageApi`, see shared/panelflow-core.js) and the service worker makes the
  // call: this side sends the address it is on and never a URL to fetch.
  //
  // Once per address, whatever comes back, because scan() runs again on every
  // mutation of a page like this one.
  let pagesAsked = null;
  function askForPages(result) {
    if (!siteFor()?.pageApi || pagesAsked === location.href) return false;
    pagesAsked = location.href;
    chrome.runtime.sendMessage({ type: 'chapterPages', url: location.href }, (resp) => {
      if (chrome.runtime.lastError || detection) return;
      const pages = (resp && resp.pages) || [];
      // Nothing to read: a chapter hosted on the publisher's own site, a rate
      // limit, an answer whose shape moved. It was still read, so record it.
      if (pages.length < rules.heuristics.minGalleryImages) {
        trackOnly(result);
        return;
      }
      detection = { ...result, pages };
      accept();
    });
    return true;
  }

  // A chapter we can follow but cannot render. Some readers keep two images in
  // the DOM and swap their src as you page through (scan-manga, mangas-origines
  // both do this) — there is no strip to lift, so no reader, and until now the
  // page went by in silence: no library entry, no progress, nothing.
  //
  // Reading the chapter still happened, so say so. Only on a domain the rules
  // already name, because outside that list "chapter-ish URL, no images" is
  // most of the web. No pill — there is nothing behind it — and the observer
  // stays connected, so if the panels do turn up later this becomes a real
  // detection on the next pass.
  let tracked = null;
  function trackOnly(result) {
    if (!result.domainRule || tracked === location.href) return;
    tracked = location.href;
    chrome.runtime.sendMessage({
      type: 'pageDetected',
      domain: location.hostname,
      url: location.href,
      meta: seriesMeta(result.domainRule),
    });
  }

  const urlLooksLikeChapter = () => {
    const path = location.pathname + location.search;
    return rules.heuristics.urlPatterns.some((p) => {
      try { return new RegExp(p, 'i').test(path); } catch { return false; }
    });
  };

  /** Everything that happens once a page is settled as a chapter. */
  function accept() {
    // Nothing left to watch for. The callback already ignored mutations once
    // a detection stuck, but the observer itself kept running for the life of
    // the tab — and the pages this fires on are infinite-scrolling readers
    // that mutate on every panel.
    observer.disconnect();
    showPill();
    // Ship the page's series meta along: Cloudflare-walled sites can only be
    // scraped from here, where the user's real session is (MangaPin's model),
    // so this is how covers and latest chapters stay fresh.
    chrome.runtime.sendMessage({
      type: 'pageDetected',
      domain: location.hostname,
      url: location.href,
      meta: seriesMeta(),
    });
    maybeAutoOpen();
  }

  // Auto-show reader, plus a one-shot reopen after the reader navigated
  // chapters in the same tab. The per-site override wins over the global
  // default; absent, the site follows the default.
  let autoOpened = false;
  function maybeAutoOpen() {
    if (autoOpened) return;
    const keys = ['autoShowDefault', 'autoShowSites', 'settings', 'reopenReaderFor'];
    chrome.storage.local.get(keys, (v) => {
      if (autoOpened || !detection) return;
      const reopen = v.reopenReaderFor === location.href;
      if (reopen) chrome.storage.local.remove('reopenReaderFor');
      const site = (v.autoShowSites || {})[location.hostname];
      const auto = site !== undefined
        ? site
        : (v.autoShowDefault ?? !!v.settings?.autoOpenReader);
      if (reopen || auto) autoOpenNow();
    });
  }

  // Detection settles as soon as three panels have a size, which on a paginated
  // reader is well before they have a src worth reading — measured on natomanga,
  // where auto-open beat the panels every time and left neither reader nor pill.
  // So: try, and if the panels are not there yet come back a few times rather
  // than once. Bounded, because a page that never fills in is a page where the
  // pill has to stay reachable instead of a timer running for the life of the
  // tab. The whole run is ~5s, and the flag is only set on the try that worked.
  //
  // "Ready" is not a count, it is a strip that has stopped growing: opening on
  // the first three panels that show up gives a four-page chapter that looks
  // complete and is not. So each try counts the panels and, while that number is
  // still climbing, hands the turn to the next try instead of opening. The
  // baseline is what detection saw, so a page that was already whole opens at
  // once and pays nothing for this. The last try opens on whatever it has: a
  // strip that never settles is still better read than not read.
  const AUTO_OPEN_TRIES = 6;
  const AUTO_OPEN_WAIT = 900;
  function autoOpenNow(attempt = 0, before = detection?.gallery?.images?.length || 0) {
    if (autoOpened || !detection) return;
    const last = attempt + 1 >= AUTO_OPEN_TRIES;
    const now = panelCount();
    const again = () => setTimeout(() => autoOpenNow(attempt + 1, now), AUTO_OPEN_WAIT);
    if (!last && now > before) {
      again();
      return;
    }
    // Taken back off only on success; a page that ends up not opening keeps it.
    const pill = document.getElementById('panelflow-pill');
    openReader().then((ok) => {
      if (ok) {
        autoOpened = true;
        pill?.remove();
        return;
      }
      if (!last) again();
    });
  }

  // Lazy-loaded images and SPA navigations: rescan on DOM changes (debounced)
  // until a detection sticks, and every time the address changes under us.
  const observer = new MutationObserver(() => { if (!detection) scheduleScan(); });
  const watchDom = () => observer.observe(document.body, { childList: true, subtree: true });
  watchDom();

  // An SPA navigation is a new page with no new document: the detection is
  // stale, the pill points at the chapter before last, the reader is full of
  // the previous chapter's panels, and the observer was disconnected by the
  // accept() of the page that just went away.
  //
  // `popstate` alone only covers the Back button. MangaDex — and every other
  // reader built as a single-page app — moves to the next chapter by calling
  // `history.pushState`, which fires nothing. The usual answer, patching
  // `history.pushState`, cannot work here: a content script runs in its own
  // JavaScript realm, so the patch is invisible to the page's own copy of
  // history. The permission that would work, `webNavigation`, spends "read
  // your browsing history" on the install screen — too much to ask of someone
  // installing a zip a friend sent them.
  //
  // So watch the address itself. One string comparison a second catches every
  // way a page can replace itself, including the ones nobody has invented yet.
  // The hash is left out: `#page-4` is an anchor inside the same chapter, and
  // readers move it as you scroll. Our own chapter navigation reloads the
  // document (see `reopenReaderFor`), so it never comes through here.
  const addressHere = () => location.pathname + location.search;
  let address = addressHere();
  function addressChanged() {
    if (addressHere() === address) return;
    address = addressHere();
    detection = null;
    tracked = null;
    site = null;
    autoOpened = false;
    document.getElementById('panelflow-pill')?.remove();
    if (window.PanelFlowReader?.isOpen?.()) window.PanelFlowReader.close();
    watchDom();
    scheduleScan();
  }
  addEventListener('popstate', addressChanged);
  setInterval(addressChanged, 1000);

  // A chapter page often only shows its own number; the series page lists
  // every chapter. Fetching it from here rides the user's real session, so
  // Cloudflare-walled sites answer normally (the server gets challenged).
  // Returns null when the URL does not resolve — the caller uses that to reject
  // a guessed series URL. Some sites (scan-manga) expose series pages under a
  // path unrelated to their chapter URLs, so no amount of string surgery can
  // derive one; storing an unverified guess is what produces dead library
  // entries. A chapter URL that works beats a series URL that 404s.
  async function fetchSeriesInfo(url) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return null;
      const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
      // Soft 404s answer 200 with an error page; a real series page lists
      // chapters, so require at least one before trusting the URL.
      const latest = latestChapterInDom(doc);
      if (latest === null && /erreur|error|404|not found/i.test(doc.title || '')) return null;
      return {
        latest,
        // The series page is where the cover, status and genres actually live —
        // a chapter page has none of them.
        cover: coverGuess(doc),
        status: statusGuess(doc),
        language: languageGuess(doc),
        genres: genresInDom(doc),
      };
    } catch { return null; }
  }

  // Popup "add this page" + reader toggle (Alt+R command, popup button).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // The popup labels its reader button from this, so it must answer even on
    // pages where nothing was detected.
    if (msg.type === 'readerState') {
      sendResponse({
        detected: !!detection,
        open: !!window.PanelFlowReader?.isOpen?.(),
      });
      return; // sync response
    }
    if (msg.type === 'toggleReader') {
      if (window.PanelFlowReader?.isOpen?.()) {
        window.PanelFlowReader.close();
        sendResponse({ ok: true, open: false });
      } else if (detection) {
        // Same rule as the pill's own click: it is the open that earns its
        // removal. The response stays synchronous — the popup is asking what it
        // just did to the reader, and it cannot wait on the panels.
        openReader().then((ok) => {
          if (ok) document.getElementById('panelflow-pill')?.remove();
        });
        sendResponse({ ok: true, open: true });
      } else {
        sendResponse({ ok: false, error: 'No chapter detected on this page.' });
      }
      return; // sync response
    }
    if (msg.type === 'openLibraryModal') {
      (async () => {
        sendResponse(await window.PanelFlowLibraryModal.open(await enrichedMeta()));
      })();
      return true; // async response
    }
    if (msg.type !== 'getSeriesMeta') return;
    (async () => {
      sendResponse({ meta: await enrichedMeta() });
    })();
    return true; // async response
  });

  // Series meta plus whatever the series page adds (real latest chapter, cover)
  // — and a sourceUrl that has been checked to actually resolve.
  async function enrichedMeta() {
    const meta = seriesMeta();
    if (meta.sourceUrl && meta.sourceUrl !== location.href) {
      const extra = await fetchSeriesInfo(meta.sourceUrl);
      if (extra) {
        const cur = parseFloat(meta.lastKnownChapter);
        const real = parseFloat(extra.latest);
        if (!Number.isNaN(real) && (Number.isNaN(cur) || real > cur)) {
          meta.lastKnownChapter = String(real);
        }
        // A chapter page's "cover" is just its first panel — the series page's
        // is the real one, so it wins rather than only filling a gap.
        if (extra.cover) meta.coverUrl = extra.cover;
        if (extra.status) meta.seriesStatus = extra.status;
        if (!meta.language && extra.language) meta.language = extra.language;
        // And its genres, for the same reason and with the same precedence: a
        // chapter page has none of its own, so whatever was scraped there came
        // from the site's furniture.
        if (extra.genres?.length) meta.genres = extra.genres;
      } else {
        // The guess does not resolve. Pin the chapter URL instead: it is
        // reachable, so the entry stays clickable and progress still tracks.
        meta.sourceUrl = location.href;
        meta.seriesUrlVerified = false;
      }
    }
    // Said out loud so a caller that already has this cannot be made to fetch
    // the series page a second time — see enrich() in library-modal.js, which
    // opens the sheet on the cheap meta and asks for this one behind it.
    meta.enriched = true;
    return meta;
  }

  // Expose for reader.js: series meta, chapter navigation, blob rescue and the
  // matching release — whoever mints has to be the one who frees.
  //
  // lazySrc and sizedImage are here so the reader's harvest asks the same two
  // questions this file does — where the address is, and whether the thing is
  // a page — instead of keeping its own copy of the answers. It kept one, and
  // the copy did not know about the spacer gif: every panel behind one was
  // measured at 1x1 and dropped on its way into an open reader.
  window.__panelflowDetect = {
    seriesMeta, enrichedMeta, chapterNav, stableImageSrc, releaseStable, lazySrc, sizedImage,
    get detection() { return detection; },
  };
})();
