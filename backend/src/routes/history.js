import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import { listCategories } from './categories.js';
import { folderStatus } from '../folders.js';
import { badUrls, refuseBadUrls } from '../http-url.js';
import { MEDIA, normalizeMedium } from '../panelflow-core.js';

export const historyRouter = Router();

// A reading session the client forgot to close should not claim the whole
// afternoon. The reader stops its clock when the tab is hidden, but a laptop
// suspended mid-chapter reports whatever the wall clock says on resume.
const MAX_SESSION_SECONDS = 4 * 3600;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const toRow = (r) => ({
  libraryId: r.library_id,
  chapterUrl: r.chapter_url,
  chapterLabel: r.chapter_label,
  day: r.day,
  pages: r.pages,
  seconds: r.seconds,
  readAt: r.read_at,
});

// The day comes from the client because "what did I read today" is a question
// about the reader's calendar, not the server's: a 1 a.m. chapter in Paris is
// still yesterday in UTC. Validated, and refused if it is in the future by
// more than a day — no timezone is that far ahead.
function readDay(value) {
  if (value === undefined || value === null) return null;
  const v = String(value);
  if (!DAY.test(v)) return null;
  const limit = new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
  return v <= limit ? v : null;
}

historyRouter.post('/', wrap(async (req, res) => {
  const { libraryId, chapterUrl, chapterLabel, pages, seconds, day } = req.body ?? {};
  if (!libraryId || !chapterUrl) {
    return res.status(400).json({ error: 'libraryId and chapterUrl required' });
  }
  const bad = badUrls(req.body, ['chapterUrl']);
  if (bad.length) return refuseBadUrls(res, bad);
  const lib = await db.prepare('SELECT id FROM library WHERE id = ? AND user_id = ?')
    .get(libraryId, req.user.id);
  if (!lib) return res.status(404).json({ error: 'library entry not found' });

  const secs = Math.min(MAX_SESSION_SECONDS, Math.max(0, Math.round(Number(seconds) || 0)));
  const pageCount = Math.max(0, Math.round(Number(pages) || 0));
  const d = readDay(day) ?? new Date().toISOString().slice(0, 10);

  await db.prepare(`
    INSERT INTO history (user_id, library_id, chapter_url, day, chapter_label, pages, seconds, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, library_id, chapter_url, day) DO UPDATE SET
      chapter_label = COALESCE(excluded.chapter_label, chapter_label),
      -- Pages is how far this chapter got, not a running total: the client
      -- reports the same chapter repeatedly as it reads further into it.
      pages = MAX(pages, excluded.pages),
      seconds = MIN(?, seconds + excluded.seconds),
      read_at = datetime('now')
  `).run(req.user.id, lib.id, chapterUrl, d, chapterLabel ?? null, pageCount, secs,
    MAX_SESSION_SECONDS * 6);

  const row = await db.prepare(
    'SELECT * FROM history WHERE user_id = ? AND library_id = ? AND chapter_url = ? AND day = ?'
  ).get(req.user.id, lib.id, chapterUrl, d);
  res.status(201).json(toRow(row));
}));

/**
 * The one kind of work a history or statistics request asks about — manga,
 * webtoon, web novel, light novel, anime — or null for all of them. Anything
 * else is refused rather than read as "all": a typo answering with the whole
 * history looks exactly like a filter that works.
 */
function mediumOf(req, res) {
  const asked = req.query.medium;
  if (asked === undefined || asked === '' || asked === 'all') return { medium: null };
  const medium = normalizeMedium(asked);
  if (!medium) {
    res.status(400).json({ error: `medium must be one of ${MEDIA.join(', ')}` });
    return null;
  }
  return { medium };
}

historyRouter.get('/', wrap(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const asked = mediumOf(req, res);
  if (!asked) return;
  const { medium } = asked;
  const rows = await db.prepare(`
    SELECT h.*, l.title, l.cover_url, l.source_domain, l.deleted, l.medium
    FROM history h JOIN library l ON l.id = h.library_id
    WHERE h.user_id = ? ${medium ? 'AND l.medium = ?' : ''}
    -- By day first: the log is read as "what did I read on Tuesday", and
    -- ordering on read_at alone interleaves days, because a row is touched
    -- again whenever a client syncs more seconds onto an older day.
    ORDER BY h.day DESC, h.read_at DESC LIMIT ?
  `).all(...[req.user.id, ...(medium ? [medium] : []), limit]);
  res.json(rows.map((r) => ({
    ...toRow(r),
    title: r.title,
    coverUrl: r.cover_url,
    sourceDomain: r.source_domain,
    medium: normalizeMedium(r.medium) ?? 'manga',
    // Kept rather than hidden: a series you removed is still a series you read,
    // and dropping it would make the totals disagree with the list.
    removed: r.deleted === 1,
  })));
}));

historyRouter.delete('/', wrap(async (req, res) => {
  const r = await db.prepare('DELETE FROM history WHERE user_id = ?').run(req.user.id);
  res.json({ removed: r.changes });
}));

/**
 * Consecutive days ending today (or yesterday — a streak is not broken until
 * the day it is missed is over), and the longest run anywhere in the list.
 * `days` arrives newest first.
 */
export function streaks(days, today = new Date().toISOString().slice(0, 10)) {
  const set = new Set(days);
  const shift = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  let current = 0;
  let cursor = set.has(today) ? today : shift(today, -1);
  while (set.has(cursor)) { current++; cursor = shift(cursor, -1); }

  let longest = 0;
  for (const day of set) {
    // Count a run only from its earliest day, so each run is walked once.
    if (set.has(shift(day, -1))) continue;
    let n = 0;
    for (let c = day; set.has(c); c = shift(c, 1)) n++;
    if (n > longest) longest = n;
  }
  return { current, longest };
}

historyRouter.get('/stats', wrap(async (req, res) => {
  const asked = mediumOf(req, res);
  if (!asked) return;
  const { medium } = asked;
  // One type of work, or all of them. The history rows are narrowed through the
  // series they belong to; with no type asked the join is left out, so a row
  // whose series is gone for good still counts in the totals, as it always did.
  const H = medium
    ? 'history h JOIN library l ON l.id = h.library_id WHERE h.user_id = ? AND l.medium = ?'
    : 'history h WHERE h.user_id = ?';
  const hArgs = medium ? [req.user.id, medium] : [req.user.id];
  const L = medium ? 'AND medium = ?' : '';
  const lArgs = medium ? [req.user.id, medium] : [req.user.id];
  const [totals, byDay, allDays, topSeries, byFolder, library, categories, byMedium] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) AS chapters, COALESCE(SUM(h.seconds), 0) AS seconds,
             COUNT(DISTINCT h.library_id) AS series, COUNT(DISTINCT h.day) AS days,
             MIN(h.day) AS firstDay
      FROM ${H}
    `).get(...hArgs),
    db.prepare(`
      SELECT h.day AS day, COUNT(*) AS chapters, COALESCE(SUM(h.seconds), 0) AS seconds
      FROM ${H} GROUP BY h.day ORDER BY h.day DESC LIMIT 400
    `).all(...hArgs),
    // Every day that was read, for the streaks. `byDay` above stops at 400 rows
    // because it draws a chart; counting a streak off a truncated list would
    // cut a long-standing reader's run at the edge of what the chart shows —
    // and `secondsPerDay` was already careful about exactly this.
    db.prepare(`
      SELECT DISTINCT h.day AS day FROM ${H} ORDER BY h.day DESC
    `).all(...hArgs),
    db.prepare(`
      SELECT h.library_id AS id, l.title, l.cover_url, l.medium,
             COUNT(*) AS chapters, COALESCE(SUM(h.seconds), 0) AS seconds
      FROM history h JOIN library l ON l.id = h.library_id
      WHERE h.user_id = ? ${medium ? 'AND l.medium = ?' : ''}
      GROUP BY h.library_id ORDER BY chapters DESC, seconds DESC LIMIT 10
    `).all(...hArgs),
    db.prepare(`
      SELECT folder, COUNT(*) AS entries FROM library
      WHERE user_id = ? AND deleted = 0 ${L} GROUP BY folder
    `).all(...lArgs),
    db.prepare(`
      SELECT COUNT(*) AS entries, COUNT(score) AS scored,
             COALESCE(AVG(score), 0) AS avgScore, COALESCE(SUM(rereads), 0) AS rereads
      FROM library WHERE user_id = ? AND deleted = 0 ${L}
    `).get(...lArgs),
    listCategories(req.user.id),
    // The general view's breakdown: what was read, and watched, by type.
    db.prepare(`
      SELECT l.medium AS medium, COUNT(*) AS chapters, COALESCE(SUM(h.seconds), 0) AS seconds,
             COUNT(DISTINCT h.library_id) AS series
      FROM history h JOIN library l ON l.id = h.library_id
      WHERE h.user_id = ? GROUP BY l.medium
    `).all(req.user.id),
  ]);

  const days = byDay.map((d) => ({ day: d.day, chapters: Number(d.chapters), seconds: Number(d.seconds) }));
  res.json({
    chapters: Number(totals.chapters),
    seconds: Number(totals.seconds),
    series: Number(totals.series),
    firstDay: totals.firstDay ?? null,
    // Only over days that were actually read: dividing by the calendar would
    // measure how long the account has existed, not how much is read. Counted
    // in SQL rather than from `days` below, which stops at 400 rows for the
    // chart — dividing an all-time total by a truncated span would report a
    // long-standing reader as reading several times what they do.
    secondsPerDay: totals.days ? Math.round(Number(totals.seconds) / Number(totals.days)) : 0,
    ...streaks(allDays.map((d) => d.day)),
    days,
    topSeries: topSeries.map((s) => ({
      id: s.id, title: s.title, coverUrl: s.cover_url,
      medium: normalizeMedium(s.medium) ?? 'manga',
      chapters: Number(s.chapters), seconds: Number(s.seconds),
    })),
    medium: medium ?? 'all',
    byMedium: byMedium.reduce((acc, m) => {
      const key = normalizeMedium(m.medium) ?? 'manga';
      const was = acc[key] ?? { chapters: 0, seconds: 0, series: 0 };
      acc[key] = {
        chapters: was.chapters + Number(m.chapters),
        seconds: was.seconds + Number(m.seconds),
        series: was.series + Number(m.series),
      };
      return acc;
    }, {}),
    // Keyed by status, not by folder: a breakdown of a library into five bars
    // that do not add up to it — because everything on a custom shelf fell out
    // of the chart — is worse than no breakdown.
    folders: byFolder.reduce((acc, f) => {
      const key = folderStatus(f.folder, categories);
      acc[key] = (acc[key] ?? 0) + Number(f.entries);
      return acc;
    }, {}),
    entries: Number(library.entries),
    scored: Number(library.scored),
    avgScore: Number(library.avgScore),
    rereads: Number(library.rereads),
  });
}));
