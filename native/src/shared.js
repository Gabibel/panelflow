// The shared modules, as imports rather than globals.
//
// `shared/folders.js` and the rest are plain IIFEs that hang themselves off
// `globalThis` — they have to be, because Chrome MV3 content scripts cannot be
// modules. Importing `core.js` first is what guarantees they have run; naming
// them here is what keeps `globalThis.PanelFlowFolders` out of every screen.
import './core.js';

export const Folders = globalThis.PanelFlowFolders;
export const Shelf = globalThis.PanelFlowView;   // library-view.js: order, and what is new
export const Sites = globalThis.PanelFlowSites;
export const Prefs = globalThis.PanelFlowPrefs;
