import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import { pushProgress } from '../tracker-push.js';
import { badUrls, refuseBadUrls } from '../http-url.js';

export const progressRouter = Router();

const toProgress = (row) => ({
  libraryId: row.library_id,
  chapterUrl: row.chapter_url,
  chapterLabel: row.chapter_label,
  page: row.page,
  pageCount: row.page_count,
  scrollPos: row.scroll_pos,
  updatedAt: row.updated_at,
});

progressRouter.get('/', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM progress WHERE user_id = ?').all(req.user.id);
  res.json(rows.map(toProgress));
}));

// "Continue reading": most recently read entries joined with their series.
progressRouter.get('/continue', wrap(async (req, res) => {
  const rows = await db.prepare(`
    SELECT p.*, l.title, l.cover_url, l.source_domain
    FROM progress p JOIN library l ON l.id = p.library_id
    WHERE p.user_id = ? AND l.deleted = 0
    ORDER BY p.updated_at DESC LIMIT 20
  `).all(req.user.id);
  res.json(rows.map((r) => ({
    ...toProgress(r),
    title: r.title,
    coverUrl: r.cover_url,
    sourceDomain: r.source_domain,
  })));
}));

// The route a reader hits most: once per page turn, on every device, all
// evening. In production the database is in another building — every statement
// here is a network round trip — so this is written as *one*, where it used to
// be three.
//
// SELECT … FROM library is where the ownership check went: no row means the
// entry is not this user's (or is not an entry), the SELECT feeds the INSERT
// nothing, and RETURNING hands back nothing — which is the 404, decided by the
// same statement that would have done the write. And RETURNING replaces the
// read-back that followed, which only ever re-read the row just written.
//
// The SELECT needs its WHERE for SQLite's sake as much as ours: with an
// INSERT … SELECT, the parser cannot otherwise tell ON CONFLICT from a join's
// ON clause.
//
// Last read wins — read, not *received*. A bookmark carries the moment it was
// written on the device (`updatedAt`), and the update only happens when that
// moment is not older than the one already stored. Before, the server stamped
// every write with its own clock and took them all, so a PC re-sending its
// stale chapter 10 on opening its popup overwrote the chapter 12 a phone had
// just read (QA, September 2026). A client that sends no moment — a build from
// before this — is stamped now, as it always was.
const UPSERT_PROGRESS = `
  INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, page, page_count, scroll_pos, updated_at)
  SELECT ?, id, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')) FROM library WHERE id = ? AND user_id = ?
  ON CONFLICT (user_id, library_id) DO UPDATE SET
    chapter_url = excluded.chapter_url,
    chapter_label = excluded.chapter_label,
    page = excluded.page,
    page_count = excluded.page_count,
    scroll_pos = excluded.scroll_pos,
    updated_at = excluded.updated_at
  WHERE excluded.updated_at >= progress.updated_at
  RETURNING *
`;

/**
 * The client's moment, in the spelling `datetime('now')` writes, so the two
 * compare as text. Never later than now: a phone whose clock runs a year
 * ahead would otherwise win every comparison for a year. Null when there is
 * nothing readable, which means "now" (see the COALESCE above).
 */
export function clientMoment(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s);
  const ms = Date.parse(sqlite ? `${s.replace(' ', 'T')}Z` : s);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.min(ms, now)).toISOString().slice(0, 19).replace('T', ' ');
}

progressRouter.put('/:libraryId', wrap(async (req, res) => {
  const { chapterUrl, chapterLabel, page, pageCount, scrollPos, updatedAt } = req.body ?? {};
  if (!chapterUrl) return res.status(400).json({ error: 'chapterUrl required' });
  const bad = badUrls(req.body, ['chapterUrl']);
  if (bad.length) return refuseBadUrls(res, bad);
  // Deliberately not filtered on `deleted`: a bookmark outlives the entry being
  // removed, and comes back with it when the series is pinned again.
  const row = await db.prepare(UPSERT_PROGRESS).get(
    req.user.id, chapterUrl, chapterLabel ?? null, page ?? 0, pageCount ?? null, scrollPos ?? 0,
    clientMoment(updatedAt), req.params.libraryId, req.user.id,
  );
  if (!row) {
    // Nothing written: either the entry is not this user's, or this bookmark
    // is older than the one already here. The second is not an error — the
    // device is told what the account has, and adopts it.
    const current = await db.prepare(
      `SELECT p.* FROM progress p JOIN library l ON l.id = p.library_id
        WHERE p.user_id = ? AND p.library_id = ? AND l.user_id = ?`,
    ).get(req.user.id, req.params.libraryId, req.user.id);
    if (current) return res.json({ ...toProgress(current), stale: true });
    return res.status(404).json({ error: 'library entry not found' });
  }
  // Tell the connected trackers, before answering rather than after: work that
  // outlives the response is killed with the lambda. It costs one query for the
  // users who have connected nothing, and one request per *chapter* — not per
  // page — for the rest. It cannot throw, and it cannot fail this write.
  const trackers = await pushProgress(req.user.id, row.library_id, chapterLabel);
  res.json({ ...toProgress(row), ...(trackers.length ? { trackers } : {}) });
}));
