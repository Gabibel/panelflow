// Covers for the entries that show a grey rectangle.
//
// Two different reasons a shelf has one, and they need different repairs:
//
//   * **No cover at all.** A cover lives on a series page, and a series added
//     the usual way — from the chapter you happened to be reading — never had
//     one. Syncing does not invent it either: the account has nothing to send.
//   * **A cover that will not load.** The URL is there and it 404s, or the site
//     moved its images, or the proxy cannot get past the host today. Nothing
//     ever noticed, because an <Image> that fails just stays empty.
//
// The first is repaired by going back to the series page (`scrape`, a server
// route — the phone cannot fetch a scan site cross-origin). The second is not:
// scraping the same page returns the same dead URL. Both then fall back to a
// public catalogue, which has a picture for nearly every work in existence —
// including the light novels and the long-finished series whose own sites never
// had one. Deliberately not the reader's tracker: a cover has nothing to do
// with having connected an account, and most readers have not.
//
// Deliberately small and slow: a handful per pass, one at a time, and never the
// same entry twice in a session. A shelf of forty coverless series must not
// become forty page fetches the moment somebody opens the app.
import { send } from './core.js';
import { Match } from './shared.js';

/** How many to try per refresh. Enough to fill a screen over a few passes. */
const PER_PASS = 4;

// Asked once per session, whatever the answer. A series whose page has no
// cover at all — or is behind a challenge today — should cost one request and
// then be left alone, not one request per redraw. This is also what stops a
// replacement cover that fails in turn from starting the cycle again.
const asked = new Set();

// Entries whose cover was fetched and did not render. Filled in by the view
// that tried to draw it — nothing else is in a position to know.
const broken = new Set();

/**
 * Called by a cover that failed to load, so the next pass can replace it.
 *
 * Live state only: it is a note that this URL did not work on this device just
 * now, which is not a fact about the series worth storing.
 */
export function reportBrokenCover(id) {
  if (id) broken.add(id);
}

/**
 * Which of the catalogue's results, if any, is this series — and has a picture.
 *
 * Pure, and separate from the fetching on purpose: it is the only part of this
 * file that can put a wrong picture on somebody's shelf, so it is the part that
 * is tested on its own (backend/test/covers-pick.test.js).
 *
 * The match has to clear `STRONG` — the same bar `pickMatch` uses server-side
 * before it writes a chapter count onto a tracker entry. Putting a stranger's
 * picture on a shelf is the same class of mistake as writing to a stranger's
 * entry, and a wrong cover is the worse of the two: it looks right, so nobody
 * reports it. A grey rectangle is the better failure.
 *
 * The results come back in the catalogue's own relevance order, so the first
 * hit that clears the bar is the answer.
 */
export function pickCover(hits, entry) {
  for (const hit of hits || []) {
    if (!hit?.coverUrl) continue;
    if (Match.bestTitleScore(hit, entry) >= Match.STRONG) return hit.coverUrl;
  }
  return null;
}

/** A cover from the catalogue, for a series its own site had none for. */
async function coverFromCatalogue(entry) {
  const title = (entry.title || '').trim();
  // The route refuses anything shorter, and rightly: one letter matches the
  // whole catalogue.
  if (title.length < 2) return null;
  // The medium travels with it: an episode of Boruto and a chapter of Boruto
  // are two different works in the catalogue, and looking for one under the
  // other finds nothing.
  const r = await send({ type: 'coverSearch', title, medium: entry.medium });
  return pickCover(r?.hits, entry);
}

/**
 * Fill in what is missing or broken, and answer whether anything changed.
 *
 * Never throws: this runs behind a shelf that is already on screen, and a cover
 * that could not be found is a cover the reader was not going to see anyway.
 * One entry failing costs that entry only — the loop carries on to the rest.
 */
export async function fillMissingCovers(library) {
  const wanted = (library || [])
    .filter((e) => e?.id && e.sourceUrl && !asked.has(e.id) && (!e.coverUrl || broken.has(e.id)))
    .slice(0, PER_PASS);
  let found = 0;

  for (const entry of wanted) {
    asked.add(entry.id);
    try {
      // A cover that is present and dead is not worth re-scraping: the series
      // page is where it came from, and it will hand back the same URL.
      let coverUrl = null;
      if (!entry.coverUrl) {
        const meta = await send({ type: 'scrape', url: entry.sourceUrl });
        if (!meta?.error) coverUrl = meta?.coverUrl || null;
      }
      if (!coverUrl) coverUrl = await coverFromCatalogue(entry);
      if (!coverUrl || coverUrl === entry.coverUrl) continue;

      // Only the cover. The title on a chapter page is the chapter's, and
      // overwriting a shelf name with "Scan One Piece 1019" is how a library
      // stops being readable — that is a repair for somewhere else.
      await send({ type: 'updateEntry', id: entry.id, patch: { coverUrl } });
      broken.delete(entry.id);
      found += 1;
    } catch (e) {
      console.warn('[panelflow] no cover for', entry.title, e);
    }
  }
  return found > 0;
}
