// Every setting the app shows, gathered from wherever it happens to live.
//
// The rule for *where* a setting lives and which answer wins is not here: it
// is `project` and `split` in shared/prefs.js, the same code the extension's
// worker runs. This file only knows how to fetch the three homes on this
// client (through the hub) and what this client answers differently from a
// desktop. It used to carry its own copy of the rule, and the copy drifted.
import { send } from './core.js';
import { Prefs } from './shared.js';

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
  const prefs = Prefs.project({
    account: accounted?.prefs || {},
    local: stored?.values || {},
    install: settings?.settings || {},
    readerDefaults: READER_DEFAULTS,
    autoShow: AUTO_SHOW_ALWAYS,
  });
  // `project` says null for "the account has no opinion", which a settings
  // page cannot draw; on this client the control shows the system choice.
  return { ...prefs, theme: prefs.theme ?? 'system' };
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
 * `patch` is the flat shape `readPrefs` returns (`{ tapZones: 'edges' }`,
 * `{ theme: 'dark' }`). `Prefs.split` sorts it into the three homes; this
 * function only performs the writes. `readerPrefs` is fetched first so the
 * merge keeps what the reader wrote from its own panel.
 */
export async function writePrefs(patch) {
  const stored = await send({ type: 'storageGet', keys: ['readerPrefs'] });
  const { account, local, settings } = Prefs.split(patch, {
    readerPrefs: stored?.values?.readerPrefs || {},
    // The phone does not offer the auto-show choice, so it has no answer to
    // push onto an account the desktop shares.
    pushAutoShow: false,
  });
  if (Object.keys(account).length) await send({ type: 'setAccountPrefs', patch: account });
  if (Object.keys(local).length) await send({ type: 'storageSet', values: local });
  // Through the core rather than a direct write: `set({ settings })` replaces
  // the whole object, and this screen knows two of its keys.
  if (Object.keys(settings).length) await send({ type: 'setSettings', patch: settings });
}
