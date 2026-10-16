// One history row, checked the same way wherever it arrives from.
//
// Two doors write reading history: POST /api/history, one session at a time
// while someone reads, and a restored backup, a year of rows at once. Both are
// a client's claim about the reader's calendar and the reader's time, and the
// statistics page adds up whatever either of them let in. So they check against
// this one copy of the rules: a second copy in the restore would be the way past
// the first, and a file is the easier thing to get wrong.
import { clampCount, MAX_PAGES } from './entry-fields.js';

// A reading session the client forgot to close should not claim the whole
// afternoon. The reader stops its clock when the tab is hidden, but a laptop
// suspended mid-chapter reports whatever the wall clock says on resume.
export const MAX_SESSION_SECONDS = 4 * 3600;

// A row is one chapter on one day, and the sessions added onto it stop at a
// day's worth: whatever a client reports, nobody read one chapter for longer
// than the day it was read on.
export const MAX_ROW_SECONDS = MAX_SESSION_SECONDS * 6;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The day comes from the client because "what did I read today" is a question
// about the reader's calendar, not the server's: a 1 a.m. chapter in Paris is
// still yesterday in UTC. Validated, and refused if it is in the future by
// more than a day — no timezone is that far ahead.
export function readDay(value) {
  if (value === undefined || value === null) return null;
  const v = String(value);
  if (!DAY.test(v)) return null;
  const limit = new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
  return v <= limit ? v : null;
}

/**
 * How far into a chapter a read got, in pages, held the way the route holds a
 * session's seconds: rounded, kept to 0..MAX_PAGES, and 0 for what is not a
 * number. JSON can spell 1e400, which parses to Infinity, and the database
 * refused that with a 500; a count past 2^53 was worse, stored and then failing
 * every later read of the account's history.
 */
export const readPages = (value) => clampCount(value, MAX_PAGES);
