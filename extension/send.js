'use strict';

// One message to the service worker, and a retry for the one failure that is
// safe to retry.
//
// An MV3 worker is stopped whenever Chrome decides it has been idle, and a page
// that sends into that instant is answered with nothing at all: the callback
// fires with `undefined` and `chrome.runtime.lastError` says the connection
// could not be established. Every caller here reads that as "no settings", "no
// library", "not signed in" — and the popup said so out loud, telling the
// reader the extension was still waking up and to press the button again. That
// is a correct diagnosis and an unreasonable thing to ask of someone who has
// already pressed it.
//
// Only "never delivered" is retried, and it is the only one that can be: the
// worker did not receive the message, so nothing has been half-done. A worker
// that died *while* answering fails differently ("message port closed before a
// response was received"), and resending that could apply a write twice — so it
// is handed back untouched, exactly as before.
(function (root) {
  if (root.PanelFlowSend) return;

  const NOT_DELIVERED = /Could not establish connection|Receiving end does not exist/i;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const attempt = (msg) => new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      // Read even when it is not used: an unchecked lastError is printed to the
      // console by Chrome, and a console full of noise from the normal case is
      // how the abnormal one gets missed.
      const err = chrome.runtime.lastError;
      const delivered = !err || !NOT_DELIVERED.test(err.message || '');
      resolve({ resp, delivered });
    });
  });

  /**
   * @returns the worker's answer, or `undefined` if it could not be woken —
   * the same shape callers already handle, so a genuinely dead worker still
   * ends where it used to.
   */
  async function send(msg, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const { resp, delivered } = await attempt(msg);
      if (delivered) return resp;
      // Long enough for a worker to boot, short enough that nobody sees it.
      await wait(50 * (i + 1));
    }
    return undefined;
  }

  root.PanelFlowSend = { send };
}(typeof self !== 'undefined' ? self : this));
