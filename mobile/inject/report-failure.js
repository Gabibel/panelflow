// What a broken injected script looks like on a phone.
//
// The native shells wrap each injected file in its own try/catch so one bad
// file cannot cost the user the rest — the right call, except that the catch
// used to end in `console.warn`. Nobody reads a WebView console on a phone.
// The observable result of detect.js dying, or of an asset missing from the
// build entirely, was a page where the Reader Mode pill simply never appeared,
// with nothing anywhere saying why. "It doesn't work on this site" is what the
// user reports, and it is not enough to act on.
//
// So the catch calls in here instead, and this file puts a line on the screen.
// It is injected first, before every other file, and it deliberately depends on
// nothing: not chrome-shim.js (which is itself one of the files that can fail),
// not the reader's stylesheet, not the page's own scripts. Two consequences —
// the eight lines of bridge transport below are a copy of the shim's, and every
// style is inline and `!important`, because the page is a scan site and its CSS
// is hostile by accident if not by design.
(function () {
  'use strict';
  // User scripts run again on every SPA navigation on both platforms.
  if (window.PanelFlowFailed && window.PanelFlowFailed.__panelflow) return;

  const BOX = 'panelflow-load-failure';
  const failures = [];

  // Fire-and-forget, so it needs no reply and holds no state open. Both shells
  // route `event` envelopes through a `when`/`switch` that ignores what it does
  // not know, so this is already safe to send to today's builds.
  const transport = (() => {
    if (window.PanelFlowNative && window.PanelFlowNative.post) {
      return (s) => window.PanelFlowNative.post(s);
    }
    if (window.webkit && window.webkit.messageHandlers &&
        window.webkit.messageHandlers.panelflow) {
      return (s) => window.webkit.messageHandlers.panelflow.postMessage(s);
    }
    return null;
  })();

  const style = (el, css) => el.setAttribute('style', css);

  function paint() {
    const root = document.body || document.documentElement;
    if (!root) return;

    let box = document.getElementById(BOX);
    if (!box || !box.isConnected) {
      box = document.createElement('div');
      box.id = BOX;
      style(box, [
        'position:fixed!important', 'left:12px!important', 'right:12px!important',
        'bottom:12px!important', 'z-index:2147483647!important',
        'box-sizing:border-box!important', 'padding:12px 14px!important',
        'border-radius:12px!important', 'border:1px solid #f87171!important',
        'background:#1f1113!important', 'color:#fde8e8!important',
        'font:13px/1.45 system-ui,-apple-system,sans-serif!important',
        'text-align:left!important', 'box-shadow:0 6px 24px rgba(0,0,0,.4)!important',
      ].join(';'));

      const text = document.createElement('div');
      text.id = BOX + '-text';
      box.appendChild(text);

      const row = document.createElement('div');
      style(row, 'margin-top:10px!important;display:flex!important;gap:8px!important');
      const button = (label, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        style(b, [
          'all:unset!important', 'cursor:pointer!important',
          'padding:6px 12px!important', 'border-radius:8px!important',
          'border:1px solid #f87171!important', 'color:#fde8e8!important',
          'font:600 13px/1 system-ui,-apple-system,sans-serif!important',
        ].join(';'));
        b.addEventListener('click', onClick);
        row.appendChild(b);
        return b;
      };
      // Reload first because it is the one that sometimes works: a script the
      // page clobbered before we ran may well survive the next load. A file
      // missing from the build will not, which is why the text says which.
      button('Reload', () => location.reload());
      button('Hide', () => box.remove());
      box.appendChild(row);

      root.appendChild(box);
    }

    const lines = failures.map((f) => `${f.file} — ${f.error}`).join('\n');
    document.getElementById(BOX + '-text').textContent =
      'PanelFlow could not fully start on this page. Reader Mode and your ' +
      'library may not work here.\n' + lines;
  }

  function show() {
    if (document.body) return paint();
    // At document-start there is no body yet, and appending to a bare
    // <html> is how you get an element the parser then throws away.
    document.addEventListener('DOMContentLoaded', paint, { once: true });
  }

  /**
   * One injected file did not survive. Called by the native wrappers, by file
   * name, including for a file the build did not ship at all.
   */
  function report(file, error) {
    const detail = { file: String(file), error: String((error && error.message) || error || 'unknown') };
    failures.push(detail);
    // Kept, because it is what a developer with a cable attached reads, and it
    // is the only trace left if the DOM part of this file is what broke.
    console.warn('panelflow: ' + detail.file + ' failed', error);
    try {
      if (transport) transport(JSON.stringify({ event: 'scriptFailed', ...detail }));
    } catch (e) { /* the bridge is the thing that is broken; nothing else to try */ }
    try {
      show();
    } catch (e) {
      console.warn('panelflow: could not show the failure', e);
    }
  }

  report.__panelflow = true;
  report.list = () => failures.slice();
  window.PanelFlowFailed = report;
})();
