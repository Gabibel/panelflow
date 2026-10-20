// When the in-app browser's page process dies (QA P6, 2026-10-19).
//
// Android kills a WebView's renderer to free memory (a long webtoon on a small
// phone, the app left in the background), and a renderer can crash; iOS
// terminates a WKWebView's content process the same way. react-native-webview
// keeps the app itself alive, but the view it leaves is an empty grey frame
// that never comes back by itself: the reader had to close the browser and
// find the chapter again (seen on the emulator). BrowserScreen.js now starts a
// fresh WebView on the page it was showing. A page that kills its renderer at
// every load would turn that into a loop, so it happens at most twice a
// minute; past that, the browser closes rather than reload forever.
//
// No import, so a test runs it as it is.

export const REVIVE_WINDOW_MS = 60000;
export const REVIVE_MAX = 2;

/** Whether to bring the page back, given when the earlier revivals happened. */
export function shouldRevive(times, now = Date.now()) {
  return (times || []).filter((t) => now - t < REVIVE_WINDOW_MS).length < REVIVE_MAX;
}
