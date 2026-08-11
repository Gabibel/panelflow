// ESM face for shared/compat.js.
//
// site-rules.js first: `analyze` reads `globalThis.PanelFlowSites` to work out
// which site it is looking at, and without it every page would be judged as if
// nobody had ever written a rule for it.
import '../../shared/site-rules.js';
import '../../shared/compat.js';

export const {
  analyze, pageImages, chapterLabel, latestChapter, WEIGHTS, THRESHOLD, MIN_GALLERY_IMAGES,
} = globalThis.PanelFlowCompat;
