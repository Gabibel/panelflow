// What a key says, on a phone.
//
// `shared/i18n.js` cannot be used here: it reads the choice out of
// `localStorage`, resolves 'auto' against `navigator.languages` and fills
// annotated DOM nodes — three things that do not exist in React Native. What is
// shared is the part that matters, the catalogue itself
// (`generated/messages.js`, built from `shared/_locales/`), so a sentence
// written once is read by the website, the extension, the two native shells and
// this one.
import '../generated/messages.js';

const MESSAGES = globalThis.PanelFlowMessages || {};
const DEFAULT = 'en';

/** What the settings screen offers, beside "follow the phone". */
export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
];

// Hermes ships a real Intl, so the device's own answer is available without a
// module for it. Wrapped anyway: this runs before anything is on screen, and a
// missing locale must not be a blank app.
function deviceLang() {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale).toLowerCase().split('-')[0];
  } catch {
    return DEFAULT;
  }
}

const known = (code) => LANGS.some((l) => l.code === code);

let lang = known(deviceLang()) ? deviceLang() : DEFAULT;

/**
 * Adopt the account's answer (`uiLang`, see shared/prefs.js), or 'auto'.
 *
 * Returns whether anything changed, so the caller can decide to redraw — the
 * strings are read at render time, not captured, so a screen that re-renders is
 * a screen in the new language.
 */
export function setLang(choice) {
  const next = known(choice) ? choice : (known(deviceLang()) ? deviceLang() : DEFAULT);
  if (next === lang) return false;
  lang = next;
  return true;
}

export const currentLang = () => lang;

/** `$1`…`$9`, filled from the call site — the same convention Chrome's uses. */
const fill = (message, subs) =>
  (subs ? message.replace(/\$([1-9])/g, (whole, n) => subs[n - 1] ?? whole) : message);

/**
 * Falls through to English rather than to nothing: a key a translator has not
 * reached yet is a readable English sentence, where the honest answer is a
 * blank label. The key itself is the last resort, and seeing one on screen
 * means the locale files and the source have drifted.
 */
export function t(key, subs) {
  const said = MESSAGES[lang]?.[key] ?? MESSAGES[DEFAULT]?.[key];
  return said === undefined ? key : fill(said, subs);
}
