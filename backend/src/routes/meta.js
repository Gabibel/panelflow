import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import { analyze } from '../compat.js';
import { loadRules } from './rules.js';
// The very same chapter-number heuristic the extension and both phone shells
// run. It used to be copied here verbatim; two copies of a regex set this
// fiddly drift, and then the server and the client disagree about what the
// latest chapter is.
import { maxChapterIn, challengePage, chapterApiUrl, maxChapterInApi } from '../panelflow-core.js';
import { resolveSite } from '../site-rules.js';
import { displayTitle } from '../series-match.js';
import { publicUrl, safeFetch } from '../safe-fetch.js';
import { spendFetches } from '../rate-limit.js';

const execFileP = promisify(execFile);

export const metaRouter = Router();

function metaContent(html, prop) {
  const tag = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i')
  )?.[0];
  return tag?.match(/content=["']([^"']+)["']/i)?.[1] ?? null;
}

// The server fetches user-supplied URLs: keep it to public http(s) hosts. The
// check lives in safe-fetch.js because it has to run on every redirect hop and
// against the resolved address, not against the hostname as written.

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** The page, as text. Throws with a status on anything that is not a page. */
export const fetchPage = async (url) => (await fetchPageMeta(url)).html;

/**
 * The same fetch, but able to ask "has this changed since?" and to answer
 * "no". Only the watcher needs that — it re-reads the same few hundred pages
 * every night, and a 304 costs the site a header exchange instead of a
 * megabyte of HTML it already sent us yesterday.
 *
 * @param {string} url
 * @param {{etag?:string|null, lastModified?:string|null}} [seen] what the last
 *   successful fetch of this URL returned, if anything.
 * @returns {Promise<{unchanged:boolean, html:string|null, etag:string|null, lastModified:string|null}>}
 */
export async function fetchPageMeta(url, seen = {}) {
  const u = await publicUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await safeFetch(u, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
        ...(seen.etag ? { 'If-None-Match': seen.etag } : {}),
        ...(seen.lastModified ? { 'If-Modified-Since': seen.lastModified } : {}),
      },
    });
    // Nothing has changed, and the site said so without sending the page.
    // Only possible when we asked, so a caller that passes no validators can
    // never see this branch.
    if (resp.status === 304) return { unchanged: true, html: null, etag: seen.etag ?? null, lastModified: seen.lastModified ?? null };
    // Cloudflare-style bot protection fingerprints Node's TLS stack and
    // answers 403 even with browser headers; curl's fingerprint passes.
    if (resp.status === 403 || resp.status === 503) {
      // curl is the fallback path and carries no validators, so the ones we
      // held are dropped rather than kept against a body they did not come
      // with — a stale ETag would make the next run believe a changed page
      // had not changed.
      return { unchanged: false, html: theRealPage(await curlFetch(u.href)), etag: null, lastModified: null };
    }
    if (!resp.ok) throw httpError(502, `site answered ${resp.status}`);
    const html = (await resp.text()).slice(0, 1_500_000);
    // The wall does not answer with an error. It answers 200 and a few kB of
    // "checking your browser", which every caller below would happily read as
    // a series page — that is how "Just a moment…" ends up being the name of
    // something in a library. curl's TLS fingerprint gets through where Node's
    // does not, so it is worth one more try before giving up on the page.
    if (challengePage(html)) {
      return { unchanged: false, html: theRealPage(await curlFetch(u.href)), etag: null, lastModified: null };
    }
    return {
      unchanged: false,
      html,
      etag: resp.headers.get('etag'),
      lastModified: resp.headers.get('last-modified'),
    };
  } catch (e) {
    throw e.status ? e : httpError(502, 'site unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/** The body, or nothing at all — an anti-bot wall is not a page. */
function theRealPage(html) {
  if (challengePage(html)) throw httpError(502, 'the site is challenging the server, not answering it');
  return html;
}

// curl follows its own redirects, out of reach of safeFetch's per-hop check, so
// it is asked where it ended up and the answer is validated before the body is
// used. The sentinel is what separates the two: -w appends to stdout after the
// body, and a page is free to contain anything, so the marker is a NUL — the
// one byte HTML cannot carry.
const CURL_MARK = '\x00PANELFLOW_EFFECTIVE_URL:';

async function curlFetch(url) {
  let stdout;
  try {
    ({ stdout } = await execFileP('curl', [
      '-sL', '--max-redirs', '5', '--max-time', '15', '--compressed',
      '--proto', '=http,https', '--proto-redir', '=http,https',
      '-A', BROWSER_UA,
      '-H', 'Accept: text/html,application/xhtml+xml',
      '-w', CURL_MARK + '%{url_effective}',
      url,                              // validated by fetchPage; no shell involved
    ], { maxBuffer: 4 * 1024 * 1024 }));
  } catch {
    throw httpError(502, 'site blocked the request');
  }
  const cut = stdout.lastIndexOf(CURL_MARK);
  const body = cut === -1 ? stdout : stdout.slice(0, cut);
  const landed = cut === -1 ? url : stdout.slice(cut + CURL_MARK.length).trim();
  // The request to a private address has already happened by this point — curl
  // made it before telling us where it went — but nothing it answered is read.
  // Blind, and one hop past a public host that chose to redirect there.
  await publicUrl(landed);
  if (!body) throw httpError(502, 'site blocked the request');
  return body.slice(0, 1_500_000);
}

/**
 * The latest chapter of a series, from the page — or from the site's own API
 * when the page is built in the browser and the server never sees a chapter
 * list (see `chapterApiUrl` in shared/panelflow-core.js).
 *
 * A site that names an API is asked it *first*: on such a site the markup is
 * an application shell by definition, so whatever `maxChapterIn` scrapes out
 * of it is furniture. The markup stays as the fallback for the day the API
 * moves, because a stale number beats no number.
 */
export async function latestChapterOf(pageUrl, html, rules) {
  let host = null;
  try { host = new URL(pageUrl).hostname; } catch { /* not a URL we can key on */ }
  const site = host && resolveSite({ host, rules: rules ?? loadRules(), html });
  const api = site && chapterApiUrl(pageUrl, site);
  if (api) {
    try {
      const found = maxChapterInApi(await fetchPage(api), site);
      if (found !== null) return found;
    } catch { /* the API is down; the markup is all there is */ }
  }
  return maxChapterIn(html);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// --- cover image proxy -----------------------------------------------------
// Scan sites hotlink-protect their images: an <img> on our origin gets a 403.
// MangaPin solves it in the browser by rewriting the Referer header with
// declarativeNetRequest; the server-side equivalent is fetching the image
// ourselves with the manga site as Referer and serving it same-origin.
// Public route (an <img> tag cannot send an Authorization header), so it is
// strictly limited: public http(s) hosts, image/* responses, 8 MB cap.

const coverCache = new Map(); // href -> { buf, type, at }
const COVER_TTL_MS = 24 * 3600 * 1000;
const COVER_CACHE_MAX = 100;
const COVER_MAX_BYTES = 8 * 1024 * 1024;
const COVER_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let cacheBytes = 0;

/**
 * The body, up to `max` bytes, or null if it runs past that.
 *
 * `arrayBuffer()` would decide the same thing one byte too late: it buffers
 * whatever the other end sends *first* and hands back a size to check
 * afterwards, so a 500 MB "cover" is already in memory by the time it is
 * refused. Reading the stream lets the refusal happen while it is still small,
 * and Content-Length lets most of them be refused before a byte arrives.
 */
async function readCapped(resp, max) {
  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of resp.body) {
    total += chunk.length;
    if (total > max) return null; // the `for await` return closes the stream
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function coverProxy(req, res) {
  let u;
  // This route is public — an <img> tag cannot send an Authorization header —
  // so it is the one an unauthenticated caller can point anywhere. Same guard
  // as the scraper, and the same refusal.
  try { u = await publicUrl(req.query.url ?? ''); } catch { return res.status(400).end(); }
  const hit = coverCache.get(u.href);
  if (hit && Date.now() - hit.at < COVER_TTL_MS) {
    return res.set('Content-Type', hit.type).set('Cache-Control', 'public, max-age=86400').send(hit.buf);
  }
  // Hotlink protection wants a same-site Referer. Use the manga page's origin
  // only when the image lives on (a subdomain of) the same site; a foreign
  // referer on a third-party image host gets 403'd just like ours did.
  let referer = u.origin + '/';
  try {
    const ref = new URL(req.query.ref);
    const tail = (h) => h.split('.').slice(-2).join('.');
    if (tail(ref.hostname) === tail(u.hostname)) referer = ref.origin + '/';
  } catch { /* keep image origin */ }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await safeFetch(u, {
      signal: ctrl.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*;q=0.8', Referer: referer },
    });
    const type = resp.headers.get('content-type') || '';
    if (!resp.ok || !type.startsWith('image/')) return res.status(502).end();
    const buf = await readCapped(resp, COVER_MAX_BYTES);
    if (!buf) return res.status(502).end();
    // Bounded by bytes and not only by entries: a hundred slots at 8 MB each is
    // 800 MB of a function's memory, reachable by asking for a hundred large
    // covers. Evicting oldest-first until the new one fits keeps the ceiling
    // real rather than nominal.
    // A stale entry for this href is about to be replaced, not added to.
    cacheBytes -= coverCache.get(u.href)?.buf.length ?? 0;
    coverCache.set(u.href, { buf, type, at: Date.now() });
    cacheBytes += buf.length;
    while (cacheBytes > COVER_CACHE_MAX_BYTES || coverCache.size > COVER_CACHE_MAX) {
      const oldest = coverCache.keys().next().value;
      if (oldest === undefined || oldest === u.href) break;
      cacheBytes -= coverCache.get(oldest).buf.length;
      coverCache.delete(oldest);
    }
    coverCache.set(u.href, { buf, type, at: Date.now() });
    res.set('Content-Type', type).set('Cache-Control', 'public, max-age=86400').send(buf);
  } catch {
    res.status(502).end();
  } finally {
    clearTimeout(timer);
  }
}

// Series page metadata for the add-series form: cover, title, latest chapter.
metaRouter.get('/scrape', wrap(async (req, res) => {
  // Outside the try, so that a spent budget is answered as a spent budget: the
  // catch below turns everything it sees into "the page could not be fetched",
  // which here would be a lie about a page nobody went to.
  await spendFetches(req, res, 1);
  try {
    const pageUrl = req.query.url ?? '';
    const html = await fetchPage(pageUrl);
    const rawCover = metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image');
    let coverUrl = null;
    if (rawCover) {
      try { coverUrl = new URL(rawCover, pageUrl).href; } catch {}
    }
    // og:title is written for search engines, not for a shelf: what comes back
    // is "Blue Box Scan VF / FR Gratuit (Webtoon)". Stored raw it overflows
    // every card and follows the entry into all three exports.
    const rawTitle =
      metaContent(html, 'og:title') ??
      html.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ??
      null;
    res.json({
      title: rawTitle === null ? null : displayTitle(rawTitle) || null,
      coverUrl,
      latestChapter: await latestChapterOf(pageUrl, html),
    });
  } catch (e) {
    res.status(e.status ?? 502).json({ error: e.message });
  }
}));

// "Can PanelFlow read this page?" — the question the mobile app asks about a
// search result before the user commits to opening it. Same verdict the reader
// itself would reach, derived from markup instead of a live DOM (shared/compat.js).
metaRouter.get('/compat', wrap(async (req, res) => {
  await spendFetches(req, res, 1);
  try {
    const pageUrl = req.query.url ?? '';
    const html = await fetchPage(pageUrl);
    res.json({ url: pageUrl, ...analyze(html, pageUrl, { rules: loadRules() }) });
  } catch (e) {
    // A site we cannot reach is not a site we know is incompatible. Say so
    // rather than letting a network blip look like a verdict.
    res.status(e.status ?? 502).json({
      url: req.query.url ?? '', error: e.message,
      verdict: 'unknown', reason: 'the page could not be fetched from the server',
    });
  }
}));

// Re-scan every library entry for new chapters (the server-side twin of the
// extension's checkNewChapters). hasNew = the latest chapter on the site
// advanced past what we knew at the previous check.

// One page fetch per series — but not one strictly after another. Twenty series
// paced at 1.5 s apart spent more of the request asleep than working and ran
// past the function timeout, and a timed-out request returns nothing at all.
// Requests to the *same* host stay sequential and paced, which is what being
// polite to a scan site actually means; different hosts proceed side by side.
const CHECK_HOST_PACE_MS = 1500;
const CHECK_HOST_CONCURRENCY = 6;
// Well inside any function timeout, so a large library comes back partial
// rather than not at all.
const CHECK_BUDGET_MS = Number(process.env.PANELFLOW_CHECK_BUDGET_MS ?? 45_000);

async function checkOne(row, rules) {
  const html = await fetchPage(row.source_url);
  const latest = await latestChapterOf(row.source_url, html, rules);
  // Backfill a missing cover from og:image while we have the page anyway.
  let coverUrl = row.cover_url;
  if (!coverUrl) {
    const raw = metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image');
    if (raw) {
      try { coverUrl = new URL(raw, row.source_url).href; } catch {}
    }
  }
  const known = parseFloat(row.last_known_chapter);
  // Deliberately no updated_at bump: checking must not reorder the library.
  await db.prepare('UPDATE library SET last_known_chapter = ?, cover_url = ? WHERE id = ?')
    .run(latest !== null ? String(latest) : row.last_known_chapter, coverUrl, row.id);
  return {
    id: row.id,
    latestChapter: latest,
    coverUrl,
    hasNew: latest !== null && !Number.isNaN(known) && latest > known,
  };
}

metaRouter.post('/check', wrap(async (req, res) => {
  const rows = await db.prepare(
    'SELECT id, source_url, cover_url, last_known_chapter FROM library WHERE user_id = ? AND deleted = 0'
  ).all(req.user.id);

  // The expensive one: a pass over a shelf of two hundred series is two hundred
  // page fetches, bounded only by the time budget below. Charged for what it
  // will actually cost — capped, because the budget itself is what stops the
  // pass, and a single user's whole library must not be refused outright for
  // being large.
  await spendFetches(req, res, Math.min(rows.length, 40));

  const byHost = new Map();
  for (const row of rows) {
    let host;
    try { host = new URL(row.source_url).hostname; } catch { host = String(row.source_url); }
    byHost.set(host, [...(byHost.get(host) ?? []), row]);
  }

  const queues = [...byHost.values()];
  const deadline = Date.now() + CHECK_BUDGET_MS;
  const results = [];
  const rules = loadRules(); // once for the whole pass, not once per series
  let next = 0;

  const worker = async () => {
    while (next < queues.length) {
      const queue = queues[next++];
      for (const [i, row] of queue.entries()) {
        if (Date.now() >= deadline) return;
        try {
          results.push(await checkOne(row, rules));
        } catch { /* site unreachable — skip, try next cycle */ }
        if (i < queue.length - 1) await new Promise((r) => setTimeout(r, CHECK_HOST_PACE_MS));
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CHECK_HOST_CONCURRENCY, queues.length) }, worker)
  );
  res.json(results);
}));
