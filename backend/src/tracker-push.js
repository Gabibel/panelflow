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
//   * A tracker is someone else's record of what the user has read. It only
//     ever moves forward, and nothing here deletes anything on the far side.
//     Two fields are written, and the second one is written under a rule:
//     progress always, and the shelf only ever from one that means "not
//     started" onto "reading". A COMPLETED entry dragged back to CURRENT
//     because someone reopened chapter 3 is the damage this module exists to
//     not do.
import { db } from './db.js';
import { freshToken } from './tracker-oauth.js';
import { bestTitleScore, chapterNumber, STRONG } from './series-match.js';
import { fromAniListEntry, fromMalStatus } from './tracker-fields.js';

const TIMEOUT_MS = 8000;

/**
 * The shelves a series may be moved off, onto "reading", by the act of reading
 * it. Everything else — reading, completed, dropped — is left exactly as the
 * reader left it, and `null` (no entry on the tracker at all) is in here too:
 * a series PanelFlow is adding for them starts as one they are reading.
 */
const PROMOTABLE = new Set([null, undefined, 'plan', 'paused']);

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

// `mediaListEntry` is the signed-in reader's own row for that media — null for
// everything they have never listed, which is most of a search. It costs
// nothing extra: AniList resolves it in the same request, and having it here
// is what lets the library sheet open already filled in.
const ANILIST_SEARCH = `
  query ($q: String) {
    Page(perPage: 10) {
      media(search: $q, type: MANGA) {
        id
        synonyms
        title { romaji english native }
        mediaListEntry {
          status
          progress
          score(format: POINT_10)
          startedAt { year month day }
          completedAt { year month day }
        }
      }
    }
  }
`;

// One entry of the reader's own, by media id: which shelf it is on and how far
// it says they got. Asked before a push that might promote, and before the
// first push to a link whose count we do not know — see `pushOne`.
const ANILIST_ENTRY = `
  query ($id: Int) {
    Media(id: $id) {
      mediaListEntry { status progress }
    }
  }
`;

// The whole manga list in one request, for the pull direction. `lists` is
// AniList's own grouping (Reading, Completed, custom lists); the same media can
// appear in more than one, so the caller keeps the furthest.
const ANILIST_LIST = `
  query ($user: Int) {
    MediaListCollection(userId: $user, type: MANGA) {
      lists { entries { mediaId status progress } }
    }
  }
`;

// Two documents rather than one with a nullable $status: AniList reads an
// explicit null as "set this field to null", so the mutation that must not
// touch the shelf is the one that never mentions it.
const ANILIST_SAVE = `
  mutation ($id: Int, $p: Int) {
    SaveMediaListEntry(mediaId: $id, progress: $p) { id progress }
  }
`;

const ANILIST_SAVE_READING = `
  mutation ($id: Int, $p: Int) {
    SaveMediaListEntry(mediaId: $id, progress: $p, status: CURRENT) { id progress status }
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
        mine: fromAniListEntry(m.mediaListEntry),
      }));
    },
    async entry(token, remoteId) {
      const data = await anilistGraphql(token, ANILIST_ENTRY, { id: Number(remoteId) });
      return fromAniListEntry(data.Media?.mediaListEntry);
    },
    async list(token) {
      // The collection is asked for by user id, and the token alone does not
      // say which that is.
      const me = await anilistGraphql(token, '{ Viewer { id } }', {});
      const id = me.Viewer?.id;
      if (!id) return [];
      const data = await anilistGraphql(token, ANILIST_LIST, { user: Number(id) });
      return (data.MediaListCollection?.lists ?? []).flatMap((l) => l.entries ?? [])
        .map((e) => ({ remoteId: String(e.mediaId), ...fromAniListEntry(e) }))
        .filter((e) => e.folder);
    },
    async push(token, remoteId, chapter, { promote } = {}) {
      // The shelf is named only when the caller has just established that the
      // one over there means "not started" — see PROMOTABLE. Which folder a
      // series is in otherwise stays the reader's to say, and is already
      // exported deliberately, by them, from /api/export.
      await anilistGraphql(token, promote ? ANILIST_SAVE_READING : ANILIST_SAVE,
        { id: Number(remoteId), p: Math.floor(chapter) });
    },
  },
  mal: {
    async search(token, q) {
      const url = new URL('https://api.myanimelist.net/v2/manga');
      // MAL rejects a query under 3 characters and truncates long ones itself.
      url.searchParams.set('q', q.slice(0, 64));
      url.searchParams.set('limit', '10');
      // my_list_status is the reader's own row, and MAL returns it inline
      // rather than making this a second request per hit.
      url.searchParams.set('fields',
        'alternative_titles,my_list_status{status,score,num_chapters_read,start_date,finish_date}');
      const body = await call(url, { headers: { Authorization: `Bearer ${token}` } });
      return (body?.data ?? []).map(({ node }) => ({
        id: String(node?.id),
        title: node?.title ?? '',
        altTitles: [
          node?.alternative_titles?.en,
          node?.alternative_titles?.ja,
          ...(node?.alternative_titles?.synonyms ?? []),
        ].filter(Boolean),
        mine: fromMalStatus(node?.my_list_status),
      }));
    },
    async entry(token, remoteId) {
      const id = encodeURIComponent(remoteId);
      const body = await call(
        `https://api.myanimelist.net/v2/manga/${id}?fields=my_list_status{status,num_chapters_read}`,
        { headers: { Authorization: `Bearer ${token}` } });
      return fromMalStatus(body?.my_list_status);
    },
    async list(token) {
      const out = [];
      let url = 'https://api.myanimelist.net/v2/users/@me/mangalist'
        + '?fields=list_status&limit=1000&nsfw=true';
      // Bounded rather than "while there is a next page": a paging cursor the
      // service keeps handing back is an infinite loop inside a request, and
      // five pages is five thousand series.
      for (let page = 0; url && page < 5; page++) {
        const body = await call(url, { headers: { Authorization: `Bearer ${token}` } });
        for (const row of body?.data ?? []) {
          const mine = fromMalStatus(row?.list_status);
          if (mine) out.push({ remoteId: String(row?.node?.id), ...mine });
        }
        url = body?.paging?.next ?? null;
      }
      return out;
    },
    async push(token, remoteId, chapter, { promote } = {}) {
      const id = encodeURIComponent(remoteId);
      await call(`https://api.myanimelist.net/v2/manga/${id}/my_list_status`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        // Form-encoded, not JSON: the v2 API answers 400 to a JSON body here.
        // And a whole number, because MAL counts chapters and 109.5 is not one.
        body: new URLSearchParams({
          num_chapters_read: String(Math.floor(chapter)),
          ...(promote ? { status: 'reading' } : {}),
        }).toString(),
      });
    },
  },
};

/** The services progress can actually be pushed to. */
export const PUSH_SERVICES = Object.keys(API);

export const canPush = (service) => Object.hasOwn(API, service);

/**
 * Search a tracker's catalogue. Exposed so the client can offer a manual fix.
 *
 * Every hit also carries `mine` — the reader's own list row, which the search
 * asks for so that resolving one series costs one request rather than two.
 * That is nobody's business outside this module: the picker is a list of
 * titles, and shipping a null field on every result to a screen that shows
 * names would only invite something to start depending on it. `myEntry` is the
 * way to read it.
 */
export async function searchTracker(service, token, q) {
  if (!canPush(service)) throw new Error(`cannot push to ${service}`);
  const hits = await API[service].search(token, String(q ?? '').trim());
  return hits.map(({ mine, ...rest }) => rest);
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

/**
 * What the reader's own tracker account already says about one series — the
 * shelf it is on, how far they got, the grade they gave it — or null.
 *
 * Used to open the library sheet already filled in rather than blank, which is
 * the difference between adding a series and re-entering what you already told
 * AniList two years ago.
 *
 * Only a STRONG title match counts, and the reason is sharper here than it is
 * for pushing: an approximate match writes a stranger's score and start date
 * into a form the reader is about to save. Where pickMatch's runner-up is
 * offered as "did you mean?", here it is simply not used — a blank form is a
 * fine outcome, a confidently wrong one is not.
 */
export async function myEntry(service, token, title) {
  const q = String(title ?? '').trim();
  if (!canPush(service) || q.length < 2) return null;
  const { match } = pickMatch(await API[service].search(token, q), q);
  if (!match?.mine) return null;
  return {
    service,
    remoteId: match.id,
    remoteTitle: match.title,
    ...match.mine,
  };
}

// --- links ------------------------------------------------------------------

const linkOf = (row) => ({
  libraryId: row.library_id,
  service: row.service,
  remoteId: row.remote_id,
  remoteTitle: row.remote_title,
  state: row.state,
  lastChapter: row.last_chapter,
  remoteStatus: row.remote_status,
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

/**
 * Write one link.
 *
 * `lastChapter` and `remoteStatus` are what the tracker itself said, when the
 * caller happens to have just asked it, and null otherwise — including on a
 * relink, where they *must* be cleared: a count remembered from the series this
 * entry used to point at is either a ceiling that blocks every push to the new
 * one, or a floor low enough to overwrite it.
 */
export async function saveLink(userId, libraryId, service,
  { remoteId, remoteTitle, state, lastChapter = null, remoteStatus = null }) {
  await db.prepare(`
    INSERT INTO tracker_links
      (user_id, library_id, service, remote_id, remote_title, state,
       last_chapter, remote_status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, library_id, service) DO UPDATE SET
      remote_id = excluded.remote_id,
      remote_title = excluded.remote_title,
      state = excluded.state,
      last_chapter = excluded.last_chapter,
      remote_status = excluded.remote_status,
      updated_at = datetime('now')
  `).run(userId, libraryId, service, remoteId ?? null, remoteTitle ?? null, state,
    lastChapter ?? null, remoteStatus ?? null);
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
  const row = await saveLink(userId, entry.id, service, {
    remoteId: match?.id ?? null,
    // The closest thing seen is kept even when it was not close enough: it is
    // what a "did you mean?" is made of, and the alternative is asking the user
    // to search a catalogue by hand with no hint at all.
    remoteTitle: (match ?? best)?.title ?? null,
    state: match ? 'linked' : 'unmatched',
    // The search already asked for the reader's own row, so the tracker's count
    // is here for free — and it has to be taken. Someone who has read 120
    // chapters on AniList, connects PanelFlow, and opens chapter 5 of the same
    // series would otherwise have their 120 overwritten by a 5 on the first
    // page turn: the forward-only rule can only protect a number it knows.
    lastChapter: match?.mine?.chaptersRead ?? null,
    remoteStatus: match?.mine?.folder ?? null,
  });
  // Not a column: the two fields above were read from the service one line ago,
  // so on this row a null shelf means "they have no entry for it" rather than
  // "we have never asked" — and those are stored identically. Saying so here is
  // what keeps a first push at one search and one write instead of three.
  return { ...row, fresh: true };
}

/** Push one entry to one service. Resolves the link if this is the first time. */
async function pushOne(userId, entry, service, token, chapter) {
  const link = await resolveLink(userId, entry, service, token);
  if (!link) return { service, libraryId: entry.id, ok: false, skipped: 'no-title' };
  if (link.state !== 'linked' || !link.remote_id) {
    return { service, libraryId: entry.id, ok: false, skipped: link.state };
  }

  // What we hold about the far side, and whether it is allowed to answer.
  //
  // A remembered shelf may say "stop" — reading, completed, dropped — and be
  // trusted, because every one of those is a shelf this module will not move a
  // series off. It may not say "go": promoting on a value remembered from last
  // month is how a series the reader finished in the meantime gets dragged back
  // to CURRENT. And a link with no count at all cannot enforce forward-only,
  // which is the rule protecting their tracker from PanelFlow's own bookmark.
  // Either question is answered by the same single request.
  let known = link.last_chapter;
  let shelf = link.remote_status;
  if (!link.fresh && (known === null || known === undefined || PROMOTABLE.has(shelf))) {
    // Not fatal: a tracker that will not say costs the promotion, and the push
    // below falls back to progress alone — which is what it did before any of
    // this existed.
    const mine = await API[service].entry(token, link.remote_id).catch(() => undefined);
    if (mine !== undefined) {
      shelf = mine?.folder ?? null;
      if (known === null || known === undefined) known = mine?.chaptersRead ?? null;
    }
  }

  // Forward only. Rereading chapter 3 of a 200-chapter series must not tell the
  // tracker the user has read 3 — that is the one way this feature could
  // destroy something the user cares about.
  if (known !== null && known !== undefined && chapter <= known) {
    // The count came from the tracker rather than from us, so it is worth
    // keeping: the next chapter compares against it without asking again.
    if (link.last_chapter !== known) await writeLink(userId, entry.id, service, known, shelf);
    return { service, libraryId: entry.id, ok: true, skipped: 'not-further' };
  }

  const promote = PROMOTABLE.has(shelf);
  await API[service].push(token, link.remote_id, chapter, { promote });
  await writeLink(userId, entry.id, service, chapter, promote ? 'reading' : shelf);
  return {
    service, libraryId: entry.id, ok: true, chapter, remoteId: link.remote_id,
    // So a client can say "and moved it to Reading" rather than leaving the
    // reader to discover it on the tracker.
    ...(promote ? { promoted: true } : {}),
  };
}

const writeLink = (userId, libraryId, service, chapter, shelf) => db.prepare(`
  UPDATE tracker_links SET last_chapter = ?, remote_status = ?, updated_at = datetime('now')
  WHERE user_id = ? AND library_id = ? AND service = ?
`).run(chapter, shelf ?? null, userId, libraryId, service);

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
    const tokens = await db.prepare('SELECT service, last_error FROM trackers WHERE user_id = ?')
      .all(userId);
    const usable = tokens.filter((t) => canPush(t.service));
    // The whole point of asking first: a user who has connected nothing — which
    // is most of them — pays one query per page turn and no more.
    if (!usable.length) return [];
    const entry = await db.prepare('SELECT id, title FROM library WHERE id = ? AND user_id = ?')
      .get(libraryId, userId);
    if (!entry) return [];
    return await Promise.all(usable.map(async (t) => {
      const result = await (async () => {
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
      })();
      await recordOutcome(userId, t, result);
      return result;
    }));
  } catch (e) {
    return [{ ok: false, error: String(e?.message ?? e) }];
  }
}

/**
 * Leave a mark on the connection saying how that went.
 *
 * Nobody is watching when a push fails. The reader is on page nine of something
 * and the response carrying the reason is read by no one — so an expired
 * AniList token, which is what every connection eventually becomes, would
 * otherwise be discovered months later by noticing the account never moved.
 * `GET /api/trackers` reports what this writes, and the clients draw it.
 *
 * Written only when the answer changes, so the steady state of a working
 * connection is still one SELECT per page turn and no writes. A push that
 * legitimately did nothing — the chapter was already sent, the series is muted
 * — is neither a success nor a failure and leaves the row alone: it is not
 * evidence the tracker is reachable.
 */
async function recordOutcome(userId, row, result) {
  // Nothing was sent and nothing refused: a muted series, a title with no
  // match, a chapter the tracker already had. None of it is evidence either way.
  if (result?.skipped) return;

  if (result?.ok) {
    await db.prepare(`
      UPDATE trackers SET last_error = NULL, last_error_at = NULL, last_push_at = ?
      WHERE user_id = ? AND service = ?
    `).run(new Date().toISOString(), userId, row.service);
    return;
  }
  const error = result?.error ?? null;
  if (!error) return;
  // The same refusal, again. Rewriting it would move its date forward and turn
  // "AniList stopped accepting this in March" into "a moment ago", which is the
  // one thing the reader needs it not to say. last_push_at is left alone for
  // the same reason: when it last worked is still true.
  if ((row.last_error ?? null) === error) return;
  await db.prepare(`
    UPDATE trackers SET last_error = ?, last_error_at = ? WHERE user_id = ? AND service = ?
  `).run(error, new Date().toISOString(), userId, row.service);
}

/**
 * The other direction: what the tracker says, brought back here.
 *
 * PanelFlow cannot adopt a chapter number as a bookmark — a bookmark is a URL
 * on a scan site and a tracker has never heard of one — so this does not touch
 * the reader's progress. What it does is make the two accounts agree about what
 * has already been read: every link learns the tracker's own count and shelf,
 * which is what stops the next page turn from pushing a smaller number over a
 * larger one, and the divergences are returned so a client can show them.
 *
 * One request for the whole list rather than one per series, which is why this
 * is worth doing at all.
 */
export async function pullProgress(userId, service, token) {
  if (!canPush(service)) throw new Error(`cannot pull from ${service}`);
  const remote = new Map();
  for (const row of await API[service].list(token)) {
    // The same media can sit in more than one AniList list; the furthest count
    // is the true one.
    const prev = remote.get(row.remoteId);
    if (!prev || row.chaptersRead > prev.chaptersRead) remote.set(row.remoteId, row);
  }

  const links = await db.prepare(`
    SELECT t.*, l.title, p.chapter_label
    FROM tracker_links t
    JOIN library l ON l.id = t.library_id
    LEFT JOIN progress p ON p.library_id = t.library_id AND p.user_id = t.user_id
    WHERE t.user_id = ? AND t.service = ? AND t.state = 'linked' AND l.deleted = 0
  `).all(userId, service);

  const out = { service, listed: remote.size, updated: 0, ahead: [] };
  for (const link of links) {
    const mine = remote.get(String(link.remote_id));
    if (!mine) continue;
    if (link.last_chapter !== mine.chaptersRead || link.remote_status !== mine.folder) {
      await writeLink(userId, link.library_id, service, mine.chaptersRead, mine.folder);
      out.updated++;
    }
    // Where the tracker is genuinely further along than the bookmark: read on
    // the phone, in the tracker's own app, somewhere that is not PanelFlow.
    const here = chapterNumber(link.chapter_label);
    if (mine.chaptersRead > (here ?? 0)) {
      out.ahead.push({
        libraryId: link.library_id,
        title: link.title,
        here,
        there: mine.chaptersRead,
      });
    }
  }
  out.ahead.sort((a, b) => (b.there - (b.here ?? 0)) - (a.there - (a.here ?? 0)));
  // The service just answered, at length, so whatever it last refused is over.
  // This is also the way out of a stuck error for a reader who reconnected: the
  // next page turn would clear it too, but only when they next read something.
  await db.prepare(
    'UPDATE trackers SET last_error = NULL, last_error_at = NULL WHERE user_id = ? AND service = ?',
  ).run(userId, service);
  return out;
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
