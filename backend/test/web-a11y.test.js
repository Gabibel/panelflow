// The accessibility rules the web app and the extension's pages are held to.
//
// Not a screen-reader run — there is no browser here — but the part of
// accessibility that is *structural* can be checked from the markup, and it is
// the part that regresses quietly: a new icon button with no name, a new field
// with only a placeholder, a stylesheet that turns the focus ring off again
// because it looked untidy. Each rule below names the failure it prevents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const PAGES = [
  'web/index.html',
  'web/mentions-legales.html', 'web/confidentialite.html', 'web/conditions.html',
  'extension/popup/popup.html', 'extension/options/options.html',
];
const STYLES = ['web/styles.css', 'web/legal.css', 'extension/popup/popup.css'];

/** Every `<tag …>` opening in the page, with its attribute string. */
const tags = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map((m) => m[1]);
const has = (attrs, name) => new RegExp(`\\s${name}=`, 'i').test(attrs);
const idOf = (attrs) => attrs.match(/\sid="([^"]+)"/)?.[1];

for (const page of PAGES) {
  const html = read(page);

  test(`${page}: every image says what it is, or says it is decoration`, () => {
    // `alt=""` is a legitimate answer — a cover next to the title it belongs
    // to would be read twice — but no alt at all is a picture the screen reader
    // announces as its file name.
    for (const attrs of tags(html, 'img')) {
      assert.ok(has(attrs, 'alt') || has(attrs, 'data-i18n-alt'), `${page}: <img${attrs}> has no alt`);
    }
  });

  test(`${page}: every field has a name that is not its placeholder`, () => {
    // A placeholder disappears when you type, and is not read as a label by
    // every screen reader. A field is named by a wrapping <label>, a <label
    // for>, or aria-label.
    const labelled = new Set([...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]));
    // Spread before mapping: `.map` straight on the iterator is Node 22 only,
    // and package.json promises Node 20.
    for (const [whole, attrs] of [...html.matchAll(/<(?:input|select|textarea)\b([^>]*)>/gi)]
      .map((m) => [m[0], m[1]])) {
      const type = attrs.match(/\stype="([^"]+)"/)?.[1] ?? 'text';
      if (['hidden', 'submit', 'button', 'checkbox'].includes(type)) continue; // checkboxes: label wraps, tested below
      const id = idOf(attrs);
      const wrapped = new RegExp(`<label[^>]*>(?:(?!</label>)[\\s\\S])*?${whole.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(html);
      const named = wrapped || (id && labelled.has(id)) || has(attrs, 'aria-label') || has(attrs, 'data-i18n-aria-label') || has(attrs, 'aria-labelledby');
      assert.ok(named, `${page}: <${whole.slice(1, 40)}…> has no label`);
    }
  });

  test(`${page}: every button has a name`, () => {
    // Text inside it, a translation key that will become text, or aria-label.
    // A button that is only an icon and only a `title` is a tooltip, not a
    // name — app.js gives those an aria-label at the same time (labelIcon).
    for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const [, attrs, inner] = m;
      const text = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
      const named = text || has(attrs, 'data-i18n') || has(attrs, 'aria-label')
        || has(attrs, 'data-i18n-aria-label') || /data-i18n="/.test(inner);
      // Buttons the scripts fill at runtime: their id is the contract, or a
      // <span id> inside them is the slot the text goes into (the popup's
      // site group is headed by the site's own hostname).
      const filledLater = ['auth-submit', 'push-toggle', 'sort-dir', 'page-state', 'entry-resume'].includes(idOf(attrs))
        || /<span id="[^"]+"><\/span>/.test(inner);
      // `title` alone is accepted only for the icon buttons the runtime names.
      assert.ok(named || filledLater || (has(attrs, 'data-i18n-title') && /icon-btn|import-open|export-open|migrate-open|check-updates/.test(attrs)),
        `${page}: <button${attrs}> has no accessible name`);
    }
  });

  test(`${page}: every dialog is named by its heading`, () => {
    for (const attrs of tags(html, 'dialog')) {
      const by = attrs.match(/aria-labelledby="([^"]+)"/)?.[1];
      assert.ok(by, `${page}: <dialog${attrs}> has no aria-labelledby`);
      assert.ok(new RegExp(`id="${by}"`).test(html), `${page}: dialog names #${by}, which is not in the page`);
    }
  });

  test(`${page}: the document says which language it is in`, () => {
    assert.match(html, /<html[^>]*\slang="[a-z]{2}"/, `${page}: <html> has no lang`);
  });
}

test('no stylesheet turns the focus ring off', () => {
  // `outline: none` on :focus was in three files. It made keyboard focus
  // invisible for everyone, including the people for whom the ring is the only
  // way to see where they are. Each surface now draws one on :focus-visible.
  for (const file of STYLES) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/outline\s*:\s*(none|0)\b/.test(css), `${file} turns the focus outline off`);
  }
  for (const file of ['web/styles.css', 'extension/popup/popup.css', 'web/legal.css']) {
    assert.match(read(file), /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/,
      `${file} draws no ring for keyboard focus`);
  }
  assert.match(read('extension/options/options.html'), /:focus-visible \{ outline: 2px solid var\(--accent\)/);
});

test('icon-only buttons the runtime creates get a name, not just a tooltip', () => {
  // The web app builds its card buttons in JavaScript. The helper that names
  // them sets aria-label alongside title, and every icon button goes through
  // it — a `.title =` on a button with `innerHTML = icon(...)` is the pattern
  // this catches.
  const js = read('web/app.js');
  assert.match(js, /const labelIcon = \(el, text\) => \{ el\.title = text; el\.setAttribute\('aria-label', text\); \}/);
  for (const name of ['remove', 'edit', 'del', 'up']) {
    assert.ok(!new RegExp(`\\b${name}\\.title = `).test(js), `${name} is named by title alone again`);
    assert.ok(new RegExp(`labelIcon\\(${name}, `).test(js), `${name} does not go through labelIcon`);
  }
});

test('the active view is announced, not only underlined', () => {
  const js = read('web/app.js');
  assert.match(js, /setAttribute\('aria-current', 'page'\)/, 'the view tabs no longer set aria-current');
});

test('creating an account says what it means, with both pages a click away', () => {
  const html = read('web/index.html');
  assert.match(html, /<p class="consent" data-i18n-html="webConsentLine"><\/p>/);
  for (const lang of ['en', 'fr']) {
    const msg = JSON.parse(read(`shared/_locales/${lang}/messages.json`)).webConsentLine.message;
    assert.match(msg, /href="conditions\.html"/, `${lang}: the consent line does not link the terms`);
    assert.match(msg, /href="confidentialite\.html"/, `${lang}: the consent line does not link the privacy policy`);
  }
});

test('the sign-in button has its name from the first paint', () => {
  // Found by looking at the screen: the markup ships the button empty (it has
  // two names, one per mode) and the labels were written only in the switch
  // handler — so a reader who had just arrived saw an orange bar with no word
  // on it. The primary button of the product, unlabelled until a click on
  // something that was not there. One function paints the mode, and it runs
  // at load.
  const js = read('web/app.js');
  assert.match(js, /function paintAuthMode\(mode\)/);
  assert.match(js, /^paintAuthMode\('login'\);/m, 'the first paint no longer happens at load');
  assert.match(js, /paintAuthMode\(\$\('auth-submit'\)\.dataset\.mode === 'login' \? 'register' : 'login'\)/,
    'the switch no longer goes through the same function');
});
