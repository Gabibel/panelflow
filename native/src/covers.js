// Covers for the entries that arrived without one.
//
// A cover lives on a series page, not on a chapter page. So a series added the
// usual way — from the chapter you happened to be reading — often has no
// `coverUrl` at all, and no amount of syncing invents one: the account has
// nothing to send either. Those are the grey rectangles on the shelf, and they
// stay grey for ever because nothing ever goes back to look.
//
// This is what goes back to look. `scrape` is a server route (the phone cannot
// fetch a scan site cross-origin, and the server is already the thing that
// knows how to read one), and `updateEntry` writes what it found, so the answer
// reaches every device rather than this one.
//
// Deliberately small and slow: a handful per pass, one at a time, and never the
// same entry twice in a session. A shelf of forty coverless series must not
// become forty page fetches the moment somebody opens the app.
import { send } from './core.js';

/** How many to try per refresh. Enough to fill a screen over a few passes. */
const PER_PASS = 4;

// Asked once per session, whatever the answer. A series whose page has no
// cover at all — or is behind a challenge today — should cost one request and
// then be left alone, not one request per redraw.
const asked = new Set();

/**
 * Fill in what is missing, and answer whether anything changed.
 *
 * Never throws: this runs behind a shelf that is already on screen, and a
 * cover that could not be found is a cover the reader was not going to see
 * anyway.
 */
export async function fillMissingCovers(library) {
  const missing = (library || [])
    .filter((e) => !e.coverUrl && e.sourceUrl && e.id && !asked.has(e.id))
    .slice(0, PER_PASS);
  let found = 0;

  for (const entry of missing) {
    asked.add(entry.id);
    try {
      const meta = await send({ type: 'scrape', url: entry.sourceUrl });
      if (!meta || meta.error || !meta.coverUrl) continue;
      // Only the cover. The title on a chapter page is the chapter's, and
      // overwriting a shelf name with "Scan One Piece 1019" is how a library
      // stops being readable — that is a repair for somewhere else.
      await send({ type: 'updateEntry', id: entry.id, patch: { coverUrl: meta.coverUrl } });
      found += 1;
    } catch (e) {
      console.warn('[panelflow] no cover for', entry.title, e);
    }
  }
  return found > 0;
}
