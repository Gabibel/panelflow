// The one door from the web app into the extension.
//
// The settings a reader changes live in chrome.storage on their machine — they
// have to, because how a chapter opens must be answerable with no account and
// no network. But people look for their settings in the app they use, so the
// web app carries the same page and reaches the worker through a content
// script: the page posts a message into its own window, the script forwards it,
// the answer comes back the same way.
//
// Both ends are lifted out of the shipping files and run against one fake
// window, because the failures worth catching here are failures of the pair:
//
//   1. The door opening wider than intended. The hub also fetches images with
//      the reader's cookies and holds their tracker tokens, and a relay that
//      forwarded whatever it was handed would put both one postMessage away.
//   2. The loop. postMessage delivers to every listener on the window, the
//      posting script included, so an answer that is not marked as one comes
//      back round as a request — forever, at the speed of the microtask queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const BRIDGE = read('extension/content/site-bridge.js').replace(/^'use strict';$/m, '');
const APP = read('web/app.js');
const MANIFEST = JSON.parse(read('extension/manifest.json'));

// The page's half: the two helpers above the first setting it draws.
const EXT_SRC = APP.slice(APP.indexOf('const extensionVersion ='), APP.indexOf('let setStatusTimer = 0;'));
assert.ok(/function ext\(/.test(EXT_SRC), 'the page no longer keeps its bridge client here');

const ORIGIN = 'https://panelflow-backend.vercel.app';

/** A window both scripts can post into, and a way to post as somebody else. */
function fakeWindow(origin = ORIGIN) {
  const listeners = [];
  const posted = [];
  const location = { origin };
  const deliver = (event) => {
    // Over a copy: a listener that removes itself — every answered `ext` call
    // does — must not shorten the list the loop is walking.
    for (const fn of [...listeners]) queueMicrotask(() => fn(event));
  };
  const window = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: (type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    postMessage: (data) => { posted.push(data); deliver({ source: window, origin, data }); },
  };
  return { window, location, deliver, posted, listeners };
}

/** Both ends, wired the way the browser wires them. */
function boot({ reply = { ok: true, uiLang: 'fr' }, answer = true } = {}) {
  const w = fakeWindow();
  const document = { documentElement: { dataset: {} } };
  const asked = [];
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
      sendMessage: (msg, cb) => {
        asked.push(msg);
        if (answer) { chrome.runtime.lastError = null; cb(reply); return; }
        // How Chrome answers for a worker that never woke.
        chrome.runtime.lastError = { message: 'Could not establish connection.' };
        cb(undefined);
      },
      lastError: null,
    },
  };
  new Function('window', 'document', 'chrome', 'location', BRIDGE)(
    w.window, document, chrome, w.location);
  const ext = new Function('window', 'document', 'location', `${EXT_SRC}\nreturn ext;`)(
    w.window, document, w.location);
  return { ...w, document, chrome, asked, ext };
}

test('the page can tell the extension is here before it draws anything', () => {
  const page = boot();
  // Synchronous, at document_start: a settings section that appears and then
  // disappears is worse than one that was never offered.
  assert.equal(page.document.documentElement.dataset.panelflowExtension, '9.9.9');
});

test('with no extension in the browser, a question is answered no rather than waited on', async () => {
  const page = boot();
  delete page.document.documentElement.dataset.panelflowExtension;
  assert.equal(await page.ext('getPrefs'), null);
  assert.deepEqual(page.asked, [], 'nothing was posted at all');
});

test('a settings question reaches the worker and its answer comes back', async () => {
  const page = boot();
  assert.deepEqual(await page.ext('getPrefs'), { ok: true, uiLang: 'fr' });
  assert.deepEqual(page.asked, [{ type: 'getPrefs', patch: undefined, lang: undefined }]);
});

test('a patch is carried through with the answer that follows it', async () => {
  const page = boot();
  await page.ext('setPrefs', { patch: { readerMode: 'rtl' } });
  assert.deepEqual(page.asked.at(-1).patch, { readerMode: 'rtl' });
  await page.ext('setLanguage', { lang: 'fr' });
  assert.equal(page.asked.at(-1).lang, 'fr');
});

test('anything outside the settings messages never reaches the worker', async () => {
  const page = boot();
  // Not a hypothetical shape: `fetchImage` pulls a page with the reader's
  // cookies attached, and `getAccount` hands back the tracker tokens.
  for (const type of ['fetchImage', 'getAccount', 'syncNow', 'auth', 'logout']) {
    assert.equal(await page.ext(type), null, type);
  }
  assert.deepEqual(page.asked, [], 'the relay forwarded something it was not asked to');
});

test('a message from another origin or another window is not the settings page', async () => {
  const page = boot();
  const request = { channel: 'panelflow-settings', id: 'pf-1', type: 'getPrefs' };
  page.deliver({ source: page.window, origin: 'https://evil.test', data: request });
  page.deliver({ source: { name: 'an iframe' }, origin: ORIGIN, data: request });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(page.asked, []);
});

test('an answer does not come back round as a question', async () => {
  const page = boot();
  await page.ext('getPrefs');
  await new Promise((r) => setTimeout(r, 5));
  // One question out, one answer back. Without the marker on the answer the
  // relay reads its own reply as a request with no type, refuses it, and the
  // refusal is itself a message on the channel — a loop with no end.
  assert.equal(page.posted.length, 2);
  assert.equal(page.posted.filter((m) => m.reply?.error === 'not allowed').length, 0);
});

test('a worker that never woke is reported, not waited on forever', async () => {
  const silent = boot({ answer: false });
  assert.equal(await silent.ext('getPrefs'), null);

  // And when it does not even call back, the page stops asking rather than
  // leaving controls that look live over settings nothing is writing.
  const gone = boot();
  gone.chrome.runtime.sendMessage = () => {};
  assert.equal(await gone.ext('getPrefs', {}, 20), null);
});

test('two questions in flight do not answer each other', async () => {
  const page = boot();
  page.chrome.runtime.sendMessage = (msg, cb) => {
    // Out of order on purpose: the second question is answered first, which is
    // what a slow getPrefs behind a quick setPrefs actually looks like.
    setTimeout(() => cb({ ok: true, for: msg.type }), msg.type === 'getPrefs' ? 15 : 1);
  };
  const both = await Promise.all([page.ext('getPrefs'), page.ext('setPrefs', { patch: {} })]);
  assert.deepEqual(both.map((r) => r.for), ['getPrefs', 'setPrefs']);
});

// --- the shape of the door ---------------------------------------------------

test('the relay is injected on PanelFlow pages and nowhere else', () => {
  const entry = MANIFEST.content_scripts.find((c) => c.js.includes('content/site-bridge.js'));
  assert.ok(entry, 'the bridge is not in the manifest at all');
  // The origin list is the manifest's job — the script itself only checks that
  // a message came from its own window. On `<all_urls>` every site on the web
  // would have this listener, and the type list would be all that stood there.
  assert.ok(!entry.matches.includes('<all_urls>'));
  for (const match of entry.matches) {
    assert.match(match, /^https:\/\/[^/]*panelflow[^/]*\/\*$|^http:\/\/localhost:\d+\/\*$/, match);
  }
  // Before the page's own scripts, so the mark is there when they read it.
  assert.equal(entry.run_at, 'document_start');
});

test('every question the app asks is one the relay forwards', () => {
  const allowed = [...BRIDGE.slice(BRIDGE.indexOf('const ALLOWED'), BRIDGE.indexOf('const CHANNEL'))
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const asked = [...APP.matchAll(/\bext\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(asked.length > 0, 'the app asks the extension nothing');
  // The other direction is deliberately not asserted: the relay may forward a
  // message the web app has no control for yet, and that is not a hole.
  for (const type of new Set(asked)) {
    assert.ok(allowed.includes(type), `the app asks for ${type}, which the relay refuses`);
  }
});
