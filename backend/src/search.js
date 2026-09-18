// ESM face of shared/search.js, the way series-match.js and prefs.js have one:
// the shared file publishes itself on globalThis because content scripts
// cannot be modules, and this re-export keeps the server idiomatic while the
// parser stays the one the phone runs.
import '../../shared/series-match.js';
import '../../shared/search.js';

export const {
  DDG,
  MAX_RESULTS,
  scanQuery,
  parseDuckDuckGo,
  parseBrave,
  unwrap,
  decodeEntities,
} = globalThis.PanelFlowSearch;
