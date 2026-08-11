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
import { maxChapterIn } from '../panelflow-core.js';

const execFileP = promisify(execFile);

export const metaRouter = Router();

function metaContent(html, prop) {
  const tag = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i')
  )?.[0];
  return tag?.match(/content=["']([^"']+)["']/i)?.[1] ?? null;
}

// The server fetches user-supplied URLs: keep it to public http(s) hosts.
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[|::1$)/i;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function fetchPage(url) {
  let u;
  try { u = new URL(url); } catch { throw httpError(400, 'invalid url'); }
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) {
    throw httpError(400, 'url not allowed');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(u, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
      },
    });
    // Cloudflare-style bot protection fingerprints Node's TLS stack and
    // answers 403 even with browser headers; curl's fingerprint passes.
    if (resp.status === 403 || resp.status === 503) return curlFetch(u.href);
    if (!resp.ok) throw httpError(502, `site answered ${resp.status}`);
    return (await resp.text()).slice(0, 1_500_000);
  } catch (e) {
    throw e.status ? e : httpError(502, 'site unreachable');
  } finally {
    clearTimeout(timer);
  }
}

async function curlFetch(url) {
  try {
    const { stdout } = await execFileP('curl', [
      '-sL', '--max-time', '15', '--compressed',
      '-A', BROWSER_UA,
      '-H', 'Accept: text/html,application/xhtml+xml',
      url,                              // validated by fetchPage; no shell involved
    ], { maxBuffer: 4 * 1024 * 1024 });
    if (!stdout) throw new Error('empty');
    return stdout.slice(0, 1_500_000);
  } catch {
    throw httpError(502, 'site blocked the request');
  }
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

export async function coverProxy(req, res) {
  let u;
  try { u = new URL(req.query.url ?? ''); } catch { return res.status(400).end(); }
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) {
    return res.status(400).end();
  }
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
    const resp = await fetch(u, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*;q=0.8', Referer: referer },
    });
    const type = resp.headers.get('content-type') || '';
    if (!resp.ok || !type.startsWith('image/')) return res.status(502).end();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return res.status(502).end();
    if (coverCache.size >= COVER_CACHE_MAX) {
      coverCache.delete(coverCache.keys().next().value); // drop oldest insert
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
metaRouter.get('/scrape', async (req, res) => {
  try {
    const pageUrl = req.query.url ?? '';
    const html = await fetchPage(pageUrl);
    const rawCover = metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image');
    let coverUrl = null;
    if (rawCover) {
      try { coverUrl = new URL(rawCover, pageUrl).href; } catch {}
    }
    res.json({
      title:
        metaContent(html, 'og:title') ??
        html.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ??
        null,
      coverUrl,
      latestChapter: maxChapterIn(html),
    });
  } catch (e) {
    res.status(e.status ?? 502).json({ error: e.message });
  }
});

// "Can PanelFlow read this page?" — the question the mobile app asks about a
// search result before the user commits to opening it. Same verdict the reader
// itself would reach, derived from markup instead of a live DOM (shared/compat.js).
metaRouter.get('/compat', async (req, res) => {
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
});

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

async function checkOne(row) {
  const html = await fetchPage(row.source_url);
  const latest = maxChapterIn(html);
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

  const byHost = new Map();
  for (const row of rows) {
    let host;
    try { host = new URL(row.source_url).hostname; } catch { host = String(row.source_url); }
    byHost.set(host, [...(byHost.get(host) ?? []), row]);
  }

  const queues = [...byHost.values()];
  const deadline = Date.now() + CHECK_BUDGET_MS;
  const results = [];
  let next = 0;

  const worker = async () => {
    while (next < queues.length) {
      const queue = queues[next++];
      for (const [i, row] of queue.entries()) {
        if (Date.now() >= deadline) return;
        try {
          results.push(await checkOne(row));
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
