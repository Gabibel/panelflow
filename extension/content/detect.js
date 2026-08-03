// PanelFlow detection engine (content script, document_idle).
// Scores the current page against manga-reading heuristics; when the score
// passes the threshold, shows a non-intrusive "Reader Mode" pill. Never
// auto-switches: the user stays in control on every site.
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
        '/(chapter|chapitre|chap|ch)[-_/ ]?\\d+',
        '/read(er)?/',
      ],
      navTextPatterns: ['next chapter', 'previous chapter', 'chapitre suivant'],
      weights: { imageGallery: 40, urlPattern: 20, chapterNav: 20, lowTextDensity: 10, knownDomain: 100 },
    },
    domains: {},
  };

  let rules = FALLBACK_RULES;
  let detection = null; // { score, container, images, domainRule }

  chrome.runtime.sendMessage({ type: 'getRules' }, (resp) => {
    if (!chrome.runtime.lastError && resp && resp.rules) rules = resp.rules;
    scheduleScan();
  });

  // --- scoring -------------------------------------------------------------

  function galleryImages() {
    const h = rules.heuristics;
    const imgs = [...document.images].filter((img) => {
      const w = img.naturalWidth || img.width;
      const hgt = img.naturalHeight || img.height;
      return w >= h.minImageWidth && hgt >= 200 && isVisible(img);
    });
    if (imgs.length < h.minGalleryImages) return null;

    // Group candidate images by ancestor container (up to 4 levels up) and
    // pick the container holding the most of them — that's the reading strip.
    const counts = new Map();
    for (const img of imgs) {
      let node = img.parentElement;
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        counts.set(node, (counts.get(node) || []).concat(img));
      }
    }
    let best = null;
    for (const [node, list] of counts) {
      const unique = [...new Set(list)];
      if (unique.length >= h.minGalleryImages && (!best || unique.length > best.images.length)) {
        best = { container: node, images: unique };
      }
    }
    if (!best) return null;
    best.images.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    return best;
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

  function hasChapterNav() {
    return [...document.querySelectorAll('a, button')].slice(0, 400).some((a) => {
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

  function scorePage() {
    const h = rules.heuristics;
    const w = h.weights;
    let score = 0;
    const domainRule = rules.domains[location.hostname];
    if (domainRule) score += w.knownDomain;

    const gallery = galleryImages();
    if (gallery) score += w.imageGallery;

    const path = location.pathname + location.search;
    if (h.urlPatterns.some((p) => { try { return new RegExp(p, 'i').test(path); } catch { return false; } })) {
      score += w.urlPattern;
    }

    const anchors = [...document.querySelectorAll('a, button')].slice(0, 400);
    const navPat = h.navTextPatterns.map((t) => t.toLowerCase());
    if (anchors.some((a) => {
      const t = (a.textContent || '').trim().toLowerCase();
      return t.length < 40 && navPat.some((p) => t.includes(p));
    })) score += w.chapterNav;

    if (gallery) {
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
    pill.textContent = '📖 Reader Mode';
    pill.title = 'PanelFlow: open this chapter in Reader Mode';
    pill.addEventListener('click', () => {
      pill.remove();
      openReader();
    });
    document.documentElement.appendChild(pill);
  }

  function seriesMeta() {
    const rule = detection?.domainRule;
    let title = null;
    if (rule && rule.title) title = document.querySelector(rule.title)?.textContent?.trim();
    if (!title) {
      // Heuristic: strip common suffixes ("Chapter 12 - SiteName") from <title>.
      const clean = (s) => s
        .replace(/[-|–—:]\s*(read online|free|manga|scan).*$/i, '')
        .replace(/\s*(chapter|chapitre|ch\.?|episode)\s*[\d.]+.*$/i, '')
        .replace(/^[\s»«|•·:—–-]+|[\s»«|•·:—–-]+$/g, '')
        .trim();
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
  function genresInDom() {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/genre" i], a[href*="/tag" i], a[rel~="tag"]')) {
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      // Genre labels are short words, never sentences or chapter titles.
      if (!text || text.length > 24 || /\d{2,}/.test(text)) continue;
      if (CHAPTERISH.test(text)) continue;
      seen.add(text);
      if (seen.size >= 12) break;
    }
    return [...seen];
  }

  // Latest chapter = max over the page's actual chapter links/dropdown
  // (MangaPin reads the chapter list; a whole-page number max returns the
  // chapter being read or a view count instead of the real latest).
  function latestChapterInDom(root = document) {
    const re = /(chapter|chapitre|chap|ch|episode)[-_/ .]*([\d]+(?:\.\d+)?)/i;
    let max = null;
    for (const el of root.querySelectorAll('a[href], option')) {
      const target = el.getAttribute('href') || el.getAttribute('value') || '';
      const text = (el.textContent || '').slice(0, 80);
      const m = target.match(re) || text.match(re);
      if (!m) continue;
      const n = parseFloat(m[2]);
      if (!Number.isNaN(n) && n < 10000 && (max === null || n > max)) max = n;
    }
    return max !== null ? String(max) : null;
  }

  // The chapter this page IS, normalised to "Ch. 109". Reads the URL first
  // (unambiguous), then falls back to the <title>; a bare number found loose
  // in the page is not trustworthy enough to label a chapter with.
  function chapterLabelHere() {
    const re = /(chapter|chapitre|chap|ch|episode)[-_/ .]*([\d]+(?:\.\d+)?)/i;
    const m = (location.pathname + location.search).match(re) || document.title.match(re);
    return m ? `Ch. ${m[2]}` : null;
  }

  function coverGuess(root = document) {
    const og = root.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content;
    if (og) return og;
    // Series pages without og:image: look for an <img> that smells like a cover.
    const imgs = [...root.querySelectorAll('img')];
    const cand = imgs.find((img) =>
      /cover|poster|thumb|affiche|wp-post-image/i.test(
        img.className + ' ' + (img.getAttribute('src') || '') + ' ' + (img.alt || '')) &&
      (img.naturalWidth || img.width || 100) >= 80);
    if (cand) return absolute(cand.getAttribute('src') || cand.currentSrc || cand.src);
    // Last resort: the tallest portrait image on the page. Covers are portrait;
    // chapter pages and banners are not.
    let best = null;
    for (const img of imgs) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h || w < 80 || h < w * 1.2 || h > w * 2.2) continue;
      if (!best || h > best.h) best = { h, img };
    }
    return best ? absolute(best.img.getAttribute('src') || best.img.src) : null;
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
  const chapNum = (s) => {
    const m = String(s).match(/(chapter|chapitre|chap|ch|episode)[-_/ .]*([\d]+(?:\.\d+)?)/i);
    return m ? parseFloat(m[2]) : NaN;
  };

  function chapterNav() {
    let options = [];
    // 1. A <select> whose options carry chapter URLs (many readers have one).
    for (const sel of document.querySelectorAll('select')) {
      const opts = [...sel.options].filter((o) => {
        const v = o.value || '';
        return (v.startsWith('http') || v.startsWith('/')) &&
          (CHAPTERISH.test(v) || CHAPTERISH.test(o.textContent));
      });
      if (opts.length >= 3 && opts.length > options.length) {
        options = opts.map((o) => ({
          label: o.textContent.trim().slice(0, 60),
          url: new URL(o.value, location.href).href,
          n: chapNum(o.value) || chapNum(o.textContent),
        }));
      }
    }
    // 2. Otherwise chapter links sharing this page's URL shape.
    if (options.length < 3) {
      const seen = new Set();
      const fromLinks = [];
      for (const a of document.querySelectorAll('a[href]')) {
        if (a.host !== location.host || !CHAPTERISH.test(a.pathname + a.search)) continue;
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        const n = chapNum(a.pathname + a.search);
        if (Number.isNaN(n)) continue;
        fromLinks.push({
          label: (a.textContent.trim() || `Ch. ${n}`).slice(0, 60),
          url: a.href,
          n,
        });
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
            return { label: o.textContent.trim().slice(0, 60), url, n };
          });
        break;
      }
    }
    options.sort((a, b) => (b.n || 0) - (a.n || 0)); // newest first, like the sites
    if (options.length > 400) options = options.slice(0, 400);

    // prev/next: explicit rel/text links win; fall back to list neighbours.
    const findNav = (rel, textRe) => {
      const el = document.querySelector(`a[rel="${rel}"]`) ||
        [...document.querySelectorAll('a[href]')].find((a) =>
          a.host === location.host && textRe.test((a.textContent || '').trim()) &&
          (a.textContent || '').trim().length < 30 && CHAPTERISH.test(a.pathname + a.search));
      return el && el.href !== location.href ? el.href : null;
    };
    let prevUrl = findNav('prev', /^(<|«|‹|←)?\s*(prev(ious)?( chapter)?|chapitre )?pr[eé]c[eé]dent|^prev/i);
    let nextUrl = findNav('next', /^(next( chapter)?|chapitre suivant|suivant)\s*(>|»|›|→)?$|^next/i);
    const cur = chapNum(location.pathname + location.search);
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

  // blob: page URLs die when the site revokes them (scan-manga revokes pages
  // you scrolled past). Copy the bytes into our own blob URL that we control;
  // if the original is already dead, rescue the decoded pixels off the <img>.
  async function stableImageSrc(img) {
    const src = img.currentSrc || img.src;
    if (!src || !src.startsWith('blob:')) return src;
    try {
      const blob = await fetch(src).then((r) => r.blob());
      return URL.createObjectURL(blob);
    } catch {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        if (blob) return URL.createObjectURL(blob);
      } catch { /* fall through */ }
      return src;
    }
  }

  async function openReader() {
    if (!detection || !detection.gallery) return;
    const srcs = (await Promise.all(detection.gallery.images.map(stableImageSrc))).filter(Boolean);
    window.PanelFlowReader.open(srcs, seriesMeta(), detection.domainRule || {}, detection.gallery.container);
  }

  // --- scan orchestration --------------------------------------------------

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 600);
  }

  function scan() {
    const result = scorePage();
    // Both gates are veto-only: a page that clears the score still has to look
    // like a chapter and read like one, or the reader stays out of the way.
    if (result.gallery &&
        (rowCount(result.gallery.images) < 3 || !chapterEvidence())) return;
    if (result.score >= rules.heuristics.scoreThreshold && result.gallery) {
      detection = result;
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
      if (reopen || auto) {
        autoOpened = true;
        document.getElementById('panelflow-pill')?.remove();
        openReader();
      }
    });
  }

  // Lazy-loaded images and SPA navigations: rescan on DOM changes (debounced)
  // until a detection sticks, and on history navigation.
  const observer = new MutationObserver(() => { if (!detection) scheduleScan(); });
  observer.observe(document.body, { childList: true, subtree: true });
  addEventListener('popstate', () => { detection = null; scheduleScan(); });

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
        document.getElementById('panelflow-pill')?.remove();
        openReader();
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
      } else {
        // The guess does not resolve. Pin the chapter URL instead: it is
        // reachable, so the entry stays clickable and progress still tracks.
        meta.sourceUrl = location.href;
        meta.seriesUrlVerified = false;
      }
    }
    return meta;
  }

  // Expose for reader.js: series meta, chapter navigation, blob rescue.
  window.__panelflowDetect = {
    seriesMeta, chapterNav, stableImageSrc,
    get detection() { return detection; },
  };
})();
