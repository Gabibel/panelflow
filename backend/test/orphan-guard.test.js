// What is left in a tab after the extension is reloaded.
//
// Chrome keeps the old content scripts running in every open tab when
// PanelFlow is reloaded or updated, with nothing behind them: `chrome.runtime.id`
// goes, and every chrome.* call throws "Extension context invalidated". Each
// throw is an uncaught error listed on chrome://extensions (owner's QA,
// September 2026). extension/content/orphan-guard.js runs first in every
// group of content scripts and turns those calls quiet; this runs the shipped
// file over a stub `chrome` that can be "reloaded".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = readFileSync(join(root, 'extension', 'content', 'orphan-guard.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));

/** A `chrome` whose calls throw once the extension behind it is gone. */
function stubChrome({ shim = false, sendMessage = null } = {}) {
  const calls = [];
  const live = { on: true };
  const api = (name, answer) => (...args) => {
    if (!live.on) throw new Error('Extension context invalidated.');
    calls.push(name);
    const cb = args[args.length - 1];
    if (typeof cb === 'function') { cb(answer); return undefined; }
    return Promise.resolve(answer);
  };
  const chrome = {
    runtime: {
      get id() { return live.on ? 'pf' : undefined; },
      sendMessage: sendMessage || api('sendMessage', { ok: true }),
      getURL: (p) => { if (!live.on) throw new Error('Extension context invalidated.'); return `chrome-extension://pf/${p}`; },
      ...(shim ? { __panelflowShim: true } : {}),
    },
    i18n: { getMessage: (k) => { if (!live.on) throw new Error('Extension context invalidated.'); return `msg:${k}`; } },
    storage: {
      local: { get: api('get', { a: 1 }), set: api('set'), remove: api('remove') },
      onChanged: { addListener: () => { if (!live.on) throw new Error('Extension context invalidated.'); } },
    },
  };
  new Function('chrome', GUARD)(chrome);
  return { chrome, calls, reload: () => { live.on = false; } };
}

const settled = (p) => Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 20))]);

test('while the extension is there, every call goes through unchanged', async () => {
  const { chrome, calls } = stubChrome();
  let answer = null;
  chrome.runtime.sendMessage({ type: 'x' }, (r) => { answer = r; });
  assert.deepEqual(answer, { ok: true });
  assert.deepEqual(await chrome.storage.local.get(['a']), { a: 1 });
  assert.equal(chrome.i18n.getMessage('k'), 'msg:k');
  assert.equal(chrome.runtime.getURL('x.png'), 'chrome-extension://pf/x.png');
  assert.deepEqual(calls, ['sendMessage', 'get']);
});

test('once it is reloaded, the copy left in the page goes quiet instead of throwing', async () => {
  const { chrome, reload } = stubChrome();
  reload();
  let called = false;
  assert.doesNotThrow(() => chrome.runtime.sendMessage({ type: 'saveProgress' }, () => { called = true; }));
  assert.equal(called, false, 'a callback answered with nothing reads as an answer');
  // A promise that never settles: the code awaiting it stops there, rather than
  // carrying on with `undefined` and throwing one line later.
  assert.equal(await settled(chrome.storage.local.get(['readerPrefs'])), false);
  assert.equal(await settled(chrome.runtime.sendMessage({ type: 'recordRead' })), false);
  assert.doesNotThrow(() => chrome.storage.local.set({ a: 2 }, () => {}));
  assert.doesNotThrow(() => chrome.storage.onChanged.addListener(() => {}));
  assert.equal(chrome.i18n.getMessage('k'), '');
  assert.equal(chrome.runtime.getURL('x.png'), '');
});

test('a real failure while the extension is there is still the caller\'s to see', () => {
  // A malformed message throws with the extension alive; hiding that would
  // hide a bug, so only the "gone" case is swallowed.
  const { chrome } = stubChrome({ sendMessage: () => { throw new Error('bad message'); } });
  assert.throws(() => chrome.runtime.sendMessage({}), /bad message/);
});

test('the phone app\'s shim is left alone', () => {
  const { chrome } = stubChrome({ shim: true });
  assert.equal(chrome.runtime.sendMessage.name, '', 'the shim was wrapped');
  assert.equal(chrome.runtime.__panelflowGuarded, undefined);
});

test('it runs first in every group of content scripts that uses chrome.*', () => {
  for (const entry of MANIFEST.content_scripts) {
    if (entry.world === 'MAIN') {
      assert.ok(!entry.js.includes('content/orphan-guard.js'), 'the page\'s own world has no chrome to guard');
      continue;
    }
    assert.equal(entry.js[0], 'content/orphan-guard.js', `${entry.js.join(', ')} runs unguarded`);
  }
});
