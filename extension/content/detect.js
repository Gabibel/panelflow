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

  /**
   * A string of HTML, as a page that enforces Trusted Types will take it.
   *
   * mangadex.org sends `require-trusted-types-for 'script'`, and from then on
   * every HTML sink refuses a plain string, DOMParser included. The extension
   * runs this file in an isolated world, which the page's policy does not
   * reach; the phone app runs it in the page's own world, where it does, so
   * every fetched page this file parses threw there. A policy of our own,
   * made on first use, hands the string over unchanged: what DOMParser builds
   * is an inert document, never run. A page whose CSP lists the policy names
   * it allows can still refuse ours; then the string goes as it always did.
   */
  let htmlPolicy;
  const asHTML = (s) => {
    if (htmlPolicy === undefined) {
      try {
        htmlPolicy = globalThis.trustedTypes?.createPolicy?.('panelflow-detect', { createHTML: (x) => x }) ?? null;
      } catch {
        htmlPolicy = null;
      }
    }
    return htmlPolicy ? htmlPolicy.createHTML(s) : s;
  };

  const FALLBACK_RULES = {
    heuristics: {
      scoreThreshold: 50,
      minGalleryImages: 3,
      minImageWidth: 400,
      urlPatterns: [
        '/(manga|manhwa|manhua|comic|scan|webtoon)s?/',
        '[/_-](chapter|chapitre|chap|ch|capitulo)[-_/ ]?\\d+',
        '/read(er)?/',
        '[/_-]episodes?[-_/]?\\d+',
        '[/_-]ep[-_/]?\\d+',
        '[?&]episode_no=\\d+',
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
  let fruitless = 0;

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
    if (brokenImage(img, address)) return false;
    if (!img.naturalWidth || address !== (img.currentSrc || img.src)) {
      return r.width >= minBoxWidth() && Boolean(address);
    }
    if (img.naturalWidth < h.minImageWidth || img.naturalHeight < 200) return false;
    // One collapsed dimension is a layout choice; both collapsed is display:none,
    // and that one still means no.
    return r.width > 0 || r.height > 0;
  }

  /**
   * How wide a box has to be for a page still loading to count as one.
   *
   * The rules say 400 px, measured on desktop screens. A phone in portrait is
   * 360 to 430 px wide, and a reading strip laid out with the site's margins
   * comes to 330 to 400 of them, so on a phone a page still loading never
   * cleared the bar and a chapter that opened on a laptop showed no reader
   * and no pill on the same site (rizzfables). Four fifths of the screen is
   * what a strip takes on a phone and a cover in a carousel does not. A
   * decoded image is still judged on its own pixels, below, which do not
   * depend on the screen.
   */
  const minBoxWidth = () =>
    Math.min(rules.heuristics.minImageWidth, Math.round((globalThis.innerWidth || 1024) * 0.8));

  /**
   * An <img> whose load is over and failed.
   *
   * What the ad blocker does to an advert: the request is refused, the
   * element stays where the page put it, often in a box as wide as a panel.
   * The checks below used to read that box as a page on its way, and a
   * refused banner between two panels became a page of the chapter, or three
   * of them a "chapter" of adverts (NEW-12). A load that is still pending is
   * not `complete`; one that never started (a lazy image below the fold) is
   * not either.
   */
  const brokenImage = (img, address = lazySrc(img)) =>
    img.complete && !img.naturalWidth && !!address && address === (img.currentSrc || img.src);

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
    /(next|previous|prev)\s+(chapter|chap|episode)|chapitre\s+(suivant|pr[eé]c[eé]dent)|次の話|前の話|次話|前話|次のエピソード|前のエピソード|[下上]一[章話话]|(다음|이전)\s?화(?![가-힣])/i;

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
    // The arrows the site's rule names are its chapter navigation, whatever
    // they say: syosetu's say "次へ" and "前へ" ("next", "previous"), which no
    // pattern here can take for a chapter turn (RS-2). Only an arrow to another
    // address, though. The same class turns the pages of syosetu's table of
    // contents (?p=2), and webtoons.com's list (&page=11): a link that stays on
    // this path is a page of this page, not the next chapter.
    const rule = siteFor();
    const elsewhere = (el) => {
      try { return !!el?.href && new URL(el.href).pathname !== location.pathname; } catch { return false; }
    };
    if (elsewhere(firstMatch(rule?.nextChapter)) || elsewhere(firstMatch(rule?.prevChapter))) return true;
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
    if (headingChapter() !== null) return true;
    if (/\/read(er)?(\/|$)/i.test(location.pathname)) return true;
    if (pageApiChapter()) return true;
    return hasChapterNav();
  }

  /**
   * Whether this site's own rule says the address is a chapter.
   *
   * A rule with a page API names the addresses it can list pages for, and
   * that is the most precise answer there is to "is this a chapter". MangaDex
   * addresses chapters by UUID (/chapter/c8d169e9-...), so the URL patterns,
   * which want a digit after "chapter/", saw a chapter only when its UUID
   * happened to begin with a digit: the six in sixteen that begin with a
   * letter were never detected (NEW-16).
   */
  function pageApiChapter() {
    const from = siteFor()?.pageApi?.from;
    if (!from) return false;
    try { return new RegExp(from).test(location.pathname); } catch { return false; }
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
  // How long a line has to be before it counts as prose at all.
  //
  // This is the guard that was missing, and a chapter picker walked straight
  // through the gap. On a Madara site the panels arrive late, `.reading-content`
  // is empty markup for a moment, and what is left in it is the "Sélectionner le
  // chapitre" list — nine hundred entries reading "Chapitre 882". Numerous
  // (well past five), long in total (well past 1200 characters), and made of
  // <option>s rather than <a>s, so the link-density check below saw no links
  // and waved it through. The reader then opened on the table of contents,
  // rendered as a novel, instead of on the chapter.
  //
  // 60 is not a new number: `shared/compat.js` — the same verdict reached from
  // raw markup on the server — has had `PROSE_MIN_LINE = 60` all along, and its
  // test "a chapter list is not prose, however long it is" is the case this
  // file was failing. The two are meant to agree; one of them simply had the
  // rule and the other did not.
  const MIN_NOVEL_LINE = 60;
  // Where a chapter body lives when the site does not use <p> at all — a single
  // block of text broken by <br>, which is most of the older novel sites.
  const NOVEL_CONTAINERS =
    '#chapter-content, .chapter-content, .entry-content, .reading-content, ' +
    '.text-content, .chapter-c, .novel-content, article, main';

  /**
   * How long a line of prose is, as Latin text would measure it: shared with
   * compat.js through shared/site-rules.js, which weighs a character of
   * Japanese, Chinese or Korean as three (RS-2). Plain length when that file
   * failed to load, which is what both detectors measured before.
   */
  const proseLength = (text) =>
    globalThis.PanelFlowSites?.proseLength?.(text) ?? String(text || '').length;

  /**
   * Text that reads like a chapter: a run of long, mostly link-free lines.
   *
   * Two separate questions, and they used to be answered by one filter. Where
   * the chapter is, is decided by its long lines: that is what tells a chapter
   * from a sidebar. What the chapter says is every line in it, short ones
   * included. The same sixty-character floor was applied to both, so every
   * short line of a chapter was left out of the reader: "No.", a line of
   * dialogue, a scene break. A chapter told in dialogue arrived with half its
   * lines missing.
   */
  function novelContent() {
    const fromParagraphs = paragraphContainer();
    if (fromParagraphs) return fromParagraphs;
    for (const el of [...document.querySelectorAll(NOVEL_CONTAINERS)].slice(0, 20)) {
      if (!isVisible(el)) continue;
      const text = el.innerText || '';
      if (!longEnough(splitLines(text)) || linkDensity(el) > 0.25) continue;
      return { container: el, paragraphs: bodyLines(allLines(text)) };
    }
    return null;
  }

  // How far a paragraph may sit inside wrappers of its own. Webnovel puts each
  // <p> in a <div> in a <div> (a comment bubble rides along in each), so no
  // two paragraphs share a parent and grouping by parent found nothing: a
  // chapter of forty paragraphs read as forty chapters of one.
  const MAX_PARAGRAPH_WRAP = 3;

  /** The outermost wrapper that holds this paragraph and no other. */
  function paragraphSlot(p) {
    let slot = p;
    for (let depth = 0; depth < MAX_PARAGRAPH_WRAP; depth++) {
      const up = slot.parentElement;
      if (!up || up.getElementsByTagName('p').length !== 1) break;
      slot = up;
    }
    return slot;
  }

  function paragraphContainer() {
    const counts = new Map();
    for (const p of document.querySelectorAll('p')) {
      const text = (p.innerText || '').trim();
      // Short <p>s are bylines, captions, ad slots and cookie notices. A novel
      // has plenty of one-line dialogue, but never five hundred of them alone.
      // This decides where the chapter is; what it says is read below. Weighed
      // by script (proseLength), so a line of Japanese counts (RS-2).
      if (proseLength(text) < MIN_NOVEL_LINE || !isVisible(p)) continue;
      const parent = paragraphSlot(p).parentElement;
      if (!parent) continue;
      const list = counts.get(parent);
      if (list) list.push(p);
      else counts.set(parent, [p]);
    }
    let best = null;
    for (const [container, ps] of counts) {
      const chars = ps.reduce((n, p) => n + proseLength(p.innerText), 0);
      if (ps.length >= MIN_NOVEL_PARAS && chars >= MIN_NOVEL_CHARS &&
          (!best || chars > best.chars) && linkDensity(container) <= 0.25) {
        best = { container, chars, long: ps.flatMap((p) => splitLines(p.innerText)) };
      }
    }
    if (!best || !longEnough(best.long)) return null;
    // The long paragraphs are the evidence; the chapter is all of them. "Ah !
    // Quelle amertume !" is twenty characters and still part of the story —
    // the reader used to open without a line of dialogue in it.
    const all = [...best.container.querySelectorAll('p')]
      .flatMap((p) => allLines(p.innerText));
    return { container: best.container, paragraphs: all.length ? all : best.long };
  }

  // A <br>-separated body arrives as one string; a <p> can hold line breaks of
  // its own. Both come out as one paragraph per line either way.
  const allLines = (text) => String(text || '')
    .split(/\n+/).map((s) => s.trim()).filter(Boolean);

  /** The long lines only: what decides that a block of text is a chapter. */
  const splitLines = (text) => allLines(text).filter((s) => proseLength(s) >= MIN_NOVEL_LINE);

  // A body without <p>s is read off its container's text, which also carries
  // the chapter's title and its "Previous / Next" links above and below. The
  // short lines inside the prose are the story; the ones around it are not.
  function bodyLines(lines) {
    const first = lines.findIndex((s) => proseLength(s) >= MIN_NOVEL_LINE);
    let last = lines.length - 1;
    while (last > first && proseLength(lines[last]) < MIN_NOVEL_LINE) last--;
    return first === -1 ? [] : lines.slice(first, last + 1);
  }

  const longEnough = (paras) =>
    paras.length >= MIN_NOVEL_PARAS &&
    paras.reduce((n, s) => n + proseLength(s), 0) >= MIN_NOVEL_CHARS;

  // A chapter body is prose with the odd link in it. A table of contents, a
  // comment thread and a sidebar are mostly links, and all three are long.
  function linkDensity(el) {
    const total = (el.innerText || '').length;
    if (!total) return 1;
    let linked = 0;
    // `option` alongside `a`: a chapter picker is a table of contents that
    // happens to be a <select>, and counting only anchors scored it at zero —
    // the emptiest possible answer for the densest possible navigation.
    for (const a of el.querySelectorAll('a, option')) linked += (a.innerText || '').length;
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
    // Only on a page that is a chapter: the reader asks for it back when it is
    // closed, and a pill with nothing behind it is a broken button.
    if (!detection || document.getElementById('panelflow-pill')) return;
    const pill = document.createElement('button');
    pill.id = 'panelflow-pill';
    // Already in the reader's language: a page translator (Chrome's, Safari's)
    // must not translate it a second time.
    pill.setAttribute('translate', 'no');
    labelPill(pill);
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
      // `autoOpened` too, and it matters: the automatic open may still be
      // waiting for the strip to stop growing (autoOpenNow), and when its turn
      // came it opened the reader a second time, from the page's own strip.
      // That second open threw away whatever the reader had done meanwhile: a
      // chapter changed in place snapped back to the page's chapter under its
      // new address, and a save in progress lost its reader.
      openReader().then((ok) => { if (ok) { autoOpened = true; pill.remove(); } });
    });
    document.documentElement.appendChild(pill);
    placePill(pill);
  }

  /**
   * The pill's own words. The book is a picture, not a word: kept out of the
   * button's name, which a screen reader used to begin with "open book emoji"
   * (QA re-test) — here and after a page-by-page chapter has been walked, which
   * rewrites the pill while it counts the pages.
   */
  function labelPill(pill) {
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '📖 ';
    pill.replaceChildren(glyph, t('pillReaderMode'));
  }

  /**
   * The pill on the part of the page that is on screen, at a finger's size.
   *
   * `position: fixed` is relative to the layout viewport, and the page sizes
   * that: a site with no viewport tag is laid out 980 px wide and shown at 0.4
   * on a phone, so a 44 px pill arrived 18 pt tall; a site whose pictures are
   * wider than the phone is laid out wider than the screen, and the pill's
   * corner was off it (QA, September 2026). So its bottom-right corner is put
   * at the visual viewport's, and it is scaled by the inverse of the zoom
   * (reader.css, #panelflow-pill.pf-vv). Where there is no visual viewport to
   * ask, it keeps the plain corner it always had.
   */
  function placePill(pill = document.getElementById('panelflow-pill')) {
    const vv = window.visualViewport;
    if (!pill || !vv || !vv.scale) return;
    const k = 1 / vv.scale;
    pill.classList.add('pf-vv');
    pill.style.setProperty('--pf-k', String(k));
    pill.style.left = `${vv.offsetLeft + vv.width - 16 * k}px`;
    pill.style.top = `${vv.offsetTop + vv.height - 16 * k}px`;
  }

  // Pinching and panning move the visual viewport under a fixed element;
  // followed at most once a frame.
  let pillFrame = 0;
  const followViewport = () => {
    if (pillFrame) return;
    pillFrame = requestAnimationFrame(() => { pillFrame = 0; placePill(); });
  };
  window.visualViewport?.addEventListener('resize', followViewport);
  window.visualViewport?.addEventListener('scroll', followViewport);

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
    // Which chapter this page is, read first: a title that ends on that very
    // number ("Scan One Piece 1019") ends on the chapter, not on the series.
    const here = chapterLabelHere();
    const picked = here ? null : selectedChapter();
    const heading = here || picked ? null : headingChapter();
    const chapterLabel = here || picked?.label || (heading !== null ? `Ch. ${heading}` : null);
    const clean = (s) => {
      const cut = String(s || '')
        .replace(/\s*(chapter|chapitre|ch\.?|episode|volume|tome|vol\.?)\s*[\d.]+.*$/i, '')
        .replace(/^[\s»«|•·:—–-]+|[\s»«|•·:—–-]+$/g, '')
        .trim();
      const opts = { host: location.hostname, rules, chapter: chapterLabel };
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
    const sourceUrl = seriesUrlFromDom(title) || seriesUrlGuess();
    // When the address and the <title> say nothing, the page still does: its
    // chapter list's pick (with the address to keep), or its heading (above).
    const meta = {
      title,
      sourceDomain: location.hostname,
      sourceUrl,
      chapterUrl: picked?.url || location.href,
      chapterLabel,
      coverUrl: coverGuess(),
      // This series' links first, by its slug; the page's sidebar links other
      // series' latest chapters. And never below the chapter on screen: the
      // last chapter of a series links only back, and the shelf said "latest:
      // 11" under a bookmark on 12 (QA It.7, phone n° 12).
      lastKnownChapter: atLeastThis(latestChapterInDom(document, sourceUrl || location.href), chapterLabel),
      genres: genresInDom(document, title),
      // What kind of work this is, decided once and here.
      //
      // Three answers, in order of how much they know. The rules file is first
      // because it is the only one that was told: a domain that says it serves
      // novels is a fact somebody wrote down, and it costs a line to correct
      // when a site changes. Then the page itself — a chapter made of prose is
      // a novel whatever the site is, which is what carries the sites nobody
      // has classified. Manga last, because it is what every entry in this
      // library was before the field existed.
      //
      // Deliberately not guessing `webtoon` from a long strip: a vertical
      // manga chapter looks exactly like one, and a wrong shelf that the reader
      // has to notice is worse than a right one they have to pick.
      //
      // Prose is a web novel until the reader says it is a light novel: nothing
      // on a page tells the two apart, and a reading site hosting prose is far
      // more often the first. The rules file still says "novel" for those sites,
      // which the core translates on the way in (normalizeMedium).
      medium: siteFor()?.medium || (videoPage() ? 'anime' : novelContent() ? 'webnovel' : 'manga'),
      language: languageGuess(),
      seriesStatus: statusGuess(),
    };
    if (meta.medium !== 'anime') return meta;
    // An episode is read the way the video bar reads it (shared/episode-page.js):
    // the series from the page's structured data, its season, the episode on
    // screen. The chapter reading above took Crunchyroll's title, "Saison 4 |
    // E1 - …", for the series, so the popup's and the phone's "Add" filed the
    // same page under another name than the bar's 🔖 did.
    const episode = window.PanelFlowEpisode?.describe();
    if (!episode?.title) return meta;
    return {
      ...meta,
      title: episode.title,
      sourceDomain: episode.sourceDomain,
      sourceUrl: episode.sourceUrl,
      chapterUrl: episode.chapterUrl || location.href,
      chapterLabel: episode.chapterLabel || null,
      coverUrl: meta.coverUrl || episode.coverUrl,
    };
  }

  /**
   * Whether this is an episode page rather than a chapter: its host is on the
   * video list, or it holds a <video>, or it picks episodes from a <select>.
   * The generic add button on the phone opens the sheet with this file's
   * meta, and an anime filed as a manga sends its progress to the wrong
   * catalogue on the reader's tracker.
   */
  function videoPage() {
    const host = location.hostname.replace(/^www\./, '');
    const known = Object.keys(rules?.videoDomains || {}).filter((k) => !k.startsWith('_'));
    if (known.some((h) => host === h || host.endsWith(`.${h}`))) return true;
    // The rest is the video bar's own reading (shared/episode-page.js), and
    // was a copy of it here: a page that says it is an episode, a <video>, an
    // episode picker, a player framed from another site on a page that names
    // its episode.
    return !!window.PanelFlowEpisode?.looksLikeVideoPage(known);
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

  /**
   * The words a genre may not be made of.
   *
   * A genre classifies a work; it never names it. One streaming site lists a
   * series' seasons and language editions as tags — "Détective Conan", "Détective Conan
   * saison 3", "Détective Conan vostfr" — and they arrived in the sheet as the
   * eight tags offered for the series. Every one of them was about that one
   * series, which is exactly what a genre is not.
   *
   * So a candidate that shares its words with the title is dropped. This is not
   * a rule about that site: any page whose "tags" are really links to the work's
   * own sub-pages produces the same thing, and the same test rejects it.
   */
  function namesTheWork(text, title) {
    if (!title) return false;
    const bare = (s) => String(s).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
    const a = bare(text);
    const b = bare(title);
    if (!a || !b) return false;
    // Either direction: the tag may be the title plus a season, or the title may
    // be the tag plus an episode.
    return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
  }

  function genresInDom(root = document, title = null) {
    const seen = new Set();
    for (const a of root.querySelectorAll('a[href*="/genre" i], a[href*="/tag" i], a[rel~="tag"]')) {
      // `closest` is missing on the elements some of our own tests hand in, and
      // on nothing a browser produces; no ancestor to check is not a menu.
      if (a.closest && a.closest(SITE_CHROME)) continue;
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      // Genre labels are short words, never sentences or chapter titles.
      if (!text || text.length > 24 || /\d{2,}/.test(text)) continue;
      if (CHAPTERISH.test(text)) continue;
      if (namesTheWork(text, title)) continue;
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
  /** The latest chapter found, raised to the one being read when that is further. */
  function atLeastThis(latest, label) {
    const here = label ? chapterNumber(String(label)) : null;
    if (here === null) return latest;
    if (latest === null || latest === undefined) return String(parseFloat(here));
    return parseFloat(here) > parseFloat(latest) ? String(parseFloat(here)) : latest;
  }

  function latestChapterInDom(root = document, seriesUrl = null) {
    const els = root.querySelectorAll('a[href], option');
    const scan = (textOf, keep = () => true) => {
      let max = null;
      for (const el of els) {
        if (!keep(el)) continue;
        const found = chapterNumber(textOf(el));
        if (found === null) continue;
        const n = parseFloat(found);
        if (max === null || n > max) max = n;
      }
      return max;
    };
    const href = (el) => el.getAttribute('href') || el.getAttribute('value');
    // This series' own links first: the sidebar links other series' latest
    // chapters, and one of them is always on chapter 2007. See seriesSlug in
    // shared/site-rules.js.
    const sites = window.PanelFlowSites;
    const slug = seriesUrl && sites ? sites.seriesSlug(seriesUrl) : null;
    const max = (slug ? scan(href, (el) => sites.sameSeriesLink(href(el), slug)) : null)
      ?? scan(href)
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

  /**
   * The chapter the page's own heading names, or null.
   *
   * Some readers say it nowhere else: webnovel.com's address is a slug and an
   * id, its <title> is "Le Cauchemar Commence - Esclave de l'Ombre - WebNovel",
   * and "Chapitre 1: Le Cauchemar Commence" is written only in the <h1> above
   * the text. The first h1 — then h2 — that *starts* with a chapter word and a
   * number: the page is about that one, and an infinite-scrolling reader that
   * has already appended chapter 2 below it still put chapter 1 first.
   */
  function headingChapter() {
    for (const tag of ['h1', 'h2']) {
      for (const h of document.querySelectorAll(tag)) {
        const text = (h.textContent || '').trim();
        if (!/^(chapitre|chapter|chap\.?|ch\.|episode|épisode)\s*\d/i.test(text)) continue;
        const n = chapterNumber(text);
        if (n !== null) return n;
      }
    }
    return null;
  }

  /** A listed reading site, on a page whose heading names its chapter. */
  const declaredChapter = () => !!siteFor() && headingChapter() !== null;

  /**
   * The chapter a page picks in its own chapter list, as { url, label }.
   *
   * lelscans shows its latest chapter at an address with no number in it
   * (/lecture-ligne-one-piece) and every page of a chapter at one that ends in
   * the page (/scan-one-piece/1194/3), and neither says "chapter" anywhere a
   * pattern could read it. What names the chapter is the <select> of chapters
   * at the top, and the option the server marked `selected` — the attribute,
   * not the property, which is true of the first option of every list. Its
   * address is also the one to bookmark: the landing page will show another
   * chapter next week.
   */
  function selectedChapter() {
    for (const select of document.querySelectorAll('select')) {
      const options = [...select.options];
      const chapters = options.filter((o) => /^https?:/i.test(o.value) && /^\s*\d+(\.\d+)?\s*$/.test(o.textContent));
      if (chapters.length < 3 || chapters.length < options.length / 2) continue;
      const picked = chapters.find((o) => o.defaultSelected);
      if (!picked) continue;
      return { url: picked.value, label: `Ch. ${picked.textContent.trim()}` };
    }
    return null;
  }

  function coverGuess(root = document) {
    const og = root.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content?.trim();
    // Made absolute like every other answer here: some themes write
    // "/wp-content/…" or "//cdn…", and the server keeps only an http(s)
    // address, so a cover written as the page wrote it was dropped on save.
    // Trimmed before the test: a blank one made absolute is the page itself.
    if (og) return absolute(og);
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
    if (best) return absolute(lazySrc(best.img));
    // Nothing portrait either: the first real picture on the page, so that a
    // site with no cover at all still gets its header rather than a grey
    // tile. Chrome (logos, icons, avatars) is not a picture.
    const CHROME = /(sprite|logo|icon|avatar|emoji|flag|pixel|blank|spacer|placeholder|loading)/i;
    const first = imgs.find((img) => {
      const address = lazySrc(img);
      if (!address || CHROME.test(`${img.className} ${img.id} ${img.alt || ''} ${address}`)) return false;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      return (!w && !h) || (w >= 120 && h >= 120);
    });
    return first ? absolute(lazySrc(first)) : null;
  }

  const absolute = (src) => {
    try { return src ? new URL(src, location.href).href : null; } catch { return src || null; }
  };

  // Which language the scan is in. The page itself declares this far more
  // reliably than any guess from the title, so preselect it in the add form.
  const LANG_NAMES = {
    en: 'English', ja: 'Japanese', ko: 'Korean',
    zh: 'Chinese (Simplified)', fr: 'French', es: 'Spanish',
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
  // `ep` and `episode_no=` for webtoons.com, whose episode links read
  // `/season-1-ep-12/viewer?title_no=95&episode_no=13` (see CHAPTER_IN in
  // shared/site-rules.js); `ep` with a boundary in front, so "step1" is not one.
  const CHAPTERISH = /(chapter|chapitre|chap|ch|episode)[-_/ .]?\d|(?:^|[^a-z])ep[-_/ .]?\d|[?&]episode_no=\d/i;

  /**
   * At most this many rows in the chapter list, centred on the chapter being
   * read. The cap used to keep the newest 400: on a series of 5,000 chapters
   * read from chapter 50, the chapter being read was not in its own list and
   * the wheel could not reach anything older than the newest 400 (H26).
   */
  const OPTIONS_MAX = 2000;
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
    return `Ch. ${n} · ${label}`;            // a real name: "Prologue"
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
      // One entry per chapter. A site that cuts a chapter into one page per
      // address links its other pages ("…/chapitre-1194/2", "…/pg-2/") with
      // the chapter's own number: they were rows of their own, and the row for
      // the chapter being read pointed at its page 2 (QA It.7, n° 4). The
      // chapter on screen keeps this page's address; any other, its shortest.
      const byNum = new Map();
      for (const a of document.querySelectorAll('a[href]')) {
        // A link back to the page being read is not a row of the list. A
        // theme's "Sign in" button is one (href="#", or this very address):
        // mangaread's chapter 140 came out as "Ch. 140 — Sign in". The chapter
        // being read is put back below, by its number; only a link that names
        // a number of its own is kept as its row.
        if ((a.getAttribute('href') || '').trim().startsWith('#')) continue;
        if (a.pathname + a.search === location.pathname + location.search && !/\d/.test(a.textContent || '')) continue;
        if (a.host !== location.host || !CHAPTERISH.test(a.pathname + a.search)) continue;
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        // Another page of this same chapter (mangago's /pg-2/) is not a row of
        // the chapter list.
        if (pageTemplate(location.href, a.href)) continue;
        if (wanted && window.PanelFlowMatch.seriesKey(a.href) !== wanted) continue;
        const n = chapNum(a.pathname + a.search);
        if (Number.isNaN(n)) continue;
        const url = n === cur ? location.href : a.href;
        const known = byNum.get(n);
        if (known) {
          if (url.length < known.url.length) known.url = url;
          continue;
        }
        // The label matters most here: on a lot of sites the only chapter-ish
        // links on a chapter page are its own prev/next arrows, so this branch
        // is where a list of "Next / Prev" comes from.
        const option = { label: optionLabel(a.textContent, n), url, n };
        byNum.set(n, option);
        fromLinks.push(option);
      }
      // Two links make a list. One is enough when every link here is known to
      // be this series' own (`wanted`): a chapter page whose only chapter link
      // is "next" (fmteam) is telling us the next chapter, and with the chapter
      // being read added below it is a list of two. Without the series filter
      // a lone link is as likely to be another series' latest chapter.
      if (fromLinks.length >= 2 || (wanted && fromLinks.length === 1)) options = fromLinks;
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
    if (options.length > OPTIONS_MAX) {
      const at = Math.max(0, options.findIndex((o) => o.n === cur || o.url === location.href));
      const start = Math.max(0, Math.min(at - OPTIONS_MAX / 2, options.length - OPTIONS_MAX));
      options = options.slice(start, start + OPTIONS_MAX);
    }

    /**
     * Whether a link moves to another chapter, the right way.
     *
     * Three links that said "next" and were not the next chapter. mangago's
     * "next" turns the page (/pg-1/ to /pg-2/), and its address names the
     * chapter too, so it was taken for the next chapter: at the end of a
     * chapter the reader went back to its own second page instead of on, for
     * ever (NEW-19). On a series' newest chapter, a Madara "next" points at the
     * series page, which names no chapter, and the reader opened that page as
     * one (RS-4). And a link to the chapter being read is not a move at all.
     * So: not a page of this chapter, and, when this chapter's number is
     * known, a link naming another chapter number on the right side of it.
     */
    const movesTo = (href, dir, known = NaN) => {
      if (!href || href === location.href) return false;
      if (pageTemplate(location.href, href)) return false;
      if (Number.isNaN(cur)) return true;
      // A list row knows its number already, from its label when its address
      // is an id; a link is read from its address.
      let n = known;
      if (Number.isNaN(n)) {
        try {
          const u = new URL(href, location.href);
          n = chapNum(u.pathname + u.search);
        } catch { return false; }
      }
      return dir > 0 ? n > cur : n < cur;
    };

    // prev/next: the engine's own arrows first — they are the one thing these
    // readers all place in the same element and label differently, sometimes
    // with nothing but an icon. Then explicit rel/text links, then neighbours in
    // the list. `el.href` is checked because a rule selector is free to land on
    // something that is not a link at all. Every one of them has to pass
    // movesTo; the first that does is the answer.
    const arrows = siteFor() || {};
    const findNav = (rel, textRe, named, dir) => {
      for (const el of [firstMatch(named), document.querySelector(`a[rel="${rel}"]`)]) {
        if (el?.href && movesTo(el.href, dir)) return el.href;
      }
      for (const a of document.querySelectorAll('a[href]')) {
        const text = (a.textContent || '').trim();
        if (a.host === location.host && text.length < 30 && textRe.test(text)
          && CHAPTERISH.test(a.pathname + a.search) && movesTo(a.href, dir)) return a.href;
      }
      return null;
    };
    let prevUrl = findNav('prev',
      /^(<|«|‹|←)?\s*(prev(ious)?( chapter)?|chapitre )?pr[eé]c[eé]dent|^prev|^(前の話|前話|前のエピソード|上一[章話话]|이전\s?화(?![가-힣]))/i,
      arrows.prevChapter, -1);
    let nextUrl = findNav('next',
      /^(next( chapter)?|chapitre suivant|suivant)\s*(>|»|›|→)?$|^next|^(次の話|次話|次のエピソード|下一[章話话]|다음\s?화(?![가-힣]))/i,
      arrows.nextChapter, 1);
    if ((!prevUrl || !nextUrl) && !Number.isNaN(cur) && options.length >= 2) {
      // The nearest chapter on either side, by number, and held to the same
      // test as the arrows. The list is newest first, so the next chapter is
      // the last row above this one's number and the previous the first row
      // below it; a row that only repeats this chapter is neither.
      const newer = options.filter((o) => o.n > cur && movesTo(o.url, 1, o.n)).pop();
      const older = options.find((o) => o.n < cur && movesTo(o.url, -1, o.n));
      if (!nextUrl && newer) nextUrl = newer.url;
      if (!prevUrl && older) prevUrl = older.url;
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

  /**
   * The file name of a stand-in, or nothing like one.
   *
   * A spacer is not always a `data:` URI. webtoons.com parks a real file,
   * `bg_transparency.png`, in the `src` of every slice below the fold and keeps
   * the slice in `data-url`; that file loads, measures a few pixels, and the
   * reader opened episodes on the four slices that happened to be loaded out
   * of forty-eight (NEW-15). The name is read off the file and not the folder:
   * a CDN called "pixel-cdn" is not a placeholder.
   */
  const PLACEHOLDER_FILE = /transparen|placeholder|blank|spacer|loading|lazy|pixel|dummy|1x1/i;

  /** The address a lazy loader is keeping for later, from its data- attribute. */
  function lazyAttr(img) {
    for (const name of LAZY_ATTRS) {
      const v = img.getAttribute(name);
      if (!v || v.startsWith('data:')) continue;
      try { return new URL(v, location.href).href; } catch { /* the next attribute */ }
    }
    return null;
  }

  /** Whether `src` is standing in for the page rather than being it. */
  function standIn(img, src) {
    const file = src.split(/[?#]/)[0].split('/').pop() || '';
    if (PLACEHOLDER_FILE.test(file)) return true;
    // Or, whatever it is called: decoded, and the size of an icon.
    return img.complete && img.naturalWidth > 0 && img.naturalWidth < 64;
  }

  function lazySrc(img) {
    const src = img.currentSrc || img.src;
    const later = lazyAttr(img);
    // lazyAttr() has always known a `data:` attribute is not an address and
    // this line did not, so on a theme that parks a spacer in `src` and the
    // address in `data-src`, the spacer won: the reader opened on seventy
    // copies of a transparent pixel, which is exactly what "the extension
    // activates and I cannot read the chapter" looks like from the outside.
    // The same goes for a stand-in that is a real file (see standIn).
    if (src && !isSpacer(src) && !(later && later !== src && standIn(img, src))) return src;
    if (later) return later;
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
    const all = [...found];
    const good = new Set(all.filter((img) => !brokenImage(img)
      && (img.complete && img.naturalWidth ? sizedImage(img) : Boolean(lazySrc(img)))));
    // An image whose load failed is a page only if it is filed with the
    // pages: a panel the network dropped is one to show again (the reader
    // asks for it afresh), an advert the blocker refused, filed with the ad
    // network, is not a page at all (NEW-12).
    const home = commonFolder([...good].map((img) => lazySrc(img)));
    const images = all.filter((img) => good.has(img)
      || (home && brokenImage(img) && folderOf(lazySrc(img)) === home));
    return images.length >= best.images.length ? { container: best.container, images } : best;
  }

  /** The folder most of these addresses are filed in, or '' for none. */
  function commonFolder(addresses) {
    const counts = new Map();
    let top = '';
    let topCount = 0;
    for (const address of addresses) {
      const folder = folderOf(address);
      if (!folder) continue;
      const n = (counts.get(folder) || 0) + 1;
      counts.set(folder, n);
      if (n > topCount) { top = folder; topCount = n; }
    }
    return top;
  }

  /** How many panels the page is offering right now. Nothing to count is 0. */
  function panelCount() {
    return detection?.gallery ? currentStrip(detection.gallery).images.length : 0;
  }

  /** Whether a paged chapter is being walked right now (see openReader). */
  let walking = false;

  /** Opens the reader. Resolves false when there was nothing to open with. */
  async function openReader() {
    if (!detection) return false;
    if (detection.novel) {
      window.PanelFlowReader.openText(
        detection.novel.paragraphs, seriesMeta(), detection.domainRule || {});
      return true;
    }
    // One address per page, and the addresses are all we were given. The pill
    // says what is happening: this is a dozen fetches, and a button that looks
    // stuck for three seconds is a button somebody presses again.
    if (detection.paged) {
      // One walk at a time. The pill stays on screen while the pages are
      // read, saying so, and a pill pressed again during those seconds must
      // join the walk in progress rather than start a second one beside it.
      if (walking) return true;
      // Walked once and found fewer pages than a chapter has: not again. The
      // auto-open retries an open that answered no a few times, and each
      // retry here would be the same fetches for the same answer.
      if (detection.paged.walked) return false;
      walking = true;
      const pill = document.getElementById('panelflow-pill');
      const reader = window.PanelFlowReader;
      const min = rules.heuristics.minGalleryImages;
      const first = [];
      let opened = false;
      let built = false;
      // Opened on the first few pages and grown page by page after that: a
      // forty-eight page chapter read through frames is a minute of waiting,
      // and the first page is readable after two seconds of it.
      const emit = (src, index, total) => {
        if (pill) pill.textContent = `${t('readerLoadingChapter')} ${index + 1}${total ? '/' + total : ''}`;
        if (opened) { reader.addPages([src]); return; }
        first.push(src);
        if (first.length >= min) {
          opened = true;
          reader.open(first, seriesMeta(), detection.domainRule || {}, null).then(() => { built = true; });
        }
      };
      // The walk goes on while the reader is up, or still on its way up: a
      // reader closed by hand ends it, a reader not built yet does not.
      const alive = () => !built || reader.isOpen();
      try {
        await walkPages(detection.paged, emit, alive);
      } finally {
        walking = false;
        if (!opened) detection.paged.walked = true;
        if (pill) labelPill(pill);
      }
      return opened;
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

  // Scans that found nothing on this address. A page that is not a chapter
  // (a home page, a catalogue) never settles, and one whose adverts rotate
  // mutates every second or two: each burst used to cost a full measure of
  // every image on the page, for as long as the page stayed open. After the
  // first few, the wait doubles every second scan, up to ten seconds; a strip
  // that does arrive late is still found, a little later. (`fruitless` is
  // declared with `scanTimer`, at the top: this function can run before here.)
  function scanWait() { return fruitless < 8 ? 600 : Math.min(10000, 600 * 2 ** ((fruitless - 8) / 2)); }

  function scheduleScan() {
    clearTimeout(scanTimer);
    // Back to null once it fires: "a scan is already on its way" is a question
    // the image listener below asks (watchImages).
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (!detection) fruitless++;
      scan();
    }, scanWait());
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

    /**
     * Whether what was found is a reading strip, as opposed to some images.
     *
     * The two gates are the same ones as before and they still veto — a strip
     * of two rows is a banner and a logo, and a page that does not read like a
     * chapter is not one however many pictures it has. What changed is what
     * happens next. This used to `return`, and that was the bug behind "the
     * reader never opens anywhere": a vetoed strip ended the scan, so a page
     * that *is* a chapter but keeps its panels somewhere else never reached the
     * two paths written for exactly that. MangaDex holds three <img> stacked in
     * one place — the page being read and two preloads — which is a gallery by
     * the letter and a strip by no reading of it, and the comment on
     * `askForPages` below has described its case all along without the code
     * ever getting there. A light novel behind a logo and an avatar fared the
     * same, one branch further down.
     *
     * So: not a strip is not the end of the scan. It only means the strip is
     * not the answer.
     */
    const strip = result.gallery
      && rowCount(result.gallery.images) >= 3
      && chapterEvidence();

    // Before the strip, and that order is the point. A chapter spread over
    // fourteen addresses publishes a list saying so, numbered from one, under
    // the address being read — that is the site stating what its chapter is.
    // The strip is a guess made by clustering whatever images are laid out, and
    // on a paged site the biggest cluster is the "latest releases" carousel: a
    // reader opened on it shows thirty covers of other people's series. When a
    // site offers both, walking the list costs a few fetches and cannot be
    // wrong; trusting the guess can.
    const paged = pagedChapter() || pagedByLinks();
    if (paged) {
      detection = { ...result, paged };
      accept();
      return;
    }

    if (strip && result.score >= rules.heuristics.scoreThreshold) {
      detection = result;
      accept();
      return;
    }

    // Not a strip, so the pages are somewhere else — or there are none, and it
    // is prose. Either way the page still has to look like a chapter first: the
    // score is built out of image signals and neither of these clears any of
    // them, so structure has to carry it, and structure alone would fire on any
    // long article. A chapter number in the URL or real prev/next links is what
    // an article never has; a chapter number in the title alone is not enough,
    // because "Chapter 3" is a normal thing for a blog post to be called.
    // A domain the rules file lists is a reading site somebody checked, so on
    // one of those a heading that names the chapter is structure enough — it is
    // what webnovel.com has instead of a number in its address.
    if (strip || !(urlLooksLikeChapter() || hasChapterNav() || declaredChapter())
        || !chapterEvidence()) return;

    // A site that publishes its pages as data is telling us what the chapter
    // is, and it is asked first for that reason: a paged reader surrounded by a
    // description and a comment section can read as prose to the test below,
    // and answering a manga chapter with its own comment section is worse than
    // answering nothing.
    if (siteFor()?.pageApi) {
      if (askForPages(result)) return;
    }

    // A site whose rule says it publishes novels is read as words: an
    // illustration in the text and a link to the next part are not a chapter
    // of pictures, whatever shape they make.
    const proseSite = siteFor()?.medium === 'novel';

    // The chapter is in the page, hidden (scan-vf): the site wrote every page
    // into the markup and lays out one. Costs nothing to read, so before the
    // walk below, which would fetch the same seventeen pages one by one.
    const parked = proseSite ? null : parkedStrip();
    if (parked) {
      detection = { ...result, pages: parked };
      accept();
      return;
    }

    // One page per address and a "next page" link (mangago): the pages are
    // walked when the reader opens, like a listed chapter.
    const byNext = proseSite ? null : pagedByNext();
    if (byNext) {
      detection = { ...result, paged: byNext };
      accept();
      return;
    }

    /**
     * Prose, but only where prose is a possible answer.
     *
     * A scan site names its reading strip in the rules file, or declares what
     * it publishes. On one of those, "the strip is not measurable yet" must not
     * become "then it must be a novel" — a chapter page carries a synopsis, a
     * comment section and a footer, which is enough text to convince
     * `novelContent`, and the reader would open a manga chapter as words. That
     * exact failure shipped once already; this is the line that keeps it shut.
     */
    // Written as "declares something that is not prose" rather than by naming
    // the drawn media one by one: `popup-shelves.test.js` forbids this file
    // from mentioning that shelf at all, because a vertical manga chapter looks
    // exactly like one and guessing it costs more than leaving it to be chosen.
    // Reading the rule the site wrote is not guessing, but the shorter form is
    // also the truer one — any medium but a novel is read as pictures.
    const site = siteFor();
    const readsAsImages = !!site?.imageContainer
      || (!!site?.medium && site.medium !== 'novel');
    const novel = readsAsImages ? null : novelContent();
    if (novel) {
      detection = { ...result, novel };
      accept();
      return;
    }
    // Nothing to open, but something worth remembering: the reader was here.
    trackOnly(result);
  }

  // --- a chapter that shows one page at a time -------------------------------
  //
  // Older readers — lelscans and its family — put one panel on screen and a
  // page selector under it. There is no strip to lift and no API to ask: the
  // chapter exists, spread over fourteen addresses, and the only way to hold it
  // is to go and get them.
  //
  // That is a cost, so it is paid at the last possible moment: detection only
  // notes that the page list is there, and the walk below happens when the
  // reader is actually opened.

  /** A label that names a page rather than a chapter: "3", "p. 3", "Page 3". */
  const PAGE_LABEL = /^\s*(p(age)?\.?\s*)?\d+\s*$/i;

  /** The directory part of a URL, which is what pages of one chapter share. */
  const dirOf = (url) => String(url).replace(/[^/]*$/, '');

  /**
   * The addresses of this chapter's pages, or null.
   *
   * Every `<select>` on one of these sites looks the same — a list of numbers
   * whose values are URLs — and the series, the chapter and the page each have
   * one. What tells them apart is how *specific* they are: the page list is the
   * only one whose addresses all live under the address being read, and when
   * two lists both qualify the deeper one is the page list. `.../1192/` beats
   * `.../scan-one-piece/`.
   */
  function pagedChapter() {
    let best = null;
    for (const select of document.querySelectorAll('select')) {
      const rows = [...select.options]
        .filter((o) => PAGE_LABEL.test(o.textContent) && /^https?:/i.test(o.value));
      if (rows.length < rules.heuristics.minGalleryImages) continue;

      // Pages are numbered from one and leave no gaps. Chapters are numbered
      // 1189, 1190, 1191 — which is the same shape of list, from the same kind
      // of <select>, and the only thing that reliably tells the two apart when
      // a page carries just one of them. (A completed series whose chapters
      // happen to run 1…14 would still fool this; when both lists are on the
      // page, the deeper one below settles it.)
      const numbers = rows.map((o) => parseInt(String(o.textContent).replace(/\D+/g, ''), 10));
      const counted = [...numbers].sort((a, b) => a - b);
      if (counted.some((n, i) => n !== i + 1)) continue;

      const urls = rows.map((o) => o.value);
      const dir = dirOf(urls[0]);
      if (!urls.every((u) => dirOf(u) === dir)) continue;

      // And the list has to be about the address being read: either it lives
      // inside it (standing on the chapter, pages one level down) or it holds
      // it (standing on page three of that same list).
      const inside = dir.replace(/\/$/, '') === location.href.replace(/\/$/, '');
      if (!inside && !urls.includes(location.href)) continue;

      if (!best || dir.length > best.dir.length) best = { dir, urls };
    }
    return best;
  }

  /**
   * The pages of this chapter, when the page links them one by one: "Pages: 1 2
   * 3 … 13" (lelscans), each an <a> whose text is its number and whose address
   * ends with that same number. The list has to run from one with no gap, and
   * it has to be about this chapter — the address being read is one of them,
   * or sits above them, or the page's own chapter list picks the folder they
   * live in (the landing page that shows the latest chapter, see
   * selectedChapter). Null otherwise.
   */
  function pagedByLinks() {
    const groups = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const text = (a.textContent || '').trim();
      if (!/^\d{1,3}$/.test(text)) continue;
      let href = '';
      try { href = new URL(a.getAttribute('href'), location.href).href; } catch { continue; }
      const m = /^(.*\/)(\d{1,3})(\/?)$/.exec(href.split('#')[0]);
      if (!m || parseInt(m[2], 10) !== parseInt(text, 10)) continue;
      const key = m[1] + '\u0000' + m[3];
      const pages = groups.get(key) || new Map();
      pages.set(parseInt(text, 10), href);
      groups.set(key, pages);
    }
    const picked = selectedChapter();
    let best = null;
    for (const [key, pages] of groups) {
      const count = pages.size;
      if (count < rules.heuristics.minGalleryImages) continue;
      let whole = true;
      for (let n = 1; n <= count; n++) if (!pages.has(n)) { whole = false; break; }
      if (!whole) continue;
      const dir = key.split('\u0000')[0];
      const trimmed = dir.replace(/\/$/, '');
      const here = location.href.split('#')[0];
      const about = [...pages.values()].includes(here)
        || here.replace(/\/$/, '') === trimmed
        || (picked && picked.url.replace(/\/$/, '') === trimmed);
      if (!about) continue;
      if (!best || count > best.urls.length) {
        best = { urls: Array.from({ length: count }, (_, i) => pages.get(i + 1)) };
      }
    }
    return best;
  }

  /** The panel on this page: the biggest image that is actually laid out. */
  function mainImage() {
    let best = null;
    for (const img of document.images) {
      if (!sizedImage(img)) continue;
      const area = img.getBoundingClientRect().width * img.getBoundingClientRect().height;
      if (!best || area > best.area) best = { area, src: lazySrc(img) || img.src };
    }
    return best?.src || null;
  }

  // Furniture, on every one of these pages: covers of other series, a logo, an
  // avatar. Named by what they are called, because a parsed document has no
  // layout to measure and this is the only signal left.
  //
  // The badges a site hands its users are furniture too: royalroad shows an
  // author's achievements as a row of small images filed together, and on a
  // phone that row was taken for a chapter parked in the page (RS-5).
  // So are the reaction buttons under a chapter: syosetu files five of them in
  // one /reaction/ folder, enough for a hidden "chapter" of emoji. The folder,
  // not the word: a series called Chain Reaction has pages too. The badge
  // words count as words of the address, never inside one, for the same
  // reason: Medalist is a series, /remote/ a CDN folder, and both have pages.
  const FURNITURE = /thumb|logo|icon|avatar|banner|sprite|placeholder|cover|\/reactions?\/|(?:^|[^a-z])(?:achievements?|badges?|awards?|medals?|emojis?|emotes?|stickers?|pfp)(?:[^a-z]|$)/i;

  /** The folder of an address, host left out: a chapter's pages share one,
   *  and a CDN hands the same folder out from several hosts (mangago's
   *  iweb_3, iweb_9). */
  function folderOf(url) {
    try { return new URL(url).pathname.replace(/[^/]*$/, ''); } catch { return ''; }
  }

  /**
   * The panel on one fetched page.
   *
   * Three answers, most certain first. A chapter keeps its pages in one folder,
   * so an image from the same folder as the panel we can already see is the
   * panel; failing that the biggest declared box; failing that the first image
   * that is not named like furniture.
   */
  function panelIn(doc, url, dir, folder = null) {
    const abs = (img) => {
      const raw = img.getAttribute('src') || img.getAttribute('data-src') || '';
      try { return new URL(raw, url).href; } catch { return ''; }
    };
    const images = [...doc.images].map((img) => ({ img, src: abs(img) })).filter((i) => i.src);
    if (dir) {
      const same = images.find((i) => i.src.startsWith(dir));
      if (same) return same.src;
    }
    // A folder to hold the answer to, host left out: the only answer is an
    // image filed there, and a page with none is "not here", never a guess.
    if (folder) return images.find((i) => folderOf(i.src) === folder)?.src || null;
    const box = (i) => (parseInt(i.img.getAttribute('width'), 10) || 0)
      * (parseInt(i.img.getAttribute('height'), 10) || 0);
    const biggest = images.slice().sort((a, b) => box(b) - box(a))[0];
    if (biggest && box(biggest) > 0) return biggest.src;
    return images.find((i) => !FURNITURE.test(i.src))?.src || null;
  }

  /** How many pages are fetched at once. Polite, and enough to feel prompt. */
  const WALK_AT_ONCE = 4;

  /** How long a hidden frame gets to show its panel before it is given up. */
  const FRAME_WAIT_MS = 12000;
  const FRAME_POLL_MS = 250;

  /** How far a walk that follows "next" may go: a chapter, never a series. */
  const FOLLOW_MAX = 300;

  /**
   * The panel on one page, read through a hidden frame of that page.
   *
   * For the sites whose markup carries no image at all: mangago sends its
   * pages as an encrypted string that its own script decodes into the <img>
   * once the page runs. Fetching the markup learns nothing, so the page is
   * loaded as the site meant it to be loaded, in a frame nobody sees, and the
   * image its script put there is read. Same session, the site's own code,
   * nothing decoded by us.
   *
   * The frame may run scripts and reach its own origin, and nothing else: no
   * pop-ups, no navigation of the tab, no forms. It is laid out at a page's
   * width so the site draws the panel rather than a phone stub. The panel is
   * the image filed in the chapter's folder that the frame has laid out; a
   * preload of the next page sits in the same folder with no box, and is not
   * the answer. Removed whatever happens.
   */
  function panelInFrame(url, folder) {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed!important;left:-10000px!important;top:0!important;'
        + 'width:1200px!important;height:900px!important;visibility:hidden!important;'
        + 'pointer-events:none!important;border:0!important';
      const started = Date.now();
      let done = false;
      const finish = (src) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        frame.remove();
        resolve(src || null);
      };
      const look = () => {
        let doc = null;
        try { doc = frame.contentDocument; } catch { doc = null; }
        if (doc) {
          let fallback = null;
          for (const img of doc.images) {
            const src = img.currentSrc || img.src || '';
            if (!src || isSpacer(src) || folderOf(src) !== folder) continue;
            if (img.getBoundingClientRect().width > 0) return finish(src);
            fallback = fallback || src;
          }
          // Give a page that has the folder's images but none laid out yet a
          // moment more; take what it has when the wait runs out.
          if (fallback && Date.now() - started > FRAME_WAIT_MS / 2) return finish(fallback);
        }
        if (Date.now() - started > FRAME_WAIT_MS) finish(null);
        return undefined;
      };
      const timer = setInterval(look, FRAME_POLL_MS);
      frame.src = url;
      (document.body || document.documentElement).appendChild(frame);
    });
  }

  /**
   * The panel on one page, by whichever door opens: the markup first (one
   * fetch), a frame when the markup carries nothing filed with the chapter.
   *
   * `folder` is the chapter's, from the panel on screen. When it is known the
   * answer has to be filed there: a fetched page whose only images are a logo
   * and an arrow (mangago's markup) must not hand the arrow back, it must say
   * "not here" so the frame is tried. Without a folder to hold it to, the
   * older readers' fallbacks in panelIn stand.
   *
   * Returns { src, via } — `via` says which door, so the walk can stop trying
   * the closed one — or null.
   */
  async function readPage(url, folder, via) {
    if (via !== 'frame') {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (resp.ok) {
          const doc = new DOMParser().parseFromString(asHTML(await resp.text()), 'text/html');
          const src = panelIn(doc, url, null, folder || null);
          if (src) return { src, via: 'fetch' };
        }
      } catch (e) {
        console.info('[panelflow] page could not be fetched', url, e);
      }
      if (!folder) return null;
    }
    const src = await panelInFrame(url, folder);
    return src ? { src, via: 'frame' } : null;
  }

  /**
   * Every page of a chapter that is spread over one address each.
   *
   * Fetched from here rather than from the server for the reason every other
   * fetch in this file is: this is the reader's own session, and these sites
   * answer a stranger with a challenge. In page order, whatever order the
   * answers arrive in — a chapter read back to front is not a chapter — and
   * handed over one at a time through `emit(src, index, total)` as soon as
   * every page before it is in, so the reader can open on the first three
   * while the rest are still coming. `alive()` is asked before each page: a
   * reader closed halfway is a walk that stops.
   *
   * Two shapes of chapter. `urls` lists every page (a <select> of addresses,
   * or a template and a page count): the pages are read a few at a time.
   * `follow` is the address of the next page and nothing more: the pages are
   * read one after the other, each one saying where the next is, until "next"
   * leaves the chapter or stops being a page. The door a page is read
   * through (markup or frame) is learnt on the first and kept.
   */
  async function walkPages(paged, emit = () => {}, alive = () => true) {
    const here = mainImage();
    const folder = here ? folderOf(here) : '';
    const dir = here ? dirOf(here) : null;
    let via = null;
    const read = async (url) => {
      if (here && url === location.href) return here;
      const got = await readPage(url, folder, via);
      if (got) via = got.via;
      return got?.src || null;
    };

    if (paged.urls) {
      const total = paged.urls.length;
      // `undefined` is not read yet; `null` is read and empty.
      const out = new Array(total);
      let cursor = 0;
      let emitted = 0;
      const flush = () => {
        while (emitted < total && out[emitted] !== undefined) {
          if (out[emitted]) emit(out[emitted], emitted, total);
          emitted += 1;
        }
      };
      const step = async () => {
        const i = cursor;
        cursor += 1;
        try {
          out[i] = await read(paged.urls[i]);
        } catch (e) {
          console.info('[panelflow] page ' + (i + 1) + ' could not be read', e);
          out[i] = null;
        }
        flush();
      };
      // The first page read settles which door the site opens; the rest may
      // then go together. Four pages through four frames at once, each trying
      // the closed door first, would be a minute of nothing.
      while (cursor < total && !via && alive()) await step();
      await Promise.all(Array.from({ length: WALK_AT_ONCE }, async () => {
        while (cursor < total && alive()) await step();
      }));
      return out.filter(Boolean);
    }

    // The markup of a page, for the link to the one after it. Links are in
    // the markup even when the panel is not (mangago), so this is a fetch
    // whichever door the panel came through.
    const markup = async (url) => {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        return resp.ok ? new DOMParser().parseFromString(asHTML(await resp.text()), 'text/html') : null;
      } catch { return null; }
    };
    const out = [];
    const seen = new Set();
    let url = paged.first;
    for (let n = 0; n < FOLLOW_MAX && url && !seen.has(url) && alive(); n += 1) {
      seen.add(url);
      let src = null;
      let next = null;
      if (url === paged.first) {
        src = here && url === location.href ? here : (await readPage(url, folder, via))?.src || null;
        next = paged.follow;
      } else {
        const got = await readPage(url, folder, via);
        if (got) { via = got.via; src = got.src; }
        const doc = await markup(url);
        next = doc ? nextPageLink(doc, url)?.href || null : null;
      }
      if (src) {
        out.push(src);
        emit(src, out.length - 1, null);
      } else if (out.length) {
        break; // a page with no panel filed with the chapter is past its end
      }
      url = next;
    }
    return out;
  }

  // --- a chapter that shows one page at a time, and lists no addresses ------
  //
  // mangago and the readers built like it put one panel on screen and a "next
  // page" link under it, and no <select> of addresses for pagedChapter to
  // read. The next address gives the shape of them all: it is this address
  // with the page number one higher (/pg-1/ to /pg-2/, or /chapitre-1193 to
  // /chapitre-1193/2). With a page count, every address of the chapter
  // follows from the shape; without one, the walk follows "next".

  /** A link that reads as a page turn: "next", "suivant", an arrow, "page". */
  const PAGE_TURN = /page|next|suiv|›|»|→|>/i;
  /** A word that makes it a chapter turn instead, whatever else it says. */
  const CHAPTER_TURN = /chap|chapter|chapitre|episode|épisode|\bep\b|\bch\b|\bvol/i;
  /** A page word before the number: mangago's /pg-2/, a reader's ?page=2. */
  const PAGE_WORD = /(?:^|[^a-z])(page|pg|p)[-_/=]?$/i;

  /**
   * The shape of one chapter's page addresses, from two of them.
   *
   * `here` and `next` must be the same address but for one run of digits,
   * `next`'s one higher; or `next` is `here` with `/2` on the end, the first
   * page often being the bare chapter address. Returns { at(n), from }: the
   * address of page n, and which page `here` is. Null when they are not two
   * pages of one chapter, and that includes two *chapters*: /chapter-11/ to
   * /chapter-12/ has the same shape, and walking it would open the first page
   * of forty chapters. So the number must not follow a chapter word, and the
   * address must say it is a page in one of two ways: a page word before the
   * number (/pg-2/), or another number earlier in it that is the chapter
   * (/chapitre-1193/2, /read/8841/3).
   */
  function pageTemplate(here, next) {
    return templateOf(here, next, (s) => s.replace(/#.*$/, ''))
      // A tail on one address and not the other — ?utm_source, ?fbclid, a
      // viewer setting — is not a different page. Compared again without the
      // query, which is what the pages after the first one are then built
      // without (QA, September 2026: ?vp=noscale left mangago with no reader).
      || templateOf(here, next, (s) => s.replace(/[?#].*$/, ''));
  }

  function templateOf(here, next, clean) {
    if (!here || !next || here === next) return null;
    const strip = (s) => clean(s).replace(/\/$/, '');
    const base = strip(here);
    const digits = (t) => /^\d+$/.test(t);
    const trailing = clean(here).endsWith('/') ? '/' : '';
    // Numbers that say "chapter" are looked for in the path only: a host or a
    // port is not a chapter (manga4life.com, a server on :8080).
    const origin = (/^[a-z][\w+.-]*:\/\/[^/]*/i.exec(base) || [''])[0];

    // The bare chapter address, then /2 (scan-vf) or /page/2 (FoolSlide): page
    // one is the address itself. The later pages take page two's shape, its
    // trailing slash included, since that is the one the site wrote.
    const after = next.replace(/#.*$/, '');
    const second = after.startsWith(base) && /^(\/(?:page\/)?)2(\/?)$/.exec(after.slice(base.length));
    if (second) {
      // No chapter number anywhere in the path: not a page.
      // manga4life.com/latest/ then /latest/page/2 is a listing.
      if (!/\d/.test(base.slice(origin.length))) return null;
      return { at: (n) => (n === 1 ? here : `${base}${second[1]}${n}${second[2]}`), from: 1 };
    }

    const a = base.match(/\d+|\D+/g) || [];
    const b = strip(next).match(/\d+|\D+/g) || [];
    if (a.length !== b.length) return null;
    const diff = a.map((t, i) => (t === b[i] ? -1 : i)).filter((i) => i !== -1);
    if (diff.length !== 1) return null;
    const i = diff[0];
    if (!digits(a[i]) || !digits(b[i]) || Number(b[i]) !== Number(a[i]) + 1) return null;
    const before = a[i - 1] || '';
    if (CHAPTER_TURN.test(before.slice(-12))) return null;
    const pageWord = PAGE_WORD.test(before);
    const head = a.slice(0, i).join('');
    // A chapter number earlier in the path is a number standing on its own.
    // One glued to letters is part of a name: syosetu's novel id n1571ko read
    // as "chapter 1571", so /n1571ko/2/, the next episode, became page two of
    // the first, and the reader lost its "next" (and an illustrated episode
    // its text).
    const words = head.slice(origin.length).match(/\d+|\D+/g) || [];
    const chapterBefore = words.slice(0, -1).some((t, j) => digits(t)
      && !/[a-z]$/i.test(words[j - 1] || '') && !/^[a-z]/i.test(words[j + 1] || ''));
    if (!pageWord && !chapterBefore) return null;
    const tail = a.slice(i + 1).join('') + trailing;
    return { at: (n) => `${head}${n}${tail}`, from: Number(a[i]) };
  }

  /**
   * The "next page" link on a page, with the shape it gives away.
   *
   * Words first: a link that names a chapter, an episode or a volume is a
   * chapter turn however it is drawn, and one that says nothing like a page
   * turn is not looked at. Then the address, which has to fit pageTemplate
   * with the page being read. Returns { href, template } or null.
   */
  function nextPageLink(doc = document, base = location.href) {
    for (const a of doc.querySelectorAll('a[href]')) {
      const words = [a.textContent, a.title, a.rel, a.className, a.id, a.getAttribute('aria-label')]
        .filter(Boolean).join(' ').trim();
      if (words.length > 60 || CHAPTER_TURN.test(words) || !PAGE_TURN.test(words)) continue;
      let href = '';
      try { href = new URL(a.getAttribute('href'), base).href; } catch { continue; }
      if (/^javascript:|#$/i.test(href)) continue;
      const template = pageTemplate(base, href);
      if (template) return { href, template };
    }
    return null;
  }

  /**
   * How many pages the chapter has, when the page says so.
   *
   * Two ways a page says it. A <select> of page numbers, 1 to N with no gap
   * (scan-vf's, whose values are numbers rather than addresses, which is why
   * pagedChapter passes it over); or a script variable, `total_pages=48`, the
   * way mangago writes it. Null when it does not, and the walk follows "next".
   */
  function pageTotal() {
    for (const select of document.querySelectorAll('select')) {
      const numbers = [...select.options]
        .filter((o) => PAGE_LABEL.test(o.textContent))
        .map((o) => parseInt(String(o.textContent).replace(/\D+/g, ''), 10))
        .sort((x, y) => x - y);
      if (numbers.length >= rules.heuristics.minGalleryImages
        && numbers.every((n, i) => n === i + 1)) return numbers.length;
    }
    for (const script of document.scripts) {
      if (script.src) continue;
      const m = /\btotal_pages?\s*[=:]\s*["']?(\d{1,4})\b/i.exec(script.textContent || '');
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  /**
   * A chapter read one page per address, with no list of them.
   *
   * The shape: one panel laid out on the page (mainImage) and a link to the
   * next page whose address is this one's with the number one higher. With a
   * count, the addresses are written out; without, the walk follows the
   * link. Null when the page is not that.
   */
  function pagedByNext() {
    if (!mainImage()) return null;
    const link = nextPageLink();
    if (!link) return null;
    const total = pageTotal();
    if (total && total >= rules.heuristics.minGalleryImages) {
      const urls = Array.from({ length: total }, (_, i) => link.template.at(i + 1));
      return { urls, from: link.template.from };
    }
    return { first: location.href, follow: link.href, from: link.template.from };
  }

  // --- a chapter parked in the page, hidden ---------------------------------

  /**
   * The pages of a chapter written into the document but never laid out.
   *
   * scan-vf and the readers built like it put every page of the chapter into
   * the markup as <img data-src> inside a container that is display:none, and
   * show one at a time by copying its address into the visible <img>. The
   * strip is there; it has no layout, which is the one thing galleryImages()
   * measures. So it is read by address: three or more images filed in one
   * folder, in the order the page wrote them, is the chapter. The folder is
   * what keeps a hidden row of covers out — those are filed elsewhere, and
   * named like furniture besides.
   *
   * Returns the addresses in page order, or null.
   */
  function parkedStrip() {
    const groups = new Map();
    for (const img of document.images) {
      const address = lazySrc(img);
      if (!address || FURNITURE.test(address)) continue;
      // Parked pages are not laid out, that is what parked means. An image
      // that is, and is small, is part of the page around the chapter: a
      // badge, an emote, a button (RS-5).
      const box = img.getBoundingClientRect();
      if (box.width > 0 && box.width < minBoxWidth() / 2) continue;
      // One already decoded at its own address is judged on its pixels, like
      // any page: a banner is too short, an icon too narrow. Only at its own
      // address: a parked page carries a 1 px spacer in `src`, decoded long
      // ago, and that spacer says nothing about the page behind it.
      const decoded = img.complete && img.naturalWidth > 0 && address === (img.currentSrc || img.src);
      if (decoded && (img.naturalWidth < rules.heuristics.minImageWidth || img.naturalHeight < 200)) continue;
      const folder = folderOf(address);
      if (!folder || folder === '/') continue;
      const group = groups.get(folder) || { list: [], whole: 0 };
      if (!group.list.includes(address)) {
        group.list.push(address);
        if (!brokenImage(img, address)) group.whole++;
      }
      groups.set(folder, group);
    }
    // A refused advert is an image whose load failed, filed with the other
    // adverts. A folder of nothing but those is a row of blocked banners, not
    // a chapter (NEW-12); one failed page among whole ones is still a page.
    // Between two folders, the one with more whole images wins: thirty refused
    // banners and three that got through must not outweigh twenty pages.
    let best = null;
    for (const group of groups.values()) {
      if (group.whole >= rules.heuristics.minGalleryImages && (!best || group.whole > best.whole)) best = group;
    }
    return best ? best.list : null;
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
    return pageApiChapter() || rules.heuristics.urlPatterns.some((p) => {
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

  /**
   * The chapter the reader turned to answered with a server error.
   *
   * A chapter the reader cannot load in place, it navigates to, and asks to
   * be reopened on arrival (`reopenReaderFor`). A site that answers that one
   * request with a 5xx (a busy server's 503, Cloudflare's 520 to 524) left
   * the reader closed on an error page in the middle of a binge, and only a
   * reload brought it back: on a network that fails one request in five, a
   * text chapter, which always turns by a full load, failed that way 3 times
   * out of 3 (T3). So that address is loaded again, once per tab session; a
   * site that is really down still ends on its own error page.
   *
   * WebKit does not say what a page answered (no `responseStatus` in Safari
   * 26, so none in the iOS app's WebView): the retry never happened there.
   * Where the status is unknown, a page the reader asked for that still shows
   * no chapter after a few seconds is taken for one that failed.
   */
  function retryFailedTurn() {
    const status = globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.responseStatus;
    const known = typeof status === 'number' && status > 0;
    if (known && status < 500) return;
    chrome.storage.local.get(['reopenReaderFor'], (v) => {
      if (v.reopenReaderFor !== location.href) return;
      const key = `panelflow:retried:${location.href}`;
      try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
      } catch {
        return; // no way to remember the retry: none, rather than a loop
      }
      setTimeout(() => {
        // Some servers send their pages with a 5xx status all the same: when
        // this one held a chapter after all, the reader is open on it by now,
        // and a reload would close it under the reader's eyes. The same
        // answer, where the status is unknown, is a page that loaded fine.
        if (detection || globalThis.PanelFlowReader?.isOpen?.()) return;
        location.reload();
        // A known 5xx is retried at once; an unknown status waits for the
        // detector's own tries (auto-open alone takes up to ~5 s).
      }, known ? 1500 : 6000);
    });
  }
  retryFailedTurn();

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
      if (reopen || (auto && confident())) autoOpenNow();
    });
  }

  /**
   * Whether this page may have the reader opened on it without being asked.
   *
   * Opening by itself is a promise that the page is a chapter, and a wrong one
   * hides the page the reader came for behind a reader of something else. So
   * it is kept for the confident answers — a rule the site wrote, pages listed
   * or walked, prose that passed the prose test, or a strip of at least
   * `minGalleryImages` images that cleared the score — and anything weaker
   * keeps the pill, which costs one tap (report, arbitrage c).
   */
  function confident() {
    if (!detection) return false;
    if (detection.domainRule || detection.paged || detection.pages || detection.novel) return true;
    const h = rules.heuristics || {};
    const images = detection.gallery?.images?.length || 0;
    return detection.score >= (h.scoreThreshold ?? 50) && images >= (h.minGalleryImages ?? 3);
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
    // Opened some other way while this waited (the pill, the popup): that is
    // the open, and a second one would reset the reader to the page's own
    // chapter, whatever the reader has moved to since.
    if (globalThis.PanelFlowReader?.isOpen?.()) { autoOpened = true; return; }
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

  // An image that finishes loading changes what a scan measures, its size,
  // without touching the DOM, so the observer above never hears of it. A
  // chapter whose one panel was still on its way at the last scan (mangago,
  // one page per address, on a slow connection) was never looked at again and
  // never offered. So a finished image asks for a scan as well; only when none
  // is already on its way, so three hundred panels arriving one by one cannot
  // keep pushing a strip's scan back.
  function watchImages() {
    document.addEventListener('load', (e) => {
      if (!detection && !scanTimer && e.target?.tagName === 'IMG') scheduleScan();
    }, true);
  }
  watchImages();

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
    fruitless = 0;
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

  /**
   * "That address change was mine, do not treat it as leaving the page."
   *
   * The reader can now move between chapters of a series without loading a
   * document — it fetches the pages and corrects the address afterwards. To the
   * check above that looks exactly like a site replacing itself, and its answer
   * to that is to close the reader: it would shut the reader in the middle of
   * the chapter it just opened, once a second, for ever.
   */
  function claimAddress() {
    address = addressHere();
  }

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
      const doc = new DOMParser().parseFromString(asHTML(await resp.text()), 'text/html');
      // Soft 404s answer 200 with an error page; a real series page lists
      // chapters, so require at least one before trusting the URL.
      const latest = latestChapterInDom(doc, url);
      if (latest === null && /erreur|error|404|not found/i.test(doc.title || '')) return null;
      return {
        latest,
        // The series page is where the cover, status and genres actually live —
        // a chapter page has none of them.
        cover: coverGuess(doc),
        status: statusGuess(doc),
        language: languageGuess(doc),
        // The fetched page's own name, so the season and language links it
        // lists as tags are recognised as being about it. `title` above belongs
        // to the chapter page this was called from and is not in scope here.
        genres: genresInDom(doc, (doc.querySelector('meta[property="og:title"]')?.content
          || doc.title || '').replace(/\s*[-–|].*$/, '').trim()),
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
          if (ok) {
            // Same as the pill: an open by hand ends the automatic one.
            autoOpened = true;
            document.getElementById('panelflow-pill')?.remove();
          }
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
      } else if (meta.medium !== 'anime') {
        // The guess does not resolve. Pin the chapter URL instead: it is
        // reachable, so the entry stays clickable and progress still tracks.
        // Not for an episode: its series page was read off the page itself,
        // not guessed, and pinning the episode's address would file each
        // episode as a series of its own.
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
  /**
   * Look at the page again, from nothing.
   *
   * `accept()` disconnects the observer, deliberately — the pages this fires on
   * are infinite-scrolling readers that mutate on every panel, and watching them
   * for the life of the tab is a cost with no answer at the end of it. The
   * consequence is that a verdict, once taken, is final: if the strip had not
   * arrived yet, the page was judged prose and stays prose, and the reader opens
   * a manga chapter as text.
   *
   * In Chrome that barely happens — content scripts run at `document_idle`,
   * after the theme has built its strip. A WebView is not Chrome, and the shell
   * around one cannot always promise the same moment. So it may ask for one more
   * look, once, a couple of seconds later.
   *
   * Refused while the reader is open: the reader *is* the answer, and taking the
   * page apart underneath somebody who is reading it is worse than any verdict.
   * Returns whether the rescan was started, so a caller can tell the difference.
   */
  function rescan() {
    if (window.PanelFlowReader?.isOpen?.()) return false;
    detection = null;
    tracked = null;
    autoOpened = false;
    // Both are keyed to "we already did this for this address"; a fresh look has
    // to be allowed to ask the same questions again.
    pagesAsked = null;
    document.getElementById('panelflow-pill')?.remove();
    watchDom();
    scheduleScan();
    return true;
  }

  window.__panelflowDetect = {
    seriesMeta, enrichedMeta, chapterNav, stableImageSrc, releaseStable, lazySrc, sizedImage,
    rescan, claimAddress, showPill,
    get detection() { return detection; },
  };
})();
