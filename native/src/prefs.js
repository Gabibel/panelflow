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

/**
 * The reader's own object, as this client defaults it.
 *
 * Two of these differ from the extension's, deliberately, because a phone is
 * not a browser: chaining to the next chapter and hiding chapters you have
 * already read are both on. On a desktop you have a tab bar and a mouse and
 * chapter lists are cheap to walk; on a phone the whole point of opening the
 * app is to carry on, and a list of two hundred chapters with no marks on it is
 * the thing you cannot navigate with a thumb.
 *
 * The account still wins wherever it has an opinion. These only decide what
 * happens on a phone nobody has told anything yet.
 */
const READER_DEFAULTS = {
  autoNext: true, hideRead: true, tapZones: 'sides', readerDark: true,
};

/**
 * And the reader opens by itself on a chapter page — here, always.
 *
 * On the desktop the pill is the right answer: PanelFlow is a guest in a tab
 * you opened for other reasons, and hijacking it would be rude. A phone that
 * has just been asked to open a chapter has no other purpose for that screen,
 * and one tap on a pill is one tap too many.
 *
 * So this is not a default on this client, it is the behaviour: there is no
 * switch for it on the phone, and the account's answer is deliberately not
 * consulted. Somebody who turned the pill on at a desk did not thereby ask for
 * an extra tap on every chapter they open on a train.
 */
const AUTO_SHOW_ALWAYS = true;

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
    // Reported so a screen could show it; not offered, and not overridable.
    autoShow: AUTO_SHOW_ALWAYS,
    reader: { ...READER_DEFAULTS, ...local.readerPrefs,
      ...pick(account, ['autoNext', 'hideRead', 'tapZones', 'readerDark']) },
    checkIntervalMin: account.checkIntervalMin ?? install.checkIntervalMin,
  };
}

/**
 * Put the defaults where the injected reader will actually find them.
 *
 * `detect.js` reads `autoShowDefault` and `reader.js` reads `readerPrefs`, both
 * straight out of the store — they never see `readPrefs` above. So a default
 * that only exists in this file is a default the reader does not have, which is
 * why the reader kept opening with the extension's answers rather than the
 * phone's.
 *
 * Only ever fills a blank. The account's answer wins where it has one, and a
 * value the reader itself wrote — mid-chapter, from its own panel — is never
 * overwritten here.
 */
export async function seedLocalDefaults() {
  const [accounted, stored] = await Promise.all([
    send({ type: 'getAccountPrefs' }),
    send({ type: 'storageGet', keys: ['autoShowDefault', 'readerPrefs'] }),
  ]);
  const account = accounted?.prefs || {};
  const local = stored?.values || {};
  const patch = {};

  // Written every launch rather than only when blank: the account can carry a
  // `false` here from a desktop, and on this client that answer does not apply.
  if (local.autoShowDefault !== AUTO_SHOW_ALWAYS) patch.autoShowDefault = AUTO_SHOW_ALWAYS;
  const reader = { ...local.readerPrefs };
  for (const [key, value] of Object.entries(READER_DEFAULTS)) {
    if (reader[key] === undefined) reader[key] = account[key] ?? value;
  }
  if (JSON.stringify(reader) !== JSON.stringify(local.readerPrefs || {})) {
    patch.readerPrefs = reader;
  }
  if (Object.keys(patch).length) await send({ type: 'storageSet', values: patch });
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
  // `autoShow` is not on this list. The phone does not offer that choice, so it
  // has none to push onto an account the desktop shares.
  const account = pick(patch, [
    'uiLang', 'theme', 'readerMode', 'checkIntervalMin',
    'autoNext', 'hideRead', 'tapZones', 'readerDark',
  ]);
  if (Object.keys(account).length) await send({ type: 'setAccountPrefs', patch: account });

  // What the reader looks up on a page. `readerPrefs` is merged and never
  // replaced: brightness and the reader's own state live in that object and are
  // written from inside the reader, where a settings screen cannot see them.
  const local = {};
  if ('readerMode' in patch) local.readerMode = patch.readerMode;
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
