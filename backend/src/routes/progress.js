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
  // The bookmark: the furthest chapter reached (see db.js). A row from before
  // it existed has none, and its own chapter is its bookmark, as it was.
  furthest: row.furthest_url ? {
    chapterUrl: row.furthest_url,
    chapterLabel: row.furthest_label,
    page: row.furthest_page,
    pageCount: row.furthest_page_count,
    at: row.furthest_at,
    movedAt: row.furthest_moved_at ?? null,
  } : null,
});

/** A label as the database keeps it: a string, or nothing. */
const text = (v) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, 500));

/**
 * A page, or a number of them: a whole number from 0, or the default. Labels
 * and addresses were bounded and the numbers were not — page -999 was kept as
 * sent (QA re-test It.5).
 */
const whole = (v, fallback) => {
  const n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : fallback;
};
/** How far down the chapter: never before its start. */
const position = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The chapter number a label (or, failing that, an address) names, or null. */
export function chapterNum(label, url) {
  const m = /(\d+(?:\.\d+)?)/.exec(String(label ?? ''));
  if (m) return parseFloat(m[1]);
  const u = /(?:chapter|chapitre|chap|ch|episode|ep)[-_\s.]*(\d+(?:\.\d+)?)/i.exec(String(url ?? ''));
  return u ? parseFloat(u[1]) : null;
}

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
//
// And the bookmark beside it, merged by its own rule (arbitrage e): the
// furthest of the two, never back — unless the reader moved it by hand. A move
// is a fence: every bookmark set before it is void, whichever device it comes
// from and however far it went. Of what is left, the further chapter wins; a
// chapter with no number on either side has no "further", and the later one
// is kept, which is what every bookmark did before. The client merges by the
// same rule (panelflow-core.js, mergeMarks).
//
// One statement still, so the last position no longer vetoes the whole write:
// a phone sending last week's chapter 12 after the PC reread chapter 9 today
// is older as a position and further as a bookmark, and both are kept.
const NEWER = 'excluded.updated_at >= progress.updated_at';
const FENCE = "MAX(COALESCE(excluded.furthest_moved_at, ''), COALESCE(progress.furthest_moved_at, ''))";
// Which side of the fence a bookmark is on. After it, or carrying it: the move
// itself, and whatever was read on from it, carry the moment of the move. A
// bookmark from the very second of a move and not carrying it is from before
// it — moments are kept to the second, and "at or after" let a move that
// followed a page turn within the second lose to it (re-test It.4).
const LIVE = (side) => `(${side}.furthest_at > ${FENCE} OR COALESCE(${side}.furthest_moved_at, '') = ${FENCE})`;
const TAKE_BOOKMARK = `(
  progress.furthest_url IS NULL
  OR (${LIVE('excluded')}
      AND (NOT ${LIVE('progress')}
           OR CASE WHEN excluded.furthest_num IS NOT NULL AND progress.furthest_num IS NOT NULL
                   THEN excluded.furthest_num > progress.furthest_num
                        OR (excluded.furthest_num = progress.furthest_num AND excluded.furthest_at >= progress.furthest_at)
                   ELSE excluded.furthest_at >= progress.furthest_at END))
)`;
const UPSERT_PROGRESS = `
  INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, page, page_count, scroll_pos, updated_at,
                        furthest_url, furthest_label, furthest_num, furthest_page, furthest_page_count,
                        furthest_at, furthest_moved_at)
  SELECT ?, id, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')),
         ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?
    FROM library WHERE id = ? AND user_id = ?
  ON CONFLICT (user_id, library_id) DO UPDATE SET
    chapter_url = CASE WHEN ${NEWER} THEN excluded.chapter_url ELSE progress.chapter_url END,
    chapter_label = CASE WHEN ${NEWER} THEN excluded.chapter_label ELSE progress.chapter_label END,
    page = CASE WHEN ${NEWER} THEN excluded.page ELSE progress.page END,
    page_count = CASE WHEN ${NEWER} THEN excluded.page_count ELSE progress.page_count END,
    scroll_pos = CASE WHEN ${NEWER} THEN excluded.scroll_pos ELSE progress.scroll_pos END,
    updated_at = MAX(excluded.updated_at, progress.updated_at),
    furthest_url = CASE WHEN ${TAKE_BOOKMARK} THEN excluded.furthest_url ELSE progress.furthest_url END,
    furthest_label = CASE WHEN ${TAKE_BOOKMARK} THEN excluded.furthest_label ELSE progress.furthest_label END,
    furthest_num = CASE WHEN ${TAKE_BOOKMARK} THEN excluded.furthest_num ELSE progress.furthest_num END,
    furthest_page = CASE WHEN ${TAKE_BOOKMARK} THEN excluded.furthest_page ELSE progress.furthest_page END,
    furthest_page_count = CASE WHEN ${TAKE_BOOKMARK} THEN excluded.furthest_page_count ELSE progress.furthest_page_count END,
    furthest_at = CASE WHEN ${TAKE_BOOKMARK} THEN excluded.furthest_at ELSE progress.furthest_at END,
    furthest_moved_at = NULLIF(${FENCE}, '')
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
  // The bookmark this device holds — or, from a client that sends none (every
  // build from before arbitrage e), the chapter it is on, set now. A bookmark
  // moved by hand carries the moment it was moved (`movedAt`).
  const sent = req.body.furthest && typeof req.body.furthest === 'object' && req.body.furthest.chapterUrl
    ? req.body.furthest : null;
  const bad = badUrls(req.body, ['chapterUrl']);
  if (sent) bad.push(...badUrls(sent, ['chapterUrl']).map((field) => `furthest.${field}`));
  if (bad.length) return refuseBadUrls(res, bad);
  const moment = clientMoment(updatedAt);
  const mark = sent ?? { chapterUrl, chapterLabel, page, pageCount };
  const markAt = (sent && clientMoment(sent.at)) ?? moment;
  const movedAt = sent ? clientMoment(sent.movedAt) : null;
  // Deliberately not filtered on `deleted`: a bookmark outlives the entry being
  // removed, and comes back with it when the series is pinned again.
  const row = await db.prepare(UPSERT_PROGRESS).get(
    // Bounded like every other free text the API keeps (F-51): a label is a
    // chapter's name, and a megabyte of one is not.
    req.user.id, String(chapterUrl).slice(0, 2048), text(chapterLabel), whole(page, 0), whole(pageCount, null),
    position(scrollPos), moment,
    String(mark.chapterUrl).slice(0, 2048), text(mark.chapterLabel), chapterNum(mark.chapterLabel, mark.chapterUrl),
    whole(mark.page, null), whole(mark.pageCount, null),
    markAt, movedAt,
    req.params.libraryId, req.user.id,
  );
  // No row: the entry is not this user's.
  if (!row) return res.status(404).json({ error: 'library entry not found' });
  // This position lost to a later one: not an error — the device is told what
  // the account has, and adopts it. The bookmark was merged either way.
  const stale = !!moment && row.updated_at > moment;
  // Tell the connected trackers, before answering rather than after: work that
  // outlives the response is killed with the lambda. It costs one query for the
  // users who have connected nothing, and one request per *chapter* — not per
  // page — for the rest. It cannot throw, and it cannot fail this write. The
  // bookmark is what they are told: a reread of chapter 9 is not progress.
  const trackers = await pushProgress(req.user.id, row.library_id, row.furthest_label ?? chapterLabel);
  res.json({ ...toProgress(row), ...(stale ? { stale: true } : {}), ...(trackers.length ? { trackers } : {}) });
}));
