// ESM face of shared/prefs.js — same reasoning as folders.js: that file stays a
// plain script because Chrome content scripts cannot be modules, so it
// publishes itself on globalThis and this re-export keeps the server idiomatic
// while there is still only one opinion about what a setting may be.
import '../../shared/prefs.js';

export const {
  ACCOUNT_PREFS,
  KEYS,
  MAX_HOSTS,
  cleanHost,
  clean,
  withDefaults,
} = globalThis.PanelFlowPrefs;
