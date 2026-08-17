import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import { pushProgress } from '../tracker-push.js';

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
const UPSERT_PROGRESS = `
  INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, page, page_count, scroll_pos, updated_at)
  SELECT ?, id, ?, ?, ?, ?, ?, datetime('now') FROM library WHERE id = ? AND user_id = ?
  ON CONFLICT (user_id, library_id) DO UPDATE SET
    chapter_url = excluded.chapter_url,
    chapter_label = excluded.chapter_label,
    page = excluded.page,
    page_count = excluded.page_count,
    scroll_pos = excluded.scroll_pos,
    updated_at = datetime('now')
  RETURNING *
`;

progressRouter.put('/:libraryId', wrap(async (req, res) => {
  const { chapterUrl, chapterLabel, page, pageCount, scrollPos } = req.body ?? {};
  if (!chapterUrl) return res.status(400).json({ error: 'chapterUrl required' });
  // Deliberately not filtered on `deleted`: a bookmark outlives the entry being
  // removed, and comes back with it when the series is pinned again.
  const row = await db.prepare(UPSERT_PROGRESS).get(
    req.user.id, chapterUrl, chapterLabel ?? null, page ?? 0, pageCount ?? null, scrollPos ?? 0,
    req.params.libraryId, req.user.id,
  );
  if (!row) return res.status(404).json({ error: 'library entry not found' });
  // Tell the connected trackers, before answering rather than after: work that
  // outlives the response is killed with the lambda. It costs one query for the
  // users who have connected nothing, and one request per *chapter* — not per
  // page — for the rest. It cannot throw, and it cannot fail this write.
  const trackers = await pushProgress(req.user.id, row.library_id, chapterLabel);
  res.json({ ...toProgress(row), ...(trackers.length ? { trackers } : {}) });
}));
