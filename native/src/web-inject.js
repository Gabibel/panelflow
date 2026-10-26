// What the app injects into a page, and how it talks to it: shared by the
// in-app browser (screens/BrowserScreen.js) and the hidden one that keeps
// chapters for offline reading (components/OfflineSaver.js), so the two load
// a page with exactly the same scripts and the same key rules.
import * as Crypto from 'expo-crypto';

/**
 * Ask the page's content scripts something — the phone's version of the
 * extension popup messaging the active tab.
 */
export const dispatchScript = (json, replyId) =>
  `try{window.PanelFlowPage&&window.PanelFlowPage.dispatch(${json},${replyId})}catch(e){};true;`;

// The toolbar needs to know two things the page owns: whether a chapter was
// detected here, and whether the reader is already open. There is no event for
// either, so the page is asked — cheaply, and only while the browser is up.
// One more look at a page whose strip may have arrived after the verdict did.
// A no-op while the reader is open — see detect.js, which refuses it there.
export const RESCAN = `try{window.__panelflowDetect&&window.__panelflowDetect.rescan&&window.__panelflowDetect.rescan()}catch(e){};true;`;

/**
 * An injection, run inside a function whose one parameter is this browser's key.
 *
 * The scripts inside read `__pfKey` as a variable; nothing outside the function
 * can, and the page never sees injected source. chrome-shim.js signs every
 * request with it and keeps `chrome` off `window` (see that file for why), and
 * the late set takes its private `chrome` from `__pfPrivateChrome(key)`: every
 * `chrome.runtime.sendMessage` in the extension's content scripts resolves to
 * that variable, inside the same function. No key, no shim, no reader — which
 * is the safe way for a page that tampered with the start of the document to
 * find this failing.
 */
//
// The key goes to the top document only. A WebView injects into every frame,
// and an advert's iframe running the shim with the key could sign requests of
// its own — the QA pass saw two accepted from a streaming player's frame. A
// frame is handed `false` instead, which chrome-shim.js reads as "no shim here
// at all", and the late set, finding no private `chrome`, does nothing. The
// popup guard and the blocker, which need no key, still run in every frame.
//
// Strict, and the key let go of as soon as it has been used. The late set runs
// after the page's own scripts, and a sloppy function is readable from below:
// a setter the page had put on `window.PanelFlowLang`, which this function
// assigns, could walk up to it (`setter.caller.arguments[0]`) and read the key
// (QA re-test It.5, found with N-B6). Strict code has no `caller` to follow.
// Every injected file is already a strict IIFE, so nothing inside changes.
export const keyed = (bundle, key, { late: isLate = false } = {}) => `(function(__pfKey){'use strict';${
  isLate ? 'var chrome=window.__pfPrivateChrome&&window.__pfPrivateChrome(__pfKey);__pfKey=false;if(!chrome)return;' : ''
}
${bundle}
})(window.top===window?${JSON.stringify(key)}:false);true;`;

/** A key nobody can guess: two random UUIDs, from the platform's own source. */
export const pageKey = () => `${Crypto.randomUUID()}${Crypto.randomUUID()}`.replace(/-/g, '');

// Every two seconds, but said only when it changed: posting the same state
// each time crossed the bridge and redrew the whole browser screen thirty
// times a minute for nothing (October 2026, "pas de gros chargements").
export const POLL = `(function(){try{
  var s=window.PanelFlowPage&&window.PanelFlowPage.state&&window.PanelFlowPage.state();
  if(!s||!window.ReactNativeWebView)return;
  var j=JSON.stringify(s);
  if(j===window.__panelflowSaid)return;
  window.__panelflowSaid=j;
  window.ReactNativeWebView.postMessage(JSON.stringify({event:'state',state:s}));
}catch(e){}})();true;`;

/**
 * The shell's own request to the page's content scripts, signed with the key
 * (chrome-shim.js, `command`): the one kind a page cannot send itself.
 */
export const commandScript = (json, replyId, key) =>
  `try{window.PanelFlowPage&&window.PanelFlowPage.command&&window.PanelFlowPage.command(${json},${replyId},${JSON.stringify(key)})}catch(e){};true;`;

/** The answer to a page's request, handed back with the key. */
export const deliverScript = (id, body, key) =>
  `try{window.PanelFlowPage&&window.PanelFlowPage.deliver(${Number(id)},${
    JSON.stringify(JSON.stringify(body ?? null))},${JSON.stringify(key)})}catch(e){};true;`;
