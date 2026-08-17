// One message to a service worker that may or may not be awake.
//
// The file under test is extension/send.js, run as it ships — an IIFE over a
// stub `chrome`, so what is exercised is the shipping retry and not a
// description of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'send.js'), 'utf8');

const NOT_DELIVERED = 'Could not establish connection. Receiving end does not exist.';

/**
 * A stub worker. `script` is consulted once per attempt: a string is an error
 * that attempt fails with, anything else is the answer it gives.
 */
function worker(script) {
  const calls = [];
  let lastErrorReads = 0;
  const chrome = {
    runtime: {
      sendMessage(msg, cb) {
        const step = script[Math.min(calls.length, script.length - 1)];
        calls.push(msg);
        chrome.runtime._error = typeof step === 'string' ? { message: step } : undefined;
        cb(typeof step === 'string' ? undefined : step);
      },
      get lastError() {
        lastErrorReads++;
        return this._error;
      },
    },
  };
  const self = {};
  new Function('self', 'chrome', src)(self, chrome);
  return { send: self.PanelFlowSend.send, calls, reads: () => lastErrorReads };
}

test('an answer that arrives is passed straight back', async () => {
  const w = worker([{ settings: { backendUrl: 'https://example.test' } }]);
  assert.deepEqual(await w.send({ type: 'getSettings' }), { settings: { backendUrl: 'https://example.test' } });
  assert.equal(w.calls.length, 1, 'a worker that answered is not asked twice');
});

test('a worker that was asleep is asked again instead of blamed', async () => {
  // This is the whole point: the popup used to tell a reader the extension was
  // still waking up and to press the button again, which is a correct diagnosis
  // and an unreasonable thing to ask of someone who already pressed it.
  const w = worker([NOT_DELIVERED, { settings: { backendUrl: 'https://example.test' } }]);
  const answer = await w.send({ type: 'getSettings' });
  assert.equal(answer.settings.backendUrl, 'https://example.test');
  assert.equal(w.calls.length, 2);
});

test('a worker that never wakes gives up, and says so the old way', async () => {
  const w = worker([NOT_DELIVERED]);
  // undefined, not a throw: every caller already handles "no answer", and this
  // is genuinely that. The reader still gets told, they just get told after
  // three real attempts rather than instead of one.
  assert.equal(await w.send({ type: 'getSettings' }), undefined);
  assert.equal(w.calls.length, 3);
});

test('a worker that died mid-answer is not asked to do it twice', async () => {
  // "Message port closed" means the message *was* received. Resending it could
  // add the same series twice, or spend the same reset link twice. Only "never
  // delivered" is safe to repeat, and only that is repeated.
  const w = worker(['The message port closed before a response was received.']);
  assert.equal(await w.send({ type: 'libraryAdd' }), undefined);
  assert.equal(w.calls.length, 1);
});

test('the same message is what gets resent', async () => {
  const w = worker([NOT_DELIVERED, NOT_DELIVERED, { ok: true }]);
  await w.send({ type: 'setSettings', patch: { backendUrl: 'https://x.test' } });
  assert.deepEqual(w.calls.map((c) => c.type), ['setSettings', 'setSettings', 'setSettings']);
  assert.deepEqual(w.calls[2].patch, { backendUrl: 'https://x.test' });
});

test('lastError is read on every attempt, including the ones that worked', async () => {
  // An unchecked lastError is printed to the console by Chrome. A console full
  // of noise from the normal case is how the abnormal one goes unnoticed.
  const w = worker([{ ok: true }]);
  await w.send({ type: 'getSettings' });
  assert.ok(w.reads() >= 1);
});
