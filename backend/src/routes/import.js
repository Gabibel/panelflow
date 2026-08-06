import { Router } from 'express';
import express from 'express';
import { db, uid } from '../db.js';
import { wrap } from '../wrap.js';

export const importRouter = Router();

// AniList and MyAnimeList both have a status per list entry; the folder column
// has five. REPEATING is someone rereading — they are reading it.
const ANILIST_FOLDER = {
  CURRENT: 'reading', REPEATING: 'reading', PLANNING: 'plan',
  COMPLETED: 'completed', DROPPED: 'dropped', PAUSED: 'paused',
};
const MAL_FOLDER = {
  reading: 'reading', completed: 'completed', 'on-hold': 'paused',
  dropped: 'dropped', 'plan to read': 'plan',
};

// MAL writes an unset date as 0000-00-00, which SQLite will happily store and
// no client can render.
const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') && !v.startsWith('0000') ? v : null);
const clampScore = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 10 ? v : null;
};

/* ---------- AniList ---------- */

const ANILIST_QUERY = `
query ($name: String) {
  MediaListCollection(userName: $name, type: MANGA) {
    lists {
      entries {
        status progress score(format: POINT_10)
        startedAt { year month day }
        completedAt { year month day }
        repeat
        media {
          siteUrl status countryOfOrigin
          title { romaji english }
          coverImage { large }
        }
      }
    }
  }
}`;

const anilistDate = (d) =>
  d?.year && d?.month && d?.day
    ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
    : null;

async function fromAniList(username) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let payload;
  try {
    const resp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { name: username } }),
    });
    payload = await resp.json().catch(() => null);
    if (resp.status === 404 || payload?.errors?.some((e) => /not found/i.test(e.message ?? ''))) {
      const err = new Error(`no AniList user named "${username}", or their list is private`);
      err.status = 404;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(`AniList refused the request (${resp.status})`);
      err.status = 502;
      throw err;
    }
  } catch (e) {
    if (e.status) throw e;
    const err = new Error(e.name === 'AbortError' ? 'AniList timed out' : 'could not reach AniList');
    err.status = 504;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const lists = payload?.data?.MediaListCollection?.lists ?? [];
  const out = [];
  for (const list of lists) {
    for (const e of list.entries ?? []) {
      const m = e.media ?? {};
      if (!m.siteUrl) continue;
      out.push({
        title: m.title?.english || m.title?.romaji || 'Untitled',
        coverUrl: m.coverImage?.large ?? null,
        sourceUrl: m.siteUrl,
        sourceDomain: 'anilist.co',
        folder: ANILIST_FOLDER[e.status] ?? 'reading',
        score: clampScore(e.score),
        rereads: Math.max(0, Math.round(Number(e.repeat) || 0)),
        startDate: anilistDate(e.startedAt),
        finishDate: anilistDate(e.completedAt),
        seriesStatus: m.status === 'FINISHED' ? 'completed' : m.status === 'RELEASING' ? 'ongoing' : null,
        language: { JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh' }[m.countryOfOrigin] ?? null,
        chaptersRead: Math.max(0, Math.round(Number(e.progress) || 0)),
      });
    }
  }
  return out;
}

/* ---------- MyAnimeList export ---------- */

// The MAL export is a small, fixed, machine-written XML: <manga> blocks of
// flat <tag>value</tag> pairs, no attributes and no nesting inside them. A
// regex reader is the right size for that, and it keeps the backend
// dependency-free — an XML parser here would be a parser for one file format
// that one site produces.
function fromMalXml(xml) {
  const text = String(xml);
  if (!/<myanimelist/i.test(text)) {
    const err = new Error('this does not look like a MyAnimeList export');
    err.status = 400;
    throw err;
  }
  const unwrap = (v) =>
    v.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
  const field = (block, name) => {
    const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? unwrap(m[1]) : '';
  };

  const out = [];
  for (const [, block] of text.matchAll(/<manga>([\s\S]*?)<\/manga>/gi)) {
    const id = field(block, 'manga_mangadb_id');
    const title = field(block, 'manga_title');
    if (!id || !title) continue;
    const status = field(block, 'my_status').toLowerCase();
    out.push({
      title,
      coverUrl: null,
      sourceUrl: `https://myanimelist.net/manga/${id}`,
      sourceDomain: 'myanimelist.net',
      folder: MAL_FOLDER[status] ?? 'reading',
      score: clampScore(field(block, 'my_score')),
      rereads: Math.max(0, Math.round(Number(field(block, 'my_times_read')) || 0)),
      startDate: cleanDate(field(block, 'my_start_date')),
      finishDate: cleanDate(field(block, 'my_finish_date')),
      seriesStatus: field(block, 'manga_publishing_status').toLowerCase() === 'finished'
        ? 'completed'
        : null,
      language: null,
      chaptersRead: Math.max(0, Math.round(Number(field(block, 'my_read_chapters')) || 0)),
      note: field(block, 'my_comments') || null,
    });
  }
  return out;
}

/* ---------- shared write path ---------- */

/**
 * Adds what is new and fills in blanks on what is not. Never overwrites a value
 * the library already has: the import is the older, coarser copy of the same
 * shelf, and its "reading" is not more current than the folder you moved a
 * series into here yesterday. Returns a report, and writes nothing when
 * `dryRun` — the preview and the run take the same path, so the preview cannot
 * describe something the run will not do.
 */
async function applyImport(userId, entries, { dryRun }) {
  const existing = await db.prepare(
    `SELECT id, source_url, folder, score, note, start_date, finish_date, rereads, deleted,
       cover_url, tags, last_known_chapter FROM library WHERE user_id = ?`
  ).all(userId);
  const bySource = new Map(existing.map((r) => [r.source_url, r]));

  const report = { total: entries.length, added: 0, updated: 0, unchanged: 0, progress: 0, dryRun: !!dryRun };
  const samples = { added: [], updated: [] };

  for (const e of entries) {
    const row = bySource.get(e.sourceUrl);

    if (!row) {
      report.added++;
      if (samples.added.length < 10) samples.added.push(e.title);
      if (!dryRun) {
        const id = uid();
        await db.prepare(
          `INSERT INTO library (id, user_id, title, cover_url, source_domain, source_url, tags,
             folder, language, score, note, start_date, finish_date, rereads, series_status,
             last_known_chapter, date_added)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
        ).run(id, userId, e.title, e.coverUrl, e.sourceDomain, e.sourceUrl,
          JSON.stringify(e.tags ?? []), e.folder,
          e.language, e.score, e.note ?? null, e.startDate, e.finishDate, e.rereads, e.seriesStatus,
          e.lastKnownChapter ?? null, e.dateAdded ?? null);
        // The decision to write progress is taken below for both branches, so
        // the preview and the run cannot disagree about it.
        await writeProgress(userId, id, e);
      }
      if (wantsProgress(e)) report.progress++;
      continue;
    }

    // The import only fills holes, and only holes it can actually fill: an
    // entry missing a score that the export does not have one for either is
    // unchanged, and saying "updated" about it would be a report of nothing.
    // A removed entry is the exception — asking for the list again is asking
    // for all of it, so the import brings it back.
    const fills = row.deleted === 1
      || (row.score === null && e.score !== null)
      || (row.note === null && e.note)
      || (row.start_date === null && e.startDate)
      || (row.finish_date === null && e.finishDate)
      || (e.rereads > (row.rereads ?? 0))
      || (row.cover_url === null && !!e.coverUrl)
      || (row.last_known_chapter === null && !!e.lastKnownChapter)
      || (row.tags === '[]' && (e.tags?.length ?? 0) > 0);
    if (fills) {
      report.updated++;
      if (samples.updated.length < 10) samples.updated.push(e.title);
    } else {
      report.unchanged++;
    }

    if (!dryRun) {
      if (fills) {
        await db.prepare(
          `UPDATE library SET deleted = 0,
             score = COALESCE(score, ?), note = COALESCE(note, ?),
             start_date = COALESCE(start_date, ?), finish_date = COALESCE(finish_date, ?),
             rereads = MAX(rereads, ?), series_status = COALESCE(series_status, ?),
             language = COALESCE(language, ?),
             cover_url = COALESCE(cover_url, ?),
             last_known_chapter = COALESCE(last_known_chapter, ?),
             -- An entry with tags of its own keeps them: the list being
             -- imported is the coarser copy, and merging two vocabularies
             -- produces a shelf nobody chose.
             tags = CASE WHEN tags = '[]' THEN ? ELSE tags END,
             updated_at = datetime('now')
           WHERE id = ?`
        ).run(e.score, e.note ?? null, e.startDate, e.finishDate, e.rereads,
          e.seriesStatus, e.language, e.coverUrl ?? null, e.lastKnownChapter ?? null,
          JSON.stringify(e.tags ?? []), row.id);
      }
      await writeProgress(userId, row.id, e);
    }
    if (wantsProgress(e)) report.progress++;
  }
  return { ...report, samples };
}

// Only for the folders where "you are at chapter N" is a live fact. A finished
// or planned series would otherwise turn up in Continue Reading pointing at a
// tracker page, and an import of 400 entries would bury the shelf.
const wantsProgress = (e) =>
  !!e.chaptersRead && (e.folder === 'reading' || e.folder === 'paused');

// Never overwrites a real progress row — one written by the reader knows the
// page, and the tracker only knows the chapter.
async function writeProgress(userId, libraryId, e) {
  if (!wantsProgress(e)) return;
  await db.prepare(`
    INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, page, updated_at)
    VALUES (?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT (user_id, library_id) DO NOTHING
  `).run(userId, libraryId, e.sourceUrl, `Chapter ${e.chaptersRead}`);
}

/* ---------- routes ---------- */

const dryRun = (req) => req.query.dryRun === '1' || req.query.dryRun === 'true';

importRouter.post('/anilist', wrap(async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  if (!username) return res.status(400).json({ error: 'username required' });
  const entries = await fromAniList(username);
  res.json({ source: 'anilist', ...(await applyImport(req.user.id, entries, { dryRun: dryRun(req) })) });
}));

// text/xml straight off a file input, not wrapped in JSON: a MAL export runs to
// several megabytes and JSON-encoding it doubles that for nothing.
importRouter.post('/mal',
  express.text({ type: ['text/xml', 'application/xml', 'text/plain'], limit: '16mb' }),
  wrap(async (req, res) => {
    const xml = typeof req.body === 'string' ? req.body : req.body?.xml;
    if (!xml) return res.status(400).json({ error: 'post the export XML as the request body' });
    const entries = fromMalXml(xml);
    if (!entries.length) return res.status(400).json({ error: 'no <manga> entries in that export' });
    res.json({ source: 'mal', ...(await applyImport(req.user.id, entries, { dryRun: dryRun(req) })) });
  }));

export { fromMalXml, applyImport };
