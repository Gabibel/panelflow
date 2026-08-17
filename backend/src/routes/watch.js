// The chapter watcher, and the news it leaves behind.
//
// The extension has always checked for new chapters itself, on a chrome.alarm.
// That works exactly as long as Chrome is open: close the browser on Friday and
// nothing is checked until Monday — which is precisely the stretch of time a
// reader wants to come back to a list for. So the same check also runs here, on
// a cron, and leaves what it found in a table the clients drain when they wake.
//
// Two things shape the runner. Scan sites are small and easily annoyed, so a
// series is fetched *once* per run no matter how many accounts follow it, and
// requests to one host are spaced out and never overlap. And a run is a single
// function invocation with a deadline, so it takes the least-recently-checked
// series first and stops on a budget: consecutive runs rotate through the whole
// library rather than one run trying to do all of it and dying halfway.
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import { fetchPageMeta, latestChapterOf } from './meta.js';
import { loadRules } from './rules.js';
import { pushNews } from './push.js';
import { WATCHED, PREFIX } from '../folders.js';
import { prunePasswordResets } from '../auth.js';
import { pruneRateLimits } from '../rate-limit.js';

export const watchRouter = Router();
export const newsRouter = Router();

// Folders whose series are both still being published and still being read
// (shared/folders.js): a completed or dropped one is not news, and a
// plan-to-read one has no "new" to be behind on because the reader has not
// started.
//
// A custom category is asked what it stands for rather than compared to this
// list — otherwise moving a series onto a shelf of one's own would quietly
// switch its new-chapter checking off, which is the opposite of what filing
// something more carefully should do.
const WATCHED_SQL = WATCHED.map(() => '?').join(',');
const WATCHED_FOLDER = `(folder IN (${WATCHED_SQL}) OR folder IN (
    SELECT '${PREFIX}' || id FROM categories WHERE status IN (${WATCHED_SQL})
  ))`;
// The bindings that clause needs, once per run — it names the watched statuses
// twice, and getting that wrong is a silent under-count rather than an error.
const WATCHED_ARGS = [...WATCHED, ...WATCHED];

export const WATCH_DEFAULTS = {
  // Series per run. Whatever is left over is simply first in line next time.
  limit: 150,
  // Hosts checked in parallel. Series on the same host, never: that is the
  // difference between a crawler and a burst that gets the IP blocked.
  hosts: 4,
  // Gap between two requests to the same host.
  pacingMs: 1200,
  // What actually bounds a run. `limit` cannot: a library of 150 series spread
  // over four hosts is a couple of minutes, and the same 150 on one slow host
  // is twenty. The function is killed at 300 s, and being killed loses the
  // checked_at writes that would have moved the rotation along — so the run
  // stops itself with room to spare and finishes the list next time.
  deadlineMs: 240_000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return String(url); }
};

/**
 * One pass of the watcher.
 * `fetch` is injectable so the tests never touch the network.
 * @returns {Promise<{series:number, checked:number, failed:number, news:number}>}
 */
export async function runWatch(opts = {}) {
  const { limit, hosts, pacingMs, deadlineMs } = { ...WATCH_DEFAULTS, ...opts };
  const fetchImpl = opts.fetch ?? fetchPageMeta;
  // Read once for the whole run, not once per series: the rules are a file on
  // disk and a run looks at 150 of them.
  const rules = opts.rules ?? loadRules();
  const latestOf = opts.latestChapter ?? ((url, html) => latestChapterOf(url, html, rules));
  const until = Date.now() + deadlineMs;

  // Grouped by URL, so the twelve accounts following One Piece cost one fetch.
  // A never-checked series sorts before every checked one because COALESCE
  // gives it the empty string, which is below any datetime.
  //
  // MAX() on the two validators rather than a column of the grouped-by row:
  // they are written for every row of a URL at once, so the rows agree — but a
  // reader who added the series this morning has a row with neither, and MAX
  // skips nulls where an arbitrary pick would not.
  const series = await db.prepare(`
    SELECT source_url, MIN(COALESCE(checked_at, '')) AS oldest,
           MAX(etag) AS etag, MAX(last_modified) AS last_modified
    FROM library
    WHERE deleted = 0 AND ${WATCHED_FOLDER}
    GROUP BY source_url
    ORDER BY oldest ASC, source_url ASC
    LIMIT ?
  `).all(...WATCHED_ARGS, limit);

  const byHost = new Map();
  for (const row of series) {
    const host = hostOf(row.source_url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(row);
  }

  const stats = { series: series.length, checked: 0, failed: 0, news: 0, unchanged: 0, ranOut: false };
  // What this run found, per account, so the notification is one banner about
  // five series rather than five banners. Only rows this run actually inserted
  // go in: a chapter already announced yesterday is not announced again.
  const byUser = new Map();
  const queue = [...byHost.values()];
  // One worker per host at a time; a worker owns a host for the whole of it, so
  // the pacing below is a real per-host gap and not an average.
  await Promise.all(Array.from({ length: Math.min(hosts, queue.length) }, async () => {
    for (let rows; (rows = queue.shift());) {
      for (let i = 0; i < rows.length; i++) {
        if (Date.now() >= until) { stats.ranOut = true; return; }
        if (i > 0 && pacingMs) await sleep(pacingMs);
        await checkSeries(rows[i], fetchImpl, stats, byUser, latestOf);
      }
    }
  }));

  // After the whole run, not inside it: a reader who follows four series that
  // all updated overnight gets one notification, and the sending never delays
  // the fetching it is competing with for the same deadline.
  const pushed = await pushNews(byUser);
  stats.pushed = pushed.sent;
  stats.dropped = pushed.dropped;
  return stats;
}

async function checkSeries(series, fetchImpl, stats, byUser, latestOf) {
  const sourceUrl = series.source_url;
  let latest = null;
  let reached = false;
  let page = null;
  try {
    const got = await fetchImpl(sourceUrl, { etag: series.etag, lastModified: series.last_modified });
    // The injected fetch of the tests answers with the HTML and nothing else,
    // which is the whole of what most of them are about. Normalising here
    // keeps that readable instead of making every fixture build an envelope.
    page = typeof got === 'string' ? { unchanged: false, html: got } : got;
    if (!page.unchanged) latest = await latestOf(sourceUrl, page.html);
    reached = true;
  } catch {
    // Down, blocking, or gone. checked_at is still written below: one
    // unreachable series must not sit at the head of the rotation forever,
    // starving every other one out of ever being looked at.
    stats.failed++;
  }
  // Written even on a 304, and even on a failure: checked_at is the rotation's
  // cursor, not a record of success. The validators are only replaced when a
  // body actually arrived with them — a 304 carries none, and overwriting with
  // null would throw away the very thing that produced the 304.
  if (page && !page.unchanged) {
    await db.prepare(
      "UPDATE library SET checked_at = datetime('now'), etag = ?, last_modified = ? WHERE source_url = ?",
    ).run(page.etag ?? null, page.lastModified ?? null, sourceUrl);
  } else {
    await db.prepare("UPDATE library SET checked_at = datetime('now') WHERE source_url = ?")
      .run(sourceUrl);
  }
  if (reached) stats.checked++;
  if (page?.unchanged) stats.unchanged++;
  if (latest === null) return;

  const rows = await db.prepare(`
    SELECT id, user_id, title, last_known_chapter FROM library
    WHERE source_url = ? AND deleted = 0 AND ${WATCHED_FOLDER}
  `).all(sourceUrl, ...WATCHED_ARGS);

  for (const row of rows) {
    const known = parseFloat(row.last_known_chapter);
    // Deliberately not touching updated_at: the clients pull the library
    // ordered by it, and a machine-made note of what a site published is no
    // reason to move a series to the top of the user's list.
    if (Number.isFinite(known) && latest > known) {
      const w = await db.prepare(
        'INSERT OR IGNORE INTO news (user_id, library_id, chapter) VALUES (?, ?, ?)',
      ).run(row.user_id, row.id, String(latest));
      stats.news += w.changes;
      if (w.changes) {
        if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
        byUser.get(row.user_id).push({
          libraryId: row.id, title: row.title, chapter: String(latest), sourceUrl,
        });
      }
    }
    // A first sighting records the baseline and announces nothing. Otherwise
    // the first run after this ships tells every reader that every series they
    // follow "has a new chapter" — all of them ones they read months ago.
    if (!Number.isFinite(known) || latest > known) {
      await db.prepare('UPDATE library SET last_known_chapter = ? WHERE id = ?')
        .run(String(latest), row.id);
    }
  }
}

// --- the cron endpoint -----------------------------------------------------

const equals = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
};

// GET as well as POST, because Vercel Cron only ever sends GET — this is not a
// route a browser can reach by accident, and the secret below is the guard.
//
// Not behind requireAuth: the cron calls this with the platform's bearer, not a
// user's. It authenticates on a secret shared with the platform, and refuses to
// run when no secret is configured — an open endpoint that makes the server
// fetch dozens of third-party pages is a free amplifier for whoever finds it.
watchRouter.route('/run').get(wrap(runRoute)).post(wrap(runRoute));

async function runRoute(req, res) {
  const secret = process.env.PANELFLOW_CRON_SECRET ?? process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'watcher not configured' });
  const sent = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!equals(sent, secret)) return res.status(401).json({ error: 'unauthorized' });

  // The one thing that runs on a schedule, so it is also where the two tables
  // nobody reads twice get swept: spent reset links and closed rate-limit
  // windows. Neither is load-bearing — a stale counter row is reused rather
  // than consulted, and an expired link is refused by its own WHERE — so a
  // failure here must not take the watcher down with it.
  try {
    await Promise.all([prunePasswordResets(), pruneRateLimits()]);
  } catch { /* housekeeping; the run is the point */ }

  const limit = Number(req.query.limit);
  res.json(await runWatch(Number.isFinite(limit) && limit > 0 ? { limit } : {}));
}

// --- what the clients drain ------------------------------------------------

const toNews = (row) => ({
  libraryId: row.library_id,
  title: row.title,
  chapter: row.chapter,
  sourceUrl: row.source_url,
  sourceDomain: row.source_domain,
  coverUrl: row.cover_url,
  foundAt: row.found_at,
  seen: !!row.seen,
});

newsRouter.get('/', wrap(async (req, res) => {
  const all = req.query.all === '1';
  const rows = await db.prepare(`
    SELECT n.*, l.title, l.source_url, l.source_domain, l.cover_url
    FROM news n JOIN library l ON l.id = n.library_id
    WHERE n.user_id = ? AND l.deleted = 0 ${all ? '' : 'AND n.seen = 0'}
    ORDER BY n.found_at DESC, CAST(n.chapter AS REAL) DESC
    LIMIT 100
  `).all(req.user.id);
  res.json(rows.map(toNews));
}));

// Called right after the client has shown the notifications. Marking by id
// rather than "everything" so news that arrives mid-drain is not silently
// swallowed; no body at all means the client is caught up on all of it.
newsRouter.post('/seen', wrap(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : null;
  if (items && !items.length) return res.json({ marked: 0 });

  let result;
  if (items) {
    const where = items.map(() => '(library_id = ? AND chapter = ?)').join(' OR ');
    const args = items.flatMap((i) => [String(i?.libraryId ?? ''), String(i?.chapter ?? '')]);
    result = await db.prepare(
      `UPDATE news SET seen = 1 WHERE user_id = ? AND seen = 0 AND (${where})`,
    ).run(req.user.id, ...args);
  } else {
    result = await db.prepare('UPDATE news SET seen = 1 WHERE user_id = ? AND seen = 0')
      .run(req.user.id);
  }
  res.json({ marked: result.changes });
}));
