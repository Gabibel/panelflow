// How a library is ordered and narrowed — once, for every screen that shows one.
//
// The popup and the web app render the same shelf from the same rows, and a
// user who sorts by score in one and finds a different order in the other has
// found a bug even though both are "working". So the rule lives here and both
// call it.
//
// Everything below is pure: rows in, rows out, no storage and no DOM. Progress
// is reached through a callback because the two clients key it differently —
// the extension by source URL, the web app by library id — and neither shape is
// this module's business.
//
// Plain script, not a module: Chrome content scripts and the extension's own
// pages cannot be ESM. The copies under extension/shared and web/shared are
// generated from this file — run `npm run sync:shared` after editing.
(function (root) {
  'use strict';

  /** The orders offered, in the order they are offered. */
  const SORTS = [
    { id: 'updated', label: 'Recently updated', dir: 'desc' },
    { id: 'added', label: 'Recently added', dir: 'desc' },
    { id: 'title', label: 'Title', dir: 'asc' },
    { id: 'chapter', label: 'Latest chapter', dir: 'desc' },
    { id: 'behind', label: 'Chapters behind', dir: 'desc' },
    { id: 'score', label: 'Score', dir: 'desc' },
    { id: 'site', label: 'Site', dir: 'asc' },
  ];

  const SORT_IDS = SORTS.map((s) => s.id);

  /**
   * The kinds of work, in the order a filter row offers them.
   *
   * The same five words on every surface: the library filter, the type picker
   * of a series' sheet, the phone's shelves. `label` is the fallback when no
   * translation is loaded, like SORTS' — the clients say them through
   * `medium_<id>`.
   *
   * Web novels and light novels are two entries and not one "novel": they are
   * two shelves to the people who read both, even though nothing on a page can
   * tell them apart — which is why a series' type can be changed by hand.
   */
  const MEDIA = [
    { id: 'manga', label: 'Manga' },
    { id: 'webtoon', label: 'Webtoon' },
    { id: 'webnovel', label: 'Web novel' },
    { id: 'lightnovel', label: 'Light novel' },
    { id: 'anime', label: 'Anime' },
  ];
  const MEDIUM_IDS = MEDIA.map((m) => m.id);

  // The one spelling an earlier version wrote: every prose site was a "novel",
  // and a reading site hosting prose is a web novel far more often than not.
  // Read, never written — the server rewrites its rows once (db.js).
  const LEGACY_MEDIUM = { novel: 'webnovel' };

  /** What kind of work a library row is, whatever version wrote it. */
  function mediumOf(entry) {
    const m = String((entry && entry.medium) || '');
    if (MEDIUM_IDS.indexOf(m) !== -1) return m;
    return LEGACY_MEDIUM[m] || 'manga';
  }

  /**
   * Whether a series is counted in episodes rather than chapters.
   *
   * An anime's "chapter 10" is its tenth episode, and every line that says
   * "ch." about one — the card, the badge, the gap, the tracker's count — reads
   * as a bug to the person watching it. The number is the same number; only
   * the word changes, and it changes through `unitKey`.
   */
  const episodic = (entry) => mediumOf(entry) === 'anime';

  // Every message that names a chapter, and its episode twin. One table, so a
  // client asks "how do I say this about that series" instead of choosing
  // between two keys at each of the thirty places that print a count.
  const EPISODE_KEYS = {
    chapterN: 'episodeN',
    chapterBadge: 'episodeBadge',
    badgeNewChapter: 'badgeNewEpisode',
    badgeNewChapterNo: 'badgeNewEpisodeNo',
    webLatestChapter: 'webLatestEpisode',
    webOneBehind: 'webOneEpisodeBehind',
    webNBehind: 'webNEpisodesBehind',
    webChaptersAhead: 'webEpisodesAhead',
    webFieldChapter: 'webFieldEpisode',
    webNewChapterOut: 'webNewEpisodeOut',
    chaptersShort: 'episodesShort',
    mobileTrackerChapters: 'mobileTrackerEpisodes',
    mobileNewChaptersOne: 'mobileNewEpisodesOne',
    mobileNewChaptersMany: 'mobileNewEpisodesMany',
    modalTrackerAdded: 'modalTrackerAddedEpisode',
    trackerUpToChapter: 'trackerUpToEpisode',
    actionReadChapter: 'actionWatchEpisode',
    notifyNewChapterTitle: 'notifyNewEpisodeTitle',
    notifyNewChapterBody: 'notifyNewEpisodeBody',
    webOneNewChapter: 'webOneNewEpisode',
    webNNewChapters: 'webNNewEpisodes',
    webNewChapter: 'webNewEpisode',
    actionRead: 'actionWatch',
  };

  /** The message to say `key` with about `entry`: its episode twin for an anime. */
  const unitKey = (key, entry) => (episodic(entry) && EPISODE_KEYS[key]) || key;
  const DEFAULT_SORT = 'updated';

  const num = (v) => {
    const m = /\d+(?:\.\d+)?/.exec(String(v == null ? '' : v));
    return m ? Number(m[0]) : null;
  };

  const text = (v) => String(v == null ? '' : v);

  /**
   * A progress row's bookmark: the furthest chapter reached, which a reread
   * never moves back (arbitrage e of the QA report, September 2026). The row's
   * own chapter is the last one opened; a row from before the two were kept
   * apart has only that, and it is its bookmark, as it always was. Same field
   * names either way, so a screen reads `.chapterLabel` off whichever it gets.
   */
  function bookmarkOf(progress) {
    if (!progress) return null;
    return progress.furthest && progress.furthest.chapterUrl ? progress.furthest : progress;
  }

  /**
   * How many chapters are out that have not been read — counted from the
   * bookmark, so rereading chapter 9 does not bring back chapters 10 and 11.
   * Null when either end is unknown — which is not the same as zero, and
   * sorting them as zero would bury every series nobody has measured yet.
   */
  function chaptersBehind(entry, progress) {
    const latest = num(entry && entry.lastKnownChapter);
    if (latest === null) return null;
    const mark = bookmarkOf(progress);
    const here = num(mark && mark.chapterLabel);
    if (here === null) return null;
    return Math.max(0, latest - here);
  }

  // --- news, which is arithmetic plus a folder ---------------------------------
  //
  // Being behind and having news are not the same thing. A series filed under
  // Completed or Dropped keeps whatever gap the last check left behind, forever,
  // and every screen went on announcing it: a finished series wearing a "3 new"
  // badge for the rest of its life.
  //
  // shared/folders.js already answers this — WATCHED is the folders the chapter
  // watcher looks at, and the server obeys it. The clients did not, so the
  // watcher stopped checking and the shelves kept shouting. Same list, read from
  // the same place, so the two can never drift apart again.
  //
  // Read off the global at call time rather than captured at load: the two files
  // are plain scripts and nothing here controls which of them the page put
  // first. Missing entirely, every folder counts as watched — that is what this
  // module did before folders existed, and losing news is worse than the badge
  // this fixes.
  function watching(entry, categories) {
    const F = root.PanelFlowFolders;
    if (!F) return true;
    const folder = (entry && entry.folder) || F.DEFAULT_FOLDER;
    return F.WATCHED.indexOf(F.folderStatus(folder, categories)) !== -1;
  }

  /**
   * How many chapters are news: out, unread, and in a folder still following the
   * series. Zero rather than null when there is nothing to say, because this is
   * a badge and a badge is drawn or it is not.
   *
   * `chaptersBehind` stays the plain measurement and stays ungated — a completed
   * series that stopped three short really is three short, and that is what the
   * "Chapters behind" order sorts on.
   */
  function newChapters(entry, progress, categories) {
    if (!watching(entry, categories)) return 0;
    return chaptersBehind(entry, progress) ?? 0;
  }

  /** Whether a chapter is out that this reader has not reached. */
  const hasUnread = (entry, progress, categories) => newChapters(entry, progress, categories) > 0;

  // --- how far through, in three states --------------------------------------
  //
  // MangaPin colours what it lists — grey for read, orange for not, half-orange
  // for the one you stopped in the middle of — and that colour is the first
  // thing anyone looks at when they reopen a series. PanelFlow said the same
  // things, in words, spread over four lines of a card.
  //
  // The states are named here rather than in each screen because the web shelf
  // and the popup draw the same rows, and two implementations of "have I read
  // this" is two chances to say different things about one series on one day.
  //
  // Only whole series are graded here. The reader's chapter wheel colours a
  // list of chapters instead, and answers that from the set of chapters the
  // history has rows for — a set this module is never given and should not
  // pretend to hold.

  const READ = 'read';
  const READING = 'reading';
  const UNREAD = 'unread';

  /** Whether a bookmark stopped in the middle of its chapter. */
  const partway = (progress) => !!progress
    && progress.pageCount > 1
    && (progress.page || 0) < progress.pageCount - 1;

  /**
   * Where a series stands, in one word a colour can be picked from.
   *
   * Unread outranks reading deliberately: being three chapters behind is the
   * thing worth seeing from across the room, and being nine pages into the one
   * before them is not. A series never opened is unread, which is why a missing
   * bookmark answers before anything is measured — `chaptersBehind` cannot tell
   * "nothing published yet" from "nothing read yet", and would call both level.
   */
  function readState(entry, progress, categories) {
    if (!progress || !progress.chapterUrl) return UNREAD;
    if (hasUnread(entry, progress, categories)) return UNREAD;
    return partway(bookmarkOf(progress)) ? READING : READ;
  }

  // Missing values go last in every order, ascending or descending alike. A
  // series with no score is not "worst" and not "best" — it is unrated, and it
  // belongs at the bottom of a list sorted by score either way.
  const NOWHERE = Symbol('missing');

  function keyOf(id, entry, progress) {
    switch (id) {
      case 'added': return text(entry.dateAdded) || NOWHERE;
      case 'title': return text(entry.title).toLowerCase() || NOWHERE;
      case 'chapter': return num(entry.lastKnownChapter) ?? NOWHERE;
      case 'behind': return chaptersBehind(entry, progress) ?? NOWHERE;
      case 'score': return typeof entry.score === 'number' ? entry.score : NOWHERE;
      case 'site': return text(entry.sourceDomain).toLowerCase() || NOWHERE;
      default: return text(entry.updatedAt) || NOWHERE;
    }
  }

  const compare = (a, b) =>
    (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));

  /**
   * A copy of `entries` in the requested order.
   * @param {Array} entries
   * @param {object} [opts]
   * @param {string} [opts.by]          one of SORT_IDS
   * @param {'asc'|'desc'} [opts.dir]   defaults to the order's own direction
   * @param {Function} [opts.progressOf] entry → progress row, for 'behind'
   */
  function sortLibrary(entries, opts) {
    const o = opts || {};
    const spec = SORTS.find((s) => s.id === o.by) || SORTS[0];
    const sign = (o.dir === 'asc' ? 1 : o.dir === 'desc' ? -1 : (spec.dir === 'asc' ? 1 : -1));
    const progressOf = o.progressOf || (() => null);

    return (entries || []).slice().sort((a, b) => {
      const ka = keyOf(spec.id, a, progressOf(a));
      const kb = keyOf(spec.id, b, progressOf(b));
      if (ka === NOWHERE || kb === NOWHERE) {
        if (ka === kb) return text(a.title).localeCompare(text(b.title));
        return ka === NOWHERE ? 1 : -1;
      }
      const d = compare(ka, kb) * sign;
      // A stable, meaningful tie-break: two series with the same score, or the
      // same site, would otherwise sit in whatever order they arrived in and
      // shuffle every time the list is rebuilt.
      return d || text(a.title).localeCompare(text(b.title));
    });
  }

  // `String(null)` is "null", which is how a hole in a tag array becomes a tag
  // called null in the filter row.
  const tagsOf = (entry) => (Array.isArray(entry && entry.tags) ? entry.tags : [])
    .map((t) => (t == null ? '' : String(t).trim())).filter(Boolean);

  /**
   * @param {Array} entries
   * @param {object} [opts]
   * @param {string} [opts.query]    matched against the title and the site
   * @param {string} [opts.folder]   'all' or a folder id
   * @param {Function} [opts.folderOf] entry → folder id, for clients that fold
   *   a folder they do not know about into one they do
   * @param {string[]} [opts.tags]   every one of them must be present
   * @param {boolean} [opts.unreadOnly]
   * @param {Array} [opts.categories] the account's own shelves, so a series in
   *   one of them is judged by the status it stands for
   * @param {Function} [opts.progressOf]
   * @param {string} [opts.medium]  'all' or one of MEDIUM_IDS
   */
  function filterLibrary(entries, opts) {
    const o = opts || {};
    const q = String(o.query || '').trim().toLowerCase();
    const folder = o.folder && o.folder !== 'all' ? o.folder : null;
    const folderOf = o.folderOf || ((e) => e.folder || 'reading');
    // Lower-cased on both sides: a tag typed as "Shonen" in the editor and
    // picked as "shonen" from the filter is the same tag.
    const want = (o.tags || []).map((t) => String(t).toLowerCase());
    const progressOf = o.progressOf || (() => null);
    const medium = o.medium && o.medium !== 'all' ? o.medium : null;

    return (entries || []).filter((entry) => {
      if (folder && folderOf(entry) !== folder) return false;
      if (medium && mediumOf(entry) !== medium) return false;
      if (q && !(`${text(entry.title)} ${text(entry.sourceDomain)}`.toLowerCase().includes(q))) {
        return false;
      }
      if (want.length) {
        const have = tagsOf(entry).map((t) => t.toLowerCase());
        // AND, not OR: picking a second tag is asking for less, not more.
        for (let i = 0; i < want.length; i++) if (have.indexOf(want[i]) === -1) return false;
      }
      if (o.unreadOnly && !hasUnread(entry, progressOf(entry), o.categories)) return false;
      return true;
    });
  }

  /**
   * Every tag in the library with how many series carry it, commonest first.
   * Keeps the first spelling seen, so a filter chip reads the way the user
   * typed it rather than folded to lower case.
   */
  function tagCounts(entries) {
    const counts = new Map();
    for (const entry of entries || []) {
      for (const tag of tagsOf(entry)) {
        const key = tag.toLowerCase();
        const seen = counts.get(key);
        if (seen) seen.count++;
        else counts.set(key, { tag, count: 1 });
      }
    }
    return [...counts.values()]
      .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
  }

  root.PanelFlowView = {
    SORTS, SORT_IDS, DEFAULT_SORT,
    MEDIA, MEDIUM_IDS, mediumOf, episodic, unitKey, EPISODE_KEYS,
    sortLibrary, filterLibrary, tagCounts, chaptersBehind, newChapters, hasUnread, bookmarkOf,
    READ, READING, UNREAD, readState,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
