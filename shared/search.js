// A web search, as the surfaces read it: one result shape, two ways to get it.
//
// The route `/api/search` on the server was the only searcher, and it scrapes
// DuckDuckGo's no-JavaScript results page, which answers a datacenter address
// (Vercel's) with a challenge and a phone's address with results. So the
// phone fetches that page itself (native/src/core.js hands the hub a
// `searchFetch`), and the server keeps doing it for the browser surfaces,
// with a second provider (Brave, backend/src/routes/search.js) for the day a
// key is configured. Whoever fetched, the page is parsed here, once, into
// the same `{ title, url, domain }` the screens draw.
//
// A plain script like series-match.js: the phone loads it beside the core,
// the server re-exports it through backend/src/search.js.
(function (root) {
  'use strict';

  const DDG = 'https://html.duckduckgo.com/html/?q=';

  /** The most results any surface shows; the page carries about thirty. */
  const MAX_RESULTS = 20;

  // A bare title mostly returns Wikipedia and MyAnimeList. What the reader is
  // after is somewhere to *read* it, so the query is biased the way they
  // would bias it themselves.
  const scanQuery = (q) => `${q} scan lecture en ligne chapitre`;

  // Results are wrapped in a redirect: //duckduckgo.com/l/?uddg=<encoded>.
  // The real URL is what the reader is deciding about, so unwrap it.
  function unwrap(href) {
    const m = /[?&]uddg=([^&]+)/.exec(href);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { /* fall through */ } }
    if (href.startsWith('//')) return 'https:' + href;
    return /^https?:/i.test(href) ? href : '';
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' };
  const decodeEntities = (s) => String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isNaN(code) ? whole : String.fromCodePoint(code);
  });

  const hostOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return null; }
  };

  /**
   * A result's title, as the shelf would show it: the site's <title> arrives
   * wearing the same SEO tail the scraper strips, and series-match.js knows
   * the per-host words to strip.
   */
  const cleanTitle = (raw, url, rules) => {
    const match = root.PanelFlowMatch;
    return match ? match.displayTitle(raw, { host: hostOf(url), rules }) : raw;
  };

  /**
   * DuckDuckGo's no-JS results page. Parsed with regexes rather than a DOM
   * because the server has no DOM and the markup is flat and stable:
   * one `<a class="result__a" href="…">title</a>` per hit.
   */
  function parseDuckDuckGo(html, rules) {
    const out = [];
    const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const seen = new Set();
    for (const m of String(html).matchAll(re)) {
      const url = unwrap(decodeEntities(m[1]));
      const raw = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
      const title = cleanTitle(raw, url, rules);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      out.push({ title, url, domain: hostOf(url) });
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }

  /**
   * Brave's JSON answer (`web.results[]`), into the same shape. The server's
   * second provider; a phone never calls it, the key is the server's.
   */
  function parseBrave(body, rules) {
    const out = [];
    const seen = new Set();
    for (const r of (body && body.web && body.web.results) || []) {
      const url = /^https?:/i.test(r && r.url) ? r.url : '';
      const title = cleanTitle(decodeEntities(String((r && r.title) || '').replace(/<[^>]+>/g, '')).trim(), url, rules);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      out.push({ title, url, domain: hostOf(url) });
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }

  const api = { DDG, MAX_RESULTS, scanQuery, parseDuckDuckGo, parseBrave, unwrap, decodeEntities };
  root.PanelFlowSearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
