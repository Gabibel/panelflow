// Getting the library back out.
//
// Three formats, for three different questions. JSON is the backup: everything
// the account holds — shelf, bookmarks and reading history — in a file this
// same module can read back, because a format nothing can restore is not a
// backup, it is a souvenir. MAL XML is the way out to another service, since
// every tracker worth leaving for reads MyAnimeList's export. CSV is for a
// spreadsheet, and is the one format here that is deliberately lossy.
//
// The JSON shape is written out field by field below rather than borrowed from
// the API's own DTO. It is a file people keep for years; renaming a field in an
// API response should not quietly change what their old backups mean.
import { Router } from 'express';
import express from 'express';
import { db, uid } from '../db.js';
import { wrap } from '../wrap.js';
import { applyImport } from './import.js';
import { listCategories, MAX_CATEGORIES } from './categories.js';
import { folderStatus, folderLabel, isCustom, categoryId, folderFor, isBuiltin, cleanName,
  DEFAULT_FOLDER } from '../folders.js';

export const exportRouter = Router();

export const BACKUP_VERSION = 1;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const parseTags = (raw) => {
  try { const t = JSON.parse(raw); return Array.isArray(t) ? t : []; } catch { return []; }
};

/** The whole account, with each entry carrying its own bookmark and history. */
export async function buildBackup(userId) {
  // Four reads that know nothing about each other, so they wait together rather
  // than in a queue: the last three do not need the first one's answer, and in
  // production each wait is a trip to another country.
  //
  // Removed entries are left out: a backup is what the user has, and a restore
  // that resurrects everything they ever deleted is a punishment.
  //
  // Categories are carried whole, and the version is not bumped for them: an
  // older PanelFlow reading this file ignores the key and folds every "cat:"
  // folder it does not recognise into reading, which is what those entries
  // meant anyway. Refusing the restore outright would be the more expensive
  // kind of correct.
  const [library, progress, history, categories] = await Promise.all([
    db.prepare(
      'SELECT * FROM library WHERE user_id = ? AND deleted = 0 ORDER BY date_added ASC',
    ).all(userId),
    db.prepare('SELECT * FROM progress WHERE user_id = ?').all(userId),
    db.prepare(
      'SELECT * FROM history WHERE user_id = ? ORDER BY day ASC, read_at ASC',
    ).all(userId),
    listCategories(userId),
  ]);

  const bookmark = new Map(progress.map((p) => [p.library_id, p]));
  const reads = new Map();
  for (const h of history) {
    if (!reads.has(h.library_id)) reads.set(h.library_id, []);
    reads.get(h.library_id).push({
      chapterUrl: h.chapter_url,
      chapterLabel: h.chapter_label,
      day: h.day,
      pages: h.pages,
      seconds: h.seconds,
    });
  }

  return {
    app: 'panelflow',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    categories,
    library: library.map((row) => {
      const p = bookmark.get(row.id);
      return {
        title: row.title,
        coverUrl: row.cover_url,
        sourceDomain: row.source_domain,
        sourceUrl: row.source_url,
        tags: parseTags(row.tags),
        folder: row.folder,
        lastKnownChapter: row.last_known_chapter,
        language: row.language,
        score: row.score,
        note: row.note,
        startDate: row.start_date,
        finishDate: row.finish_date,
        rereads: row.rereads,
        seriesStatus: row.series_status,
        previousSources: parseTags(row.previous_sources),
        dateAdded: row.date_added,
        updatedAt: row.updated_at,
        progress: p ? {
          chapterUrl: p.chapter_url,
          chapterLabel: p.chapter_label,
          page: p.page,
          pageCount: p.page_count,
          scrollPos: p.scroll_pos,
          updatedAt: p.updated_at,
        } : null,
        history: reads.get(row.id) ?? [],
      };
    }),
  };
}

// --- MyAnimeList XML --------------------------------------------------------

const MAL_STATUS = {
  reading: 'Reading', completed: 'Completed', paused: 'On-Hold',
  dropped: 'Dropped', plan: 'Plan to Read',
};

// CDATA rather than entity escaping, which is what MAL itself writes — and it
// is the only thing that makes a title containing ]]> worth thinking about.
const cdata = (v) => `<![CDATA[${String(v ?? '').replace(/]]>/g, ']]&gt;')}]]>`;

// MAL matches an imported row on its own database id, so an entry that came
// from MAL can go home and one that came from a scan site cannot. Writing 0 —
// which is what MAL's own exporter does for a deleted work — keeps the entry in
// the file, readable by us and by anything that matches on title.
const malId = (url) => (/^https?:\/\/(www\.)?myanimelist\.net\/manga\/(\d+)/i.exec(url ?? '') || [])[2] ?? '0';

const chapterNum = (label) => {
  const m = /\d+(?:\.\d+)?/.exec(String(label ?? ''));
  return m ? Math.floor(Number(m[0])) : 0;
};

export function toMalXml(backup) {
  // MAL has five statuses and no notion of a shelf, so a category exports as
  // what it stands for. "Weekly" leaves as Reading, which is the truth about
  // those entries; leaving as nothing would not be.
  const cats = backup.categories ?? [];
  const rows = backup.library.map((e) => [
    '  <manga>',
    `    <manga_mangadb_id>${malId(e.sourceUrl)}</manga_mangadb_id>`,
    `    <manga_title>${cdata(e.title)}</manga_title>`,
    // Progress only, never lastKnownChapter: that is the chapter the *site* is
    // up to, and writing it here tells MAL the user has read it. With
    // update_on_import below, importing this file would then overwrite their
    // real progress on an account we do not own — an entry never opened would
    // arrive as "237 chapters read". No progress exports as 0, which is true.
    `    <my_read_chapters>${chapterNum(e.progress?.chapterLabel)}</my_read_chapters>`,
    `    <my_start_date>${e.startDate ?? '0000-00-00'}</my_start_date>`,
    `    <my_finish_date>${e.finishDate ?? '0000-00-00'}</my_finish_date>`,
    `    <my_score>${e.score ?? 0}</my_score>`,
    `    <my_status>${MAL_STATUS[folderStatus(e.folder, cats)] ?? 'Reading'}</my_status>`,
    `    <my_times_read>${e.rereads ?? 0}</my_times_read>`,
    `    <my_comments>${cdata(e.note ?? '')}</my_comments>`,
    // Without this MAL keeps whatever it already had and the file is a no-op.
    '    <update_on_import>1</update_on_import>',
    '  </manga>',
  ].join('\n'));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<myanimelist>',
    '  <myinfo>',
    '    <user_export_type>2</user_export_type>',
    `    <user_total_manga>${backup.library.length}</user_total_manga>`,
    '  </myinfo>',
    ...rows,
    '</myanimelist>',
    '',
  ].join('\n');
}

// --- CSV --------------------------------------------------------------------

// Status is the built-in one, so a spreadsheet can group on a column with five
// values; the shelf the user actually chose gets a column of its own rather
// than being folded into that one or lost.
const CSV_COLUMNS = [
  ['Title', (e) => e.title],
  ['Status', (e, cats) => folderStatus(e.folder, cats)],
  ['Shelf', (e, cats) => (isCustom(e.folder) ? folderLabel(e.folder, cats) : '')],
  ['Chapter read', (e) => e.progress?.chapterLabel ?? ''],
  ['Latest chapter', (e) => e.lastKnownChapter ?? ''],
  ['Score', (e) => e.score ?? ''],
  ['Tags', (e) => e.tags.join(' ')],
  ['Language', (e) => e.language ?? ''],
  ['Rereads', (e) => e.rereads ?? 0],
  ['Started', (e) => e.startDate ?? ''],
  ['Finished', (e) => e.finishDate ?? ''],
  ['Site', (e) => e.sourceDomain],
  ['URL', (e) => e.sourceUrl],
  ['Note', (e) => e.note ?? ''],
  ['Added', (e) => e.dateAdded],
];

// Every field quoted, always. A note is free text and a title routinely holds a
// comma; the rule with no exceptions is the one that cannot be got wrong.
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function toCsv(backup) {
  const cats = backup.categories ?? [];
  const lines = [CSV_COLUMNS.map(([name]) => cell(name)).join(',')];
  for (const e of backup.library) {
    lines.push(CSV_COLUMNS.map(([, get]) => cell(get(e, cats))).join(','));
  }
  // CRLF and a BOM: Excel opens a plain UTF-8 CSV as Latin-1 and turns every
  // accent in a French note into mojibake.
  return `﻿${lines.join('\r\n')}\r\n`;
}

// --- reading a backup back in -----------------------------------------------

/**
 * Restore, with the same rule the tracker imports use: fill what is missing,
 * overwrite nothing. A backup restored into a live library must not undo the
 * afternoon's work, and restored into an empty one it fills everything, which
 * is the case that actually matters.
 */
export async function restoreBackup(userId, data, { dryRun }) {
  if (!data || data.app !== 'panelflow' || !Array.isArray(data.library)) {
    throw httpError(400, 'this does not look like a PanelFlow export');
  }
  if (Number(data.version) > BACKUP_VERSION) {
    throw httpError(400, `this backup was written by a newer PanelFlow (v${data.version})`);
  }

  // Shelves come back before the entries that stand on them, and they are
  // matched by name: restoring into an account that already has a "Weekly"
  // reuses it instead of leaving the user two shelves to merge by hand. Ids are
  // this account's, never the file's, so every custom folder is remapped below.
  const fileCats = Array.isArray(data.categories) ? data.categories : [];
  const folderMap = new Map();
  let addedCategories = 0;
  if (fileCats.length) {
    const mine = await listCategories(userId);
    const byName = new Map(mine.map((c) => [c.name.toLowerCase(), c]));
    let position = mine.reduce((max, c) => Math.max(max, c.position), -1);
    for (const c of fileCats) {
      const name = cleanName(c?.name);
      if (!c?.id || !name) continue;
      let target = byName.get(name.toLowerCase());
      if (!target) {
        if (byName.size >= MAX_CATEGORIES) continue;  // entries fall back below
        target = {
          id: uid(),
          name,
          status: isBuiltin(c.status) ? c.status : DEFAULT_FOLDER,
          position: ++position,
        };
        if (!dryRun) {
          await db.prepare(
            'INSERT INTO categories (id, user_id, name, status, position) VALUES (?, ?, ?, ?, ?)',
          ).run(target.id, userId, target.name, target.status, target.position);
        }
        byName.set(name.toLowerCase(), target);
        addedCategories++;
      }
      folderMap.set(c.id, folderFor(target));
    }
  }

  // A folder naming a shelf this file never described — hand-edited, or written
  // by a version that did not carry them — lands on the default rather than on
  // a category that does not exist.
  const folderOf = (e) => (isCustom(e.folder)
    ? folderMap.get(categoryId(e.folder)) ?? DEFAULT_FOLDER
    : e.folder ?? DEFAULT_FOLDER);

  const entries = data.library.filter((e) => e && e.title && e.sourceUrl && e.sourceDomain);
  // chaptersRead is left at 0 on purpose: the tracker import derives a bookmark
  // from a chapter count, and a backup has the real one — url, page and all —
  // which is written below instead of being reconstructed.
  const report = await applyImport(userId, entries.map((e) => ({
    title: e.title,
    coverUrl: e.coverUrl ?? null,
    sourceUrl: e.sourceUrl,
    sourceDomain: e.sourceDomain,
    folder: folderOf(e),
    score: e.score ?? null,
    note: e.note ?? null,
    startDate: e.startDate ?? null,
    finishDate: e.finishDate ?? null,
    rereads: e.rereads ?? 0,
    seriesStatus: e.seriesStatus ?? null,
    language: e.language ?? null,
    tags: Array.isArray(e.tags) ? e.tags : [],
    lastKnownChapter: e.lastKnownChapter ?? null,
    dateAdded: e.dateAdded ?? null,
    chaptersRead: 0,
  })), { dryRun });

  const rows = await db.prepare('SELECT id, source_url FROM library WHERE user_id = ?').all(userId);
  const idOf = new Map(rows.map((r) => [r.source_url, r.id]));

  let bookmarks = 0;
  let reads = 0;
  // Collected, then sent in batches rather than one statement at a time. This
  // is the largest write the API accepts and it was also the slowest possible
  // shape for it: a year of reading is thousands of history rows, and each one
  // was its own round trip to a database in another building. The counting
  // still happens for a dry run — it just produces no statements.
  const writes = [];
  for (const e of entries) {
    const libraryId = idOf.get(e.sourceUrl);
    if (e.progress?.chapterUrl) {
      bookmarks++;
      // DO NOTHING, not an update: a bookmark on this account was written by
      // someone reading, and this file was written some time before that.
      if (!dryRun && libraryId) {
        writes.push({
          sql: `
            INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, page,
              page_count, scroll_pos, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
            ON CONFLICT (user_id, library_id) DO NOTHING
          `,
          args: [userId, libraryId, e.progress.chapterUrl, e.progress.chapterLabel ?? null,
            e.progress.page ?? 0, e.progress.pageCount ?? null, e.progress.scrollPos ?? 0,
            e.progress.updatedAt ?? null],
        });
      }
    }
    for (const h of Array.isArray(e.history) ? e.history : []) {
      if (!h?.chapterUrl || !h?.day) continue;
      reads++;
      // Merged by the larger value rather than added: restoring the same file
      // twice must not double how long the user has read.
      if (!dryRun && libraryId) {
        writes.push({
          sql: `
            INSERT INTO history (user_id, library_id, chapter_url, day, chapter_label, pages, seconds)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id, library_id, chapter_url, day) DO UPDATE SET
              pages = MAX(pages, excluded.pages),
              seconds = MAX(seconds, excluded.seconds),
              chapter_label = COALESCE(chapter_label, excluded.chapter_label)
          `,
          args: [userId, libraryId, h.chapterUrl, h.day, h.chapterLabel ?? null,
            Math.max(0, Math.round(Number(h.pages) || 0)),
            Math.max(0, Math.round(Number(h.seconds) || 0))],
        });
      }
    }
  }
  await inBatches(writes);
  return { ...report, bookmarks, reads, categories: addedCategories };
}

// One request per chunk instead of one per row. Chunked rather than sent whole
// because a batch travels as a single request and a full restore would be tens
// of thousands of statements in it. Each chunk is still a transaction of its
// own, so a chunk that fails leaves the ones before it standing — the same
// partial-restore outcome the row-at-a-time loop had, reached in far fewer
// trips.
const BATCH_SIZE = 200;

async function inBatches(statements) {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

// --- routes -----------------------------------------------------------------

// A filename with the date in it, because the second copy of a backup is the
// one that makes the first one useful.
const filename = (ext) => `panelflow-${new Date().toISOString().slice(0, 10)}.${ext}`;

const download = (res, ext, type, body) => {
  res.set('Content-Type', type);
  res.set('Content-Disposition', `attachment; filename="${filename(ext)}"`);
  res.send(body);
};

exportRouter.get('/', wrap(async (req, res) => {
  const backup = await buildBackup(req.user.id);
  // Indented: a backup is something people open and read when they are trying
  // to work out what they lost.
  download(res, 'json', 'application/json; charset=utf-8', JSON.stringify(backup, null, 2));
}));

exportRouter.get('/mal', wrap(async (req, res) => {
  download(res, 'xml', 'text/xml; charset=utf-8', toMalXml(await buildBackup(req.user.id)));
}));

exportRouter.get('/csv', wrap(async (req, res) => {
  download(res, 'csv', 'text/csv; charset=utf-8', toCsv(await buildBackup(req.user.id)));
}));

// The restore, mounted at /api/import/panelflow — where the other list imports
// are, and where someone holding a file is going to look for it.
//
// It carries its own JSON parser because it is mounted ahead of the app-wide
// one: a backup of a large library, history and all, is the single biggest
// thing this API accepts, and the 1 MB shared limit would refuse it before any
// of this ran.
export const restoreRoute = [
  express.json({ limit: '32mb' }),
  wrap(async (req, res) => {
    const dry = req.query.dryRun === '1' || req.query.dryRun === 'true';
    res.json({ source: 'panelflow', ...(await restoreBackup(req.user.id, req.body, { dryRun: dry })) });
  }),
];
