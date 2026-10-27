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
import { planImport, writePlan } from './import.js';
import { toEntry } from './library.js';
import { chapterNum as markNum, clientMoment } from './progress.js';
import { isHttpUrl } from '../http-url.js';
import { normalizeLanguage } from '../languages.js';
import { listCategories, MAX_CATEGORIES } from './categories.js';
import { nonBlank, webUrl, whole, isoDay } from '../entry-fields.js';
import { MAX_ROW_SECONDS, readDay, readPages } from '../history-fields.js';
import { readBookmark } from '../progress-fields.js';
import { malXmlDate } from '../tracker-fields.js';
import { folderStatus, folderLabel, isCustom, categoryId, folderFor, isBuiltin, cleanName,
  DEFAULT_FOLDER } from '../folders.js';

export const exportRouter = Router();

export const BACKUP_VERSION = 1;

/**
 * A backup's bookmark, as the progress row keeps it — or nothing, when the
 * file has none (one written before arbitrage e) or one that is not an http(s)
 * address: the row's own chapter is then its bookmark, as it always was.
 */
function restoredMark(progress) {
  const f = progress?.furthest;
  if (!f?.chapterUrl || !isHttpUrl(f.chapterUrl)) return [null, null, null, null, null, null, null];
  const moment = (v) => clientMoment(v);
  return [f.chapterUrl, f.chapterLabel ?? null, markNum(f.chapterLabel, f.chapterUrl),
    Number.isInteger(f.page) ? f.page : null, Number.isInteger(f.pageCount) ? f.pageCount : null,
    moment(f.at), moment(f.movedAt)];
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

const parseTags = (raw) => {
  try { const t = JSON.parse(raw); return Array.isArray(t) ? t : []; } catch { return []; }
};

const parseObject = (raw) => {
  try { const o = JSON.parse(raw); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
};

/** The host of a push endpoint: which service it is, without the address that reaches the device. */
const pushService = (endpoint) => { try { return new URL(endpoint).host; } catch { return null; } };

/**
 * Everything else the account holds, for the person it is about (RGPD art. 15
 * and 20): the account itself, its settings, what it is connected to, what the
 * server found for it, and what it removed.
 *
 * The QA pass of September 2026 found the "complete" backup was the shelf
 * alone. This is the rest, in its own key: the restore reads `library` and
 * `categories` and nothing here, so a backup restored into another account
 * never carries this one's e-mail, connections or settings with it.
 *
 * Three things are described rather than copied, because a copy would be a
 * working key in a file people e-mail to themselves: the tracker tokens (the
 * service and the account they open are listed; revoke them from there), the
 * password (a bcrypt hash, useless to its owner) and a push subscription's
 * address and keys (the service is named).
 */
/** An entry as the library route writes it, without the row's internal id. */
const withoutId = ({ id: _id, ...entry }) => entry;

/**
 * A progress row as the backup writes it: where the reader is, and the
 * bookmark — the furthest chapter reached, and when it was last moved back by
 * hand. One shape for a series on the shelf and a removed one: the second
 * used to lose the pages, the scroll and the move (QA re-test It.5, N9).
 */
const progressOut = (p) => ({
  chapterUrl: p.chapter_url,
  chapterLabel: p.chapter_label,
  page: p.page,
  pageCount: p.page_count,
  scrollPos: p.scroll_pos,
  updatedAt: p.updated_at,
  furthest: p.furthest_url ? {
    chapterUrl: p.furthest_url,
    chapterLabel: p.furthest_label,
    page: p.furthest_page,
    pageCount: p.furthest_page_count,
    at: p.furthest_at,
    movedAt: p.furthest_moved_at,
  } : null,
});

async function accountSection(userId) {
  const [user, prefs, trackers, links, news, push, removed, emailChange] = await Promise.all([
    db.prepare('SELECT email, tier, created_at, premium_until FROM users WHERE id = ?').get(userId),
    db.prepare('SELECT data, updated_at FROM prefs WHERE user_id = ?').get(userId),
    db.prepare(`SELECT service, remote_user, expires_at, last_push_at, last_error, last_error_at
                FROM trackers WHERE user_id = ? ORDER BY service`).all(userId),
    db.prepare(`SELECT l.source_url, l.title, t.service, t.remote_id, t.remote_title, t.state,
                       t.last_chapter, t.remote_status, t.updated_at
                FROM tracker_links t JOIN library l ON l.id = t.library_id
                WHERE t.user_id = ? ORDER BY l.title, t.service`).all(userId),
    db.prepare(`SELECT l.source_url, l.title, n.chapter, n.found_at, n.seen
                FROM news n JOIN library l ON l.id = n.library_id
                WHERE n.user_id = ? ORDER BY n.found_at`).all(userId),
    db.prepare('SELECT endpoint, created_at, last_ok FROM push_subs WHERE user_id = ? ORDER BY created_at')
      .all(userId),
    db.prepare(`SELECT l.*,
                       p.chapter_url, p.chapter_label, p.page, p.page_count, p.scroll_pos,
                       p.updated_at AS read_at,
                       p.furthest_url, p.furthest_label, p.furthest_page, p.furthest_page_count,
                       p.furthest_at, p.furthest_moved_at
                FROM library l LEFT JOIN progress p ON p.library_id = l.id AND p.user_id = l.user_id
                WHERE l.user_id = ? AND l.deleted = 1 ORDER BY l.updated_at`).all(userId),
    db.prepare(`SELECT new_email, expires_at FROM email_changes
                WHERE user_id = ? AND used_at IS NULL AND expires_at > datetime('now')`).get(userId),
  ]);
  return {
    email: user?.email ?? null,
    tier: user?.tier ?? null,
    // When Premium stops counting, as the server last heard it from RevenueCat.
    premiumUntil: user?.premium_until ?? null,
    createdAt: user?.created_at ?? null,
    pendingEmailChange: emailChange ? { newEmail: emailChange.new_email, expiresAt: emailChange.expires_at } : null,
    prefs: prefs ? parseObject(prefs.data) : {},
    prefsUpdatedAt: prefs?.updated_at ?? null,
    trackers: trackers.map((t) => ({
      service: t.service,
      remoteUser: t.remote_user,
      expiresAt: t.expires_at,
      lastPushAt: t.last_push_at,
      lastError: t.last_error,
      lastErrorAt: t.last_error_at,
    })),
    trackerLinks: links.map((t) => ({
      title: t.title,
      sourceUrl: t.source_url,
      service: t.service,
      remoteId: t.remote_id,
      remoteTitle: t.remote_title,
      state: t.state,
      lastChapter: t.last_chapter,
      remoteStatus: t.remote_status,
      updatedAt: t.updated_at,
    })),
    newChapters: news.map((n) => ({
      title: n.title, sourceUrl: n.source_url, chapter: n.chapter, foundAt: n.found_at, seen: !!n.seen,
    })),
    pushSubscriptions: push.map((p) => ({
      service: pushService(p.endpoint), createdAt: p.created_at, lastDelivered: p.last_ok,
    })),
    // With everything the server still keeps of them until they are erased:
    // the entry as it was — its note, score, tags and folder come back if the
    // series is added again (QA re-test, September 2026) — the bookmark and
    // the reading history. Article 15 is about all of it.
    removedSeries: await Promise.all(removed.map(async (r) => ({
      ...withoutId(toEntry(r)),
      removedAt: r.updated_at,
      progress: r.chapter_url ? progressOut({ ...r, updated_at: r.read_at }) : null,
      history: (await db.prepare(
        'SELECT chapter_url, chapter_label, day, pages, seconds FROM history WHERE user_id = ? AND library_id = ? ORDER BY day',
      ).all(userId, r.id)).map((h) => ({
        chapterUrl: h.chapter_url, chapterLabel: h.chapter_label, day: h.day, pages: h.pages, seconds: h.seconds,
      })),
    }))),
  };
}

/** The whole account, with each entry carrying its own bookmark and history. */
export async function buildBackup(userId) {
  // Four reads that know nothing about each other, so they wait together rather
  // than in a queue: the last three do not need the first one's answer, and in
  // production each wait is a trip to another country.
  //
  // Removed entries are left out of the shelf: a backup is what the user has,
  // and a restore that resurrects everything they ever deleted is a
  // punishment. They are listed, read-only, under `account.removedSeries`.
  //
  // Categories are carried whole, and the version is not bumped for them: an
  // older PanelFlow reading this file ignores the key and folds every "cat:"
  // folder it does not recognise into reading, which is what those entries
  // meant anyway. Refusing the restore outright would be the more expensive
  // kind of correct.
  const [library, progress, history, categories, account] = await Promise.all([
    db.prepare(
      'SELECT * FROM library WHERE user_id = ? AND deleted = 0 ORDER BY date_added ASC',
    ).all(userId),
    db.prepare('SELECT * FROM progress WHERE user_id = ?').all(userId),
    db.prepare(
      'SELECT * FROM history WHERE user_id = ? ORDER BY day ASC, read_at ASC',
    ).all(userId),
    listCategories(userId),
    accountSection(userId),
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
    account,
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
        language: normalizeLanguage(row.language),
        score: row.score,
        note: row.note,
        startDate: row.start_date,
        finishDate: row.finish_date,
        rereads: row.rereads,
        seriesStatus: row.series_status,
        // Without it a restored anime came back as a manga, the column's
        // default, and a tracker routes on it. Like the categories, it does not
        // bump the version: an older PanelFlow ignores the key and restores
        // every entry as a manga, which is what it would have done anyway.
        medium: row.medium,
        previousSources: parseTags(row.previous_sources),
        dateAdded: row.date_added,
        updatedAt: row.updated_at,
        progress: p ? progressOut(p) : null,
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

/**
 * How far a series was read: its bookmark — the furthest chapter reached —
 * rather than the last chapter opened, which is a reread as often as not
 * (arbitrage e). A backup from before the two were kept apart has only the one.
 */
const markOf = (progress) => (progress?.furthest?.chapterUrl ? progress.furthest : progress);

const chapterNum = (label) => {
  const m = /\d+(?:\.\d+)?/.exec(String(label ?? ''));
  return m ? Math.floor(Number(m[0])) : 0;
};

// MyAnimeList keeps anime and manga on two lists, and an export file is one of
// them: user_export_type 1 is an anime list, 2 a manga list, and this file is
// the second. An anime written into it is an episode count on a manga list: at
// best it is skipped, and by anything that matches on title (see malId) it is
// taken for the manga of the same name and, with update_on_import, written
// over it. So anime are left out, and the download says how many were (see the
// route below). Light novels and webtoons stay: MAL files both on its manga
// list. An entry that names no medium is a manga, as it is everywhere else.
const onMangaList = (e) => e.medium !== 'anime';

/** How many entries of `backup` the MyAnimeList file leaves out, because they are anime. */
export const malLeftOut = (backup) => backup.library.filter((e) => !onMangaList(e)).length;

export function toMalXml(backup) {
  // MAL has five statuses and no notion of a shelf, so a category exports as
  // what it stands for. "Weekly" leaves as Reading, which is the truth about
  // those entries; leaving as nothing would not be.
  const cats = backup.categories ?? [];
  const manga = backup.library.filter(onMangaList);
  const rows = manga.map((e) => [
    '  <manga>',
    `    <manga_mangadb_id>${malId(e.sourceUrl)}</manga_mangadb_id>`,
    `    <manga_title>${cdata(e.title)}</manga_title>`,
    // Progress only, never lastKnownChapter: that is the chapter the *site* is
    // up to, and writing it here tells MAL the user has read it. With
    // update_on_import below, importing this file would then overwrite their
    // real progress on an account we do not own — an entry never opened would
    // arrive as "237 chapters read". No progress exports as 0, which is true.
    `    <my_read_chapters>${chapterNum(markOf(e.progress)?.chapterLabel)}</my_read_chapters>`,
    // A month or a year alone, as MAL's own export writes one: 2024-03-00.
    `    <my_start_date>${malXmlDate(e.startDate)}</my_start_date>`,
    `    <my_finish_date>${malXmlDate(e.finishDate)}</my_finish_date>`,
    // MAL grades in whole numbers: 8.5 (an AniList 85/100) is a 9 there.
    `    <my_score>${e.score > 0 ? Math.min(10, Math.max(1, Math.round(e.score))) : 0}</my_score>`,
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
    `    <user_total_manga>${manga.length}</user_total_manga>`,
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
  ['Chapter read', (e) => markOf(e.progress)?.chapterLabel ?? ''],
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
//
// And a field that a spreadsheet would read as a formula is written as text:
// a title or a note starting with =, +, -, @, a tab or a carriage return is
// run by Excel and LibreOffice when the file is opened (CSV injection, QA
// report F-51). A leading apostrophe is how both are told "this is text"; the
// value itself is unchanged, and a number keeps its sign because only text
// that does not read as a number is touched.
const FORMULA = /^[=+\-@\t\r]/;
const cell = (v) => {
  let text = String(v ?? '');
  if (FORMULA.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

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
 *
 * Planned whole before anything is written, shelves, entries, bookmarks and
 * history alike, and then sent as one plan (import.js, writePlan). Every value
 * is checked on the way in: the file is the reader's, but it may have been
 * edited, cut short or written by something else, and what is stored here is
 * shown on every device and added up on the statistics page.
 */
export async function restoreBackup(userId, data, { dryRun }) {
  if (!data || data.app !== 'panelflow' || !Array.isArray(data.library)) {
    throw httpError(400, 'this does not look like a PanelFlow export');
  }
  if (Number(data.version) > BACKUP_VERSION) {
    throw httpError(400, `this backup was written by a newer PanelFlow (v${data.version})`);
  }

  const shelves = await planShelves(userId, data.categories);

  // A folder naming a shelf this file never described — hand-edited, or written
  // by a version that did not carry them — lands on the default rather than on
  // a category that does not exist.
  const folderOf = (e) => (isCustom(e.folder)
    ? shelves.folderMap.get(categoryId(e.folder)) ?? DEFAULT_FOLDER
    : e.folder ?? DEFAULT_FOLDER);

  // chaptersRead is left at 0 on purpose: the tracker import derives a bookmark
  // from a chapter count, and a backup has the real one — url, page and all —
  // which is added below instead of being reconstructed. The import checks
  // every field here; what is not an object is counted there as skipped.
  const plan = await planImport(userId, data.library.map((e) => (e && typeof e === 'object' ? {
    title: e.title,
    coverUrl: e.coverUrl,
    sourceUrl: e.sourceUrl,
    sourceDomain: e.sourceDomain,
    folder: folderOf(e),
    score: e.score,
    note: e.note,
    startDate: e.startDate,
    finishDate: e.finishDate,
    rereads: e.rereads,
    seriesStatus: e.seriesStatus,
    medium: e.medium,
    language: e.language,
    tags: e.tags,
    lastKnownChapter: e.lastKnownChapter,
    dateAdded: e.dateAdded,
    chaptersRead: 0,
    progress: e.progress,
    history: e.history,
  } : null)));

  // The counting happens for a dry run too; it just never sends the plan.
  let bookmarks = 0;
  let reads = 0;
  for (const group of plan.groups) {
    const bookmark = firstBookmark(group.sources);
    if (bookmark) {
      bookmarks++;
      group.statements.push(bookmarkStatement(userId, group.libraryId, bookmark));
    }
    for (const row of foldHistory(group.sources)) {
      reads++;
      group.statements.push(historyStatement(userId, group.libraryId, row));
    }
  }

  // Shelves first, so that no prefix of the plan files an entry on a shelf the
  // database does not have yet.
  if (!dryRun) {
    await writePlan([...shelves.statements, ...plan.groups.flatMap((g) => g.statements)]);
  }
  return {
    ...plan.report, dryRun: !!dryRun, samples: plan.samples,
    bookmarks, reads, categories: shelves.added,
  };
}

/**
 * The shelves the file describes, matched to this account's by name, and the
 * statements that create the missing ones. Matching by name means restoring
 * into an account that already has a "Weekly" reuses it, instead of leaving
 * the user two shelves to merge by hand. Ids are this account's, never the
 * file's, so `folderMap` turns each id of the file into a folder here.
 */
async function planShelves(userId, fileCats) {
  const folderMap = new Map();
  const statements = [];
  let added = 0;
  if (!Array.isArray(fileCats) || !fileCats.length) return { folderMap, statements, added };

  const mine = await listCategories(userId);
  const byName = new Map(mine.map((c) => [c.name.toLowerCase(), c]));
  let position = mine.reduce((max, c) => Math.max(max, c.position), -1);
  for (const c of fileCats) {
    // A backup's shelf name is text or the shelf is skipped, as one with no
    // name is: cleanName makes "[object Object]" of anything else.
    const name = typeof c?.name === 'string' ? cleanName(c.name) : '';
    if (!c?.id || !name) continue;
    let target = byName.get(name.toLowerCase());
    if (!target) {
      if (byName.size >= MAX_CATEGORIES) continue;  // its entries fall back to the default
      target = {
        id: uid(),
        name,
        status: isBuiltin(c.status) ? c.status : DEFAULT_FOLDER,
        position: ++position,
      };
      // DO NOTHING for the same reason as the entries' own inserts: a shelf of
      // that name created by another request meanwhile is left as it is.
      statements.push({
        sql: `INSERT INTO categories (id, user_id, name, status, position) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (user_id, name) DO NOTHING`,
        args: [target.id, userId, target.name, target.status, target.position],
      });
      byName.set(name.toLowerCase(), target);
      added++;
    }
    folderMap.set(String(c.id), folderFor(target));
  }
  return { folderMap, statements, added };
}

// The first copy of a series that has a bookmark keeps it, as the first
// bookmark written keeps its row below. Each is read by the rules the progress
// route applies to a page turn (../progress-fields.js), so a file cannot carry
// in a bookmark that route would not have stored. The furthest chapter reached
// travels with the position it belongs to (restoredMark).
function firstBookmark(sources) {
  for (const source of sources) {
    const bookmark = readBookmark(source?.progress);
    if (bookmark) return { ...bookmark, mark: restoredMark(source.progress) };
  }
  return null;
}

/**
 * One history row from the file, or null.
 *
 * The day, the time and the pages are held to what POST /api/history accepts,
 * from the same rules (../history-fields.js), plus one a file needs and a live
 * client does not: that the day exists. A row whose day cannot be placed is
 * dropped rather than moved to today as the live route does, because a restore
 * that invents a session today also invents a streak. Seconds stop at what one
 * row can hold, a day; a single value of a trillion was enough to make every
 * average on the statistics page meaningless.
 */
function readHistoryRow(h) {
  const chapterUrl = webUrl(h?.chapterUrl);
  const day = isoDay(readDay(h?.day));
  if (!chapterUrl || !day) return null;
  return {
    chapterUrl,
    day,
    chapterLabel: nonBlank(h.chapterLabel),
    pages: readPages(h.pages),
    seconds: Math.min(MAX_ROW_SECONDS, whole(h.seconds)),
  };
}

/**
 * The history of one series, from every copy of it in the file, as the table
 * keys it: one row per chapter per day. Rows are merged on the larger value, as
 * the statement below merges them with what is stored, so a chapter the file
 * lists twice is counted, and written, once.
 */
function foldHistory(sources) {
  const rows = new Map();
  for (const source of sources) {
    for (const h of Array.isArray(source?.history) ? source.history : []) {
      const row = readHistoryRow(h);
      if (!row) continue;
      const key = `${row.chapterUrl}\n${row.day}`;
      const held = rows.get(key);
      if (!held) {
        rows.set(key, row);
        continue;
      }
      held.pages = Math.max(held.pages, row.pages);
      held.seconds = Math.max(held.seconds, row.seconds);
      held.chapterLabel ??= row.chapterLabel;
    }
  }
  return [...rows.values()];
}

// DO NOTHING, not an update: a bookmark on this account was written by someone
// reading, and this file was written some time before that. INSERT … SELECT so
// the bookmark lands only on a row of this account that exists (see import.js).
const bookmarkStatement = (userId, libraryId, b) => ({
  sql: `
    INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, page,
      page_count, scroll_pos, updated_at,
      furthest_url, furthest_label, furthest_num, furthest_page, furthest_page_count,
      furthest_at, furthest_moved_at)
    SELECT ?, id, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?
    FROM library WHERE id = ? AND user_id = ?
    ON CONFLICT (user_id, library_id) DO NOTHING
  `,
  args: [userId, b.chapterUrl, b.chapterLabel, b.page, b.pageCount, b.scrollPos, b.updatedAt,
    ...b.mark, libraryId, userId],
});

// Merged by the larger value rather than added: restoring the same file twice
// must not double how long the user has read.
const historyStatement = (userId, libraryId, h) => ({
  sql: `
    INSERT INTO history (user_id, library_id, chapter_url, day, chapter_label, pages, seconds)
    SELECT ?, id, ?, ?, ?, ?, ? FROM library WHERE id = ? AND user_id = ?
    ON CONFLICT (user_id, library_id, chapter_url, day) DO UPDATE SET
      pages = MAX(pages, excluded.pages),
      seconds = MAX(seconds, excluded.seconds),
      chapter_label = COALESCE(chapter_label, excluded.chapter_label)
  `,
  args: [userId, h.chapterUrl, h.day, h.chapterLabel, h.pages, h.seconds, libraryId, userId],
});

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

// The anime the file leaves out are counted in a header, the one place a file
// download has room for a number: the body is the file itself, and a client
// that does not read the header gets the same file it always did. Exposed, so a
// page on another origin can read it as well as the one this server serves.
// web/app.js reads it by this name.
const LEFT_OUT_HEADER = 'X-PanelFlow-Anime-Left-Out';

exportRouter.get('/mal', wrap(async (req, res) => {
  const backup = await buildBackup(req.user.id);
  res.set(LEFT_OUT_HEADER, String(malLeftOut(backup)));
  res.set('Access-Control-Expose-Headers', LEFT_OUT_HEADER);
  download(res, 'xml', 'text/xml; charset=utf-8', toMalXml(backup));
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
