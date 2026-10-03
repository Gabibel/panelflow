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

// The phone's pages get only the sentences the page scripts ask for
// (scripts/build-native-inject.mjs, pageKeys): the whole catalogue was 96 kB
// of every page. A sentence left out would show as its own key, so every way
// a page script names one is accounted for here.
test('every sentence a page script can ask for is in the phone pages\' catalogue', async () => {
  const { pageKeys, LATE } = await import('../../scripts/build-native-inject.mjs');
  const { catalogue } = await import('../../scripts/build-messages.mjs');
  const all = catalogue();
  const kept = pageKeys(all);
  assert.ok(kept.size > 100 && kept.size < Object.keys(all.en).length / 2,
    `${kept.size} sentences kept: either the whole catalogue again, or the scan broke`);
  const files = {
    'detect.js': read('extension', 'content', 'detect.js'),
    'library-modal.js': read('extension', 'content', 'library-modal.js'),
    'reader.js': read('extension', 'content', 'reader.js'),
    'episode-page.js': read('shared', 'episode-page.js'),
  };
  for (const name of Object.keys(files)) assert.ok(LATE.includes(name), `${name} is no longer injected`);
  // The first argument of every t(...) call, brackets balanced.
  const firstArgs = (s) => {
    const out = [];
    for (const m of s.matchAll(/(^|[^A-Za-z0-9_$.])t\(/g)) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      const start = i + 1;
      for (; i < s.length; i++) {
        const c = s[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { depth--; if (!depth) break; }
        else if (c === ',' && depth === 1) break;
      }
      out.push(s.slice(start, i).trim());
    }
    return out;
  };
  // The calls whose key is not written out where they are made, each one
  // argued: the reading-mode toast's key comes from modeToast(), a table of
  // literal keys in reader.js.
  const COMPUTED = new Set(['reader.js:key']);
  for (const [name, src] of Object.entries(files)) {
    for (const arg of firstArgs(src)) {
      // `t()` with nothing in it is a comment talking about the function.
      if (!arg) continue;
      const literals = [...arg.matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)].map((m) => m[1]);
      if (!literals.length) {
        assert.ok(COMPUTED.has(`${name}:${arg}`), `${name} asks t(${arg}), a key this test cannot see`);
        continue;
      }
      for (const word of literals) {
        if (word.endsWith('_')) {
          const family = Object.keys(all.en).filter((k) => k.startsWith(word));
          assert.ok(family.length && family.every((k) => kept.has(k)), `the ${word}* sentences are not all on the phone`);
        } else if (word in all.en) {
          assert.ok(kept.has(word), `${name} asks for ${word}, which the phone's pages do not carry`);
        }
      }
    }
  }
  for (const k of ['modeToastVertical', 'modeToastLtr', 'modeToastLtrRtl', 'modeToastSpread', 'modeToastSpreadRtl']) {
    assert.ok(kept.has(k), `${k} is not on the phone`);
  }
});
