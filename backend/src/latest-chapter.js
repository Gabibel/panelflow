// Who may change a series' latest chapter, and with what.
//
// `last_known_chapter` is a measurement: the newest chapter a series page
// listed when it was read. It used to be a high-water mark instead. The
// watcher only ever raised it and every merge kept the higher of two, so a
// single wrong reading (a sidebar's "Chapter 2007" on the page of a series
// that has 300) was there for good, and the shelf said "2005 new" (iPhone,
// October 2026).
//
// The rule now, in one place for every route that writes the column:
//
// - A reading made by the server (the watcher, a check, a scrape) is dated
//   now and replaces any older reading. Upwards always; downwards only when
//   it is sure (`readingReplaces`): a lower number off a page that did not
//   finish loading, or off a list that pages its chapters, would otherwise
//   come down tonight and be announced as new tomorrow.
// - A reading a client sends with its date (`chapterMeasuredAt`) replaces the
//   stored one only if it is newer. A date in the future counts as now, or a
//   phone with its clock a year ahead would win every argument for a year.
// - A value sent with no date is an older client, or a copy nobody measured.
//   It only fills a series that has no measurement yet, which is what the
//   column did before dates existed.
import { db } from './db.js';
import { chapterNumber } from './series-match.js';

/** Now, in the one format the column holds: ISO, so text order is time order. */
export const nowIso = () => new Date().toISOString();

/**
 * A client's `chapterMeasuredAt`, as stored: ISO, never later than now.
 * Null when absent. `undefined` when present but not a date, so the route can
 * refuse it by name.
 */
export function measuredAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return undefined;
  return new Date(Math.min(at, Date.now())).toISOString();
}

/**
 * What the row should hold after a client sent `chapter` measured at `at`
 * (null: undated): the `{ chapter, at }` to write. The row's own pair comes
 * back when the sent value loses.
 */
export function settleChapter(row, chapter, at) {
  const stored = { chapter: row?.last_known_chapter ?? null, at: row?.chapter_measured_at ?? null };
  if (!stored.at) return { chapter, at: at ?? null };
  if (!at) return stored;
  return Date.parse(at) > Date.parse(stored.at) ? { chapter, at } : stored;
}

/**
 * Whether a reading of the series page, `{ chapter, sure }` (latestReadingOf
 * in routes/meta.js), replaces the chapter stored. Up, or the same: always,
 * which also renews the date. Down: only a sure reading, the series' own
 * chapter links or the site's API, because the wrong value this exists for
 * came from a link that was not the series' own, and a short page is not.
 */
export function readingReplaces(stored, reading) {
  if (!reading || reading.chapter === null || reading.chapter === undefined) return false;
  const known = chapterNumber(stored);
  if (known === null || Number(reading.chapter) >= known) return true;
  return !!reading.sure;
}

/**
 * Writes a reading the server made at `at` onto one row, unless a device
 * sent a newer one in the meantime. Never touches updated_at: the clients
 * pull the library ordered by it, and checking must not reorder the shelf.
 */
export async function recordReading(id, chapter, at) {
  await db.prepare(`UPDATE library SET last_known_chapter = ?, chapter_measured_at = ?
    WHERE id = ? AND (chapter_measured_at IS NULL OR chapter_measured_at <= ?)`)
    .run(String(chapter), at, id, at);
}
