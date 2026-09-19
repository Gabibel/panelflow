// "Signaler un problème": what a bug report contains, on every surface.
//
// The testers were sending screenshots, and a screenshot of a page that did
// not open says nothing about why. What does: the build (so a fix that is not
// in the tester's build is not reported as not working), the device and its
// system, the page they were on, the moment, and the last few things the app
// noted. This file is the two halves of that, shared so the phone, the
// extension and the web app write the same mail:
//
//   createDiagnostics()  a ring buffer of the last few dozen events, in
//                        memory, with no transport at all. The privacy page
//                        promises that nothing leaves the device but what
//                        the reader sends; this file holds to that by having
//                        nothing to send with. It forgets on restart, which
//                        is fine: a report is about now.
//   reportLines()        the mail, as lines. Pure, so a test reads it
//                        without a phone or a browser.
//   mailto()             the address bar form of that mail.
//
// A plain script like search.js: the phone loads it beside the core, the
// extension in its worker and its options page, the web app on its settings
// tab, and backend/src/report.js re-exports it for the tests.
(function (root) {
  'use strict';

  /** Where reports go: the operator's address, the same one the legal pages carry. */
  const REPORT_TO = '1animoment@gmail.com';

  /** How many events are kept. Sixty is a session, not a history. */
  const KEEP = 60;

  /** No detail longer than this: a URL with a token in it, or a stack, never fills the mail. */
  const DETAIL_MAX = 200;

  /**
   * A buffer of what happened lately, for the report screen and nothing else.
   * Anything may `note()`; only the report screen `recent()`s.
   *
   * `kind` is a short word ('refused', 'script', 'hub', 'page'); `detail`
   * whatever explains it. The page the reader was on last is kept apart: it
   * is the first line of a report.
   */
  function createDiagnostics(keep = KEEP) {
    const events = [];
    let lastUrl = '';
    return {
      note(kind, detail) {
        events.push({ at: new Date().toISOString(), kind, detail: String(detail ?? '').slice(0, DETAIL_MAX) });
        if (events.length > keep) events.shift();
      },
      sawPage(url) {
        if (url) lastUrl = String(url).slice(0, DETAIL_MAX);
      },
      recent: () => events.slice(),
      lastPage: () => lastUrl,
      /** Empty, for tests and for a tester who wants a clean slate before repeating. */
      clear() {
        events.length = 0;
        lastUrl = '';
      },
    };
  }

  /**
   * The core's own failure trail (`PanelFlowCore.diag.trail()`), in the shape
   * the report prints: a failed hub call is an event like any other.
   */
  function fromTrail(trail) {
    return (trail || []).map((e) => ({
      at: e.at,
      kind: e.scope || 'hub',
      detail: String(`${e.path ? `${e.path}${e.status ? ' → ' + e.status : ''}: ` : ''}${e.message || ''}`).slice(0, DETAIL_MAX),
    }));
  }

  /** The facts, as lines. */
  function reportLines({ description, url, events, app, platform, now }) {
    const sorted = (events || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return [
      `PanelFlow ${app.version} (build ${app.build})`,
      `${platform.os} ${platform.version}`,
      `Page: ${url || '(none)'}`,
      `Date: ${now}`,
      '',
      description || '(what happened?)',
      '',
      '--- last events ---',
      ...(sorted.length ? sorted.map((e) => `${e.at} ${e.kind}: ${e.detail}`) : ['(none)']),
    ];
  }

  /** The mail as an address, for `Linking`, an `<a href>` or `window.open`. */
  function mailto(to, subject, lines) {
    return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
  }

  const api = { REPORT_TO, KEEP, createDiagnostics, fromTrail, reportLines, mailto };
  root.PanelFlowReport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
