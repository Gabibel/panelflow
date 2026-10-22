import { Router } from 'express';
import express from 'express';
import { db, uid } from '../db.js';
import { wrap } from '../wrap.js';
import { WATCHED, DEFAULT_FOLDER, folderStatus, isFolder } from '../folders.js';
import { normUrl } from '../series-match.js';
import { DEFAULT_MEDIUM, normalizeMedium } from '../panelflow-core.js';
import { freshToken, whoami } from '../tracker-oauth.js';
import {
  ANILIST_FOLDER, malFolder, cleanDate, clampScore, anilistDate, anilistScore,
} from '../tracker-fields.js';
import { nonBlank, webUrl, whole, inRange, readingDay, timestamp, chapterText } from '../entry-fields.js';
import { cleanScore } from '../prefs.js';
import { rememberScoreFormat } from './prefs.js';
import { anilistScoreFormat } from '../tracker-push.js';
import { listCategories } from './categories.js';
import { normalizeLanguage } from '../languages.js';

export const importRouter = Router();

// AniList and MyAnimeList both have a status per list entry; the folder column
// has five. The tables that reconcile them live in ../tracker-fields.js,
// because the library sheet now asks the same question about one series and
// the two answers have to be the same answer.

/* ---------- AniList ---------- */

const ANILIST_QUERY = `
query ($name: String) {
  MediaListCollection(userName: $name, type: MANGA) {
    lists {
      entries {
        status progress score(format: POINT_100)
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

/**
 * `token` is optional and only ever helps: the same query against the same
 * username, signed, also returns the lists a private profile hides. Importing
 * by name stays possible for a reader who has connected nothing.
 */
async function fromAniList(username, token = null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let payload;
  try {
    const resp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
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
        score: anilistScore(e.score),
        rereads: Math.max(0, Math.round(Number(e.repeat) || 0)),
        startDate: anilistDate(e.startedAt),
        finishDate: anilistDate(e.completedAt),
        seriesStatus: m.status === 'FINISHED' ? 'completed' : m.status === 'RELEASING' ? 'ongoing' : null,
        // The stored spelling (languages.js), not a code the clients would
        // show as it is.
        language: { JP: 'Japanese', KR: 'Korean', CN: 'Chinese (Simplified)', TW: 'Chinese (Traditional)' }[m.countryOfOrigin] ?? null,
        chaptersRead: Math.max(0, Math.round(Number(e.progress) || 0)),
      });
    }
  }
  return out;
}

/* ---------- MyAnimeList, from the connected account ---------- */

// The same shelf the XML export describes, read live. `sourceUrl` is built the
// same way as the XML reader builds it — the two paths must produce the same
// key or importing by file after importing by account duplicates the library.
const MAL_LIST = 'https://api.myanimelist.net/v2/users/@me/mangalist'
  + '?fields=list_status{status,score,num_chapters_read,num_times_reread,start_date,finish_date},'
  + 'main_picture,status&limit=100&nsfw=true';

async function fromMalApi(token) {
  const out = [];
  let url = MAL_LIST;
  // Paged, and bounded: MAL hands back a `next` link and a runaway loop here
  // would be a loop against someone else's API. 100 pages is 10 000 series.
  for (let page = 0; url && page < 100; page++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let payload;
    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (resp.status === 401) {
        const err = new Error('the connection to MyAnimeList has expired: connect it again');
        err.status = 401;
        throw err;
      }
      if (!resp.ok) {
        const err = new Error(`MyAnimeList refused the request (${resp.status})`);
        err.status = 502;
        throw err;
      }
      payload = await resp.json();
    } catch (e) {
      if (e.status) throw e;
      const err = new Error(e.name === 'AbortError' ? 'MyAnimeList timed out' : 'could not reach MyAnimeList');
      err.status = 504;
      throw err;
    } finally {
      clearTimeout(timer);
    }

    for (const item of payload?.data ?? []) {
      const node = item?.node ?? {};
      const st = item?.list_status ?? {};
      if (!node.id || !node.title) continue;
      out.push({
        title: node.title,
        coverUrl: node.main_picture?.large || node.main_picture?.medium || null,
        sourceUrl: `https://myanimelist.net/manga/${node.id}`,
        sourceDomain: 'myanimelist.net',
        folder: malFolder(st.status),
        score: clampScore(st.score),
        rereads: Math.max(0, Math.round(Number(st.num_times_reread) || 0)),
        startDate: cleanDate(st.start_date),
        finishDate: cleanDate(st.finish_date),
        seriesStatus: node.status === 'finished' ? 'completed'
          : node.status === 'currently_publishing' ? 'ongoing' : null,
        language: null,
        chaptersRead: Math.max(0, Math.round(Number(st.num_chapters_read) || 0)),
      });
    }
    url = payload?.paging?.next || null;
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
  if (isCutOff(text)) {
    const err = new Error('this MyAnimeList export is cut off before its end, so nothing was '
      + 'imported: export your list again and import the new file');
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
      sourceUrl: malPage(id),
      sourceDomain: 'myanimelist.net',
      folder: malFolder(status),
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

/**
 * Whether the export stops before its end.
 *
 * A file cut off on its way here (a download that stopped, a disk that filled
 * up) still reads: every <manga> block before the cut is whole, and importing
 * those while saying nothing leaves the reader believing they have their list
 * back. MyAnimeList closes every block it opens and ends the file with
 * </myanimelist>, so a file that does not is refused whole. CDATA is set aside
 * first: a comment is free text and may well contain either tag.
 */
function isCutOff(xml) {
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const opened = markup.match(/<manga>/gi)?.length ?? 0;
  const closed = markup.match(/<\/manga>/gi)?.length ?? 0;
  return opened !== closed || !/<\/myanimelist\s*>/i.test(markup);
}

// MyAnimeList's exporter writes 0 for a work it has since deleted, and our own
// MAL export writes 0 for a series that came from a scan site. Neither has a
// page to point at, and giving them all the same one would fold every one of
// them into a single row. They are read, and the import then skips them as
// entries with no address.
const malPage = (id) => (/^[1-9]\d*$/.test(id) ? `https://myanimelist.net/manga/${id}` : null);

/* ---------- what an imported value may be ---------- */

// Everything below arrives from somewhere else: a service, an export a reader
// kept for years, a file edited by hand. The library keeps it for good and
// every client renders it, so each field is checked here, once, on the one road
// all three sources share. A value that fails is dropped to what the field
// holds when nothing is known, and the series around it still comes in: one
// impossible date is not a reason to lose the score next to it. What a date, a
// score or an address may be is decided in ../entry-fields.js, which the
// library's own routes ask too, so what is dropped here cannot go in through
// the form instead.

/**
 * The entry as the import may use it, or null when there is nothing to import:
 * no title, no site, or no address a client could open.
 */
function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const title = nonBlank(e.title);
  const sourceUrl = webUrl(e.sourceUrl);
  const sourceDomain = nonBlank(e.sourceDomain);
  if (!title || !sourceUrl || !sourceDomain) return null;
  return {
    title,
    sourceUrl,
    sourceDomain,
    coverUrl: webUrl(e.coverUrl),
    folder: isFolder(e.folder) ? e.folder : DEFAULT_FOLDER,
    score: cleanScore(e.score),
    rereads: inRange(e.rereads, 0, 9999) ?? 0,
    note: nonBlank(e.note),
    startDate: readingDay(e.startDate),
    finishDate: readingDay(e.finishDate),
    seriesStatus: e.seriesStatus === 'ongoing' || e.seriesStatus === 'completed' ? e.seriesStatus : null,
    // The list the library route holds a client to. A file that names none is
    // from before there was a choice, and every series was a manga then; one
    // that names a medium nobody knows is read the same way, as the shared core
    // reads it on a device, rather than costing the series.
    medium: normalizeMedium(e.medium) ?? DEFAULT_MEDIUM,
    // The stored spelling (languages.js): "ja" and "Japanese" are one language.
    language: normalizeLanguage(nonBlank(e.language)),
    tags: Array.isArray(e.tags) ? e.tags.filter((t) => nonBlank(t) !== null) : [],
    lastKnownChapter: chapterText(e.lastKnownChapter),
    dateAdded: timestamp(e.dateAdded),
    chaptersRead: whole(e.chaptersRead),
  };
}

/* ---------- one row per series ---------- */

/**
 * Which series a page address names, for matching only: what is stored is the
 * address as it was given. Case and a trailing slash do not make a second page
 * (normUrl, the rule the extension and /api/library/match already apply), and
 * neither does an anchor such as #comments. A fragment that is a route
 * (#/manga/12, #!/manga/12) is kept: on a site that navigates by hash it is the
 * only part of the address that names the series.
 */
const sourceKey = (url) => normUrl(String(url).replace(/#(?![!/]).*$/, ''));

/**
 * The entries as series: one per address, in the order the file gave them.
 *
 * One file can name the same series twice. AniList returns an entry once for
 * every list it is on, and an export edited by hand repeats lines. Inserting
 * the second copy is what used to break an import halfway through, after the
 * preview had counted both. So copies are folded together before anything is
 * decided, by the rule the import applies to the library itself (see fillBlanks
 * below): the first one wins and the later ones only fill its blanks, which is
 * what importing the first copy and then the second would have done.
 */
function foldEntries(entries) {
  const series = new Map();
  let duplicates = 0;
  let skipped = 0;
  for (const raw of entries) {
    const entry = cleanEntry(raw);
    if (!entry) { skipped++; continue; }
    const key = sourceKey(entry.sourceUrl);
    const held = series.get(key);
    if (!held) {
      series.set(key, { key, entry, sources: [raw] });
      continue;
    }
    fillBlanks(held.entry, entry);
    held.sources.push(raw);
    duplicates++;
  }
  return { series: [...series.values()], duplicates, skipped };
}

// fillEntry's rule, applied in memory between two copies of one series. Title,
// folder, medium and date added stay the first copy's, as the library's own would.
const FILLED = ['score', 'note', 'startDate', 'finishDate', 'seriesStatus', 'language',
  'coverUrl', 'lastKnownChapter', 'dateAdded'];

function fillBlanks(kept, later) {
  for (const key of FILLED) kept[key] ??= later[key];
  kept.rereads = Math.max(kept.rereads, later.rereads);
  if (!kept.tags.length) kept.tags = later.tags;
  // A bookmark is written only where there is none, so the same goes for the
  // chapter count it would be written from.
  if (!kept.chaptersRead) kept.chaptersRead = later.chaptersRead;
}

/**
 * The library by series. A library that already holds one series under two
 * addresses (both written before matching was normalised) has the import fill
 * the live copy rather than bring the removed one back next to it.
 */
function libraryBySeries(rows) {
  const bySeries = new Map();
  for (const row of rows) {
    const key = sourceKey(row.source_url);
    const held = bySeries.get(key);
    if (!held || (held.deleted === 1 && row.deleted !== 1)) bySeries.set(key, row);
  }
  return bySeries;
}

/* ---------- shared write path ---------- */

/**
 * Everything an import would do, decided before any of it is done.
 *
 * Adds what is new and fills in blanks on what is not. Never overwrites a value
 * the library already has: the import is the older, coarser copy of the same
 * shelf, and its "reading" is not more current than the folder you moved a
 * series into here yesterday.
 *
 * Writes nothing. The preview is this plan and the run is this plan sent, so
 * the preview cannot describe something the run will not do. Returns the
 * report, and one group per series: the library row it lands on, the entries
 * of the file that named it, and the statements that put it there. A restore
 * adds to those the bookmark and history its entries carry.
 */
export async function planImport(userId, entries) {
  const { series, duplicates, skipped } = foldEntries(entries);
  // Two reads that know nothing about each other, so they wait together. The
  // categories are only there so a folder naming a custom shelf can be asked
  // what status it stands for — see wantsProgress.
  const [existing, categories] = await Promise.all([
    db.prepare(
      `SELECT id, source_url, score, note, start_date, finish_date, rereads, deleted,
         cover_url, tags, last_known_chapter FROM library WHERE user_id = ?`
    ).all(userId),
    listCategories(userId),
  ]);
  const bySeries = libraryBySeries(existing);

  const report = {
    total: series.length, added: 0, updated: 0, unchanged: 0, progress: 0, duplicates, skipped,
  };
  const samples = { added: [], updated: [] };
  const groups = [];

  for (const { key, entry: e, sources } of series) {
    const row = bySeries.get(key);
    const libraryId = row ? row.id : uid();
    const statements = [];

    if (!row) {
      report.added++;
      if (samples.added.length < 10) samples.added.push(e.title);
      statements.push(insertEntry(userId, libraryId, e));
    } else if (fillsBlanks(row, e)) {
      report.updated++;
      if (samples.updated.length < 10) samples.updated.push(e.title);
      statements.push(fillEntry(userId, libraryId, e));
    } else {
      report.unchanged++;
    }

    // Decided once for both branches, so the preview and the run cannot
    // disagree about it. The bookmark opens the address the library holds,
    // which for a series already here may be written differently from the file's.
    if (wantsProgress(e, categories)) {
      report.progress++;
      statements.push(bookmarkFromCount(userId, libraryId, row?.source_url ?? e.sourceUrl, e.chaptersRead));
    }
    groups.push({ libraryId, sources, statements });
  }
  return { report, samples, groups };
}

/**
 * Plans an import and, unless it is a dry run, sends the plan. The report is
 * the same either way.
 */
async function applyImport(userId, entries, { dryRun }) {
  const { report, samples, groups } = await planImport(userId, entries);
  if (!dryRun) await writePlan(groups.flatMap((g) => g.statements));
  return { ...report, dryRun: !!dryRun, samples };
}

// The import only fills holes, and only holes it can actually fill: an entry
// missing a score that the export does not have one for either is unchanged,
// and saying "updated" about it would be a report of nothing. A removed entry
// is the exception — asking for the list again is asking for all of it, so the
// import brings it back.
const fillsBlanks = (row, e) => row.deleted === 1
  || (row.score === null && e.score !== null)
  || (row.note === null && !!e.note)
  || (row.start_date === null && !!e.startDate)
  || (row.finish_date === null && !!e.finishDate)
  || (e.rereads > (row.rereads ?? 0))
  || (row.cover_url === null && !!e.coverUrl)
  || (row.last_known_chapter === null && !!e.lastKnownChapter)
  || (row.tags === '[]' && e.tags.length > 0);

// A series new to the library. ON CONFLICT is for the one thing a plan cannot
// see: another request adding the same address while a long import is being
// written. The row that got there first is the newer one, and it stays as is.
const insertEntry = (userId, id, e) => ({
  sql: `INSERT INTO library (id, user_id, title, cover_url, source_domain, source_url, tags,
          folder, language, score, note, start_date, finish_date, rereads, series_status,
          medium, last_known_chapter, date_added)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
        ON CONFLICT (user_id, source_url) DO NOTHING`,
  args: [id, userId, e.title, e.coverUrl, e.sourceDomain, e.sourceUrl, JSON.stringify(e.tags),
    e.folder, e.language, e.score, e.note, e.startDate, e.finishDate, e.rereads, e.seriesStatus,
    e.medium, e.lastKnownChapter, e.dateAdded],
});

// The blanks of a series already here, filled. COALESCE rather than the values
// the plan read, so whatever the reader set since that read still wins. The
// medium is not among them: a row always has one, and it is never changed after
// the series was added (see db.js), so the library's own answer stands.
const fillEntry = (userId, id, e) => ({
  sql: `UPDATE library SET deleted = 0,
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
        WHERE id = ? AND user_id = ?`,
  args: [e.score, e.note, e.startDate, e.finishDate, e.rereads, e.seriesStatus, e.language,
    e.coverUrl, e.lastKnownChapter, JSON.stringify(e.tags), id, userId],
});

// Only for the folders where "you are at chapter N" is a live fact. A finished
// or planned series would otherwise turn up in Continue Reading pointing at a
// tracker page, and an import of 400 entries would bury the shelf.
//
// Asked of the status, not the folder: an entry arriving on a custom shelf —
// which is what a restored backup carries — still counts if that shelf stands
// for reading.
const wantsProgress = (e, categories) =>
  !!e.chaptersRead && WATCHED.includes(folderStatus(e.folder, categories));

// Never overwrites a real progress row — one written by the reader knows the
// page, and the tracker only knows the chapter. INSERT … SELECT, the way the
// progress route writes: the bookmark lands only on a row of this account that
// exists, so a series another request got to first costs its bookmark rather
// than failing the whole import.
const bookmarkFromCount = (userId, libraryId, seriesUrl, chaptersRead) => ({
  sql: `INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, page, updated_at)
        SELECT ?, id, ?, ?, 0, datetime('now') FROM library WHERE id = ? AND user_id = ?
        ON CONFLICT (user_id, library_id) DO NOTHING`,
  args: [userId, seriesUrl, `Chapter ${chaptersRead}`, libraryId, userId],
});

/* ---------- sending a plan ---------- */

// How many statements travel together. Each chunk is one transaction and one
// request to the database, and a few tens of milliseconds on a local file.
const CHUNK = 200;

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Sends a plan to the database.
 *
 * A plan that fits in one chunk, which is most imports, is one transaction: it
 * lands whole or not at all. A bigger one goes a chunk at a time, and the event
 * loop gets a turn between chunks. The local driver runs every statement
 * synchronously, so five thousand of them back to back held every other
 * request, /api/health included, for seconds; one transaction around all of
 * them would hold SQLite's only write lock, which every account shares, for as
 * long.
 *
 * By the time a plan is sent nothing in it can fail because of the file: every
 * value was checked and every duplicate folded while it was made, an insert
 * gives way to a row another request added meanwhile, and nothing is written
 * against a row that might not be there. What is left is the database itself
 * failing between two chunks. Then the import stops and says so, and running it
 * again finishes it, because every statement in a plan leaves alone what is
 * already there.
 */
export async function writePlan(statements) {
  if (statements.length <= CHUNK) {
    if (statements.length) await db.batch(statements);
    return;
  }
  let sent = 0;
  try {
    while (sent < statements.length) {
      const chunk = statements.slice(sent, sent + CHUNK);
      await db.batch(chunk);
      sent += chunk.length;
      if (sent < statements.length) await nextTurn();
    }
  } catch (err) {
    if (sent === 0) throw err;
    console.error(`[import] stopped after ${sent} of ${statements.length} statements`, err);
    const stopped = new Error('the import stopped part way through: run it again to finish it, '
      + 'nothing already imported will be added twice');
    stopped.status = 503;
    throw stopped;
  }
}

/* ---------- routes ---------- */

const dryRun = (req) => req.query.dryRun === '1' || req.query.dryRun === 'true';

// The list of whoever is connected, without asking them for a username they
// have already proved, or for a file they would have to go and export. The
// token never leaves the server, so this cannot be done client-side.
importRouter.post('/:service/account', wrap(async (req, res) => {
  const service = req.params.service;
  if (service !== 'anilist' && service !== 'mal') {
    return res.status(404).json({ error: `nothing can be imported from ${service}` });
  }
  const token = await freshToken(req.user.id, service);
  if (!token) {
    // 409, not 401: a 401 is the session refused, and the clients released
    // before October 2026 sign out on any. Asking to import from a tracker
    // never connected signed the reader out of PanelFlow.
    return res.status(409).json({ error: 'connect that tracker first, in Trackers' });
  }

  let entries;
  if (service === 'mal') {
    entries = await fromMalApi(token);
  } else {
    // AniList's list query is by name, so the connection has to say whose it
    // is. The name was stored when the account was connected; asking again is
    // the fallback, not the rule.
    const row = await db.prepare(
      'SELECT remote_user FROM trackers WHERE user_id = ? AND service = ?',
    ).get(req.user.id, service);
    const name = row?.remote_user || await whoami(service, token);
    if (!name) {
      return res.status(502).json({ error: 'AniList did not say which account this is' });
    }
    entries = await fromAniList(name, token);
    // The grades just read are out of 100 (anilistScore); how this reader
    // wants them shown is AniList's answer, kept on the account.
    if (!dryRun(req)) await rememberScoreFormat(req.user.id, await anilistScoreFormat(token));
  }
  res.json({ source: service, from: 'account', ...(await applyImport(req.user.id, entries, { dryRun: dryRun(req) })) });
}));

importRouter.post('/anilist', wrap(async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  if (!username) return res.status(400).json({ error: 'username required' });
  const entries = await fromAniList(username);
  // Somebody's public list, usually the reader's own: its format is taken
  // only by an account that has not said how it grades.
  if (!dryRun(req)) {
    await rememberScoreFormat(req.user.id, await anilistScoreFormat(null, username), { onlyIfUnset: true });
  }
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
