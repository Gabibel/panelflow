import { Router } from 'express';
import { db, uid } from '../db.js';
import { wrap } from '../wrap.js';
import { findMatches, normUrl, chapterNumber, furtherChapter } from '../series-match.js';

export const libraryRouter = Router();

const FOLDERS = ['reading', 'paused', 'plan', 'completed', 'dropped'];

const parseJson = (raw, fallback) => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch { return fallback; }
};

const toEntry = (row) => ({
  id: row.id,
  title: row.title,
  coverUrl: row.cover_url,
  sourceDomain: row.source_domain,
  sourceUrl: row.source_url,
  previousSources: parseJson(row.previous_sources, []),
  // Same tolerant read as previous_sources: a single row with a NULL or
  // malformed tags column must not turn the whole library into a 500.
  tags: parseJson(row.tags, []),
  lastKnownChapter: row.last_known_chapter,
  folder: row.folder,
  language: row.language,
  score: row.score,
  note: row.note,
  startDate: row.start_date,
  finishDate: row.finish_date,
  rereads: row.rereads,
  seriesStatus: row.series_status,
  dateAdded: row.date_added,
  updatedAt: row.updated_at,
});

// Normalises the optional metadata shared by POST and PUT. Returns null for
// anything absent so callers can COALESCE onto what the row already holds.
function readDetails(body) {
  const { folder, language, score, note, startDate, finishDate, rereads, seriesStatus } = body ?? {};
  const errors = [];
  if (folder !== undefined && folder !== null && !FOLDERS.includes(folder)) {
    errors.push(`folder must be one of ${FOLDERS.join(', ')}`);
  }
  if (seriesStatus !== undefined && seriesStatus !== null &&
      !['ongoing', 'completed'].includes(seriesStatus)) {
    errors.push('seriesStatus must be ongoing or completed');
  }
  const num = (v, lo, hi, name) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) { errors.push(`${name} must be ${lo}-${hi}`); return null; }
    return n;
  };
  const date = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { errors.push(`${name} must be YYYY-MM-DD`); return null; }
    return v;
  };
  return {
    errors,
    folder: folder ?? null,
    language: language ?? null,
    score: num(score, 0, 10, 'score'),
    note: note ?? null,
    startDate: date(startDate, 'startDate'),
    finishDate: date(finishDate, 'finishDate'),
    rereads: num(rereads, 0, 9999, 'rereads'),
    seriesStatus: seriesStatus ?? null,
  };
}

libraryRouter.get('/', wrap(async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM library WHERE user_id = ? AND deleted = 0 ORDER BY updated_at DESC'
  ).all(req.user.id);
  res.json(rows.map(toEntry));
}));

libraryRouter.post('/', wrap(async (req, res) => {
  const { title, coverUrl, sourceDomain, sourceUrl, tags, lastKnownChapter } = req.body ?? {};
  if (!title || !sourceDomain || !sourceUrl) {
    return res.status(400).json({ error: 'title, sourceDomain, sourceUrl required' });
  }
  const d = readDetails(req.body);
  if (d.errors.length) return res.status(400).json({ error: d.errors.join('; ') });

  const existing = await db.prepare(
    'SELECT * FROM library WHERE user_id = ? AND source_url = ?'
  ).get(req.user.id, sourceUrl);
  if (existing) {
    // Re-pinning a previously removed entry resurrects it. A client that has
    // no cover/tags/chapter of its own (the extension syncing a bare local
    // entry) must not wipe what the server already knows.
    const keepTags = tags && tags.length > 0 ? JSON.stringify(tags) : existing.tags;
    await db.prepare(
      `UPDATE library SET deleted = 0, title = ?, cover_url = COALESCE(?, cover_url),
         tags = ?, last_known_chapter = COALESCE(?, last_known_chapter),
         folder = COALESCE(?, folder), language = COALESCE(?, language),
         score = COALESCE(?, score), note = COALESCE(?, note),
         start_date = COALESCE(?, start_date), finish_date = COALESCE(?, finish_date),
         rereads = COALESCE(?, rereads), series_status = COALESCE(?, series_status),
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(title, coverUrl ?? null, keepTags, lastKnownChapter ?? null,
      d.folder, d.language, d.score, d.note, d.startDate, d.finishDate, d.rereads,
      d.seriesStatus, existing.id);
    return res.json(toEntry(await db.prepare('SELECT * FROM library WHERE id = ?').get(existing.id)));
  }
  const id = uid();
  await db.prepare(
    `INSERT INTO library (id, user_id, title, cover_url, source_domain, source_url, tags,
       last_known_chapter, folder, language, score, note, start_date, finish_date, rereads,
       series_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'reading'), ?, ?, ?, ?, ?, COALESCE(?, 0), ?)`
  ).run(id, req.user.id, title, coverUrl ?? null, sourceDomain, sourceUrl,
    JSON.stringify(tags ?? []), lastKnownChapter ?? null,
    d.folder, d.language, d.score, d.note, d.startDate, d.finishDate, d.rereads,
    d.seriesStatus);
  res.status(201).json(toEntry(await db.prepare('SELECT * FROM library WHERE id = ?').get(id)));
}));

libraryRouter.put('/:id', wrap(async (req, res) => {
  const row = await db.prepare('SELECT * FROM library WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const body = req.body ?? {};
  const { title, coverUrl, tags, lastKnownChapter } = body;
  const d = readDetails(body);
  if (d.errors.length) return res.status(400).json({ error: d.errors.join('; ') });
  // PUT is an explicit edit, so an omitted key keeps the stored value while an
  // explicit null clears it — that is the only way to unset a score or a note.
  const patch = (key, next, current) => (key in body ? next : current);

  await db.prepare(
    `UPDATE library SET title = ?, cover_url = ?, tags = ?, last_known_chapter = ?,
       folder = ?, language = ?, score = ?, note = ?, start_date = ?, finish_date = ?,
       rereads = ?, series_status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    title ?? row.title,
    patch('coverUrl', coverUrl, row.cover_url),
    tags !== undefined ? JSON.stringify(tags) : row.tags,
    patch('lastKnownChapter', lastKnownChapter, row.last_known_chapter),
    patch('folder', d.folder ?? row.folder, row.folder), // folder is never null
    patch('language', d.language, row.language),
    patch('score', d.score, row.score),
    patch('note', d.note, row.note),
    patch('startDate', d.startDate, row.start_date),
    patch('finishDate', d.finishDate, row.finish_date),
    patch('rereads', d.rereads ?? row.rereads, row.rereads),
    patch('seriesStatus', d.seriesStatus, row.series_status),
    row.id
  );
  res.json(toEntry(await db.prepare('SELECT * FROM library WHERE id = ?').get(row.id)));
}));

// "Is this work already in my library?" — asked before adding, so the client
// can offer to migrate the existing entry to the new site instead of ending up
// with the same series twice under two different URLs.
libraryRouter.post('/match', wrap(async (req, res) => {
  const { title, sourceUrl, altTitles } = req.body ?? {};
  if (!title && !sourceUrl) return res.status(400).json({ error: 'title or sourceUrl required' });
  const rows = await db.prepare(
    'SELECT * FROM library WHERE user_id = ? AND deleted = 0'
  ).all(req.user.id);
  const candidate = {
    title,
    sourceUrl,
    altTitles: Array.isArray(altTitles) ? altTitles : [],
  };
  const matches = findMatches(candidate, rows.map(toEntry));
  res.json(matches.map((m) => ({
    confidence: m.confidence,
    score: Number(m.score.toFixed(4)),
    entry: m.entry,
  })));
}));

/**
 * Move a series to a different scan site, keeping everything the user built up
 * around it: progress, score, notes, tags, folder, date added.
 *
 * The destination may already exist as its own entry — that is exactly what
 * happens when someone added the series twice before noticing. UNIQUE
 * (user_id, source_url) means the two rows cannot both survive, so this merges
 * them into the one being migrated and removes the other. Nothing merge-worthy
 * is dropped: the further chapter, the union of tags and whichever fields the
 * kept row left empty all come across first.
 */
libraryRouter.post('/:id/migrate', wrap(async (req, res) => {
  const row = await db.prepare('SELECT * FROM library WHERE id = ? AND user_id = ? AND deleted = 0')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const { sourceUrl, sourceDomain, title, coverUrl, lastKnownChapter, tags,
          chapterUrl, chapterLabel } = req.body ?? {};
  if (!sourceUrl || !sourceDomain) {
    return res.status(400).json({ error: 'sourceUrl, sourceDomain required' });
  }
  if (normUrl(sourceUrl) === normUrl(row.source_url)) {
    return res.status(400).json({ error: 'already the current source' });
  }

  // The row standing on the destination URL, live or previously removed —
  // either way it holds the UNIQUE slot we are about to take.
  const other = await db.prepare(
    'SELECT * FROM library WHERE user_id = ? AND source_url = ? AND id != ?'
  ).get(req.user.id, sourceUrl, row.id);

  const mine = await db.prepare('SELECT * FROM progress WHERE user_id = ? AND library_id = ?')
    .get(req.user.id, row.id);
  const theirs = other
    ? await db.prepare('SELECT * FROM progress WHERE user_id = ? AND library_id = ?')
      .get(req.user.id, other.id)
    : undefined;

  const mergedTags = [...new Set([
    ...parseJson(row.tags, []),
    ...(other ? parseJson(other.tags, []) : []),
    ...(Array.isArray(tags) ? tags : []),
  ])];

  // Prefer what the migrated row already holds; fall back to the row being
  // absorbed, then to whatever the client scraped off the new page.
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? null;

  const history = parseJson(row.previous_sources, []);
  history.push({
    sourceUrl: row.source_url,
    sourceDomain: row.source_domain,
    lastKnownChapter: row.last_known_chapter,
    migratedAt: new Date().toISOString(),
  });

  // Deleting the row that holds the UNIQUE slot and moving this one onto it are
  // one change, not two: between them the absorbed entry no longer exists and
  // nothing has inherited its contents yet. A batch is a transaction, so a
  // failure on the update puts the other row back.
  const statements = [];
  if (other) {
    // Its progress row goes with it (ON DELETE CASCADE), which is why `theirs`
    // was read a few lines up rather than after.
    statements.push({
      sql: 'DELETE FROM library WHERE id = ? AND user_id = ?',
      args: [other.id, req.user.id],
    });
  }

  statements.push({
    sql: `UPDATE library SET source_url = ?, source_domain = ?, previous_sources = ?,
       title = ?, cover_url = ?, tags = ?, last_known_chapter = ?,
       folder = ?, language = ?, score = ?, note = ?, start_date = ?, finish_date = ?,
       rereads = ?, series_status = ?, date_added = ?, deleted = 0,
       updated_at = datetime('now')
     WHERE id = ?`,
    args: [
      sourceUrl,
      sourceDomain,
      JSON.stringify(history),
      pick(title, row.title, other?.title),
      pick(coverUrl, row.cover_url, other?.cover_url),
      JSON.stringify(mergedTags),
      furtherChapter(row.last_known_chapter, other?.last_known_chapter, lastKnownChapter),
      // 'reading' is the default every entry starts at, so it loses to a folder
      // the user actually chose on the row being absorbed.
      row.folder !== 'reading' ? row.folder : (other?.folder ?? row.folder),
      pick(row.language, other?.language),
      pick(row.score, other?.score),
      pick(row.note, other?.note),
      pick(row.start_date, other?.start_date),
      pick(row.finish_date, other?.finish_date),
      Math.max(row.rereads ?? 0, other?.rereads ?? 0),
      pick(row.series_status, other?.series_status),
      // Whichever entry was created first is when this series entered the library.
      other && other.date_added < row.date_added ? other.date_added : row.date_added,
      row.id,
    ],
  });
  await db.batch(statements);

  // Three bookmarks can exist for this series now: the one from the site being
  // left, the one from the destination if it was already in the library, and
  // the page the user is standing on. Keep whichever is furthest along.
  //
  // Only the first has a problem: its chapter_url points into the site being
  // left. The chapter *number* is what has to survive, so the label is kept and
  // the link is aimed at the new series page.
  const candidates = [
    mine && { url: sourceUrl, label: mine.chapter_label, page: mine.page,
              pageCount: mine.page_count, scroll: mine.scroll_pos,
              at: mine.updated_at, live: false },
    theirs && { url: theirs.chapter_url, label: theirs.chapter_label, page: theirs.page,
                pageCount: theirs.page_count, scroll: theirs.scroll_pos,
                at: theirs.updated_at, live: true },
    chapterUrl && { url: chapterUrl, label: chapterLabel ?? null, page: 0,
                    pageCount: null, scroll: 0, at: '9999', live: true },
  ].filter(Boolean);

  const winner = candidates.sort((a, b) =>
    ((chapterNumber(b.label) ?? -1) - (chapterNumber(a.label) ?? -1))
    || (Number(b.live) - Number(a.live))
    || String(b.at).localeCompare(String(a.at)))[0];

  if (winner) {
    await db.prepare(
      `INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, page, page_count, scroll_pos, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, library_id) DO UPDATE SET
         chapter_url = excluded.chapter_url, chapter_label = excluded.chapter_label,
         page = excluded.page, page_count = excluded.page_count,
         scroll_pos = excluded.scroll_pos, updated_at = excluded.updated_at`
    ).run(req.user.id, row.id, winner.url, winner.label,
      winner.page ?? 0, winner.pageCount ?? null, winner.scroll ?? 0);
  }

  const entry = toEntry(await db.prepare('SELECT * FROM library WHERE id = ?').get(row.id));
  res.json({ entry, merged: other ? toEntry(other) : null });
}));

libraryRouter.delete('/:id', wrap(async (req, res) => {
  const info = await db.prepare(
    "UPDATE library SET deleted = 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  ).run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));
