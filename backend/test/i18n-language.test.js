// Reading the extension in a language the browser is not in.
//
// chrome.i18n answers in the browser's UI language and offers no way to ask for
// another one. That is a reasonable default and a wrong answer for the people
// this extension is for: someone reading French scans on a machine that boots in
// English. So a chosen language is fetched out of `_locales/` by the worker —
// the only context allowed to read that reserved directory — flattened into
// storage, and consulted by i18n.js ahead of Chrome in every context.
//
// Three ways that goes wrong, and each has a test below: the map is never
// consulted; it is consulted but the placeholders come out raw; or a key the
// chosen language happens to be missing turns into `popupOpenApp` on screen
// instead of falling back to the sentence Chrome has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { I18N_SRC, MESSAGES, i18n } from './helpers/i18n.js';
import { bootWorker } from '../test-support/worker.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const FR = JSON.parse(read('extension/_locales/fr/messages.json'));
const flat = (raw) => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.message]));

/**
 * The real i18n.js, over a storage holding whatever the reader has chosen.
 *
 * `document` is passed in rather than global: apply() and markLanguage() reach
 * for it by name, and the file is written to survive not having one.
 */
function boot(stored = {}, { storage = true } = {}) {
  const document = { documentElement: {}, querySelectorAll: () => [] };
  const self = {
    chrome: {
      i18n,
      storage: storage
        ? { local: { get: async (keys) => Object.fromEntries(
          keys.filter((k) => k in stored).map((k) => [k, stored[k]])) } }
        // A content script on a page that predates the permission: reaching for
        // storage here throws, and the extension still has to have words.
        : { get local() { throw new Error('no storage in this context'); } },
    },
  };
  new Function('self', 'document', I18N_SRC)(self, document);
  return { api: self.PanelFlowI18n, document };
}

// --- what the reader ends up seeing ------------------------------------------

test('with no choice made, the browser language is the answer', async () => {
  const { api, document } = boot();
  await api.ready;
  assert.equal(api.t('optionsTitle'), MESSAGES.optionsTitle.message);
  api.markLanguage();
  assert.equal(document.documentElement.lang, 'en');
});

test('a chosen language is used even though Chrome is in another', async () => {
  const { api, document } = boot({ uiLang: 'fr', uiMessages: flat(FR) });
  await api.ready;
  assert.equal(api.t('optionsTitle'), FR.optionsTitle.message);
  // And the page says so, which is what makes a screen reader pronounce it.
  api.markLanguage();
  assert.equal(document.documentElement.lang, 'fr');
});

test('placeholders are filled in the chosen language too', async () => {
  const { api } = boot({ uiLang: 'fr', uiMessages: flat(FR) });
  await api.ready;
  // Chrome does this substitution itself; nothing does it for a map read out of
  // storage, so without it the reader sees a literal `$1`.
  assert.equal(api.t('agoDays', ['3']), 'il y a 3 j');
  assert.equal(api.t('durationHours', ['2', '30']), '2 h 30');
  // A missing substitution leaves the marker rather than an empty gap, so an
  // under-supplied call is visible instead of silently losing the number.
  assert.equal(api.t('agoDays'), FR.agoDays.message);
});

test('a key the chosen language lacks falls back to Chrome, not to the key', async () => {
  const { api } = boot({ uiLang: 'fr', uiMessages: { optionsTitle: 'Réglages PanelFlow' } });
  await api.ready;
  assert.equal(api.t('optionsTitle'), 'Réglages PanelFlow');
  // One untranslated sentence beats a raw identifier on screen.
  assert.equal(api.t('actionSignIn'), MESSAGES.actionSignIn.message);
});

test('no storage at all is the browser-language case, not a crash', async () => {
  const { api } = boot({}, { storage: false });
  assert.equal(await api.ready, null);
  assert.equal(api.t('optionsTitle'), MESSAGES.optionsTitle.message);
});

test('reload() picks up a choice made after the page loaded', async () => {
  const stored = {};
  const document = { documentElement: {}, querySelectorAll: () => [] };
  const self = {
    chrome: { i18n, storage: { local: { get: async (keys) => Object.fromEntries(
      keys.filter((k) => k in stored).map((k) => [k, stored[k]])) } } },
  };
  new Function('self', 'document', I18N_SRC)(self, document);
  await self.PanelFlowI18n.ready;
  assert.equal(self.PanelFlowI18n.t('optionsTitle'), MESSAGES.optionsTitle.message);

  Object.assign(stored, { uiLang: 'fr', uiMessages: flat(FR) });
  assert.equal(await self.PanelFlowI18n.reload(), 'fr');
  assert.equal(self.PanelFlowI18n.t('optionsTitle'), FR.optionsTitle.message);
});

// --- what the worker puts there ----------------------------------------------

/** Serves the extension's own files, which is all the worker asks for here. */
const serveExtension = async (url) => {
  const path = String(url).replace('chrome-extension://panelflow/', '');
  return { ok: true, json: async () => JSON.parse(read(join('extension', path))) };
};

test('choosing a language stores the whole of it, flattened', async () => {
  const w = bootWorker({ fetch: serveExtension });
  // Field by field: the worker's replies are built inside the vm and are not
  // reference-equal to a plain object out here, whatever they contain.
  const resp = await w.send({ type: 'setLanguage', lang: 'fr' });
  assert.equal(resp.ok, true);
  assert.equal(resp.lang, 'fr');

  const { uiLang, uiMessages } = w.storage();
  assert.equal(uiLang, 'fr');
  assert.deepEqual(Object.keys(uiMessages).sort(), Object.keys(FR).sort());
  assert.equal(uiMessages.optionsTitle, FR.optionsTitle.message);
  // The descriptions are for translators. Storing them would put a few kilobytes
  // of prose in chrome.storage for nothing.
  assert.equal(typeof uiMessages.optionsTitle, 'string');
});

test('back to "follow the browser" clears the map, not just the code', async () => {
  const w = bootWorker({ storage: { uiLang: 'fr', uiMessages: flat(FR) } });
  const resp = await w.send({ type: 'setLanguage', lang: 'auto' });
  assert.equal(resp.ok, true);
  assert.equal(resp.lang, 'auto');
  // A left-behind map would be consulted ahead of Chrome forever: i18n.js only
  // ignores it when there is no code, and code-without-map is the safer of the
  // two halves to leave. Both halves go.
  const left = w.storage();
  assert.ok(!('uiLang' in left) && !('uiMessages' in left), 'the old language survived "auto"');
  // "Auto" is an answer and not the absence of one, so the account hears about
  // it like any other: a reader who sets the extension back to the browser's
  // language has said something the site and the phone should be told.
  assert.deepEqual(left, { accountPrefs: { uiLang: 'auto' } });
  assert.equal(w.calls.length, 0, 'auto should not need the network');
});

test('a language that is not shipped is refused rather than fetched', async () => {
  const w = bootWorker({ fetch: serveExtension });
  assert.equal((await w.send({ type: 'setLanguage', lang: 'jp' })).error, 'unknown language');
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.storage(), {});
});

test('the offered languages are the ones that exist on disk', () => {
  const { api } = boot();
  const offered = api.LANGS.map((l) => l.code).sort();
  const shipped = readdirSync(join(root, 'extension', '_locales')).sort();
  // Offering a language with no directory behind it fetches a 404 and leaves the
  // reader on a page that did not change; shipping one nobody is offered is a
  // translation paid for and never seen.
  assert.deepEqual(offered, shipped);
  // Named in itself, not in English: a picker that says "French" to someone who
  // cannot read English has not helped them.
  assert.equal(api.LANGS.find((l) => l.code === 'fr').label, 'Français');
});
