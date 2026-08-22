// The settings that follow the reader, on every surface that shows them.
//
// backend/test/prefs.test.js covers the endpoint and the shape rules;
// options-page.test.js and web-settings.test.js run the two settings pages for
// real. What is left over is the thing that made this feature necessary in the
// first place — a surface that quietly does not join in.
//
// There are four of them and only two have a settings page. The popup and the
// phone have no theme control at all: they obey, and the only way to see that
// they obey is to read them. The phone especially, because there is no iOS or
// Android toolchain in this repo — mobile/www/app.js is never executed by any
// test, so a line of it that was deleted would be found by a reader on a train
// and by nobody else.
//
// So this file is text-level on purpose, and it asserts the one sequence that
// makes the whole thing work:
//
//   paint from what this device last saw, then adopt what the account says.
//
// Not the other way round. shared/theme.js runs from <head> before first paint
// and cannot wait for a network answer, so every surface is painted from
// localStorage and corrected a moment later. `adopt` is that correction, and a
// surface that calls `set` there instead would be writing this device's guess
// over the account's answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS } from '../src/prefs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Hand-written only. extension/shared, web/shared and mobile/www/shared are
// copies made by scripts/sync-shared.mjs and are covered by the sync test.
const SURFACES = {
  'the extension options page': 'extension/options/options.js',
  'the extension popup': 'extension/popup/popup.js',
  'the web app': 'web/app.js',
  'the phone': 'mobile/www/app.js',
};

test('every surface adopts the account theme rather than assuming its own', () => {
  for (const [who, file] of Object.entries(SURFACES)) {
    assert.match(read(file), /panelflowTheme\.adopt\(/,
      `${who} paints the theme it last saw and never asks the account`);
  }
});

test('the theme is only written by the control the reader just used', () => {
  // `set` writes localStorage and repaints, and it is the loud half — whatever
  // it is given becomes this device's answer and is then offered to the
  // account. It therefore belongs in a change handler and nowhere else. An
  // answer arriving from the account goes to `adopt`, which is the quiet half:
  // it does nothing when the account has no opinion, so a device that has been
  // offline for a week cannot hand its stale guess back on the next sign-in.
  for (const [who, file] of Object.entries(SURFACES)) {
    const src = read(file);
    for (const m of src.matchAll(/panelflowTheme\.set\(/g)) {
      const before = src.slice(Math.max(0, m.index - 300), m.index);
      assert.match(before, /addEventListener\('change'/,
        `${who} writes the theme somewhere other than a change handler`);
    }
  }
});

test('the two surfaces with no settings page only ever obey', () => {
  // The popup is a toolbar window and the phone has no settings screen; neither
  // offers a theme control, so neither may write one to the account. A `set`
  // here would be a device deciding on the reader's behalf.
  for (const file of ['extension/popup/popup.js', 'mobile/www/app.js']) {
    assert.doesNotMatch(read(file), /panelflowTheme\.set\(/,
      `${file} sets a theme it never asked the reader about`);
  }
});

test('the popup takes the cached answer and does not wait for the server', () => {
  // A toolbar window that pauses before it draws is a broken toolbar window.
  // getAccountPrefs is the local copy; pullAccountPrefs is the round trip, and
  // it belongs to the alarm and to the settings pages.
  const popup = read('extension/popup/popup.js');
  assert.match(popup, /send\(\{ type: 'getAccountPrefs' \}\)/);
  assert.doesNotMatch(popup, /pullAccountPrefs/, 'the popup blocks on the network to draw itself');
});

test('something wakes up on its own and refills the cache', () => {
  // Otherwise the extension only hears about a theme chosen on the website when
  // somebody opens its options page, which is roughly never. The chapter alarm
  // is the one thing that starts the worker without being asked.
  const bg = read('extension/background.js');
  const alarm = bg.slice(bg.indexOf("chrome.alarms.onAlarm.addListener"));
  const body = alarm.slice(0, alarm.indexOf('\n});'));
  assert.match(body, /pullAccountPrefs\(\)/,
    'nothing refreshes the account settings unless a settings page is opened');
});

test('the address of the server stays with the machine it points at', () => {
  // It is the address of the server that would store it. A setting that
  // travelled would let one device hand every other device a URL, and the whole
  // point of the account list is that anything on it crosses machines.
  assert.ok(!KEYS.includes('backendUrl'));
  const bg = read('extension/background.js');
  const setPrefs = bg.slice(bg.indexOf('  setPrefs: async'), bg.indexOf('  setLanguage: async (msg)'));
  const account = setPrefs.slice(setPrefs.indexOf('const account = {'));
  assert.doesNotMatch(account.slice(0, account.indexOf('};')), /backendUrl/,
    'the worker offers the server address to the account');
});

/* ---------- The other half of the row ---------- */
//
// `theme` and `uiLang` sit beside each other in ACCOUNT_PREFS because they are
// one question — how this reader wants to be read to — and they were not
// treated as one. The theme reached all four surfaces; the language reached the
// extension and stopped there, so choosing "Français" on the website switched
// the popup and left the website itself in English, and the phone had no
// translations at all. These are the same checks as above, for that half.

const SPEAKING = {
  'the web app': 'web/app.js',
  'the phone': 'mobile/www/app.js',
};

test('the two pages that carry the runtime adopt the account language', () => {
  for (const [who, file] of Object.entries(SPEAKING)) {
    assert.match(read(file), /PanelFlowI18n\.adopt\(/,
      `${who} speaks whatever language it last heard and never asks the account`);
  }
});

test('the extension takes its language from the account too, through the worker', () => {
  // Its own path, because the sentences live in chrome.storage rather than in a
  // <script> the page loaded: the worker merges the account's answer into what
  // getPrefs hands back, on the same `??` the theme rides.
  const bg = read('extension/background.js');
  assert.match(bg, /uiLang: acc\.uiLang \?\? local\.uiLang \?\? 'auto'/,
    'the worker prefers this install over the account, or has stopped asking');
  // And the choice goes back the other way, or a language picked in the options
  // page would never reach the website or the phone.
  const at = bg.indexOf('  setLanguage: async (msg)');
  assert.ok(at !== -1, 'the worker no longer answers setLanguage');
  // The first lines of the handler, before any of the early returns: choosing
  // "follow the browser" has to be recorded too, or the last named language
  // stays on file and the phone keeps speaking it.
  assert.match(bg.slice(at, at + 500),
    /saveAccountPrefs\(\{ uiLang/, 'the extension keeps the language to itself');
});

test('the language is only written by the control the reader just used', () => {
  // The same rule as the theme, for the same reason: `set` is this device
  // deciding, `adopt` is this device being told. A `set` reached from anywhere
  // but a change handler hands a stale guess back to the account.
  for (const [who, file] of Object.entries(SPEAKING)) {
    // Comments out first, unlike the theme's version of this above: the handler
    // that survived this rewrite carries a paragraph explaining why it does the
    // three things it does, and a window measured in characters would be spent
    // on the paragraph rather than on the code it is checking.
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/PanelFlowI18n\.set\(/g)) {
      const before = src.slice(Math.max(0, m.index - 300), m.index);
      assert.match(before, /addEventListener\('change'/,
        `${who} writes the language somewhere other than a change handler`);
    }
  }
});

test('the phone has no language control either, and so only ever obeys', () => {
  // It has no settings screen at all. Everything it looks like is decided in
  // the extension's options or on the website and arrives over the bridge.
  assert.doesNotMatch(read('mobile/www/app.js'), /PanelFlowI18n\.set\(/,
    'the phone picks a language it never asked the reader about');
});

test('a language adopted after the paint is followed by a redraw', () => {
  // Where the two halves of the row stop being the same. A stylesheet reacts to
  // an attribute on <html> on its own, so adopting a theme repaints itself; a
  // sentence already in the DOM does not retranslate, and every one built in JS
  // has to be built again. An adopt with no redraw is a page that is in the new
  // language only where nothing has been drawn yet.
  for (const [who, file] of Object.entries(SPEAKING)) {
    const src = read(file);
    const at = src.indexOf('PanelFlowI18n.adopt(');
    assert.match(src.slice(at, at + 220), /redrawEverything\(\)/,
      `${who} changes language and leaves what is already on screen behind`);
  }
});
