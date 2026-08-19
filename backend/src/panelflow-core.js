// ESM face for shared/panelflow-core.js — see backend/src/series-match.js for
// why the shared files are plain IIFEs rather than modules.
import './series-match.js'; // publishes globalThis.PanelFlowMatch, required first
import './prefs.js';        // and globalThis.PanelFlowPrefs, for saveAccountPrefs
import '../../shared/panelflow-core.js';

export const {
  createCore, createHub, maxChapterIn, labelNum, cleanTitle, DEFAULTS,
  challengePage, chapterApiUrl, maxChapterInApi, pageApiUrl, pagesFromApi,
} = globalThis.PanelFlowCore;
