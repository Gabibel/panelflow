// ESM face for shared/adblock.js, which is a browser IIFE (Chrome cannot load a
// content script or a service-worker import as a module).
import '../../shared/adblock.js';

export const { flatten, toDnr, allowRules } = globalThis.PanelFlowAdblock;
