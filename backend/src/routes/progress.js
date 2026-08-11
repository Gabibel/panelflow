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

progressRouter.put('/:libraryId', wrap(async (req, res) => {
  const lib = await db.prepare('SELECT id FROM library WHERE id = ? AND user_id = ?')
    .get(req.params.libraryId, req.user.id);
  if (!lib) return res.status(404).json({ error: 'library entry not found' });
  const { chapterUrl, chapterLabel, page, pageCount, scrollPos } = req.body ?? {};
  if (!chapterUrl) return res.status(400).json({ error: 'chapterUrl required' });
  await db.prepare(`
    INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, page, page_count, scroll_pos, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, library_id) DO UPDATE SET
      chapter_url = excluded.chapter_url,
      chapter_label = excluded.chapter_label,
      page = excluded.page,
      page_count = excluded.page_count,
      scroll_pos = excluded.scroll_pos,
      updated_at = datetime('now')
  `).run(req.user.id, lib.id, chapterUrl, chapterLabel ?? null, page ?? 0, pageCount ?? null, scrollPos ?? 0);
  const row = await db.prepare('SELECT * FROM progress WHERE user_id = ? AND library_id = ?')
    .get(req.user.id, lib.id);
  // Tell the connected trackers, before answering rather than after: work that
  // outlives the response is killed with the lambda. It costs one query for the
  // users who have connected nothing, and one request per *chapter* — not per
  // page — for the rest. It cannot throw, and it cannot fail this write.
  const trackers = await pushProgress(req.user.id, lib.id, chapterLabel);
  res.json({ ...toProgress(row), ...(trackers.length ? { trackers } : {}) });
}));
