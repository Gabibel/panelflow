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
  // The client-side half: where a setting lives on a device. Re-exported so
  // the tests reach it the same way the server reaches the rest.
  READER_KEYS,
  project,
  split,
} = globalThis.PanelFlowPrefs;
