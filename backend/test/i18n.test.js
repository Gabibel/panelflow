// The extension speaks two languages, and nothing in a browser says when it
// stops.
//
// `chrome.i18n.getMessage` answers a key it does not know with an empty string.
// There is no exception, no console warning and no build step: a key renamed on
// one side of the wall and not the other is a button with no label, a heading
// with no words, a toast that flashes an empty box. It looks like a rendering
// bug and it is found by a user.
//
// So the wall is checked here instead. Every key the source asks for is
// collected by scanning it — the same shapes the code actually uses, not a list
// kept by hand — and matched against both locale files in both directions.
//
// Two families of key are computed at run time from ids that live in shared/,
// and one from the reading mode; they cannot be found by scanning and are named
// in COMPUTED below. Adding a folder, a sort order or a reading mode means
// adding a line there — which is the point: it is the same edit as adding the
// translation, in the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ext = join(root, 'extension');
const read = (p) => readFileSync(p, 'utf8');

const LOCALES = readdirSync(join(ext, '_locales'));
const messages = Object.fromEntries(LOCALES.map(
  (lang) => [lang, JSON.parse(read(join(ext, '_locales', lang, 'messages.json')))],
));

// --- what the source asks for -----------------------------------------------

const COMPUTED = [
  // popup.js folderName(), library-modal.js folderName() — shared/folders.js ids.
  'folder_reading', 'folder_paused', 'folder_plan', 'folder_completed', 'folder_dropped',
  // popup.js sortName() — shared/library-view.js ids.
  'sort_updated', 'sort_added', 'sort_title', 'sort_chapter', 'sort_behind', 'sort_score', 'sort_site',
  // reader.js modeToast() — one per reading mode.
  'modeToastVertical', 'modeToastLtr', 'modeToastRtl', 'modeToastSpread', 'modeToastSpreadRtl',
];

// Quoted words that sit inside a t(...) call without being keys: the value a
// ternary is testing, and the two prefixes the computed families are built from.
const NOT_KEYS = new Set([
  'String', 'Number', 'true', 'false', 'null', 'tuned', 'text', 'folder_', 'sort_',
]);

/** Every file the extension ships, minus i18n.js itself and the generated copies. */
function sources(dir = ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // `shared/` is a copy of the repo root's, and has no chrome.i18n to call.
      if (name !== '_locales' && name !== 'shared') sources(p, out);
    } else if (/\.(js|html|json)$/.test(name) && name !== 'i18n.js') {
      out.push(p);
    }
  }
  return out;
}

/**
 * The argument text of every `t(...)` call in `s`, brackets balanced.
 *
 * A regular expression cannot do this: `t(cond ? 'a' : 'b')` and
 * `t('outer', [t('inner')])` both appear in the reader, and a lazy match on the
 * closing bracket silently drops the second key of each.
 */
function callArgs(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== 't' || s[i + 1] !== '(') continue;
    if (i > 0 && /[A-Za-z0-9_$.]/.test(s[i - 1])) continue;   // encodeURIComponent(, obj.t(
    let depth = 0, j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') { depth--; if (!depth) break; }
    }
    out.push(s.slice(i + 2, j));
  }
  return out;
}

/** Only the first argument names a key; past the first top-level comma are subs. */
function firstArg(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && !depth) return args.slice(0, i);
  }
  return args;
}

/** key -> the files that ask for it. */
function keysUsed() {
  const used = new Map();
  const add = (k, where) => used.set(k, (used.get(k) || new Set()).add(where));
  for (const file of sources()) {
    const where = relative(root, file).replace(/\\/g, '/');
    const s = read(file);
    for (const args of callArgs(s)) {
      for (const q of firstArg(args).matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)) {
        if (!NOT_KEYS.has(q[1])) add(q[1], where);
      }
    }
    for (const m of s.matchAll(
      /data-i18n(?:-html|-title|-placeholder|-aria-label|-alt)?="([A-Za-z0-9_]+)"/g)) add(m[1], where);
    for (const m of s.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) add(m[1], where);
  }
  for (const k of COMPUTED) add(k, '(computed)');
  return used;
}

const USED = keysUsed();
/** The files that ask for at least one key, repo-relative. */
const TRANSLATING = new Set([...USED.values()].flatMap((files) => [...files]));

// --- the checks --------------------------------------------------------------

test('the collector found the strings, so the checks below mean something', () => {
  // A scanner that quietly matched nothing would make every test in this file
  // pass against an extension with no translations at all.
  assert.ok(USED.size > 250, `only ${USED.size} keys found — the scan is broken`);
  assert.ok(LOCALES.includes('en'), 'en is the default locale and has to exist');
  assert.ok(LOCALES.length > 1, 'there is nothing to check with one locale');
});

test('every key the extension asks for exists in every locale', () => {
  for (const lang of LOCALES) {
    const missing = [...USED.keys()]
      .filter((k) => !messages[lang][k])
      .map((k) => `${k} (${[...USED.get(k)].join(', ')})`);
    // Chrome falls back to the default locale on its own, so a key missing from
    // fr alone is only a French sentence in English — but a key missing from en
    // is a blank label, and this is the one place that difference is visible.
    assert.deepEqual(missing, [], `${lang} is missing keys`);
  }
});

test('no locale carries a key nobody asks for', () => {
  // Dead entries are how a locale file drifts: a translator keeps updating a
  // string that stopped being drawn two versions ago.
  for (const lang of LOCALES) {
    assert.deepEqual(Object.keys(messages[lang]).filter((k) => !USED.has(k)), [],
      `${lang} has entries the source never asks for`);
  }
});

test('the locales agree on which keys exist', () => {
  const en = Object.keys(messages.en).sort();
  for (const lang of LOCALES) {
    assert.deepEqual(Object.keys(messages[lang]).sort(), en, `${lang} and en disagree`);
  }
});

test('a translation asks for no substitution the English one does not', () => {
  // $1…$9 are filled from the call site, which passes what the English string
  // needs. A French sentence reaching for a $3 that is never passed prints an
  // empty gap; one that forgets a $1 drops the chapter number on the floor.
  const subs = (s) => [...new Set([...s.matchAll(/\$([1-9])/g)].map((m) => m[1]))].sort();
  for (const lang of LOCALES) {
    if (lang === 'en') continue;
    for (const [key, entry] of Object.entries(messages[lang])) {
      assert.deepEqual(subs(entry.message), subs(messages.en[key].message),
        `${lang}/${key} uses different placeholders from en`);
    }
  }
});

test('every message says something', () => {
  for (const lang of LOCALES) {
    for (const [key, entry] of Object.entries(messages[lang])) {
      assert.equal(typeof entry.message, 'string', `${lang}/${key} has no message`);
      assert.notEqual(entry.message.trim(), '', `${lang}/${key} is empty`);
    }
  }
});

test('an annotated node ships empty, so no page flashes English first', () => {
  // apply() runs after the markup is parsed. Text left inside a [data-i18n]
  // node is painted, then replaced — a visible flicker in English on every
  // French page load, and the reason the strings live in _locales at all.
  for (const file of sources().filter((f) => f.endsWith('.html'))) {
    for (const m of read(file).matchAll(/<(\w+)([^>]*\sdata-i18n[^>]*)>([^<]*)</g)) {
      // <title> is the exception: the browser shows it before any script runs,
      // so its fallback is the only thing standing between a French user and a
      // tab labelled with nothing at all.
      if (m[1] === 'title') continue;
      assert.equal(m[3].trim(), '',
        `${relative(root, file)} leaves "${m[3].trim()}" inside a translated node`);
    }
  }
});

test('the manifest is set up for translation', () => {
  const manifest = JSON.parse(read(join(ext, 'manifest.json')));
  // Chrome refuses to load an extension whose manifest uses __MSG_…__ without
  // one, and the name is the first thing __MSG_ appears in.
  assert.equal(manifest.default_locale, 'en');
  assert.match(manifest.name, /^__MSG_\w+__$/);
  // i18n.js has to be injected ahead of any script that calls t(), because some
  // of them call it while they are still being evaluated. Checked per injection
  // group: the guard runs alone in the MAIN world and translates nothing, and
  // handing it i18n.js would put a copy of it on the page for the site to see.
  for (const entry of manifest.content_scripts || []) {
    if ((entry.js || []).some((f) => TRANSLATING.has(`extension/${f}`))) {
      assert.equal(entry.js[0], 'i18n.js', `${entry.js.join(', ')} load before i18n.js`);
    }
  }
});

test('every page that carries annotated markup also loads i18n.js', () => {
  for (const file of sources().filter((f) => f.endsWith('.html'))) {
    const html = read(file);
    if (!/data-i18n/.test(html)) continue;
    assert.match(html, /<script src="[^"]*i18n\.js"><\/script>/,
      `${relative(root, file)} is annotated but never loads i18n.js`);
  }
});
