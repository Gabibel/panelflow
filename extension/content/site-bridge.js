'use strict';

// The one page outside the extension that is allowed to change its settings.
//
// PanelFlow's settings live in chrome.storage on the machine, because the
// reader has to be able to change how a chapter opens without an account and
// without a network. But the place people actually look for their settings is
// the app they use, so the web app carries the same page — and this file is how
// that page reaches the worker: the site posts a message into its own window,
// this script forwards it, and the answer comes back the same way.
//
// Two things keep that from being a door into the extension for the whole web:
//
//   1. The manifest only injects this file on PanelFlow's own origins. No other
//      site has this listener at all.
//   2. Only the settings messages are forwarded, by name. The hub also fetches
//      images with the user's cookies and holds their tracker tokens, and a
//      relay that passed along whatever it was handed would put both of those
//      one postMessage away.
const ALLOWED = new Set(['getPrefs', 'setPrefs', 'setLanguage']);

const CHANNEL = 'panelflow-settings';

// How the page knows the extension is here at all — read synchronously, before
// it draws, so the settings it cannot offer are never shown and then removed.
// Set at document_start, which is early enough to beat the app's own scripts.
document.documentElement.dataset.panelflowExtension = chrome.runtime.getManifest().version;

window.addEventListener('message', (event) => {
  // Same window, same origin: a message from an iframe or from another origin
  // is not the settings page, whatever it says its channel is.
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data;
  // `reply` marks an answer this script posted. postMessage delivers to every
  // listener on the window, this one included, so without this the answer comes
  // back round as a request with no type, gets refused, and the refusal comes
  // back round as another one — forever.
  if (!msg || msg.channel !== CHANNEL || !msg.id || 'reply' in msg) return;
  if (!ALLOWED.has(msg.type)) {
    window.postMessage({ channel: CHANNEL, id: msg.id, reply: { error: 'not allowed' } },
      location.origin);
    return;
  }
  chrome.runtime.sendMessage({ type: msg.type, patch: msg.patch, lang: msg.lang }, (reply) => {
    // An asleep worker answers nothing and sets lastError; read it either way,
    // because an unchecked lastError is printed to the console by Chrome and a
    // console full of noise from the normal case is how the odd one gets missed.
    const err = chrome.runtime.lastError;
    window.postMessage({
      channel: CHANNEL,
      id: msg.id,
      reply: reply || { error: err?.message || 'no answer from the extension' },
    }, location.origin);
  });
});
