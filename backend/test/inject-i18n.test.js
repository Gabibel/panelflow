// The phone's stand-in for shared/i18n.js has everything the page scripts call.
//
// The in-app browser injects mobile/inject/i18n.js where the extension loads
// shared/i18n.js, and the library sheet called `PanelFlowI18n.languageName`,
// which only the second had. The call threw halfway through drawing the sheet:
// on a phone it stopped under "Type", with no language, no trackers and no
// Save button (owner's report, October 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

function phoneI18n(lang = 'fr') {
  const scope = {
    PanelFlowLang: lang,
    PanelFlowMessages: { en: { hello: 'Hello' }, fr: { hello: 'Bonjour' } },
    navigator: { languages: [lang] },
  };
  new Function('globalThis', 'self', 'chrome', read('mobile', 'inject', 'i18n.js'))(scope, scope, undefined);
  return scope.PanelFlowI18n;
}

test('every PanelFlowI18n member a page script calls exists on the phone', () => {
  const i18n = phoneI18n();
  const dir = join(root, 'extension', 'content');
  const used = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    for (const [, name] of read('extension', 'content', file).matchAll(/PanelFlowI18n\??\.(\w+)/g)) used.add(name);
  }
  assert.ok(used.has('languageName'), 'the sheet no longer names languages; this test lost its reason');
  for (const name of used) assert.ok(name in i18n, `the phone's i18n has no ${name}`);
});

test('a series language is named in the reader\'s language', () => {
  assert.equal(phoneI18n('fr').languageName('Japanese'), 'Japonais');
  assert.equal(phoneI18n('en').languageName('Korean'), 'Korean');
  // One a page detected, outside the list, is shown as it is.
  assert.equal(phoneI18n('fr').languageName('Thai'), 'Thai');
});
