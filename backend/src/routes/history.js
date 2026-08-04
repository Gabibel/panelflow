import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from '../wrap.js';

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

historyRouter.get('/', wrap(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const rows = await db.prepare(`
    SELECT h.*, l.title, l.cover_url, l.source_domain, l.deleted
    FROM history h JOIN library l ON l.id = h.library_id
    WHERE h.user_id = ?
    -- By day first: the log is read as "what did I read on Tuesday", and
    -- ordering on read_at alone interleaves days, because a row is touched
    -- again whenever a client syncs more seconds onto an older day.
    ORDER BY h.day DESC, h.read_at DESC LIMIT ?
  `).all(req.user.id, limit);
  res.json(rows.map((r) => ({
    ...toRow(r),
    title: r.title,
    coverUrl: r.cover_url,
    sourceDomain: r.source_domain,
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
  const [totals, byDay, topSeries, byFolder, library] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) AS chapters, COALESCE(SUM(seconds), 0) AS seconds,
             COUNT(DISTINCT library_id) AS series, MIN(day) AS firstDay
      FROM history WHERE user_id = ?
    `).get(req.user.id),
    db.prepare(`
      SELECT day, COUNT(*) AS chapters, COALESCE(SUM(seconds), 0) AS seconds
      FROM history WHERE user_id = ? GROUP BY day ORDER BY day DESC LIMIT 400
    `).all(req.user.id),
    db.prepare(`
      SELECT h.library_id AS id, l.title, l.cover_url,
             COUNT(*) AS chapters, COALESCE(SUM(h.seconds), 0) AS seconds
      FROM history h JOIN library l ON l.id = h.library_id
      WHERE h.user_id = ?
      GROUP BY h.library_id ORDER BY chapters DESC, seconds DESC LIMIT 10
    `).all(req.user.id),
    db.prepare(`
      SELECT folder, COUNT(*) AS entries FROM library
      WHERE user_id = ? AND deleted = 0 GROUP BY folder
    `).all(req.user.id),
    db.prepare(`
      SELECT COUNT(*) AS entries, COUNT(score) AS scored,
             COALESCE(AVG(score), 0) AS avgScore, COALESCE(SUM(rereads), 0) AS rereads
      FROM library WHERE user_id = ? AND deleted = 0
    `).get(req.user.id),
  ]);

  const days = byDay.map((d) => ({ day: d.day, chapters: Number(d.chapters), seconds: Number(d.seconds) }));
  res.json({
    chapters: Number(totals.chapters),
    seconds: Number(totals.seconds),
    series: Number(totals.series),
    firstDay: totals.firstDay ?? null,
    // Only over days that were actually read: dividing by the calendar would
    // measure how long the account has existed, not how much is read.
    secondsPerDay: days.length ? Math.round(Number(totals.seconds) / days.length) : 0,
    ...streaks(days.map((d) => d.day)),
    days,
    topSeries: topSeries.map((s) => ({
      id: s.id, title: s.title, coverUrl: s.cover_url,
      chapters: Number(s.chapters), seconds: Number(s.seconds),
    })),
    folders: Object.fromEntries(byFolder.map((f) => [f.folder, Number(f.entries)])),
    entries: Number(library.entries),
    scored: Number(library.scored),
    avgScore: Number(library.avgScore),
    rereads: Number(library.rereads),
  });
}));
