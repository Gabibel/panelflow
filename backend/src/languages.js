// A series' language, spelled one way.
//
// Two spellings reached the server. The extension and the phone file a series
// under an English word ("French", "Chinese (Simplified)"); the website and the
// AniList import filed it under a code ("fr", "zh"). So the website showed "—"
// for the extension's series and wiped the value on its next save, the
// extension's sheet showed "fr" as a chip of its own, and a series filed under
// "Chinese (Simplified)" — twenty characters, against a limit of sixteen — was
// refused at every sync and never reached the account (QA It.7, n° 1 and 2).
//
// The English word is the stored form: it is what the export writes, and what
// every client names in the reader's language (shared/i18n.js, languageName).
// A code, or the word in another case, becomes it on the way in and on the way
// out, so rows written before this read back the same as new ones. A value
// outside the list — a page can declare any language — is kept as it came.

export const LANGUAGE_NAMES = [
  'English', 'Japanese', 'Korean', 'Chinese (Simplified)', 'Chinese (Traditional)', 'French', 'Spanish',
];

const BY_CODE = {
  en: 'English',
  ja: 'Japanese',
  jp: 'Japanese',
  ko: 'Korean',
  kr: 'Korean',
  zh: 'Chinese (Simplified)',
  'zh-hans': 'Chinese (Simplified)',
  'zh-cn': 'Chinese (Simplified)',
  chinese: 'Chinese (Simplified)',
  'zh-hant': 'Chinese (Traditional)',
  'zh-tw': 'Chinese (Traditional)',
  'zh-hk': 'Chinese (Traditional)',
  fr: 'French',
  es: 'Spanish',
};
const BY_NAME = Object.fromEntries(LANGUAGE_NAMES.map((name) => [name.toLowerCase(), name]));

/** The stored spelling of a language; null for none; undefined left alone. */
export function normalizeLanguage(value) {
  if (value === undefined || value === null) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/_/g, '-');
  return BY_NAME[key] ?? BY_CODE[key] ?? raw;
}
