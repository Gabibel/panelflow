// One bookmark from a backup, checked before it is restored.
//
// Two doors write the progress table: PUT /api/progress, once per page turn on
// every device (routes/progress.js, which holds a page turn to its own rules),
// and a restored backup, a whole library of bookmarks at once. A file is the
// reader's, but it may have been edited or written by something else: a
// javascript: chapter address every client would then offer as "continue", or
// a page number past 2^53 that failed every later read of the account's
// bookmarks. So the restore reads each bookmark here, as it reads history rows
// through ./history-fields.js.
import { nonBlank, webUrl, timestamp, clampCount, MAX_PAGES } from './entry-fields.js';

/**
 * Where in the chapter, from 0 (its top) to 1 (its end). A reader that scrolls
 * past an end, as a phone's rubber band does for a moment, is at that end
 * rather than sent back to the top, and a position that is not a number is the
 * top, where a chapter opens.
 */
const scrollRatio = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/** How many pages the chapter has, or null: a count that is not a count is not known. */
const knownPageCount = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= MAX_PAGES ? n : null;
};

/**
 * A bookmark as it may be stored, or null when it names no chapter a client
 * could open. A page before the first is the first and one past any chapter
 * stops at MAX_PAGES; a position outside the chapter is the nearer end of it.
 */
export function readBookmark(p) {
  const chapterUrl = webUrl(p?.chapterUrl);
  if (!chapterUrl) return null;
  return {
    chapterUrl,
    chapterLabel: nonBlank(p.chapterLabel),
    page: clampCount(p.page, MAX_PAGES),
    pageCount: knownPageCount(p.pageCount),
    scrollPos: scrollRatio(p.scrollPos),
    updatedAt: timestamp(p.updatedAt),
  };
}
