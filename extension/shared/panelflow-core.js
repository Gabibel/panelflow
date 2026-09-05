// PanelFlow store core — every rule about the library, progress, duplicates and
// backend sync lives here, and only here.
//
// The extension's service worker, the Android shell and the iOS shell all run
// this same file. They differ only in what they hand to `createCore`: a key/value
// store, a `fetch`, and a way to raise a notification. Nothing below touches a
// `chrome.*` API, a DOM, or a Node built-in, so it loads unchanged as a Chrome
// content/worker script, inside a WKWebView, inside an Android WebView, and in
// `node --test`.
//
// Plain IIFE rather than an ES module on purpose: Chrome MV3 content scripts
// cannot be modules, and this file has to be loadable by `importScripts` too.
// Edit this copy — `extension/shared/` and `mobile/shared/` are generated
// (`npm run sync:shared`).
(function (root) {
  'use strict';

  const M = root.PanelFlowMatch;
  if (!M) throw new Error('panelflow-core.js requires series-match.js to be loaded first');
  const { normUrl, seriesKey, sameSeries, findMatches, furtherChapter, chapterNumber } = M;

  // Production, not localhost: a fresh install has no backend of its own to
  // talk to, and one that points at a port nothing is listening on looks broken
  // rather than signed out. Working on the server means typing the local URL
  // into the options page once — the stored value always wins over this.
  const DEFAULTS = {
    backendUrl: 'https://panelflow-backend.vercel.app',
    checkIntervalMin: 360,
  };
  const RULES_TTL_MS = 6 * 3600 * 1000;

  /**
   * What kind of work an entry is. Exhaustive, and named once.
   *
   * `manga` is anything drawn, `novel` is anything read as prose, `anime` is
   * anything watched. The list is closed on purpose: this value decides which
   * catalogue a tracker is told to write to, and a fourth spelling invented by
   * one client is a bookmark sent to the wrong list on somebody's real account.
   *
   * Here rather than in a shared file of its own, because `addToLibrary` below
   * is what sets it and this file is already loaded by every client — a new
   * shared file would mean a load-order entry in five manifests to name three
   * strings.
   */
  const MEDIA = ['manga', 'novel', 'anime'];
  const DEFAULT_MEDIUM = 'manga';

  // Pull the chapter number out of a label like "Ch. 110". Stripping non-digits
  // instead leaves the dot from "Ch." glued to the front (".110" → 0.11), which
  // made "Ch. 9" (0.9) look newer than "Ch. 10" (0.1) and blocked the advance.
  const labelNum = (label) => {
    const m = String(label ?? '').match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : NaN;
  };

  const CHAPTER_RE = /(chapter|chapitre|chap|ch|episode)[-_\s]*([\d]+(?:\.\d+)?)/gi;

  // Three ways to read the latest chapter off a series page, best first — and
  // they are *passes*, not one merged scan. The first that finds anything wins,
  // and the rest are never consulted.
  //
  // Merging them was a real bug. A series page carries a carousel of other
  // series, each card reading "Hajime no Ippo Chapitre 1515"; a single maximum
  // over every pattern answered 1515 for a series whose own chapter links stop
  // at 125 — and answered something different on the next load, because the
  // carousel rotates. A chapter link names its series in its own href, so once
  // the page has offered one, nothing loose in the markup may outbid it.
  //
  // Sits above URL_NUM_RE on purpose: two tests lift the run of source that
  // starts there, and a pass list holding CHAPTER_RE would not survive the cut.
  const CHAPTER_PASSES = [
    // The chapter list, as links. Only this series' chapters can appear here.
    { re: /(?:href|value|data-href|data-url)=["'][^"']*?(?:chapter|chapitre|chap|ch|episode)[-_/]?([\d]+(?:\.\d+)?)[^"']*["']/gi, num: 1 },
    // The chapter list rendered without links: a tag that opens on the number.
    { re: />\s*(?:chapter|chapitre|chap\.?|ch\.?|episode)[-_\s]*([\d]+(?:\.\d+)?)/gi, num: 1 },
    // Anywhere at all. Last resort, and the one that reads other series.
    { re: CHAPTER_RE, num: 2 },
  ];

  function maxChapterIn(html) {
    for (const { re, num } of CHAPTER_PASSES) {
      let max = null;
      for (const m of html.matchAll(re)) {
        const n = parseFloat(m[num]);
        if (!Number.isNaN(n) && n < 10000 && (max === null || n > max)) max = n;
      }
      if (max !== null) return max;
    }
    return null;
  }

  // --- a page that is not the page -------------------------------------------
  //
  // Anti-bot services do not answer with an error. They answer 200, with an
  // interstitial that says "checking your browser", and everything downstream
  // treats that like a series page: the scraper reads `<title>` and hands back
  // "Just a moment…", which is then the name of a series in someone's library.
  //
  // Two families of sign, kept apart because they carry different risk. The
  // machine markers below are strings no manga page contains, so they are
  // matched anywhere in the markup. The human-readable ones are matched against
  // the `<title>` only — "access denied" in the body of a chapter is a line of
  // dialogue, in the title of a 3 kB page it is the wall.
  const CHALLENGE_MARKERS = [
    'cf-browser-verification', '_cf_chl_opt', 'cf_chl_opt', '/cdn-cgi/challenge-platform',
    'ddos-guard.net', '__ddg', 'sucuri_cloudproxy', 'x-sucuri-id',
  ];
  const CHALLENGE_TITLES = [
    'just a moment', 'attention required', 'access denied', 'ddos-guard',
    'security check', 'checking your browser', 'verifying you are human',
    'bot verification', 'un instant', 'один момент',
  ];

  /**
   * Whether this response is an anti-bot wall rather than the page asked for.
   * Callers must treat true as a failed fetch: no title, no cover, and above
   * all no chapter number, because the wall has none and "none" would be read
   * as "the series has no chapters yet".
   */
  function challengePage(html) {
    const markup = String(html || '');
    if (!markup) return false;
    const lower = markup.toLowerCase();
    if (CHALLENGE_MARKERS.some((sign) => lower.includes(sign))) return true;
    const title = (lower.match(/<title[^>]*>([^<]*)/) || [])[1] || '';
    return CHALLENGE_TITLES.some((sign) => title.includes(sign));
  }

  // --- sites that build their page in the browser ----------------------------
  //
  // MangaDex sends 6 kB of application shell and fills it in with JavaScript.
  // The `<meta>` tags are in that shell, so title and cover survive — but the
  // chapter list is not, and the chapter list is the entire job of the watcher.
  // The result was a site among the largest in the world on which PanelFlow
  // never announced a single chapter, and never said why.
  //
  // The answer is not to render JavaScript on the server. These sites have a
  // public API — the same one their own front end calls — so a domain rule may
  // name it, and the number comes from the source instead of from the markup:
  //
  //   "*.mangadex.org": {
  //     "chapterApi": {
  //       "from": "/title/([0-9a-f-]{36})",   against the page URL
  //       "url":  "https://api.mangadex.org/manga/$1/aggregate",
  //       "pick": "\"chapter\"\\s*:\\s*\"(\\d+(?:\\.\\d+)?)\""
  //     }
  //   }
  //
  // Pure on purpose: this half decides *what* to ask and reads the answer, and
  // the fetching is left to whoever has one — the server, or a client.

  /**
   * The call one of these rules asks for, for this page: pull the id out of the
   * page URL with the rule's own pattern, put it into the rule's own template.
   * Null when the rule does not apply here.
   */
  function apiCallFor(api, pageUrl) {
    if (!api || !api.from || !api.url) return null;
    let hit;
    try { hit = String(pageUrl || '').match(new RegExp(api.from)); } catch { return null; }
    if (!hit) return null;
    // $1..$9 only: the whole match is never what these rules want, and $0 in a
    // URL template reads as a typo for a capture that was not written.
    return api.url.replace(/\$([1-9])/g, (whole, i) => hit[Number(i)] ?? whole);
  }

  /** The chapter-list call this site's rule asks for, for this page. */
  function chapterApiUrl(pageUrl, site) {
    return apiCallFor(site && site.chapterApi, pageUrl);
  }

  /** The highest chapter number in an API answer, read the rule's way. */
  function maxChapterInApi(text, site) {
    const api = site && site.chapterApi;
    if (!api || !api.pick || !text) return null;
    let re;
    try { re = new RegExp(api.pick, 'g'); } catch { return null; }
    let max = null;
    for (const m of String(text).matchAll(re)) {
      const n = parseFloat(m[1]);
      // No 10000 ceiling here, unlike maxChapterIn: that bound exists to fend
      // off page furniture — timestamps, view counts, prices — and an answer
      // from the site's own chapter endpoint has none of that in it.
      if (!Number.isNaN(n) && (max === null || n > max)) max = n;
    }
    return max;
  }

  // --- the panels, when the page will not hand them over ----------------------
  //
  // The same site, the same problem one floor down. MangaDex shows one page at a
  // time and keeps three <img> in the DOM — the one being read and two preloads
  // with no box yet — so the strip the reader is built to lift does not exist,
  // and the detector was right to refuse it. Nothing in the markup can fix that.
  //
  // The panels are one call away, in the same public API the site's own front
  // end uses, so a domain rule may name that call too:
  //
  //   "*.mangadex.org": {
  //     "pageApi": {
  //       "from":  "/chapter/([0-9a-fA-F-]{36})",       against the page URL
  //       "url":   "https://api.mangadex.org/at-home/server/$1",
  //       "base":  "baseUrl",          dotted paths into the JSON answer
  //       "hash":  "chapter.hash",
  //       "files": "chapter.data",
  //       "page":  "{base}/data/{hash}/{file}"
  //     }
  //   }
  //
  // Pure, like the pair above: this decides what to ask and reads the answer,
  // and the fetching belongs to whoever has one.

  /** A value at a dotted path inside a parsed JSON answer, or undefined. */
  function atPath(data, path) {
    let node = data;
    for (const key of String(path || '').split('.')) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[key];
    }
    return node;
  }

  const fillTemplate = (tpl, vars) =>
    String(tpl).replace(/\{(base|hash|file)\}/g, (whole, k) => vars[k] ?? whole);

  /** The call this site's rule asks for to list a chapter's panels. */
  function pageApiUrl(pageUrl, site) {
    return apiCallFor(site && site.pageApi, pageUrl);
  }

  /**
   * The panel URLs in an API answer, built the rule's way. An empty array for
   * anything unexpected — a shape that moved, an error body, a truncated
   * answer — because "no pages" is a page the reader declines to open, and a
   * half-read answer would be a chapter missing panels with nothing to say so.
   *
   * Only http(s) URLs come back. The template is ours but `base` is the remote
   * answer's, and an image src is not a place to let an arbitrary scheme land.
   */
  function pagesFromApi(text, site) {
    const api = site && site.pageApi;
    if (!api || !api.files || !api.page) return [];
    let data;
    try { data = JSON.parse(String(text || '')); } catch { return []; }
    const files = atPath(data, api.files);
    if (!Array.isArray(files)) return [];
    const vars = {
      base: api.base ? atPath(data, api.base) : '',
      hash: api.hash ? atPath(data, api.hash) : '',
    };
    for (const key of ['base', 'hash']) {
      if (api[key] && typeof vars[key] !== 'string') return [];
      vars[key] = String(vars[key] ?? '').replace(/\/$/, '');
    }
    return files
      .filter((file) => typeof file === 'string' && file)
      .map((file) => fillTemplate(api.page, { ...vars, file }))
      .filter((url) => /^https?:\/\//i.test(url));
  }

  // A number in a URL, and whether a chapter word introduces it. Sites put the
  // chapter number in the path — /chapter/245, /chapitre-109-vf, /read/x/1055 —
  // which is the only handle on "the next one" that exists before the next one
  // is out and linkable.
  const URL_NUM_RE = /\d+(?:\.\d+)?/g;
  // Anchored at a word start, or "/comic/245" reads as the abbreviation "c".
  const CHAPTER_WORD_RE = /(?:^|[^a-z])(chapter|chapitre|chap|ch|episode|ep|c)[-_/]?$/i;

  // Written the way the site writes it: 246 after /chapter/245 but 0246 after
  // /chapter/0245, because a site that pads its numbers 404s on the short form.
  const renderNum = (was, n) => {
    const [whole] = was.split('.');
    const [i, dec] = String(n).split('.');
    const padded = /^0\d/.test(whole) ? i.padStart(whole.length, '0') : i;
    return dec ? `${padded}.${dec}` : padded;
  };

  /**
   * The URL of another chapter of the same series, worked out from the URL of
   * one you already have. Only the path and query are considered — the host is
   * full of numbers that have nothing to do with chapters ("ww6.example.com").
   *
   * Returns null rather than a guess whenever the substitution is not obvious:
   * no occurrence of the number you are coming from, or several of them with no
   * chapter word to break the tie. Sites that mint a slug or a uuid per chapter
   * land there, and the caller falls back to something it knows is real.
   */
  function nextChapterUrl(url, from, to) {
    // isFinite, not !isNaN: the two callers disagree about how they spell "no
    // number" — one returns NaN, the other null — and both must land here.
    if (!url || !Number.isFinite(from) || !Number.isFinite(to)) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    const tail = u.pathname + u.search;

    const hits = [];
    for (const m of tail.matchAll(URL_NUM_RE)) {
      if (parseFloat(m[0]) !== from) continue;
      hits.push({ at: m.index, text: m[0], keyed: CHAPTER_WORD_RE.test(tail.slice(0, m.index)) });
    }
    if (hits.length === 0) return null;
    // "/manga/tower-of-god-3/chapter/3" — the same number twice, and only one of
    // them is the chapter. With no chapter word in front of either, changing the
    // wrong one silently asks for a different series.
    const keyed = hits.filter((h) => h.keyed);
    const hit = hits.length === 1 ? hits[0] : keyed.length === 1 ? keyed[0] : null;
    if (!hit) return null;

    const moved = tail.slice(0, hit.at) + renderNum(hit.text, to) + tail.slice(hit.at + hit.text.length);
    // The hash is dropped on purpose: it anchors a page of the chapter you are
    // leaving, and carrying it over would land you halfway down the new one.
    return u.origin + moved;
  }

  /**
   * Where a series' cover should take you. Normally the chapter you are on —
   * that is what a bookmark is for — but once you have caught up and the site
   * has moved on, the point of opening the series is the chapter you have not
   * read, not the one you finished last week.
   *
   * "The one after the one you finished", not the newest: someone five chapters
   * behind wants 246, not 250.
   */
  function continueTarget(entry, progress) {
    const series = { url: entry?.sourceUrl || null, label: null, isNew: false };
    if (!progress?.chapterUrl) return series;
    const here = { url: progress.chapterUrl, label: progress.chapterLabel || null, isNew: false };

    const read = labelNum(progress.chapterLabel);
    const latest = labelNum(entry?.lastKnownChapter);
    if (!Number.isFinite(read) || !Number.isFinite(latest) || latest <= read) return here;

    // Positive evidence of being mid-chapter, and nothing weaker: a page count
    // and a page short of it. Most bookmarks have no count at all — the ones the
    // site's own next-chapter link writes never do — and treating "unknown" as
    // "unfinished" would leave the reader on a chapter they closed months ago.
    if (progress.pageCount > 1 && (progress.page ?? 0) < progress.pageCount - 1) return here;

    const next = Math.min(read + 1, latest);
    const url = nextChapterUrl(progress.chapterUrl, read, next);
    return url ? { url, label: `Ch. ${next}`, isNew: true } : here;
  }

  // Far more rows than anyone scrolls through, and the point past which the
  // list costs more to build than it is worth. The longest series in print are
  // an order of magnitude below it.
  const RANGE_CAP = 2000;

  /**
   * Every chapter of a series, worked out from one of them.
   *
   * Plenty of sites ship a three-entry chapter list — previous, current, next —
   * which is nothing to search through. The numbers below the one on screen are
   * safe to fill in: a site cannot have published chapter 245 without having
   * published 1 to 244. Above it, only as far as the library knows the series
   * has got, because a chapter that is not out yet is a 404.
   *
   * Newest first, the way every site orders its own list. Empty when the
   * chapter's URL yields nothing to derive from (a uuid, a per-chapter slug):
   * a list of links that all 404 is worse than no list.
   */
  function chapterRange(chapterUrl, label, latestLabel) {
    const here = labelNum(label);
    if (!Number.isFinite(here) || here < 1) return [];
    const latest = labelNum(latestLabel);
    const top = Math.floor(Math.max(here, Number.isFinite(latest) ? latest : 0));

    const nums = [];
    for (let n = top; n >= Math.max(1, top - RANGE_CAP + 1); n--) nums.push(n);
    // "245.5" is a real chapter on plenty of sites, and it is the one being
    // read, so it takes its own row rather than being rounded onto a neighbour.
    if (!Number.isInteger(here)) {
      const i = nums.indexOf(Math.floor(here));
      nums.splice(i === -1 ? 0 : i, 0, here);
    }

    const out = [];
    for (const n of nums) {
      const url = n === here ? chapterUrl : nextChapterUrl(chapterUrl, here, n);
      if (url) out.push({ n, label: `Ch. ${n}`, url });
    }
    // Only the chapter already on screen came back: nothing was derived, and
    // one row is not a list.
    return out.length > 1 ? out : [];
  }

  // Titles scraped from a chapter page keep the separators around them ("Ao no
  // Hako »") and, far more often, the site's SEO tail with them ("Blue Box Scan
  // VF / FR Gratuit (Webtoon)"). Both come off here, and here is the only place
  // they come off: the shelf, the three exports and both trackers all read the
  // stored title, so a card that reads right next to a MyAnimeList entry that
  // does not is what happens when each screen cleans for itself.
  //
  // `opts` is `{ host, rules }`, and it is what makes the word list changeable:
  // it lets the site's own section in detection-rules.json apply, so a site
  // renaming its tail costs a line in a file every client re-reads every six
  // hours rather than an extension release and a store review. Called without
  // it, this trims what it always trimmed and strips the words that shipped.
  const cleanTitle = (t, opts) => {
    const trimmed = String(t || '').replace(/^[\s»«|•·:—–-]+|[\s»«|•·:—–-]+$/g, '').trim();
    // displayTitle already refuses to hand back an empty string; this is the
    // second lock on the same door. A title is the one field on a library card
    // that cannot be worked out again once it is gone.
    return M.displayTitle(trimmed, opts) || trimmed;
  };

  // --- saying where a failure came from ---------------------------------------
  //
  // Everything a reader can do in the extension, on Android and on iOS arrives
  // as one of the messages `createHub` answers, and every failure inside one of
  // them used to leave through a single line: `{ error: e.message }`. That
  // sentence is the right thing to put on screen — "connect that tracker again"
  // is what the reader needs to read — but it was also *all* anyone got. The
  // stack was dropped, the message type was not in it, and the request that
  // actually answered 502 was three frames further down. A bug report then says
  // "it told me to connect it again", and the only road back to the cause is to
  // read every handler that can produce that sentence.
  //
  // So the sentence is left exactly as it was, and the provenance travels
  // beside it. Three fields, set at the innermost frame that knows them:
  //
  //   err.pfOrigin  the operation that failed  ("apiFetch")
  //   err.pfPath    the request, when there was one  ("/api/trackers/anilist/pull")
  //   err.pfStatus  what it answered  (502)
  //
  // `report` writes each failure once, in one shape, and keeps the last few in
  // a ring the reader can be asked to paste back — the console of an MV3
  // service worker or of an offscreen WebView is closed by the time anyone
  // thinks to open it, so a failure nobody was watching has to survive itself.
  const TRAIL_MAX = 40;
  const trail = [];

  /**
   * Attach provenance to an error without touching what it says.
   *
   * The innermost frame wins: a field already set is a field set by whoever was
   * closer to the failure, and re-stamping it on the way out is how a hub-level
   * label overwrites the endpoint that actually broke.
   */
  function tagError(err, origin, fields) {
    const e = err instanceof Error ? err : new Error(String((err && err.message) || err));
    if (!e.pfOrigin) e.pfOrigin = origin;
    for (const key of Object.keys(fields || {})) {
      if (e[key] === undefined && fields[key] !== undefined) e[key] = fields[key];
    }
    return e;
  }

  /** One line per failure, one shape, and a copy kept for later. */
  function reportError(scope, err) {
    const entry = {
      at: new Date().toISOString(),
      scope,
      origin: (err && err.pfOrigin) || scope,
      path: err && err.pfPath,
      status: err && err.pfStatus,
      message: String((err && err.message) || err),
    };
    trail.push(entry);
    if (trail.length > TRAIL_MAX) trail.shift();
    if (root.console) {
      const where = entry.path
        ? ` at ${entry.path}${entry.status ? ' → ' + entry.status : ''}`
        : '';
      root.console.warn(`[panelflow] ${scope} failed in ${entry.origin}${where}: ${entry.message}`, err);
    }
    return entry;
  }

  const diag = {
    tag: tagError,
    report: reportError,
    /** The last few failures, newest last. `PanelFlowCore.diag.trail()`. */
    trail: () => trail.slice(),
  };

  /**
   * @param {object} env
   * @param {{get(keys): Promise<object>, set(obj): Promise<void>}} env.storage
   * @param {Function} env.fetch          network access (same signature as global fetch)
   * @param {Function} [env.notify]       ({ id, title, message, entry, latest, url }) → void
   * @param {Function} [env.now]          () → ISO string, injectable for tests
   * @param {Function} [env.uuid]         () → string
   * @param {number}   [env.checkPacingMs] gap between requests in checkNewChapters
   * @param {Function} [env.canFetch]   (url) → boolean|Promise<boolean>; whether this
   *                                    platform is allowed to fetch that origin at all
   * @param {object}   [env.defaults]     settings defaults (backendUrl, checkIntervalMin)
   */
  function createCore(env) {
    const store = env.storage;
    const netFetch = env.fetch;
    const notify = env.notify || (() => {});
    const now = env.now || (() => new Date().toISOString());
    const uuid = env.uuid || (() => root.crypto.randomUUID());
    const pacingMs = env.checkPacingMs ?? 2000;
    // Whether this platform may reach an origin at all.
    //
    // Only the Chrome extension answers anything but yes. Its worker runs on a
    // `chrome-extension://` origin, so a fetch to a site it holds no host
    // permission for is subject to CORS and the site refuses it — every time,
    // for good, not as a passing failure. The web app and the phones have no
    // such wall, so they pass nothing and get the default.
    const canFetch = env.canFetch || (() => true);
    const defaults = { ...DEFAULTS, ...(env.defaults || {}) };
    // What else has to happen when a series leaves the library. The shells that
    // keep chapters on the device hand in their offline store here, because
    // neither of the other two places would work: the core cannot hold the
    // store itself (the web app has none), and the hub cannot intercept the
    // message (`extras` only answers types the hub does not already know).
    const onRemoved = env.onRemoved || (() => {});

    async function getSettings() {
      const { settings } = await store.get(['settings']);
      // A stored blank is a cleared field, not a setting. The options page
      // shows the default as the box's placeholder, so an empty box looks
      // exactly like "the default is in force" — and pressing Save writes the
      // emptiness over it. Merged as-is, `backendUrl: ''` then blinds every
      // client that trusted it, while the URL it should be using goes on
      // showing, greyed out, in the very box that caused it. Clearing a field
      // means "back to the default", and this is where that is true.
      const kept = Object.entries(settings || {})
        .filter(([, v]) => !(typeof v === 'string' && v.trim() === ''));
      return { ...defaults, ...Object.fromEntries(kept) };
    }

    async function setSettings(patch) {
      const settings = { ...(await store.get(['settings'])).settings, ...patch };
      await store.set({ settings });
      // Read back rather than assembled here, so what Save hands the page is
      // what the next reader of these settings will see — including the blank
      // that just became a default again.
      return getSettings();
    }

    async function getToken() {
      const { authToken } = await store.get(['authToken']);
      return authToken || null;
    }

    async function apiFetch(path, options = {}) {
      const settings = await getSettings();
      const token = await getToken();
      const method = options.method || 'GET';
      let resp;
      try {
        resp = await netFetch(settings.backendUrl + path, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(options.headers || {}),
          },
        });
      } catch (e) {
        // A network failure says "Failed to fetch" and nothing else — not which
        // request, not to which backend. Stamped here, that is the difference
        // between "the phone is offline" and "this one endpoint is wrong".
        throw tagError(e, 'apiFetch', { pfPath: path, pfMethod: method });
      }
      if (!resp.ok) {
        // The server's own sentence when it wrote one. "The connection to this
        // tracker has expired — connect it again" tells the reader what to do
        // next; "API /api/trackers/…: 401" tells them a number.
        let said = null;
        let ref = null;
        // `ref` is the backend's own label for an unlabelled 500 (see the error
        // middleware in backend/src/index.js). Carried through so one grep of
        // the server log lands on the stack instead of on a hundred routes.
        try { const body = await resp.json(); said = body.error; ref = body.ref; } catch (e) { /* not JSON */ }
        throw tagError(new Error(said || `API ${path}: ${resp.status}`), 'apiFetch',
          { pfPath: path, pfMethod: method, pfStatus: resp.status, pfRef: ref || undefined });
      }
      return resp.status === 204 ? null : resp.json();
    }

    // --- detection rules (remote config with bundled fallback) ---------------

    /**
     * The rules already on this device, without ever asking for them.
     *
     * getRules() below fetches when the cache is cold, which is right for the
     * detector — it is answering "is this a reader page?" and a round trip is
     * the cost of knowing. It is wrong everywhere else: adding a series is a
     * local write, and "everything works signed out and nothing is sent
     * anywhere" is a property this app has and means to keep. So the callers
     * that only want the word list read what is there and take null for an
     * answer, which the vocabulary handles by falling back to what shipped.
     *
     * No TTL either. Stale rules are a slightly generous word list, and a
     * request sent to freshen one is worse than the staleness.
     */
    async function storedRules() {
      const { rulesCache } = await store.get(['rulesCache']);
      return rulesCache ? rulesCache.rules : null;
    }

    async function getRules() {
      const { rulesCache } = await store.get(['rulesCache']);
      if (rulesCache && Date.now() - rulesCache.fetchedAt < RULES_TTL_MS) {
        return rulesCache.rules;
      }
      try {
        const rules = await apiFetch('/api/rules');
        await store.set({ rulesCache: { rules, fetchedAt: Date.now() } });
        return rules;
      } catch {
        return rulesCache ? rulesCache.rules : null; // clients carry their own fallback
      }
    }

    /**
     * The ad-block list, same contract as getRules: cached, refreshed on a TTL,
     * and null when there has never been an answer.
     *
     * Null is the important case. Every client ships a copy of the list, so
     * null means "keep blocking what you already block" — the one thing this
     * must never do is come back empty and be mistaken for a list that blocks
     * nothing, which would silently turn ad blocking off for anyone whose
     * backend is down.
     */
    async function getFilterList() {
      const { filterCache } = await store.get(['filterCache']);
      if (filterCache && Date.now() - filterCache.fetchedAt < RULES_TTL_MS) {
        return filterCache.list;
      }
      try {
        const list = await apiFetch('/api/adblock');
        if (!list || !Array.isArray(list.entries) || !list.entries.length) throw new Error('empty');
        await store.set({ filterCache: { list, fetchedAt: Date.now() } });
        return list;
      } catch {
        return filterCache ? filterCache.list : null;
      }
    }

    // --- library (local-first, sync when signed in) --------------------------

    async function getLibrary() {
      const { library } = await store.get(['library']);
      return library || [];
    }

    // Series URLs are guessed from chapter URLs and the guess drifts between
    // visits, so two entries for one series rarely share a URL. seriesKey (from
    // shared/series-match.js) reduces every URL to host + series slug so
    // ".../ao-no-hako/245/" and ".../ao-no-hako/247/" land on the same book, and
    // a site that files chapters under /chapter/ and the series under /manga/
    // still resolves to one entry.
    const findEntry = (library, url) => library.find((e) => sameSeries(e.sourceUrl, url));

    // That same drift means an entry's sourceUrl gets rewritten in place —
    // adding chapter 110 of a series first added from chapter 109 moves it. But
    // progress is keyed by sourceUrl, so unless the bookmark moves with it the
    // user's place in the book is orphaned under a URL nothing points at any
    // more, and "Continue reading" silently loses the series. migrateEntry does
    // this the long way round because it also has an absorbed entry to fold in;
    // here there are only ever two bookmarks to reconcile.
    async function rekeyProgress(from, to) {
      if (!from || !to || normUrl(from) === normUrl(to)) return;
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      const moved = map[from];
      if (!moved) return;
      delete map[from];
      // Forward-only, the same rule chapterVisited uses: whichever bookmark is
      // deeper into the series wins, so re-keying can never rewind the user.
      const rank = (p) => (p ? (chapterNumber(p.chapterLabel) ?? -1) : -Infinity);
      const winner = rank(map[to]) > rank(moved) ? map[to] : moved;
      map[to] = { ...winner, sourceUrl: to, updatedAt: now() };
      await store.set({ progress: map });
    }

    async function addToLibrary(entry) {
      // Where the user is reading rides along with the entry, but it is
      // progress, not library metadata — keep it out of the stored record.
      // `medium` leaves with them, and for a stronger reason than progress: it
      // is set once, below, and the generic copy that follows would put an
      // incoming value straight back over a correction the reader made by hand.
      const { chapterUrl, chapterLabel, medium: _medium, ...fields } = entry;
      const library = await getLibrary();
      const existing = findEntry(library, entry.sourceUrl);
      const movedFrom = existing?.sourceUrl;
      const record = existing || {
        folder: 'reading',
        id: uuid(),
        dateAdded: now(),
      };
      // Re-adding an entry is how the modal saves edits, so incoming fields win
      // — but only the ones actually supplied, or a quick add would blank the
      // rest.
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null) record[k] = v;
      }
      // The title arrives as the page's <title>, SEO tail and all, and this is
      // the door it comes in through: everything downstream reads what is
      // stored, not what was on the page.
      //
      // On the way in only, never on a re-add — re-adding is also how the edit
      // modal saves, and a reader who typed "Manga Dogs" back over our guess
      // must not have it taken off them again the next time they touch the
      // form. The rules file is fetched here rather than handed in because the
      // entry is the only thing that knows which host it came from.
      if (!existing && record.title) {
        record.title = cleanTitle(record.title, {
          host: record.sourceDomain, rules: await storedRules(),
        });
      }
      // The kind of work, settled once and then left alone.
      //
      // On the way in only, for the same reason the title is cleaned here and
      // nowhere else: re-adding is also how the edit sheet saves, and somebody
      // who corrected a mis-detected medium by hand must not have it taken back
      // off them the next time they touch the form.
      //
      // Whatever the detector said, if it said anything — it is the only thing
      // that has seen the page. An unknown or invented value falls back rather
      // than being stored: this is what a tracker routes on, and a bad value
      // there writes to the wrong catalogue on somebody's real account.
      if (!existing) {
        record.medium = MEDIA.includes(entry.medium) ? entry.medium : DEFAULT_MEDIUM;
      }
      record.updatedAt = now();
      if (!existing) library.push(record);
      await store.set({ library });
      await rekeyProgress(movedFrom, record.sourceUrl);
      if (await getToken()) {
        try {
          await pushEntry(record, library);
          await backfillMeta(record, library);
        } catch (e) { warn('library sync failed', e); }
      }
      // Now that the entry exists, the chapter the user added it from can be
      // pinned as their progress (chapterVisited is forward-only, so re-adding
      // an old chapter later cannot rewind the bookmark).
      if (chapterUrl && chapterLabel) {
        await chapterVisited({ sourceUrl: record.sourceUrl, chapterUrl, chapterLabel });
      }
      return record;
    }

    // Push one local entry to the backend; POST is idempotent per (user, sourceUrl).
    async function pushEntry(record, library) {
      const remote = await apiFetch('/api/library', {
        method: 'POST',
        body: JSON.stringify({
          title: record.title,
          coverUrl: record.coverUrl ?? null,
          sourceDomain: record.sourceDomain,
          sourceUrl: record.sourceUrl,
          tags: record.tags || [],
          lastKnownChapter: record.lastKnownChapter ?? null,
          folder: record.folder ?? null,
          language: record.language ?? null,
          score: record.score ?? null,
          note: record.note ?? null,
          startDate: record.startDate ?? null,
          finishDate: record.finishDate ?? null,
          rereads: record.rereads ?? null,
          seriesStatus: record.seriesStatus ?? null,
          // Sent on every push, not only the first: the server COALESCEs it, so
          // a device that learned the medium after the row was created is how a
          // library added before this existed ever gets one.
          medium: record.medium ?? null,
        }),
      });
      record.remoteId = remote.id;
      await store.set({ library });
      return remote;
    }

    // Chapter pages rarely carry a usable og:image, so entries added from the
    // reader often have no cover and no latest chapter. Ask the backend to
    // scrape the series page and fill both, locally and remotely.
    async function backfillMeta(record, library) {
      if (record.coverUrl && record.lastKnownChapter) return;
      const meta = await apiFetch('/api/meta/scrape?url=' + encodeURIComponent(record.sourceUrl));
      const patch = {};
      if (!record.coverUrl && meta.coverUrl) patch.coverUrl = meta.coverUrl;
      if (!record.lastKnownChapter && meta.latestChapter !== null) {
        patch.lastKnownChapter = String(meta.latestChapter);
      }
      if (Object.keys(patch).length === 0) return;
      Object.assign(record, patch);
      await store.set({ library });
      if (record.remoteId) {
        await apiFetch(`/api/library/${record.remoteId}`, { method: 'PUT', body: JSON.stringify(patch) });
      }
    }

    // Collapse entries that seriesKey says are one series. Older builds guessed
    // a different sourceUrl on every visit, so a single book could end up filed
    // four times; the surviving entry keeps the best field from each and
    // inherits the furthest progress. Deleting the losers also soft-deletes them
    // server-side, so the web app converges without a separate migration.
    function pickCanonical(group) {
      // A sourceUrl left ending on a separator is the old broken guess — it
      // 404s, so it must never win however complete the rest of the entry looks.
      const rank = (e) =>
        (e.coverUrl ? 4 : 0) + (e.lastKnownChapter ? 2 : 0) + (e.remoteId ? 1 : 0) -
        (/[-_.\s]$/.test(String(e.sourceUrl || '')) ? 8 : 0);
      return group.reduce((best, e) => (rank(e) > rank(best) ? e : best), group[0]);
    }

    async function dedupeLibrary() {
      const library = await getLibrary();
      // Asked once for the whole pass rather than per group: this walks the
      // entire library, and the word list is the same file every time.
      const rules = await storedRules();
      const groups = new Map();
      for (const e of library) {
        const k = seriesKey(e.sourceUrl);
        groups.set(k, (groups.get(k) || []).concat(e));
      }
      const merged = [];
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const keep = pickCanonical(group);
        const losers = group.filter((e) => e !== keep);
        for (const e of losers) {
          for (const [k, v] of Object.entries(e)) {
            // Fill gaps only: the canonical entry's own values are the good ones.
            if (v !== undefined && v !== null && v !== '' &&
                (keep[k] === undefined || keep[k] === null || keep[k] === '') &&
                !['id', 'remoteId', 'sourceUrl', 'dateAdded'].includes(k)) {
              keep[k] = v;
            }
          }
          keep.lastKnownChapter = furtherChapter(keep.lastKnownChapter, e.lastKnownChapter);
          // Keep the earliest date the series entered the library.
          if (e.dateAdded && (!keep.dateAdded || e.dateAdded < keep.dateAdded)) {
            keep.dateAdded = e.dateAdded;
          }
          keep.tags = [...new Set([...(keep.tags || []), ...(e.tags || [])])];
        }
        // The survivor's title, cleaned against its own site: the group being
        // merged is one work seen on several hosts, and the one being kept is
        // the one whose spelling everything downstream will use.
        keep.title = cleanTitle(keep.title, { host: keep.sourceDomain, rules }) || keep.title;
        merged.push({ keep, losers });
      }
      if (merged.length === 0) return { groups: 0, removed: 0 };

      // Move progress onto the surviving entry, furthest chapter wins.
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      for (const { keep, losers } of merged) {
        for (const e of losers) {
          const p = map[e.sourceUrl];
          if (!p) continue;
          const cur = map[keep.sourceUrl];
          if (!cur || !(labelNum(cur.chapterLabel) >= labelNum(p.chapterLabel))) {
            map[keep.sourceUrl] = { ...p, sourceUrl: keep.sourceUrl };
          }
          delete map[e.sourceUrl];
        }
        keep.updatedAt = now();
      }
      const drop = new Set(merged.flatMap(({ losers }) => losers.map((e) => e.id)));
      const kept = library.filter((e) => !drop.has(e.id));
      await store.set({ library: kept, progress: map });

      // Remote cleanup, one by one so a single failure cannot abort the rest.
      if (await getToken()) {
        for (const { losers } of merged) {
          for (const e of losers) {
            if (!e.remoteId) continue;
            try {
              await apiFetch(`/api/library/${e.remoteId}`, { method: 'DELETE' });
            } catch (err) { warn('dedupe remote delete failed', e.sourceUrl, err); }
          }
        }
        for (const { keep } of merged) {
          // `map` and `kept` are what was just written to the store, so re-reading
          // them once per group would only cost a round-trip per surviving entry.
          const p = map[keep.sourceUrl];
          try {
            if (!keep.remoteId) await pushEntry(keep, kept);
            else await apiFetch(`/api/library/${keep.remoteId}`, {
              method: 'PUT',
              body: JSON.stringify({
                title: keep.title,
                coverUrl: keep.coverUrl ?? null,
                lastKnownChapter: keep.lastKnownChapter ?? null,
                tags: keep.tags || [],
              }),
            });
            if (p && keep.remoteId) {
              await apiFetch(`/api/progress/${keep.remoteId}`, {
                method: 'PUT', body: JSON.stringify(p),
              });
            }
          } catch (err) { warn('dedupe remote merge failed', keep.sourceUrl, err); }
        }
      }
      return { groups: merged.length, removed: drop.size };
    }

    // Full reconciliation with the backend: adopt entries that never got a
    // remoteId (added while signed out), re-push all local progress, and
    // backfill missing covers. Runs after sign-in and on app/browser startup.
    async function syncAll() {
      if (!(await getToken())) return;
      // First, and best-effort: everything below may file an entry into a
      // category, and a client that has not heard of one yet would draw the
      // series under no tab at all.
      await pullCategories().catch((e) => warn('categories sync failed', e));
      await dedupeLibrary();
      const library = await getLibrary();
      for (const entry of library) {
        try {
          if (!entry.remoteId) await pushEntry(entry, library);
          await backfillMeta(entry, library);
        } catch (e) { warn('sync failed for', entry.sourceUrl, e); }
      }
      const { progress } = await store.get(['progress']);
      for (const p of Object.values(progress || {})) {
        const entry = findEntry(library, p.sourceUrl);
        if (!entry?.remoteId) continue;
        try {
          await apiFetch(`/api/progress/${entry.remoteId}`, { method: 'PUT', body: JSON.stringify(p) });
        } catch (e) { warn('progress sync failed for', p.sourceUrl, e); }
      }
      // Whatever was read while the account was unreachable. Last, because it
      // needs the entries above to have been pushed and given a remoteId.
      await flushHistory();
    }

    // Adopt the server's library into the local store. The extension never
    // needed this (it only ever pushes), but a phone that was signed in on
    // another device starts with an empty store and must be able to pull.
    async function pullLibrary() {
      if (!(await getToken())) return { added: 0, updated: 0 };
      const remote = await apiFetch('/api/library');
      const library = await getLibrary();
      let added = 0, updated = 0;
      for (const r of remote) {
        const local = library.find((e) => e.remoteId === r.id) || findEntry(library, r.sourceUrl);
        if (local) {
          // Last write wins, and the server row is only newer if it says so.
          if (!local.updatedAt || String(r.updatedAt) > String(local.updatedAt)) {
            Object.assign(local, r, { id: local.id, remoteId: r.id });
            updated++;
          } else if (!local.remoteId) {
            local.remoteId = r.id;
          }
        } else {
          library.push({ ...r, id: uuid(), remoteId: r.id });
          added++;
        }
      }
      await store.set({ library });

      const { progress } = await store.get(['progress']);
      const map = progress || {};
      for (const p of await apiFetch('/api/progress/continue').catch(() => [])) {
        const entry = library.find((e) => e.remoteId === p.libraryId);
        if (!entry) continue;
        const cur = map[entry.sourceUrl];
        if (cur && String(cur.updatedAt || '') >= String(p.updatedAt || '')) continue;
        map[entry.sourceUrl] = {
          sourceUrl: entry.sourceUrl,
          chapterUrl: p.chapterUrl,
          chapterLabel: p.chapterLabel,
          page: p.page ?? 0,
          pageCount: p.pageCount ?? null,
          scrollPos: p.scrollPos ?? 0,
          updatedAt: p.updatedAt,
        };
      }
      await store.set({ progress: map });
      return { added, updated };
    }

    // Patch one entry. Unlike addToLibrary's merge, an explicit null here clears
    // the field — that is how the detail view removes a score or a note.
    async function updateEntry(id, patch) {
      const library = await getLibrary();
      const entry = library.find((e) => e.id === id);
      if (!entry) throw new Error('entry not found');
      const movedFrom = entry.sourceUrl;
      Object.assign(entry, patch, { updatedAt: now() });
      await store.set({ library });
      await rekeyProgress(movedFrom, entry.sourceUrl);
      if (entry.remoteId && await getToken()) {
        apiFetch(`/api/library/${entry.remoteId}`, {
          method: 'PUT',
          body: JSON.stringify(patch),
        }).catch((e) => warn('entry sync failed', e));
      }
      return entry;
    }

    async function removeFromLibrary(id) {
      const library = await getLibrary();
      const entry = library.find((e) => e.id === id);
      await store.set({ library: library.filter((e) => e.id !== id) });
      if (entry?.remoteId && await getToken()) {
        apiFetch(`/api/library/${entry.remoteId}`, { method: 'DELETE' }).catch(() => {});
      }
      // After the library is written, and never fatal. Ninety days of a book
      // nobody has any more — tens of megabytes of it, listed on the saved
      // chapters page under a series that is gone — is not a retention policy;
      // it is a leak with a timer on it. But a store that will not open is no
      // reason to refuse to remove a series from the library.
      if (entry) {
        try { await onRemoved(entry); } catch (e) { warn('post-removal cleanup failed', e); }
      }
    }

    // --- duplicates across sites ---------------------------------------------

    // Everything in the library that might already be the work on `meta`'s page.
    // Answered from local storage so it is instant and works signed out; the
    // server has the same matcher behind POST /api/library/match for clients
    // that do not carry the library locally.
    async function findSimilar(meta) {
      if (!meta?.title && !meta?.sourceUrl) return [];
      const library = await getLibrary();
      return findMatches(meta, library).map((m) => ({
        confidence: m.confidence,
        score: m.score,
        entry: m.entry,
      }));
    }

    /**
     * Move an existing entry to a different scan site, keeping progress, score,
     * tags and the date it was added. This is the alternative offered when the
     * series being added is already in the library under another site — without
     * it the user ends up reading the same book twice, in two places, with two
     * half-finished bookmarks.
     *
     * If a separate entry already sits on the destination it is absorbed rather
     * than left behind, mirroring what POST /api/library/:id/migrate does server
     * side so both stores end up with the same single entry.
     */
    async function migrateEntry(id, target) {
      const { sourceUrl, sourceDomain, title, coverUrl, lastKnownChapter, tags,
              chapterUrl, chapterLabel } = target || {};
      if (!sourceUrl || !sourceDomain) throw new Error('sourceUrl and sourceDomain required');

      const library = await getLibrary();
      const entry = library.find((e) => e.id === id);
      if (!entry) throw new Error('entry not found');
      const from = entry.sourceUrl;
      if (normUrl(sourceUrl) === normUrl(from)) throw new Error('already the current source');

      const other = library.find((e) => e.id !== entry.id && sameSeries(e.sourceUrl, sourceUrl));
      const keep = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? null;

      entry.previousSources = [...(entry.previousSources || []), {
        sourceUrl: from,
        sourceDomain: entry.sourceDomain,
        lastKnownChapter: entry.lastKnownChapter ?? null,
        migratedAt: now(),
      }];
      entry.sourceUrl = sourceUrl;
      entry.sourceDomain = sourceDomain;
      entry.title = keep(title, entry.title, other?.title);
      entry.coverUrl = keep(coverUrl, entry.coverUrl, other?.coverUrl);
      entry.lastKnownChapter = furtherChapter(entry.lastKnownChapter, other?.lastKnownChapter, lastKnownChapter);
      entry.tags = [...new Set([...(entry.tags || []), ...(other?.tags || []), ...(tags || [])])];
      // 'reading' is where every entry starts, so it loses to a folder the user
      // actually picked on the entry being absorbed.
      if (other && (!entry.folder || entry.folder === 'reading')) entry.folder = other.folder ?? entry.folder;
      for (const field of ['language', 'score', 'note', 'startDate', 'finishDate', 'seriesStatus', 'medium']) {
        entry[field] = keep(entry[field], other?.[field]);
      }
      entry.rereads = Math.max(entry.rereads || 0, other?.rereads || 0);
      if (other?.dateAdded && other.dateAdded < entry.dateAdded) entry.dateAdded = other.dateAdded;
      entry.updatedAt = now();

      // Progress is keyed by sourceUrl, so it has to be re-filed under the new
      // one. Three bookmarks can exist: the one from the site being left, the
      // one the absorbed entry had, and the page the user is standing on. Keep
      // the furthest — and note that only the first has a URL into a site that
      // is being abandoned, so it gets aimed at the new series page instead.
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      const mine = map[from];
      const theirs = other ? map[other.sourceUrl] : undefined;
      const candidates = [
        mine && { ...mine, chapterUrl: sourceUrl, live: false },
        theirs && { ...theirs, live: true },
        chapterUrl && chapterLabel && { chapterUrl, chapterLabel, page: 0, live: true },
      ].filter(Boolean);
      const winner = candidates.sort((a, b) =>
        ((chapterNumber(b.chapterLabel) ?? -1) - (chapterNumber(a.chapterLabel) ?? -1))
        || (Number(b.live) - Number(a.live)))[0];

      delete map[from];
      if (other) delete map[other.sourceUrl];
      if (winner) {
        const { live, ...p } = winner;
        map[sourceUrl] = { ...p, sourceUrl, updatedAt: now() };
      }

      const next = other ? library.filter((e) => e.id !== other.id) : library;
      await store.set({ library: next, progress: map });

      if (await getToken()) {
        try {
          // No remoteId means the entry was added signed out; POST it first so
          // the migration has something server-side to move.
          if (!entry.remoteId) await pushEntry(entry, next);
          else {
            const { entry: remote } = await apiFetch(`/api/library/${entry.remoteId}/migrate`, {
              method: 'POST',
              body: JSON.stringify({
                sourceUrl, sourceDomain,
                title: entry.title,
                coverUrl: entry.coverUrl ?? null,
                lastKnownChapter: entry.lastKnownChapter ?? null,
                tags: entry.tags,
                chapterUrl: map[sourceUrl]?.chapterUrl ?? null,
                chapterLabel: map[sourceUrl]?.chapterLabel ?? null,
              }),
            });
            entry.remoteId = remote.id;
            await store.set({ library: next });
          }
        } catch (e) { warn('migration sync failed', e); }
      }
      return { entry, merged: other ?? null };
    }

    // --- progress ------------------------------------------------------------

    async function saveProgress(p) {
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      map[p.sourceUrl] = { ...p, updatedAt: now() };
      await store.set({ progress: map });
      if (await getToken()) {
        const library = await getLibrary();
        const entry = findEntry(library, p.sourceUrl);
        if (!entry) return;
        try {
          // Entry added while signed out: adopt it on the backend first.
          if (!entry.remoteId) await pushEntry(entry, library);
          const saved = await apiFetch(`/api/progress/${entry.remoteId}`, {
            method: 'PUT',
            body: JSON.stringify(p),
          });
          await noteTrackerOutcome(saved?.trackers);
        } catch (e) { warn('progress sync failed', e); }
      }
    }

    /**
     * Send one series' bookmark to the connected trackers now, and say what
     * they did with it.
     *
     * Same request as a page turn — the push lives on the server, on the
     * progress route — but asked for deliberately and with somebody watching
     * the answer. saveProgress() drops that answer into the alert store,
     * because on a page turn nobody is reading it; here it is the whole point.
     * The library sheet's "Add to AniList" is the one caller: a series has to
     * exist and have a bookmark before anything can be sent anywhere, and once
     * it does, this is all "add it to my list" means.
     */
    async function pushProgressNow(sourceUrl) {
      if (!(await getToken())) return { trackers: [], error: 'not signed in' };
      const library = await getLibrary();
      const entry = findEntry(library, sourceUrl);
      if (!entry) return { trackers: [], error: 'not in the library' };
      const { progress } = await store.get(['progress']);
      const p = (progress || {})[entry.sourceUrl];
      if (!p?.chapterUrl) return { trackers: [], error: 'no chapter to send' };
      try {
        if (!entry.remoteId) await pushEntry(entry, library);
        const saved = await apiFetch(`/api/progress/${entry.remoteId}`, {
          method: 'PUT',
          body: JSON.stringify(p),
        });
        await noteTrackerOutcome(saved?.trackers);
        return { trackers: saved?.trackers || [] };
      } catch (e) {
        return { trackers: [], error: String(e?.message ?? e) };
      }
    }

    /**
     * Remember which trackers refused the last chapter we sent them.
     *
     * The answer arrives on a page turn, where nobody is looking: the reader is
     * on page nine of something and this response is read by no one. An AniList
     * token, which lasts a year and cannot be refreshed, ends exactly this way —
     * so without somewhere to put the refusal, a connection that stopped working
     * in March looks the same in September as one that works.
     *
     * Only the services that answered are touched. A tracker that was not asked
     * — muted series, a chapter with no number in it — must not have its
     * standing quietly cleared by a chapter it had nothing to do with.
     */
    async function noteTrackerOutcome(results) {
      if (!Array.isArray(results) || !results.length) return;
      const { trackerAlerts } = await store.get(['trackerAlerts']);
      const alerts = { ...(trackerAlerts || {}) };
      let changed = false;
      for (const r of results) {
        if (!r?.service) continue;
        if (r.ok) {
          if (alerts[r.service]) { delete alerts[r.service]; changed = true; }
        } else if (r.error && alerts[r.service]?.error !== r.error) {
          alerts[r.service] = { error: r.error, at: now() };
          changed = true;
        }
      }
      if (changed) await store.set({ trackerAlerts: alerts });
    }

    /** Which trackers are currently refusing, for the badge on the menu. */
    async function getTrackerAlerts() {
      const { trackerAlerts } = await store.get(['trackerAlerts']);
      return trackerAlerts || {};
    }

    async function getProgressAll() {
      return store.get(['progress']);
    }

    // --- reading history -----------------------------------------------------

    // Reading happens on trains and planes; the account is not always reachable
    // and the reader must not have to care. A read is written locally first and
    // pushed when it can be, which is the same shape as progress — except that
    // progress overwrites and history accumulates, so a failed push here cannot
    // simply be left for the next save to carry.
    const HISTORY_LIMIT = 2000;
    const historyKey = (r) => `${r.chapterUrl}|${r.day}`;

    /** The reader's local day, not the server's: 1 a.m. is still last night. */
    function localDay(ts = Date.now()) {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    async function recordRead(read) {
      if (!read || !read.sourceUrl || !read.chapterUrl) return { ok: false };
      const seconds = Math.max(0, Math.round(Number(read.seconds) || 0));
      const pages = Math.max(0, Math.round(Number(read.pages) || 0));
      if (!seconds && !pages) return { ok: false };

      const day = read.day || localDay();
      const { history } = await store.get(['history']);
      const map = history || {};
      const key = historyKey({ chapterUrl: read.chapterUrl, day });
      const prev = map[key];
      map[key] = {
        sourceUrl: read.sourceUrl,
        chapterUrl: read.chapterUrl,
        chapterLabel: read.chapterLabel ?? prev?.chapterLabel ?? null,
        day,
        // Same arithmetic as the server, so a row that syncs late and a row
        // that syncs at once end up saying the same thing: time adds up,
        // pages is how far the chapter got.
        seconds: (prev?.seconds ?? 0) + seconds,
        pages: Math.max(prev?.pages ?? 0, pages),
        // What has not reached the server yet, which is what a later sync must
        // send — not the running total, or a retry would double-count it.
        pending: (prev?.pending ?? 0) + seconds,
        pendingPages: Math.max(prev?.pendingPages ?? 0, pages),
        at: now(),
      };
      prune(map);
      await store.set({ history: map });
      await pushRead(map[key], map);
      return { ok: true };
    }

    // Oldest days go first: the local copy exists to survive a flight, not to
    // be an archive — the account holds that.
    function prune(map) {
      const keys = Object.keys(map);
      if (keys.length <= HISTORY_LIMIT) return;
      keys.sort((a, b) => String(map[a].day).localeCompare(String(map[b].day)));
      for (const k of keys.slice(0, keys.length - HISTORY_LIMIT)) delete map[k];
    }

    async function pushRead(row, map) {
      if (!row.pending && !row.pendingPages) return;
      if (!(await getToken())) return;
      const library = await getLibrary();
      const entry = findEntry(library, row.sourceUrl);
      if (!entry) return;
      try {
        if (!entry.remoteId) await pushEntry(entry, library);
        await apiFetch('/api/history', {
          method: 'POST',
          body: JSON.stringify({
            libraryId: entry.remoteId,
            chapterUrl: row.chapterUrl,
            chapterLabel: row.chapterLabel,
            pages: row.pendingPages,
            seconds: row.pending,
            day: row.day,
          }),
        });
        // Re-read: the push took a round-trip and the reader may have added
        // more seconds to this same row in the meantime. Subtracting what was
        // sent keeps those, where clearing the field would drop them.
        const { history } = await store.get(['history']);
        const fresh = history || map;
        const cur = fresh[historyKey(row)];
        if (cur) {
          cur.pending = Math.max(0, (cur.pending ?? 0) - row.pending);
          cur.pendingPages = cur.pendingPages > row.pendingPages ? cur.pendingPages : 0;
          await store.set({ history: fresh });
        }
      } catch (e) { warn('history sync failed', row.chapterUrl, e); }
    }

    async function flushHistory() {
      const { history } = await store.get(['history']);
      const map = history || {};
      for (const row of Object.values(map)) await pushRead(row, map);
    }

    async function getHistory() {
      const { history } = await store.get(['history']);
      return Object.values(history || {}).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    }

    const dayShift = (iso, n) => {
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };

    /**
     * Consecutive days read, now and at their longest. Same walk the server
     * does (backend/src/routes/history.js), over the same list of days —
     * first-run.test.js runs one set of days through both and insists they
     * agree, because a streak that resets on sign-in is the kind of wrong
     * answer that looks like lost data.
     */
    function streaks(days) {
      const set = new Set(days);
      const today = localDay();
      let current = 0;
      let cursor = set.has(today) ? today : dayShift(today, -1);
      while (set.has(cursor)) { current++; cursor = dayShift(cursor, -1); }

      let longest = 0;
      for (const day of set) {
        // Count a run only from its earliest day, so each run is walked once.
        if (set.has(dayShift(day, -1))) continue;
        let n = 0;
        for (let c = day; set.has(c); c = dayShift(c, 1)) n++;
        if (n > longest) longest = n;
      }
      return { current, longest };
    }

    /**
     * The same figures, from the copy on this device.
     *
     * Reached only when there is no account, and that is what makes it honest:
     * with one account and several devices the server's answer is the only one
     * that can add them up, but with no account there is nothing to add — this
     * history is the whole of it. The alternative was a statistics panel that
     * said "sign in" about reading it had itself recorded.
     *
     * `local: true` goes back with it because the two are not interchangeable:
     * this copy is pruned to HISTORY_LIMIT rows, so on a long-lived install the
     * all-time totals are a floor rather than a total, and the panel says so.
     */
    async function localStats() {
      const { history } = await store.get(['history']);
      const library = await getLibrary();
      const rows = Object.values(history || {});

      const byDay = new Map();
      const bySeries = new Map();
      let seconds = 0;
      for (const row of rows) {
        const secs = Math.max(0, Number(row.seconds) || 0);
        seconds += secs;

        const day = byDay.get(row.day) || { day: row.day, chapters: 0, seconds: 0 };
        day.chapters += 1;
        day.seconds += secs;
        byDay.set(row.day, day);

        // Grouped by the entry the row belongs to, not by its URL: a series
        // whose address drifted mid-read (see findEntry) is one book, and
        // counting it as two would inflate "series read" for the readers who
        // read the most.
        const entry = findEntry(library, row.sourceUrl);
        const key = entry ? entry.id : (row.sourceUrl || row.chapterUrl);
        const s = bySeries.get(key) || {
          id: key,
          title: entry ? entry.title : (row.sourceUrl || row.chapterUrl),
          coverUrl: entry ? (entry.coverUrl || null) : null,
          chapters: 0,
          seconds: 0,
        };
        s.chapters += 1;
        s.seconds += secs;
        bySeries.set(key, s);
      }

      const days = [...byDay.values()].sort((a, b) => String(b.day).localeCompare(String(a.day)));
      const scored = library.filter((e) => Number.isFinite(Number(e.score)) && e.score !== null
        && e.score !== '' && Number(e.score) > 0);
      const F = root.PanelFlowFolders;

      return {
        local: true,
        chapters: rows.length,
        seconds,
        series: bySeries.size,
        firstDay: days.length ? days[days.length - 1].day : null,
        // Over days that were read, not over the calendar — dividing by the
        // time since installing measures how long the browser has been open.
        secondsPerDay: days.length ? Math.round(seconds / days.length) : 0,
        ...streaks(days.map((d) => d.day)),
        days,
        topSeries: [...bySeries.values()]
          .sort((a, b) => b.chapters - a.chapters || b.seconds - a.seconds)
          .slice(0, 10),
        // Keyed by status rather than by shelf, as the server keys it, so a
        // custom shelf still lands in one of the five bars. No categories to
        // pass: a device with no account has no shelves of its own.
        folders: F ? library.reduce((acc, e) => {
          const key = F.folderStatus(e.folder, []);
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}) : {},
        entries: library.length,
        scored: scored.length,
        avgScore: scored.length
          ? scored.reduce((n, e) => n + Number(e.score), 0) / scored.length : 0,
        rereads: library.reduce((n, e) => n + (Number(e.rereads) || 0), 0),
      };
    }

    // Statistics are the account's when there is one: it holds every device's
    // reads, and a second implementation over the local copy would answer a
    // different question while looking like the same one. With no account there
    // is no second question to answer — see localStats above.
    async function getStats() {
      if (!(await getToken())) return localStats();
      await flushHistory();
      return apiFetch('/api/history/stats');
    }

    /**
     * The chapters of one series that have actually been read — which is the
     * history, not the progress. Progress remembers one chapter per series (the
     * last one open), so it cannot answer "have I seen chapter 42"; history has
     * a row per chapter per day, written only once the reader banked real time
     * or real pages on it. Opening a chapter and closing it at once leaves no
     * row, which is the right answer: it was not read.
     *
     * A Set is what the caller wants, but this crosses a JSON bridge, so it
     * goes back as an array.
     */
    async function getReadChapters(sourceUrl) {
      const { history } = await store.get(['history']);
      const seen = new Set();
      for (const row of Object.values(history || {})) {
        if (sourceUrl && row.sourceUrl !== sourceUrl) continue;
        seen.add(row.chapterUrl);
      }
      return [...seen];
    }

    /**
     * The whole series' chapter list, for a reader that only got a handful of
     * links from the page it is on. The ceiling comes from the library, which
     * is the only place that knows how far the series has got — the reader is
     * on one chapter and can see no further than the site's own "next" link.
     */
    async function chapterList(sourceUrl, chapterUrl, chapterLabel) {
      const library = await getLibrary();
      const entry = findEntry(library, sourceUrl) || findEntry(library, chapterUrl);
      return chapterRange(chapterUrl, chapterLabel, entry?.lastKnownChapter);
    }

    /**
     * Where every series' cover leads, in one message: `{ [entryId]: target }`.
     * The shells ask for this rather than working it out themselves — the popup,
     * the phone and the notification have to agree on which chapter is "next",
     * and three copies of that rule would not stay in agreement for long.
     */
    async function continueTargets() {
      const library = await getLibrary();
      const { progress } = await store.get(['progress']);
      const map = {};
      for (const entry of library) {
        map[entry.id] = continueTarget(entry, (progress || {})[entry.sourceUrl]);
      }
      return map;
    }

    async function getProgressFor(chapterUrl) {
      const { progress } = await store.get(['progress']);
      for (const p of Object.values(progress || {})) {
        if (p.chapterUrl === chapterUrl) return p;
      }
      return null;
    }

    async function removeProgress(sourceUrl) {
      const { progress } = await store.get(['progress']);
      const map = progress || {};
      delete map[sourceUrl];
      await store.set({ progress: map });
    }

    // A detected page carries fresh series meta scraped from the live DOM — the
    // only vantage point that works on Cloudflare-walled sites. Update the
    // matching library entry: cover if missing, latest chapter if it advanced.
    async function seriesSeen(meta) {
      if (!meta) return;
      const library = await getLibrary();
      const entry = findEntry(library, meta.sourceUrl) || findEntry(library, meta.chapterUrl);
      if (!entry) return;
      const patch = {};
      if (!entry.coverUrl && meta.coverUrl) patch.coverUrl = meta.coverUrl;
      // labelNum, not parseFloat: what the page yields is free text as often as
      // a bare number ("Chapitre 1055"), and parseFloat reads that as NaN and
      // drops the update.
      const seen = labelNum(meta.lastKnownChapter);
      const known = labelNum(entry.lastKnownChapter);
      if (!Number.isNaN(seen) && (Number.isNaN(known) || seen > known)) {
        patch.lastKnownChapter = String(seen);
      }
      if (Object.keys(patch).length === 0) return;
      Object.assign(entry, patch);
      await store.set({ library });
      if (entry.remoteId && await getToken()) {
        apiFetch(`/api/library/${entry.remoteId}`, { method: 'PUT', body: JSON.stringify(patch) })
          .catch(() => {});
      }
    }

    // Merely opening a chapter of a series you follow advances your progress —
    // no reader, no button. This is what keeps the library in step when you
    // navigate 109 → 110 with the site's own next-chapter link.
    async function chapterVisited(meta) {
      if (!meta?.chapterUrl || !meta.chapterLabel) return;
      const library = await getLibrary();
      const entry = findEntry(library, meta.sourceUrl) || findEntry(library, meta.chapterUrl);
      if (!entry) return; // only track series the user actually pinned
      const { progress } = await store.get(['progress']);
      const cur = (progress || {})[entry.sourceUrl];
      // Same chapter: the reader owns the page position, don't reset it to 0.
      if (cur && cur.chapterUrl === meta.chapterUrl) return;
      // Forward-only, so re-reading an old chapter doesn't rewind the bookmark.
      const seen = labelNum(meta.chapterLabel);
      const known = labelNum(cur?.chapterLabel);
      if (!Number.isNaN(known) && !Number.isNaN(seen) && seen < known) return;
      await saveProgress({
        sourceUrl: entry.sourceUrl,
        chapterUrl: meta.chapterUrl,
        chapterLabel: meta.chapterLabel,
        page: 0,
        pageCount: null,
        scrollPos: 0,
      });
    }

    // --- new chapter check ---------------------------------------------------

    /**
     * The latest chapter of a series, the same two steps the server takes: the
     * site's own API when its rule names one, the markup otherwise. A page that
     * is assembled in the browser has no chapter list in the HTML this fetch
     * gets back, which is why MangaDex never announced anything.
     *
     * PanelFlowSites is read through `root` rather than required at load time:
     * the phone shells load these files with <script> tags in an order this
     * file does not control, and a background check that throws on startup is
     * worse than one that falls back to reading the markup.
     */
    async function latestChapterFor(pageUrl, html) {
      const sites = root.PanelFlowSites;
      if (sites) {
        try {
          const site = sites.resolveSite({
            host: new URL(pageUrl).hostname, rules: await getRules(), html,
          });
          const api = chapterApiUrl(pageUrl, site);
          if (api) {
            const resp = await netFetch(api);
            if (resp.ok) {
              const found = maxChapterInApi(await resp.text(), site);
              if (found !== null) return found;
            }
          }
        } catch { /* unreachable or unparsable: the markup is all there is */ }
      }
      return maxChapterIn(html);
    }

    /**
     * The panels of a chapter, for the sites whose rule names an API that
     * lists them (see pagesFromApi). An empty array everywhere else, which is
     * every site where reading the DOM works.
     *
     * It runs here, in the shell, and not in the content script that wants the
     * answer, for the reason `trackerConnectTab` does: the caller hands over a
     * page URL and nothing else, and *which* URL gets fetched is decided here,
     * out of the rules file. A page cannot talk this into fetching for it.
     */
    async function chapterPages(pageUrl) {
      const sites = root.PanelFlowSites;
      if (!sites || !pageUrl) return [];
      try {
        const site = sites.resolveSite({
          host: new URL(pageUrl).hostname, rules: await getRules(),
        });
        const api = pageApiUrl(pageUrl, site);
        if (!api) return [];
        const resp = await netFetch(api);
        if (!resp.ok) return [];
        return pagesFromApi(await resp.text(), site);
      } catch { return []; }
    }

    async function checkNewChapters() {
      const library = await getLibrary();
      const found = new Map(); // entry id -> the chapter number seen on the site
      // Sites this client was never allowed to ask. Collected rather than
      // logged one by one: a library of forty series on unlisted sites would
      // otherwise write forty identical lines every six hours.
      const unreachable = [];
      for (const entry of library) {
        try {
          // Asked before the request, not learned from its failure.
          //
          // A site outside the extension's host permissions cannot be fetched
          // from the worker: the browser blocks it on CORS, the site is not at
          // fault, and it will go on being blocked on every cycle forever. Firing
          // the request anyway put one red line per series per check into
          // chrome://extensions and told the reader nothing at all.
          //
          // Skipping is the right answer and costs nothing: the server-side
          // watcher (backend/src/routes/watch.js) reaches these sites without a
          // browser's permissions, and the first client to open drains what it
          // found. The reader can also grant the origin from the popup, which
          // makes this branch stop being taken.
          if (!(await canFetch(entry.sourceUrl))) {
            unreachable.push(entry.sourceUrl);
            continue;
          }
          // With the user's cookies: Cloudflare-walled sites (scan-manga) answer
          // normally in the browser but challenge anonymous/server requests.
          const resp = await netFetch(entry.sourceUrl, { credentials: 'include' });
          if (!resp.ok) continue;
          const html = await resp.text();
          // A wall answers 200 as readily as a page does, and it has no chapter
          // number in it — which would be read as the series having lost one.
          if (challengePage(html)) continue;
          const latest = await latestChapterFor(entry.sourceUrl, html);
          if (latest === null) continue;
          const known = parseFloat(entry.lastKnownChapter);
          if (!Number.isNaN(known) && latest > known) {
            // Read now rather than once before the loop: a full pass runs for
            // minutes, and the bookmark this points at may have moved during it.
            const { progress } = await store.get(['progress']);
            // Where tapping the notification lands. The same rule the covers
            // use, so the alert and the library cannot disagree about which
            // chapter is the next one — and the series page when there is no
            // chapter to name.
            const target = continueTarget(
              { ...entry, lastKnownChapter: String(latest) },
              (progress || {})[entry.sourceUrl],
            );
            // `title` and `message` are the ready-made English text, and the
            // three fields under them are the same thing taken apart. This file
            // is shared with the web app and the phone and cannot reach a
            // translation table; the extension has one, so it rebuilds the
            // sentence from the parts and everyone else prints what is here.
            notify({
              id: `pf-${entry.id}`,
              title: 'New chapter!',
              message: `${entry.title} — chapter ${latest} is out on ${entry.sourceDomain}`,
              seriesTitle: entry.title,
              sourceDomain: entry.sourceDomain,
              entry,
              latest,
              url: target.url || entry.sourceUrl,
            });
          }
          entry.lastKnownChapter = String(latest);
          found.set(entry.id, entry.lastKnownChapter);
          if (entry.remoteId && await getToken()) {
            apiFetch(`/api/library/${entry.remoteId}`, {
              method: 'PUT',
              body: JSON.stringify({ lastKnownChapter: entry.lastKnownChapter }),
            }).catch(() => {});
          }
          // Respectful pacing: one request per series with a gap between domains.
          if (pacingMs) await new Promise((r) => setTimeout(r, pacingMs));
        } catch (e) {
          // A real failure this time — the site was reachable in principle and
          // did not answer. Named, because "the alerts stopped for this one
          // series" is otherwise indistinguishable from "nothing new came out".
          diag.report(`checkNewChapters:${entry.sourceDomain || 'unknown'}`, e);
        }
      }
      if (unreachable.length) {
        warn(`[panelflow] ${unreachable.length} series on sites this browser may not fetch — `
          + `the server checks those. Grant the site from the popup to check it here too: `
          + unreachable.slice(0, 5).join(', '));
      }
      if (found.size === 0) return;
      // Re-read before writing. A full pass is one request plus a pause per
      // series, so it runs for minutes in the background while the user keeps
      // adding and editing entries — and `library` above is a snapshot from
      // before all of that. Writing it back would silently undo their work, so
      // only the field this function owns is carried over.
      const current = await getLibrary();
      for (const entry of current) {
        const latest = found.get(entry.id);
        if (latest !== undefined) entry.lastKnownChapter = latest;
      }
      await store.set({ library: current });
    }

    /**
     * The other half of the check: what the server's watcher found while this
     * client was not running at all.
     *
     * checkNewChapters only ever runs while the browser is open, so a laptop
     * that spends the weekend shut learns nothing until Monday. The server has
     * no such gap, and draining what it found costs one request instead of one
     * per series — which is why this, and not the site-by-site check, is what
     * runs on browser start.
     * @returns {Promise<number>} how many chapters were announced
     */
    async function pullNews() {
      if (!(await getToken())) return 0;
      let news;
      try { news = await apiFetch('/api/news'); } catch { return 0; }
      if (!Array.isArray(news) || news.length === 0) return 0;

      const library = await getLibrary();
      const { progress } = await store.get(['progress']);
      const seen = [];
      const local = new Map(); // local entry id -> chapter the server saw
      for (const item of news) {
        if (!item || !item.libraryId || !item.chapter) continue;
        seen.push({ libraryId: item.libraryId, chapter: item.chapter });
        const entry = library.find((e) => e.remoteId === item.libraryId)
          || findEntry(library, item.sourceUrl);
        // A series this device has not pulled yet still gets its alert — the
        // server sent the title and the address along for exactly that case.
        if (entry) local.set(entry.id, item.chapter);
        const target = entry && continueTarget(
          { ...entry, lastKnownChapter: item.chapter },
          (progress || {})[entry.sourceUrl],
        );
        notify({
          id: `pf-${entry ? entry.id : item.libraryId}`,
          title: 'New chapter!',
          message: `${item.title} — chapter ${item.chapter} is out on ${item.sourceDomain}`,
          seriesTitle: item.title,
          sourceDomain: item.sourceDomain,
          entry: entry || null,
          latest: item.chapter,
          url: (target && target.url) || (entry && entry.sourceUrl) || item.sourceUrl,
        });
      }

      // The local copy learns what the server saw, so the on-device check does
      // not rediscover the same chapter an hour later and announce it twice.
      if (local.size) {
        const current = await getLibrary();
        let changed = false;
        for (const entry of current) {
          const chapter = local.get(entry.id);
          if (chapter === undefined) continue;
          const next = furtherChapter(entry.lastKnownChapter, chapter);
          if (next !== entry.lastKnownChapter) { entry.lastKnownChapter = next; changed = true; }
        }
        if (changed) await store.set({ library: current });
      }

      // Last, and best-effort: a drain that announced its chapters and then
      // failed to say so repeats them next time, which is a smaller fault than
      // marking them seen for a notification that never appeared.
      await apiFetch('/api/news/seen', {
        method: 'POST',
        body: JSON.stringify({ items: seen }),
      }).catch(() => {});
      return seen.length;
    }

    // --- categories ----------------------------------------------------------
    //
    // The five built-in folders are the client's own; categories belong to the
    // account, so a signed-out client simply has none and every screen falls
    // back to the built-ins (shared/folders.js). They are cached rather than
    // fetched per render because the popup opens a hundred times a day and a
    // shelf list changes about twice a year.

    async function getCategories() {
      const { categories } = await store.get(['categories']);
      return categories || [];
    }

    async function pullCategories() {
      if (!(await getToken())) {
        await store.set({ categories: [] });
        return [];
      }
      const categories = await apiFetch('/api/categories');
      await store.set({ categories });
      return categories;
    }

    // --- the settings that belong to the reader ------------------------------
    //
    // `settings` above is about this install — chiefly `backendUrl`, which
    // cannot live on an account because it is the address of the account. These
    // are the other kind: the theme, the language, which way a chapter opens.
    // They were being asked again on every surface, so someone who set the
    // theme in the extension found the site still light. See shared/prefs.js.
    //
    // The cached copy is not an optimisation. Every caller here is drawing a
    // control or opening a chapter and cannot wait for a round trip, and a
    // phone on a train has to answer at all.

    async function getAccountPrefs() {
      const { accountPrefs } = await store.get(['accountPrefs']);
      return accountPrefs || {};
    }

    /** The account's answers, refreshed from the server. `{}` when signed out. */
    async function pullAccountPrefs() {
      if (!(await getToken())) {
        await store.set({ accountPrefs: {} });
        return {};
      }
      try {
        const { prefs } = await apiFetch('/api/prefs');
        await store.set({ accountPrefs: prefs || {} });
        return prefs || {};
      } catch (e) {
        // A settings page that shows nothing because the network is down is
        // worse than one showing what this device last heard. The caller finds
        // out from what it gets back, not from an exception it cannot act on.
        warn('could not read the account settings', e);
        return getAccountPrefs();
      }
    }

    /**
     * Change some of them, everywhere.
     *
     * The local copy moves first and unconditionally: the control the reader
     * just used has to stay where they put it, and a failed PUT is a thing to
     * retry, not a reason to snap a switch back under their finger. The server
     * is then given the same patch, and its answer replaces the guess.
     */
    async function saveAccountPrefs(patch) {
      const { prefs: cleaned } = root.PanelFlowPrefs.clean(patch);
      if (!Object.keys(cleaned).length) return getAccountPrefs();
      const local = { ...(await getAccountPrefs()), ...cleaned };
      await store.set({ accountPrefs: local });
      if (!(await getToken())) return local;
      try {
        const { prefs } = await apiFetch('/api/prefs', {
          method: 'PUT',
          body: JSON.stringify({ prefs: cleaned }),
        });
        await store.set({ accountPrefs: prefs || local });
        return prefs || local;
      } catch (e) {
        warn('could not save the account settings', e);
        return local;
      }
    }

    // --- auth ----------------------------------------------------------------

    async function authenticate(kind, email, password) {
      const data = await apiFetch(`/api/auth/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      await store.set({ authToken: data.token, authUser: data.user });
      return data.user;
    }

    async function logout() {
      // The shelves went with the account, and leaving them behind would show a
      // signed-out library tabs it can no longer file anything into.
      // The settings went with the account too. Leaving them behind would show
      // the next person to open this browser somebody else's theme, and — worse
      // — hand it back to the account they then sign in with.
      await store.set({ authToken: null, authUser: null, categories: [], accountPrefs: {} });
    }

    async function getAccount() {
      return store.get(['authUser']);
    }

    const warn = (...args) => (root.console ? root.console.warn(...args) : undefined);

    return {
      getSettings, setSettings, getToken, apiFetch, getRules, getFilterList,
      getLibrary, findEntry, addToLibrary, pushEntry, backfillMeta,
      updateEntry, removeFromLibrary, dedupeLibrary, syncAll, pullLibrary,
      findSimilar, migrateEntry,
      saveProgress, getProgressAll, getProgressFor, removeProgress, getTrackerAlerts,
      pushProgressNow,
      recordRead, getHistory, getReadChapters, chapterList, getStats, flushHistory, localDay,
      continueTargets,
      seriesSeen, chapterVisited, checkNewChapters, pullNews, chapterPages,
      getCategories, pullCategories,
      getAccountPrefs, pullAccountPrefs, saveAccountPrefs,
      authenticate, logout, getAccount,
    };
  }

  /**
   * The message hub every shell shares: one `{ type, ... }` in, one reply out.
   * The extension's service worker, the iOS `WKScriptMessageHandler` and the
   * Android `@JavascriptInterface` all funnel into this, so a content script
   * cannot tell which platform it is running on.
   *
   * `extras` lets a shell add the messages only it can answer (the extension's
   * declarativeNetRequest referer rules, for instance) without forking the hub.
   */
  function createHub(core, extras = {}) {
    return async function handle(msg) {
      try {
        switch (msg && msg.type) {
          case 'getRules': return { rules: await core.getRules() };
          // The panels of a chapter no page will hand over. The content script
          // sends the page it is on; the rules file decides what gets fetched.
          case 'chapterPages': return { pages: await core.chapterPages(msg.url) };
          case 'pageDetected':
            await core.seriesSeen(msg.meta);
            await core.chapterVisited(msg.meta);
            return { ok: true };
          case 'addToLibrary': return { ok: true, entry: await core.addToLibrary(msg.entry) };
          case 'removeFromLibrary': await core.removeFromLibrary(msg.id); return { ok: true };
          case 'updateEntry': return { ok: true, entry: await core.updateEntry(msg.id, msg.patch) };
          case 'getLibrary': return { library: await core.getLibrary() };
          case 'findSimilar': return { matches: await core.findSimilar(msg.meta) };
          case 'migrateEntry': return { ok: true, ...(await core.migrateEntry(msg.id, msg.target)) };
          case 'saveProgress': await core.saveProgress(msg.progress); return { ok: true };
          case 'getProgressFor': return { progress: await core.getProgressFor(msg.chapterUrl) };
          case 'getProgressAll': return await core.getProgressAll();
          case 'continueTargets': return { targets: await core.continueTargets() };
          case 'removeProgress': await core.removeProgress(msg.sourceUrl); return { ok: true };
          case 'recordRead': return await core.recordRead(msg.read);
          case 'getHistory': return { history: await core.getHistory() };
          case 'getReadChapters':
            return { chapters: await core.getReadChapters(msg.sourceUrl) };
          case 'chapterList':
            return {
              chapters: await core.chapterList(msg.sourceUrl, msg.chapterUrl, msg.chapterLabel),
            };
          case 'getStats': return { stats: await core.getStats() };
          case 'auth': {
            const user = await core.authenticate(msg.kind, msg.email, msg.password);
            // Adopt whatever the account already holds before pushing what this
            // device has: a phone signing in for the first time starts empty,
            // and pushing first would leave it looking like the account is too.
            // Deliberately not awaited — signing in should not block on a sync.
            core.pullLibrary().then(() => core.syncAll())
              .catch((e) => (root.console && root.console.warn('post-login sync failed', e)));
            // Awaited, unlike the library: the caller is a settings page or a
            // sign-in screen that is about to redraw itself, and the theme
            // arriving a second later is the flash this whole arrangement
            // exists to avoid. It is one small request and it cannot throw.
            const prefs = await core.pullAccountPrefs();
            return { ok: true, user, prefs };
          }
          case 'logout': await core.logout(); return { ok: true };
          case 'getAccount': return await core.getAccount();
          case 'getCategories': return { categories: await core.getCategories() };
          case 'pullCategories': return { ok: true, categories: await core.pullCategories() };
          // The reader's own settings, as opposed to this install's. `get` is
          // the cached answer and never waits; `pull` goes and asks.
          case 'getAccountPrefs': return { ok: true, prefs: await core.getAccountPrefs() };
          case 'pullAccountPrefs': return { ok: true, prefs: await core.pullAccountPrefs() };
          case 'setAccountPrefs':
            return { ok: true, prefs: await core.saveAccountPrefs(msg.patch || {}) };
          // The cheap half first: whatever the server already found while this
          // client was closed, before spending a request per series on top.
          case 'checkNow':
            await core.pullNews();
            await core.checkNewChapters();
            return { ok: true };
          case 'pullNews': return { ok: true, count: await core.pullNews() };
          case 'syncNow': await core.syncAll(); return { ok: true };
          case 'pullNow': return { ok: true, ...(await core.pullLibrary()) };
          case 'dedupeLibrary': return { ok: true, ...(await core.dedupeLibrary()) };
          // Search and the compatibility check are server-side (no search
          // engine allows a cross-origin query, and the check needs a page
          // fetch the client would be blocked from making), so the hub's job
          // is only to carry the call and the bearer token.
          case 'search': {
            const q = new root.URLSearchParams({ q: String(msg.q ?? '') });
            if (msg.scans) q.set('scans', '1');
            if (msg.check) q.set('check', '1');
            return await core.apiFetch(`/api/search?${q}`);
          }
          case 'compat':
            return await core.apiFetch('/api/meta/compat?url=' + encodeURIComponent(msg.url ?? ''));
          case 'scrape':
            return await core.apiFetch('/api/meta/scrape?url=' + encodeURIComponent(msg.url ?? ''));
          // Trackers. Every one of these is the server's own work — the client
          // secret and the tokens never leave it — so the hub only carries the
          // call, exactly as it does for search above.
          case 'trackers': {
            // Three answers to one question ("what does this screen show?"),
            // asked together so the screen is never drawn half-informed.
            const [services, connected, links] = await Promise.all([
              core.apiFetch('/api/trackers/services'),
              core.apiFetch('/api/trackers'),
              core.apiFetch('/api/trackers/links'),
            ]);
            // What page turns have seen go wrong since. The server's own
            // last_error says the same thing and is the durable copy; this one
            // is what a client that has not opened this screen yet can badge on.
            return { services, connected, links, alerts: await core.getTrackerAlerts() };
          }
          // Which trackers are refusing, for a menu badge — cheap enough to ask
          // on every popup open because it never leaves the device.
          case 'trackerAlerts':
            return { alerts: await core.getTrackerAlerts() };
          // What the reader's trackers already hold for one title. Asked by the
          // library sheet while it is being filled in, so it answers `null`
          // rather than throwing when nobody is signed in: an addition made
          // offline still has to work, and a prefill is a nicety.
          case 'trackerEntry': {
            if (!(await core.getToken())) return { entries: [], connected: [] };
            try {
              return await core.apiFetch(
                `/api/trackers/entry?title=${encodeURIComponent(msg.title ?? '')}`);
            } catch (err) {
              return { entries: [], connected: [], error: String(err.message) };
            }
          }
          case 'trackerConnect':
            return await core.apiFetch(`/api/trackers/${msg.service}/connect`, { method: 'POST' });
          case 'trackerDisconnect':
            await core.apiFetch(`/api/trackers/${msg.service}`, { method: 'DELETE' });
            return { ok: true };
          case 'trackerSearch':
            return {
              hits: await core.apiFetch(
                `/api/trackers/${msg.service}/search?q=${encodeURIComponent(msg.q ?? '')}`,
              ),
            };
          case 'trackerLink':
            return {
              link: await core.apiFetch(`/api/trackers/${msg.service}/link/${msg.libraryId}`, {
                method: 'PUT',
                body: JSON.stringify({
                  remoteId: msg.remoteId ?? null,
                  remoteTitle: msg.remoteTitle ?? null,
                  state: msg.state,
                }),
              }),
            };
          case 'trackerUnlink':
            await core.apiFetch(`/api/trackers/${msg.service}/link/${msg.libraryId}`,
              { method: 'DELETE' });
            return { ok: true };
          // One series, on demand, with the answer handed back — see
          // pushProgressNow. `trackerPushAll` below is the whole library and
          // reports a summary; this is the sheet asking about one addition.
          case 'trackerPushOne':
            return await core.pushProgressNow(msg.sourceUrl);
          case 'trackerPushAll':
            return { report: await core.apiFetch(`/api/trackers/${msg.service}/push`, { method: 'POST' }) };
          // The counterpart: what the tracker itself holds, read back into the
          // links so a page turn cannot push a smaller number over a larger one.
          // It reports where the tracker is ahead and changes no bookmark — a
          // bookmark is a URL on a scan site, and a chapter count is not one.
          case 'trackerPull':
            return { report: await core.apiFetch(`/api/trackers/${msg.service}/pull`, { method: 'POST' }) };
          // The other direction: what the tracker already knows, brought here.
          // `dryRun` reports without writing, and the caller is expected to ask
          // for that first — an import writes across the whole library at once.
          case 'trackerImport':
            return {
              report: await core.apiFetch(
                `/api/import/${msg.service}/account${msg.dryRun ? '?dryRun=1' : ''}`,
                { method: 'POST' },
              ),
            };
          case 'getSettings': return { settings: await core.getSettings() };
          case 'setSettings': return { ok: true, settings: await core.setSettings(msg.patch) };
          default: {
            const extra = extras[msg && msg.type];
            if (extra) return await extra(msg);
            return { error: `unknown message: ${msg && msg.type}` };
          }
        }
      } catch (e) {
        // `error` is untouched — the clients put that sentence on screen and it
        // is written for a reader, not for us. What is new is beside it:
        // `failedAt` names which of the messages above died, and `ref` carries
        // the backend's label when the failure came back from a route. Between
        // them, a screenshot of a toast now names the file to open.
        const seen = reportError(`hub:${(msg && msg.type) || 'unknown'}`, e);
        return {
          error: seen.message,
          failedAt: seen.scope,
          ...(e && e.pfRef ? { ref: e.pfRef } : {}),
        };
      }
    };
  }

  root.PanelFlowCore = {
    diag, MEDIA, DEFAULT_MEDIUM,
    createCore, createHub, maxChapterIn, labelNum, cleanTitle, DEFAULTS,
    nextChapterUrl, continueTarget, chapterRange,
    challengePage, chapterApiUrl, maxChapterInApi, pageApiUrl, pagesFromApi,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
