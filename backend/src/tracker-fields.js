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

// REPEATING is someone rereading — they are reading it.
export const ANILIST_FOLDER = {
  CURRENT: 'reading', REPEATING: 'reading', PLANNING: 'plan',
  COMPLETED: 'completed', DROPPED: 'dropped', PAUSED: 'paused',
};

// The XML export writes "on-hold", the API answers "on_hold", and they mean
// the same shelf — so the key is neither, and `malFolder` normalises to it.
export const MAL_FOLDER = {
  reading: 'reading', completed: 'completed', 'on hold': 'paused',
  dropped: 'dropped', 'plan to read': 'plan',
};

export const malFolder = (status) =>
  MAL_FOLDER[String(status ?? '').toLowerCase().replace(/[-_]+/g, ' ').trim()] ?? 'reading';

// MAL writes an unset date as 0000-00-00, which SQLite will happily store and
// no client can render.
export const cleanDate = (v) =>
  (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') && !v.startsWith('0000') ? v : null);

/**
 * A score PanelFlow can show, or none.
 *
 * Both services use 0 for "not scored", and both are asked for a ten-point
 * scale, so anything outside 1..10 is the absence of an opinion rather than a
 * low one — storing it as 0 would show a reader a grade they never gave.
 */
export const clampScore = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 10 ? v : null;
};

/** AniList's `{ year, month, day }`, which is null in every combination. */
export const anilistDate = (d) =>
  (d?.year && d?.month && d?.day
    ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
    : null);

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
    score: clampScore(e.score),
    startDate: anilistDate(e.startedAt),
    finishDate: anilistDate(e.completedAt),
  };
}

/** The same, from MyAnimeList's `my_list_status`. */
export function fromMalStatus(st) {
  if (!st || !st.status) return null;
  return {
    folder: malFolder(st.status),
    chaptersRead: whole(st.num_chapters_read),
    score: clampScore(st.score),
    startDate: cleanDate(st.start_date),
    finishDate: cleanDate(st.finish_date),
  };
}
