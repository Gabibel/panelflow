// ESM face of shared/series-match.js.
//
// That file has to stay a plain script because Chrome content scripts cannot
// be modules, so it publishes itself on globalThis. Importing it for effect and
// re-exporting keeps the server side idiomatic — and keeps one copy of the
// matching rules, so the extension and the API never disagree about whether two
// pages are the same work.
import '../../shared/series-match.js';

export const {
  normUrl,
  seriesKey,
  sameSeries,
  normalizeTitle,
  similarity,
  bestTitleScore,
  classify,
  findMatches,
  bestMatch,
  chapterNumber,
  furtherChapter,
  STRONG,
  WEAK,
  MIN_FUZZY_LEN,
} = globalThis.PanelFlowMatch;
