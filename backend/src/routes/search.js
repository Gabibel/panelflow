// Integrated web search.
//
// The mobile app has no address bar to fall back on the way the extension has
// the browser's — so search has to live inside the app. A WebView cannot query
// a search engine itself (no CORS on any of them), which is why this is a
// server route rather than client-side code.
//
// Store-compliance note (see docs/ARCHITECTURE.md): this is a general web
// search over the user's own words. PanelFlow hosts no catalogue, ships no site
// list, and ranks nothing — an empty query returns nothing, not a directory.
import { Router } from 'express';
import { fetchPage } from './meta.js';
import { analyze } from '../compat.js';
import { loadRules } from './rules.js';
import { wrap } from '../wrap.js';

export const searchRouter = Router();

const DDG = 'https://html.duckduckgo.com/html/?q=';

/**
 * DuckDuckGo's no-JS results page. Parsed with regexes rather than a DOM
 * because the backend has no DOM and the markup is flat and stable:
 * one `<a class="result__a" href="…">title</a>` per hit.
 */
export function parseResults(html) {
  const out = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  for (const m of String(html).matchAll(re)) {
    const url = unwrap(decodeEntities(m[1]));
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, domain: hostOf(url) });
    if (out.length >= 20) break;
  }
  return out;
}

// Results are wrapped in a redirect: //duckduckgo.com/l/?uddg=<encoded>.
// The real URL is what the user is deciding about, so unwrap it.
function unwrap(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  if (href.startsWith('//')) return 'https:' + href;
  return /^https?:/i.test(href) ? href : '';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' };
const decodeEntities = (s) =>
  String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isNaN(code) ? whole : String.fromCodePoint(code);
  });

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

// A bare title mostly returns Wikipedia and MyAnimeList. What the user is after
// is somewhere to *read* it, so bias the query the way they would themselves.
export const scanQuery = (q) => `${q} scan lecture en ligne chapitre`;

/**
 * GET /api/search?q=…&scans=1&check=1
 *   scans=1  bias the query toward reading sites
 *   check=1  run the compatibility check on the first few hits
 */
searchRouter.get('/', wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  if (q.length > 200) return res.status(400).json({ error: 'q too long' });

  const query = req.query.scans === '1' ? scanQuery(q) : q;
  let results;
  try {
    results = parseResults(await fetchPage(DDG + encodeURIComponent(query)));
  } catch (e) {
    return res.status(e.status ?? 502).json({ error: 'search unavailable' });
  }

  // Checking costs a page fetch each, so only the top hits get one — that is
  // where the user looks, and the rest can be checked on demand.
  if (req.query.check === '1' && results.length) {
    const rules = loadRules();
    const head = results.slice(0, 5);
    await Promise.all(head.map(async (r) => {
      try {
        const { verdict, reason, imageCount, chapterLabel, title, coverUrl } =
          analyze(await fetchPage(r.url), r.url, { rules });
        r.compat = { verdict, reason, imageCount, chapterLabel, seriesTitle: title, coverUrl };
      } catch {
        r.compat = { verdict: 'unknown', reason: 'the page could not be fetched from the server' };
      }
    }));
  }
  res.json({ query, results });
}));
