// Every setting the app shows, gathered from wherever it happens to live.
//
// There are three homes, and which one a setting is in is not arbitrary:
//
//   the account   what should follow the reader between devices — the theme,
//                 the language, the reading direction (shared/prefs.js says
//                 what may be stored and validates it, server-side too)
//   this device   what the injected reader reads on a page: `readerMode`,
//                 `readerPrefs`, `autoShowDefault`. detect.js and reader.js
//                 look those up in `chrome.storage.local`, which on a phone is
//                 the same store, reached through chrome-shim.js
//   the install   the backend URL and the check interval — `core.getSettings`
//
// A settings screen that wrote only the first would be a screen whose switches
// do nothing until the next sign-in, because the reader never looks there.
//
// The twin of `getPrefs`/`setPrefs` in `extension/background.js`, which does
// exactly this for the browser. The two are not shared code yet and should be:
// a second answer to "where does tapZones live" is how two surfaces start
// disagreeing about it. Until then, that file is the one to read beside this.
import { send } from './core.js';

/** The reader's own object, as the extension defaults it. */
const READER_DEFAULTS = {
  autoNext: false, hideRead: false, tapZones: 'sides', readerDark: true,
};

const pick = (source, keys) => Object.fromEntries(
  keys.filter((k) => k in (source || {})).map((k) => [k, source[k]]),
);

/**
 * Everything a settings screen draws, in one answer.
 *
 * The account's answers win where it has one. Where it has none — a fresh
 * account, or a setting nobody has touched — the key is simply absent and the
 * fallback is what this install already knew. That difference matters: a first
 * sign-in must not overwrite this phone's settings with a shrug.
 */
export async function readPrefs({ refresh = false } = {}) {
  if (refresh) await send({ type: 'pullAccountPrefs' });
  const [accounted, stored, settings] = await Promise.all([
    send({ type: 'getAccountPrefs' }),
    send({ type: 'storageGet', keys: ['readerMode', 'readerPrefs', 'autoShowDefault'] }),
    send({ type: 'getSettings' }),
  ]);
  const account = accounted?.prefs || {};
  const local = stored?.values || {};
  const install = settings?.settings || {};

  return {
    uiLang: account.uiLang ?? 'auto',
    theme: account.theme ?? 'system',
    readerMode: account.readerMode ?? local.readerMode ?? 'vertical',
    autoShow: account.autoShow ?? local.autoShowDefault ?? false,
    reader: { ...READER_DEFAULTS, ...local.readerPrefs,
      ...pick(account, ['autoNext', 'hideRead', 'tapZones', 'readerDark']) },
    checkIntervalMin: account.checkIntervalMin ?? install.checkIntervalMin,
  };
}

/**
 * One change, written everywhere it has to be true.
 *
 * `patch` is the flat shape above (`{ tapZones: 'edges' }`, `{ theme: 'dark' }`).
 * The account copy is the flat shape of shared/prefs.js, which the server
 * validates and drops anything it does not know; the local copy is what the
 * injected scripts read on the next page.
 */
export async function writePrefs(patch) {
  const account = pick(patch, [
    'uiLang', 'theme', 'readerMode', 'autoShow', 'checkIntervalMin',
    'autoNext', 'hideRead', 'tapZones', 'readerDark',
  ]);
  if (Object.keys(account).length) await send({ type: 'setAccountPrefs', patch: account });

  // What the reader looks up on a page. `readerPrefs` is merged and never
  // replaced: brightness and the reader's own state live in that object and are
  // written from inside the reader, where a settings screen cannot see them.
  const local = {};
  if ('readerMode' in patch) local.readerMode = patch.readerMode;
  if ('autoShow' in patch) local.autoShowDefault = !!patch.autoShow;
  const readerPatch = pick(patch, ['autoNext', 'hideRead', 'tapZones', 'readerDark']);
  if (Object.keys(readerPatch).length) {
    const stored = await send({ type: 'storageGet', keys: ['readerPrefs'] });
    local.readerPrefs = { ...(stored?.values?.readerPrefs || {}), ...readerPatch };
  }
  if (Object.keys(local).length) await send({ type: 'storageSet', values: local });

  // Through the core rather than a direct write: `set({ settings })` replaces
  // the whole object, and a settings screen knows one of its keys.
  if ('checkIntervalMin' in patch) {
    await send({ type: 'setSettings', patch: { checkIntervalMin: Number(patch.checkIntervalMin) } });
  }
}
