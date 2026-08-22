// The translation layer the extension actually ships, for the tests that boot a
// piece of it.
//
// Every UI test in here asserts the words a reader sees. A stub `t` returning
// its own key would keep all of them green while the strings rotted, so this
// helper wires the real i18n.js to the real extension/_locales/en/messages.json
// instead — which turns each of those assertions into a check that the key
// exists, is spelled right, and still says what the test says it says.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/** i18n.js verbatim, for a harness that runs sources in a vm context. */
export const I18N_SRC = read('extension/i18n.js');

export const MESSAGES = JSON.parse(read('extension/_locales/en/messages.json'));

/**
 * `chrome.i18n`, as the browser implements the parts this codebase uses:
 * `$1`…`$9` are replaced from `subs`, `$$` is a literal dollar, and a key that
 * is in no locale at all comes back empty rather than throwing.
 */
export const i18n = {
  getMessage(key, subs) {
    const entry = MESSAGES[key];
    if (!entry) return '';
    const list = subs == null ? [] : [].concat(subs);
    return entry.message.replace(/\$(\$|[1-9])/g, (_, d) => (d === '$' ? '$' : list[d - 1] ?? ''));
  },
  getUILanguage: () => 'en',
};

/** The same function the extension's own files call. */
export const t = (key, subs) => i18n.getMessage(key, subs) || key;

/**
 * For a harness that passes free names in as arguments rather than globals.
 *
 * `ready` is already resolved and `reload` finds nothing, which is the browser
 * -language case — the chosen-language path is driven against the real i18n.js
 * in i18n-language.test.js, where a storage exists to hold a choice.
 */
export const PanelFlowI18n = {
  t,
  apply() {},
  markLanguage() {},
  reload: async () => null,
  ready: Promise.resolve(null),
  LANGS: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }],
};

/**
 * `shared/i18n.js` as the website and the phone see it, over a language the
 * test holds.
 *
 * The real one writes to localStorage and repaints a document. What the pages
 * lifted into these tests act on is narrower: what the language is now, whether
 * setting it actually moved the sentences, and whether the account's answer
 * differs from this browser's. `t` is the real catalogue, so an assertion about
 * a sentence is still an assertion about a key that exists.
 */
export const webI18n = (start = 'auto') => {
  const state = { lang: start, applied: 0, asked: [] };
  const api = {
    t,
    get: () => state.lang,
    apply() { state.applied++; },
    markLanguage() {},
    set(value) {
      state.asked.push(value);
      const moved = value !== state.lang;
      state.lang = value;
      api.apply();
      return moved;
    },
    // A shrug is not an instruction, and neither is an answer this browser has
    // already given itself.
    adopt: (value) => (value == null || value === state.lang ? false : api.set(value)),
  };
  return { api, state };
};

/** Adds `i18n` to a stub `chrome` in place, and hands it back. */
export const withI18n = (chrome) => Object.assign(chrome, { i18n });
