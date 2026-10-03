// What an episode page is: the series, its season, the episode on screen.
//
// Two scripts ask, and they used to answer apart. The video bar
// (extension/content/video-speed.js) files an episode from the player; the
// detector's "Add to library" (extension/content/detect.js), which the
// extension's popup and the phone's browser button both reach, files the same
// page from outside it. The bar had learnt to read Crunchyroll's structured
// data, the season and an episode picker; the detector still took the page's
// title, so the same episode page gave two different titles depending on the
// button pressed (owner's request, October 2026: the phone has to get the same
// changes). One answer, here, for both.
//
// Plain script, not a module: content scripts cannot be ESM. It reads
// `document` and `location` when it is asked, never when it loads, so a page
// that changes episode without loading (Crunchyroll, a picker) is read as it
// is now. Copied to extension/shared by `npm run sync:shared`, and baked into
// the phone's injected bundle by scripts/build-native-inject.mjs.
(function (root) {
  'use strict';

  /** A whole number from 1 to 9999 in `v` ("Saison 4", 4, "12"), or null. */
  function numberOf(v) {
    const m = /\d+/.exec(String(v ?? ''));
    const n = m ? Number(m[0]) : NaN;
    return n >= 1 && n < 10000 ? n : null;
  }

  /**
   * The episode as the page describes it to search engines, when it does.
   *
   * schema.org's TVEpisode names the series, the season and the episode
   * outright, and the licensed platforms publish it. Crunchyroll titles its
   * pages "Saison 4 | E1 - Un nouveau quotidien", which names neither the
   * series nor, in any shape a pattern can count on, the episode, so the bar
   * had nothing to add (owner's report, September 2026). The data under the
   * page says "Moi, quand je me réincarne en Slime", season 4, episode 1.
   *
   * Read once per moment rather than once per question: describe() reaches it
   * through four functions, and the video bar asks again each time the page
   * moves, a few times a second on a streaming page. The data change with the
   * episode, never within the same tenth of a second.
   */
  let readAt = -Infinity;
  let lastRead = null;
  function structuredEpisode() {
    const now = Date.now();
    if (now - readAt < 100) return lastRead;
    readAt = now;
    lastRead = readStructuredEpisode();
    return lastRead;
  }

  function readStructuredEpisode() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(script.textContent || ''); } catch { continue; }
      const found = episodeIn(data, 0);
      if (found) return found;
    }
    return null;
  }

  function episodeIn(node, depth) {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = episodeIn(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const types = [].concat(node['@type'] || []);
    if (types.some((type) => type === 'TVEpisode' || type === 'Episode')) {
      const series = node.partOfSeries || node.partOfTVSeries;
      const name = typeof series === 'string' ? series : series?.name;
      if (!name || typeof name !== 'string') return null;
      return {
        series: name.replace(/\s+/g, ' ').trim(),
        seriesUrl: typeof series === 'object' ? (series['@id'] || series.url || null) : null,
        season: numberOf(node.partOfSeason?.seasonNumber ?? node.partOfSeason?.name),
        episode: numberOf(node.episodeNumber),
      };
    }
    return episodeIn(node['@graph'], depth + 1);
  }

  /** The series title, without the site's own furniture around it. */
  function pageTitle() {
    const og = document.querySelector('meta[property="og:title"]')?.content;
    const raw = (og || document.title || '').trim();
    // "Détective Conan Saison 30 Episode 3 VOSTFR - <site>" — the season and
    // episode are progress, not the name of the work, and the tail is the site.
    return raw
      .replace(/\s*[-–|]\s*[^-–|]*$/, '')
      .replace(/\s*(saison|season)\s*\d+.*$/i, '')
      .replace(/\s*(episode|épisode|ep\.?)\s*\d+.*$/i, '')
      // "Cyberpunk : Edgerunners - Saison 1 | <site>" left its dash behind.
      .replace(/[\s\-–|:]+$/, '')
      .trim() || raw;
  }

  /**
   * Which season this episode belongs to, when anything on the page says so.
   *
   * A season is a work of its own to a tracker: "Tensei Shitara Slime Datta
   * Ken 3rd Season" is its own entry on AniList, numbered from episode 1. The
   * season used to be cut off with the site's name, and episodes of season 3
   * were counted on season 1.
   */
  function seasonNumber() {
    const ld = structuredEpisode();
    if (ld?.season) return ld.season;
    const inPath = /[/_-](?:saison|season)[-_ ]?(\d+)(?=[/_-]|$)/i.exec(location.pathname)
      || /[?&](?:s|season|saison)=(\d+)(?:&|$)/i.exec(location.search);
    if (inPath) return numberOf(inPath[1]);
    const titled = /(?:^|[\s|–-])(?:saison|season)\s*(\d+)\b/i.exec(document.title || '');
    return titled ? numberOf(titled[1]) : null;
  }

  /** "Saison" on a page in French, "Season" elsewhere: the title reads as the site does. */
  const seasonWord = () => (/^fr\b/i.test(document.documentElement?.lang || '') ? 'Saison' : 'Season');

  /**
   * What this page is, for the sheet: the series and its season, the series'
   * page, and the episode on screen.
   *
   * Worked out again each time it is asked and not once at load: Crunchyroll
   * changes episode without loading a page, and so does a site's episode picker,
   * so an answer kept from the start filed the first episode seen, under the
   * first title seen.
   */
  function describe() {
    const ld = structuredEpisode();
    const name = ld?.series || pageTitle();
    const season = seasonNumber();
    const episode = episodeNumber();
    return {
      // Season 1 is the work's own name; any later one is said, as the
      // catalogues say it.
      title: season > 1 ? `${name} ${seasonWord()} ${season}` : name,
      sourceUrl: seriesHome(ld, season),
      sourceDomain: location.hostname.replace(/^www\./, ''),
      coverUrl: document.querySelector('meta[property="og:image"]')?.content || null,
      // The whole reason the column exists: this is what a tracker routes on
      // to say episodes rather than chapters.
      medium: 'anime',
      ...(episode ? { chapterLabel: `Episode ${episode}`, chapterUrl: episodeAddress(episode, ld) } : {}),
    };
  }

  /**
   * An address of this episode's own.
   *
   * Most sites give each episode one. A site that plays a whole season from
   * one address, the episode chosen in a picker or with its "next episode"
   * button, gives none, and every episode was filed under the season's: one
   * row of history for twenty episodes, counted as one watched. The episode
   * goes in the fragment, which the site ignores and the library keys on.
   */
  function episodeAddress(episode, ld) {
    const own = EPISODE_IN_PATH.test(location.pathname) || EPISODE_IN_QUERY.test(location.search) || ld?.episode;
    if (own) return location.href;
    const u = new URL(location.href);
    u.hash = `episode-${episode}`;
    return u.href;
  }

  /**
   * The series' own page when the episode names one on this site, the
   * episode's address without its query otherwise. A season after the first
   * goes in the query: Crunchyroll keeps every season on one series page, and
   * one entry per season is what keeps each one's episodes counting
   * (series-match.js, seriesKey).
   */
  function seriesHome(ld, season) {
    const here = location.hostname.replace(/^www\./, '');
    let url = null;
    try {
      const u = ld?.seriesUrl ? new URL(ld.seriesUrl, location.href) : null;
      if (u && /^https?:$/.test(u.protocol) && u.hostname.replace(/^www\./, '') === here) url = u;
    } catch { /* a series page that is not an address */ }
    if (!url) return location.origin + location.pathname;
    url.hash = '';
    if (season > 1) url.searchParams.set('season', String(season));
    return url.href;
  }

  const EPISODE_WORD = /(?:episode|épisode|ep)[-_/ .]*(\d+(?:\.\d+)?)/i;

  /**
   * The episode this page is: from the address, else from the page.
   *
   * Some sites keep one address per season (/catalogue/<slug>/saison1/vostfr/)
   * and change the episode in a <select> without navigating, so the address
   * says nothing and the selected option is the only thing that does. A
   * heading that names the episode is read the same way.
   */
  const EPISODE_IN_PATH = /[/_-](?:episode|épisode|ep)[-_/ ]?(\d+(?:\.\d+)?)/i;
  const EPISODE_IN_QUERY = /[?&](?:episode|ep)=(\d+(?:\.\d+)?)/i;

  const episodeNumber = () => {
    // In the path (/episode-3/, /ep-34) or, as some sites write it, in the
    // query (?ep=12).
    const m = EPISODE_IN_PATH.exec(location.pathname) || EPISODE_IN_QUERY.exec(location.search);
    if (m) return m[1];
    // What the page tells search engines (Crunchyroll: "E1" and nothing else).
    const ld = structuredEpisode();
    if (ld?.episode) return String(ld.episode);
    const chosen = episodeSelect()?.selectedOptions?.[0]?.textContent;
    const fromSelect = chosen && EPISODE_WORD.exec(chosen);
    if (fromSelect) return fromSelect[1];
    for (const el of document.querySelectorAll('h1, h2, h3, .episode-title, [class*="episode"]')) {
      const hit = EPISODE_WORD.exec((el.textContent || '').slice(0, 120));
      if (hit) return hit[1];
    }
    return null;
  };

  /** A <select> whose options are episodes, if the page picks them that way. */
  function episodeSelect() {
    for (const sel of document.querySelectorAll('select')) {
      const opts = [...sel.options].slice(0, 3);
      if (opts.length && opts.every((o) => EPISODE_WORD.test(o.textContent || ''))) return sel;
    }
    return null;
  }

  /**
   * Whether this page is an episode of something, judged by what it holds
   * when its host is not on the list: a page that says it is an episode, a
   * <video>, a player in a frame from a listed host, or an episode picker.
   * The list stays the first answer; this is for the domain the site moved to
   * last week, and for the platforms nobody lists because they are not
   * pirate sites (Crunchyroll, turned on with "all sites").
   */
  function looksLikeVideoPage(known) {
    if (structuredEpisode()) return true;
    if (document.querySelector('meta[property="og:type"]')?.content === 'video.episode') return true;
    if (document.querySelector('video')) return true;
    if (episodeSelect()) return true;
    const here = location.hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    for (const f of document.querySelectorAll('iframe[src]')) {
      let h = '';
      try { h = new URL(f.src).hostname.replace(/^www\./, ''); } catch { continue; }
      if (known.some((k) => h === k || h.endsWith(`.${k}`))) return true;
      // A frame from another site on a page that names an episode is a
      // player whose host nobody has listed yet: the twelve sites opened on
      // 20 September all fit this shape. Adverts and comment widgets are frames too, so they are named
      // out, and a number is still required.
      const other = h.split('.').slice(-2).join('.') !== here;
      if (other && !AD_FRAME.test(h) && episodeNumber()) return true;
    }
    return false;
  }
  /** Frames that are never a player: adverts, comments, consent. */
  const AD_FRAME = /(a-ads|adsterra|doubleclick|googlesyndication|disqus|facebook|twitter|recaptcha|cloudflare|criteo|monetix|pushub|propeller)/i;

  root.PanelFlowEpisode = {
    numberOf, structuredEpisode, pageTitle, seasonNumber, describe,
    episodeNumber, episodeSelect, looksLikeVideoPage, AD_FRAME,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
