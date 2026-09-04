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
      if (delivered) return say(msg, resp);
      // Long enough for a worker to boot, short enough that nobody sees it.
      await wait(50 * (i + 1));
    }
    return say(msg, undefined);
  }

  // --- where the answer came from ---------------------------------------------
  //
  // Every page of the extension — popup, options, the welcome tour — asks the
  // worker through here, so this is the one place that sees every answer. The
  // callers are screens: they put `resp.error` on a line and move on, which is
  // right for the reader and useless for anyone debugging. The worker now says
  // which of its handlers died (`failedAt`) and, for a 500, what the server
  // filed it under (`ref`), and this is where those two get read out loud —
  // once, in one shape, instead of in twenty callers that would each forget.
  //
  // A reply of `undefined` is the other half: three attempts and the worker
  // never woke. Callers read that as "no library", "not signed in", "no
  // settings" and say so, which is a plausible sentence for a completely
  // different problem. Named here, it stops being one.
  function say(msg, resp) {
    const type = (msg && msg.type) || 'unknown';
    if (resp === undefined) {
      console.warn(`[panelflow] ${type}: the service worker did not answer (3 attempts)`);
    } else if (resp && resp.error) {
      const at = resp.failedAt ? ` in ${resp.failedAt}` : '';
      const ref = resp.ref ? ` ref=${resp.ref}` : '';
      console.warn(`[panelflow] ${type} failed${at}${ref}: ${resp.error}`);
    }
    return resp;
  }

  // The same net for the three extension pages that load this file — popup,
  // options and welcome. One listener here covers all three, and it is the only
  // way an `async` click handler that threw leaves a trace: the button does
  // nothing, no catch runs, and nothing is printed.
  //
  // Deliberately here and not in a content script: this file is loaded by
  // extension pages only, never injected into a site. A listener living on a
  // scan site's window would report that site's own rejections as ours.
  if (root.addEventListener) {
    root.addEventListener('unhandledrejection', (ev) => {
      const err = ev && ev.reason;
      console.warn(`[panelflow] unhandled: ${(err && err.message) || err}`, err);
    });
  }

  root.PanelFlowSend = { send };
}(typeof self !== 'undefined' ? self : this));
