// Pushing progress *out* to AniList and MyAnimeList.
//
// The other direction has existed for a while — routes/import.js reads a MAL
// export, routes/export.js writes one — so a tracker could seed the library and
// then never hear from it again. This is the half that keeps the tracker up to
// date while the user reads.
//
// Two facts shape everything below:
//
//   * A scan site says "Chapitre 109 VF" and AniList says media 30002. Turning
//     one into the other costs a search request, so the answer is cached per
//     entry in `tracker_links` and the search happens once, not on every page.
//   * A tracker is someone else's record of what the user has read. Progress is
//     the only field written, it only ever moves forward, and nothing here
//     deletes or reclassifies anything on the far side.
import { db } from './db.js';
import { freshToken } from './tracker-oauth.js';
import { bestTitleScore, chapterNumber, STRONG } from './series-match.js';

const TIMEOUT_MS = 8000;

/** fetch + timeout + JSON, with a message naming the host that refused. */
async function call(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await resp.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!resp.ok) {
      const err = new Error(`${new URL(url).host} answered ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// --- AniList ----------------------------------------------------------------

const ANILIST_SEARCH = `
  query ($q: String) {
    Page(perPage: 10) {
      media(search: $q, type: MANGA) {
        id
        synonyms
        title { romaji english native }
      }
    }
  }
`;

const ANILIST_SAVE = `
  mutation ($id: Int, $p: Int) {
    SaveMediaListEntry(mediaId: $id, progress: $p) { id progress }
  }
`;

async function anilistGraphql(token, query, variables) {
  const body = await call('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  // AniList reports an expired token, a rate limit and a malformed query alike
  // as HTTP 200 with an `errors` array. Unchecked, every one of those looks
  // like a push that worked.
  const first = body?.errors?.[0];
  if (first) throw new Error(`anilist: ${first.message ?? 'error'}`);
  return body?.data ?? {};
}

// --- the services -----------------------------------------------------------
// Kitsu is deliberately absent, exactly as it is from /connect: its OAuth is a
// resource-owner password grant nobody has wired up, so there is no token to
// push with. An absent entry here means "skip", not "fail".

const API = {
  anilist: {
    async search(token, q) {
      const data = await anilistGraphql(token, ANILIST_SEARCH, { q });
      return (data.Page?.media ?? []).map((m) => ({
        id: String(m.id),
        title: m.title?.romaji ?? m.title?.english ?? m.title?.native ?? '',
        altTitles: [m.title?.english, m.title?.native, ...(m.synonyms ?? [])].filter(Boolean),
      }));
    },
    async push(token, remoteId, chapter) {
      // `progress` and nothing else. Sending `status` too would drag a
      // COMPLETED or DROPPED entry back to CURRENT the moment the user opened
      // an old chapter, and which folder a series is in is already exported
      // deliberately, by the user, from /api/export.
      await anilistGraphql(token, ANILIST_SAVE, { id: Number(remoteId), p: Math.floor(chapter) });
    },
  },
  mal: {
    async search(token, q) {
      const url = new URL('https://api.myanimelist.net/v2/manga');
      // MAL rejects a query under 3 characters and truncates long ones itself.
      url.searchParams.set('q', q.slice(0, 64));
      url.searchParams.set('limit', '10');
      url.searchParams.set('fields', 'alternative_titles');
      const body = await call(url, { headers: { Authorization: `Bearer ${token}` } });
      return (body?.data ?? []).map(({ node }) => ({
        id: String(node?.id),
        title: node?.title ?? '',
        altTitles: [
          node?.alternative_titles?.en,
          node?.alternative_titles?.ja,
          ...(node?.alternative_titles?.synonyms ?? []),
        ].filter(Boolean),
      }));
    },
    async push(token, remoteId, chapter) {
      const id = encodeURIComponent(remoteId);
      await call(`https://api.myanimelist.net/v2/manga/${id}/my_list_status`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        // Form-encoded, not JSON: the v2 API answers 400 to a JSON body here.
        // And a whole number, because MAL counts chapters and 109.5 is not one.
        body: new URLSearchParams({ num_chapters_read: String(Math.floor(chapter)) }).toString(),
      });
    },
  },
};

/** The services progress can actually be pushed to. */
export const PUSH_SERVICES = Object.keys(API);

export const canPush = (service) => Object.hasOwn(API, service);

/** Search a tracker's catalogue. Exposed so the client can offer a manual fix. */
export function searchTracker(service, token, q) {
  if (!canPush(service)) throw new Error(`cannot push to ${service}`);
  return API[service].search(token, String(q ?? '').trim());
}

/**
 * The candidate that is the same work as `title`, or none.
 *
 * Same rule as merging two library entries (`shared/series-match.js`): above
 * STRONG the titles are one work under two spellings, below it they are a
 * guess. A wrong link here writes chapter counts onto a stranger's series, so
 * a guess is never taken — it is only remembered, as the "did you mean?" the
 * user is offered.
 */
export function pickMatch(candidates, title) {
  let best = null;
  let score = 0;
  for (const c of candidates ?? []) {
    const s = bestTitleScore(c, { title });
    // `best === null` and not just `s > score`: two titles sharing no bigram at
    // all score exactly 0, and a search that returns only those still returned
    // something. Falling back to the first hit keeps the tracker's own
    // relevance ranking rather than showing the user nothing.
    if (best === null || s > score) { score = s; best = c; }
  }
  return { match: score >= STRONG ? best : null, best, score };
}

// --- links ------------------------------------------------------------------

const linkOf = (row) => ({
  libraryId: row.library_id,
  service: row.service,
  remoteId: row.remote_id,
  remoteTitle: row.remote_title,
  state: row.state,
  lastChapter: row.last_chapter,
  updatedAt: row.updated_at,
});

export async function listLinks(userId) {
  const rows = await db.prepare(`
    SELECT t.*, l.title
    FROM tracker_links t JOIN library l ON l.id = t.library_id
    WHERE t.user_id = ? AND l.deleted = 0
  `).all(userId);
  return rows.map((r) => ({ ...linkOf(r), title: r.title }));
}

export async function saveLink(userId, libraryId, service, { remoteId, remoteTitle, state }) {
  await db.prepare(`
    INSERT INTO tracker_links (user_id, library_id, service, remote_id, remote_title, state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, library_id, service) DO UPDATE SET
      remote_id = excluded.remote_id,
      remote_title = excluded.remote_title,
      state = excluded.state,
      updated_at = datetime('now')
  `).run(userId, libraryId, service, remoteId ?? null, remoteTitle ?? null, state);
  return db.prepare('SELECT * FROM tracker_links WHERE user_id = ? AND library_id = ? AND service = ?')
    .get(userId, libraryId, service);
}

/**
 * The link for one entry, resolving it against the tracker the first time.
 *
 * A row already there is taken as final, whatever it says. `unmatched` in
 * particular is not retried: a title that is simply not in the catalogue would
 * otherwise cost a search on every chapter the user ever reads, forever. The
 * way out of `unmatched` is the user linking it by hand, which is also the only
 * thing that can actually know the answer.
 */
export async function resolveLink(userId, entry, service, token) {
  const existing = await db.prepare(
    'SELECT * FROM tracker_links WHERE user_id = ? AND library_id = ? AND service = ?',
  ).get(userId, entry.id, service);
  if (existing) return existing;
  if (!entry.title) return null;
  const candidates = await API[service].search(token, entry.title);
  const { match, best } = pickMatch(candidates, entry.title);
  return saveLink(userId, entry.id, service, {
    remoteId: match?.id ?? null,
    // The closest thing seen is kept even when it was not close enough: it is
    // what a "did you mean?" is made of, and the alternative is asking the user
    // to search a catalogue by hand with no hint at all.
    remoteTitle: (match ?? best)?.title ?? null,
    state: match ? 'linked' : 'unmatched',
  });
}

/** Push one entry to one service. Resolves the link if this is the first time. */
async function pushOne(userId, entry, service, token, chapter) {
  const link = await resolveLink(userId, entry, service, token);
  if (!link) return { service, libraryId: entry.id, ok: false, skipped: 'no-title' };
  if (link.state !== 'linked' || !link.remote_id) {
    return { service, libraryId: entry.id, ok: false, skipped: link.state };
  }
  // Forward only. Rereading chapter 3 of a 200-chapter series must not tell the
  // tracker the user has read 3 — that is the one way this feature could
  // destroy something the user cares about.
  if (link.last_chapter !== null && link.last_chapter !== undefined && chapter <= link.last_chapter) {
    return { service, libraryId: entry.id, ok: true, skipped: 'not-further' };
  }
  await API[service].push(token, link.remote_id, chapter);
  await db.prepare(`
    UPDATE tracker_links SET last_chapter = ?, updated_at = datetime('now')
    WHERE user_id = ? AND library_id = ? AND service = ?
  `).run(chapter, userId, entry.id, service);
  return { service, libraryId: entry.id, ok: true, chapter, remoteId: link.remote_id };
}

/**
 * Tell every connected tracker how far the user has read one series.
 *
 * Called from PUT /api/progress/:libraryId, in the request, on purpose: work
 * started after the response is sent is killed with the lambda, so a
 * fire-and-forget push would land only when it felt like it. The cost is paid
 * once per *chapter* rather than once per page — the `last_chapter` check above
 * turns every later save of the same chapter into one local UPDATE-free read —
 * and the whole thing short-circuits on a single query for the many users who
 * have no tracker connected at all.
 *
 * It never throws. A tracker being down is not a reason to fail a bookmark.
 */
export async function pushProgress(userId, libraryId, chapterLabel) {
  try {
    const chapter = chapterNumber(chapterLabel);
    if (chapter === null) return [];
    const tokens = await db.prepare('SELECT service FROM trackers WHERE user_id = ?').all(userId);
    const usable = tokens.filter((t) => canPush(t.service));
    // The whole point of asking first: a user who has connected nothing — which
    // is most of them — pays one query per page turn and no more.
    if (!usable.length) return [];
    const entry = await db.prepare('SELECT id, title FROM library WHERE id = ? AND user_id = ?')
      .get(libraryId, userId);
    if (!entry) return [];
    return await Promise.all(usable.map(async (t) => {
      try {
        // A MAL token lasts an hour, so the token is fetched through the
        // refresher rather than read off the row. A connection that has ended
        // is reported, not thrown: turning a page must still save the bookmark.
        const token = await freshToken(userId, t.service);
        if (!token) {
          return { service: t.service, libraryId, ok: false, error: 'the connection has expired' };
        }
        return await pushOne(userId, entry, t.service, token, chapter);
      } catch (e) {
        return { service: t.service, libraryId, ok: false, error: String(e?.message ?? e) };
      }
    }));
  } catch (e) {
    return [{ ok: false, error: String(e?.message ?? e) }];
  }
}

/**
 * Backfill: push everything the user has a bookmark in to one service.
 *
 * Sequential and deadline-bounded rather than parallel — AniList allows 90
 * requests a minute and MAL less, and a backfill that gets the account rate
 * limited has made things worse. What does not fit in the deadline is reported
 * as `remaining`; calling again picks up where this stopped, and by then the
 * links it did resolve are cached, so the second run is mostly pushes.
 */
export async function pushAll(userId, service, token, { limit = 500, deadlineMs = 20000 } = {}) {
  if (!canPush(service)) throw new Error(`cannot push to ${service}`);
  const rows = await db.prepare(`
    SELECT l.id, l.title, p.chapter_label
    FROM library l JOIN progress p ON p.library_id = l.id AND p.user_id = l.user_id
    WHERE l.user_id = ? AND l.deleted = 0
    ORDER BY p.updated_at DESC
    LIMIT ?
  `).all(userId, limit);

  const until = Date.now() + deadlineMs;
  const out = { service, pushed: 0, skipped: 0, failed: 0, remaining: 0, errors: [] };
  for (const [i, row] of rows.entries()) {
    if (Date.now() > until) { out.remaining = rows.length - i; break; }
    const chapter = chapterNumber(row.chapter_label);
    if (chapter === null) { out.skipped++; continue; }
    try {
      const r = await pushOne(userId, { id: row.id, title: row.title }, service, token, chapter);
      if (r.ok && !r.skipped) out.pushed++;
      else out.skipped++;
    } catch (e) {
      out.failed++;
      // Enough to name what went wrong without turning a 500-series library
      // into a response nobody can read.
      if (out.errors.length < 10) out.errors.push({ title: row.title, error: String(e?.message ?? e) });
    }
  }
  return out;
}
