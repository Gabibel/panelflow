// ESM face for shared/site-rules.js — same reasoning as compat.js and
// folders.js: that file stays a plain script because Chrome content scripts
// cannot be modules, so it publishes itself on globalThis and this re-export
// keeps the server idiomatic while there is still only one copy of the rule.
import '../../shared/site-rules.js';

export const { resolveSite, domainRule, sniffEngine, hostKeys } = globalThis.PanelFlowSites;
