// Integrated web search.
//
// The mobile app has no address bar to fall back on the way the extension has
// the browser's — so search has to live inside the app. A browser page cannot
// query a search engine itself (no CORS on any of them), which is why this is
// a server route rather than client-side code. The phone can, and does
// (native/src/core.js hands the hub a `searchFetch`); this route is what the
// browser surfaces use, and what the phone falls back to.
//
// Two providers, one shape. DuckDuckGo's no-JavaScript page needs no key and
// is parsed like a page; it answers a datacenter address (Vercel's) with a
// challenge more often than not, which is the audit's "search is not the
// same on every surface". Brave's Search API answers a datacenter fine and
// needs a key: set PANELFLOW_BRAVE_KEY (a free tier exists) and it is used
// first, DuckDuckGo second. The parsing of both is shared/search.js, the same
// file the phone runs, so a result looks the same whoever fetched it.
//
// Store-compliance note (see docs/ARCHITECTURE.md): this is a general web
// search over the user's own words. PanelFlow hosts no catalogue, ships no site
// list, and ranks nothing — an empty query returns nothing, not a directory.
import { Router } from 'express';
import { fetchPage } from './meta.js';
import { analyze } from '../compat.js';
import { loadRules } from './rules.js';
import { wrap } from '../wrap.js';
import { spendFetches } from '../rate-limit.js';
import { DDG, parseDuckDuckGo, parseBrave } from '../search.js';

export const searchRouter = Router();

// Kept under its old name: search.test.js and the "move a whole site" flow
// import it from here.
export const parseResults = parseDuckDuckGo;

const BRAVE = 'https://api.search.brave.com/res/v1/web/search';
const braveKey = () => process.env.PANELFLOW_BRAVE_KEY || '';

/** Brave's answer for `query`, or a throw with a status the caller reports. */
export async function braveResults(query, rules, fetchImpl = fetch) {
  const resp = await fetchImpl(`${BRAVE}?q=${encodeURIComponent(query)}&count=20`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey() },
  });
  if (!resp.ok) throw Object.assign(new Error(`brave answered ${resp.status}`), { status: 502 });
  return parseBrave(await resp.json(), rules);
}

/** The results, from whichever provider this deployment has. */
export async function results(query, rules) {
  if (braveKey()) return braveResults(query, rules);
  return parseDuckDuckGo(await fetchPage(DDG + encodeURIComponent(query)), rules);
}

const CHECKED_HITS = 5;

/**
 * GET /api/search?q=…&check=1
 *   check=1  run the compatibility check on the first few hits
 */
searchRouter.get('/', wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  if (q.length > 200) return res.status(400).json({ error: 'q too long' });

  await spendFetches(req, res, req.query.check === '1' ? 1 + CHECKED_HITS : 1);

  // As typed: `scans=1` used to add "scan lecture en ligne chapitre", and an
  // old client that still asks for it is simply not obeyed.
  const query = q;
  const rules = loadRules();
  let hits;
  try {
    hits = await results(query, rules);
  } catch (e) {
    return res.status(e.status ?? 502).json({ error: 'search unavailable' });
  }

  if (req.query.check === '1' && hits.length) {
    const head = hits.slice(0, CHECKED_HITS);
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
  res.json({ query, results: hits, provider: braveKey() ? 'brave' : 'duckduckgo' });
}));
