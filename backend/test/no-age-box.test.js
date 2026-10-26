// No "I am 15 or older" box at sign-up (owner, October 2026).
//
// PanelFlow is still not for people under 15: the privacy policy (§11) and
// the terms of use say so. What changed is where it is said at the moment an
// account is made: no box to tick on any surface, and the one line under the
// buttons that already asks for the terms and the privacy policy says it
// instead, on the phone, the website and the extension alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const messages = (lang) => JSON.parse(read('shared', '_locales', lang, 'messages.json'));

test('no surface asks for a box to be ticked', () => {
  const sources = {
    phone: read('native', 'src', 'screens', 'AccountScreen.js'),
    website: read('web', 'index.html') + read('web', 'app.js'),
    options: read('extension', 'options', 'options.html') + read('extension', 'options', 'options.js'),
    welcome: read('extension', 'welcome', 'welcome.html') + read('extension', 'welcome', 'welcome.js'),
  };
  for (const [where, src] of Object.entries(sources)) {
    assert.doesNotMatch(src, /accountAge/, `${where} still has the age box`);
    assert.doesNotMatch(src, /id="(auth-)?age"|setAdult/, `${where} still has the age box`);
  }
  for (const lang of ['en', 'fr']) {
    assert.ok(!messages(lang).accountAge && !messages(lang).accountAgeRequired, `${lang}: the box's sentences are left`);
  }
});

test('the line under the buttons says it, in every language and on every surface', () => {
  for (const lang of ['en', 'fr']) {
    const m = messages(lang);
    for (const key of ['webConsentLine', 'optionsConsentLine', 'mobileConsentBefore']) {
      assert.match(m[key].message, /15/, `${lang}: ${key} does not say 15`);
    }
  }
});

test('the policy and the terms still say who PanelFlow is for', () => {
  assert.match(read('web', 'confidentialite.html'), /moins de 15 ans/);
  assert.match(read('web', 'conditions.html'), /moins de 15 ans/);
});
