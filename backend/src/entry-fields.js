// What a value sent in may be, whichever door it comes through.
//
// The library, its bookmarks and its reading history are written by the routes
// a client calls while someone reads, by the tracker imports and by a restored
// backup. Each door used to hold its own idea of a date or an address, and the
// loosest one let in what the others refused: a javascript: address the import
// dropped went in through POST /api/library instead, and came out of the web
// app as a link. So the rules live here, once, and every door asks them.
//
// Pure: no request and no database. Each rule answers the value it can use, or
// null (0 for a count) when there is none; what that means is the caller's
// business. The import drops the value and keeps the series around it, and a
// route that already refuses bad input answers 400.

/** A string with something in it, kept as written, or null. */
export const nonBlank = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * A chapter as the library stores it, as text, whichever of the two a client
 * wrote, or null. A number has to be made text here: the database driver binds
 * 120 as a real, and the text column then holds "120.0".
 */
export const chapterText = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : nonBlank(v));

/**
 * An http(s) address, or null. Every client turns a stored address into a
 * link, and anything else (javascript:, data:) is a script waiting for a click.
 */
export function webUrl(v) {
  if (typeof v !== 'string') return null;
  try {
    const { protocol } = new URL(v.trim());
    return protocol === 'https:' || protocol === 'http:' ? v.trim() : null;
  } catch {
    return null;
  }
}

/** A count: a whole number of zero or more, and 0 for anything else. */
export const whole = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** An integer from `lo` to `hi`, or null. Numeric strings count, as they do on the form. */
export const inRange = (v, lo, hi) => {
  if (typeof v !== 'number' && (typeof v !== 'string' || v.trim() === '')) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/**
 * A day that exists, as YYYY-MM-DD, or null. The shape alone lets 2026-13-45
 * through, and MyAnimeList's 0000-00-00 for "never" with it; a date no calendar
 * has is one no client can draw. Date rolls 02-30 over into March rather than
 * refusing it, hence the round trip.
 */
export function isoDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.startsWith('0000')) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/**
 * A moment, kept as written, or null. The database writes "YYYY-MM-DD HH:MM:SS"
 * and a backup carries that back; an ISO string is the other shape that turns
 * up. A word like "yesterday" would sort after every real date and pin its row
 * to the top of any list ordered by time.
 */
export function timestamp(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})?)?$/
    .exec(v);
  if (!m || !isoDay(m[1])) return null;
  // Without a zone the database means UTC; the time itself is checked by Date.
  const iso = m[2] ? `${m[1]}T${m[2]}${m[3] ?? 'Z'}` : m[1];
  return Number.isNaN(Date.parse(iso)) ? null : v;
}

/**
 * A count held to 0..max: rounded, clamped at both ends, and 0 for anything
 * that is not a number. JSON can spell a number far past any range (1e400
 * parses to Infinity), and that is the far end of the range rather than an
 * error, the same answer as for any other number that is too big.
 */
export function clampCount(v, max) {
  const n = Math.round(Number(v) || 0);
  return Math.min(max, Math.max(0, n));
}

// The most pages anything here counts: a chapter's length, the page a bookmark
// is on, how far a read got. Far past any chapter drawn or written, and far
// short of 2^53. A whole number past that is stored as an integer JavaScript
// cannot hold, and from then on every read of the rows it sits in fails, the
// account's whole history or every one of its bookmarks with it.
export const MAX_PAGES = 100_000;
