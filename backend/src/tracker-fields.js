// One tracker entry, read the same way wherever it is read.
//
// AniList says CURRENT, MyAnimeList says "reading" over the API and "on-hold"
// in an XML export, and PanelFlow has five folders. That translation used to
// live inside routes/import.js, which was the only thing doing it: importing a
// whole account. It is now also done one series at a time, when the library
// sheet asks what the tracker already knows about the page you are on — and a
// second copy of these tables would be a second answer to "which shelf is
// this", differing quietly on whichever case nobody re-tested.
//
// Pure: no fetch, no db. What the services *return* is their own business and
// stays with them; this is only the shape PanelFlow stores.
import { readingDay } from './entry-fields.js';

// REPEATING is someone rereading — they are reading it.
export const ANILIST_FOLDER = {
  CURRENT: 'reading', REPEATING: 'reading', PLANNING: 'plan',
  COMPLETED: 'completed', DROPPED: 'dropped', PAUSED: 'paused',
};

// The XML export writes "on-hold", the API answers "on_hold", and they mean
// the same shelf — so the key is neither, and `malFolder` normalises to it.
//
// The anime half of MAL says "watching" and "plan to watch" for the same two
// shelves, and an anime row read with the manga table landed on Reading
// whatever it was.
export const MAL_FOLDER = {
  reading: 'reading', completed: 'completed', 'on hold': 'paused',
  dropped: 'dropped', 'plan to read': 'plan',
  watching: 'reading', 'plan to watch': 'plan',
};

export const malFolder = (status) =>
  MAL_FOLDER[String(status ?? '').toLowerCase().replace(/[-_]+/g, ' ').trim()] ?? 'reading';

// MAL writes an unset date as 0000-00-00, which SQLite will happily store and
// no client can render. A date it only half knows is "2024-03" over the API and
// "2024-03-00" in its XML export, and both are the month the reader gave: kept
// as "2024-03" (readingDay, ../entry-fields.js), not dropped.
export const cleanDate = (v) => {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const [, year, month = '00', day = '00'] = m;
  const known = month === '00' ? year : day === '00' ? `${year}-${month}` : `${year}-${month}-${day}`;
  return readingDay(known);
};

/**
 * A MyAnimeList score PanelFlow can show, or none.
 *
 * MAL grades in whole numbers from 1 to 10 and uses 0 for "not scored", so
 * anything outside 1..10 is the absence of an opinion rather than a low one:
 * storing it as 0 would show a reader a grade they never gave.
 */
export const clampScore = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 10 ? v : null;
};

/**
 * An AniList grade, asked for as `score(format: POINT_100)`, as PanelFlow
 * stores it: out of ten, with the one decimal that keeps it exact (85 is 8.5).
 * AniList keeps every grade out of 100 whatever format the reader picked, so
 * this is the one request that never rounds (shared/prefs.js, scoreIn).
 */
export const anilistScore = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n) / 10 : null;
};

/**
 * AniList's `{ year, month, day }`, which is null in every combination. A
 * year, or a year and a month, is a date the reader gave and is kept as such.
 */
export const anilistDate = (d) => {
  if (!d?.year) return null;
  const pad = (n) => String(n).padStart(2, '0');
  if (!d.month) return readingDay(String(d.year));
  return readingDay(d.day ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : `${d.year}-${pad(d.month)}`);
};

/**
 * A stored date as AniList's FuzzyDateInput, read off the string and never
 * through a Date: a date has no time zone, and a Date in Kiritimati moves
 * 2024-03-01 to the day before the moment anything turns it into UTC.
 */
export const fuzzyDate = (v) => {
  const day = readingDay(v);
  if (!day) return null;
  const [year, month = null, date = null] = day.split('-').map(Number);
  return { year, month, day: date };
};

/** A stored date as MyAnimeList's XML export writes it: the parts it lacks as 00. */
export const malXmlDate = (v) => {
  const day = readingDay(v);
  if (!day) return '0000-00-00';
  const [year, month = '00', date = '00'] = day.split('-');
  return `${year}-${month}-${date}`;
};

const whole = (n) => Math.max(0, Math.round(Number(n) || 0));

/**
 * What AniList holds for the signed-in reader on one series, as PanelFlow
 * fields — or null where there is no entry, which is the normal answer for a
 * series they have never listed.
 */
export function fromAniListEntry(e) {
  if (!e || !e.status) return null;
  return {
    folder: ANILIST_FOLDER[e.status] ?? 'reading',
    chaptersRead: whole(e.progress),
    score: anilistScore(e.score),
    startDate: anilistDate(e.startedAt),
    finishDate: anilistDate(e.completedAt),
  };
}

/** The same, from MyAnimeList's `my_list_status`. */
export function fromMalStatus(st) {
  if (!st || !st.status) return null;
  return {
    folder: malFolder(st.status),
    // An anime's row counts episodes under its own name. `chaptersRead` is the
    // one field either way: it is "how far", and the caller knows which kind.
    chaptersRead: whole(st.num_chapters_read ?? st.num_episodes_watched),
    score: clampScore(st.score),
    startDate: cleanDate(st.start_date),
    finishDate: cleanDate(st.finish_date),
  };
}
