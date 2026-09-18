// Where the in-app browser may be sent, and by whom.
//
// This is the decision behind `onShouldStartLoadWithRequest` in
// BrowserScreen.js, kept apart from it so the rule can be read — and tested —
// without a WebView. It is a pure function of the request and of what the
// screen already knows; nothing here reaches the network or the page.
//
// What it is for: the "OnClick" ad networks anime and scan sites run. Their
// script waits for the reader's first tap anywhere on the page — the play
// button, say — and spends it on an advertiser. The first thing they try is
// `window.open`, which popup-guard.js refuses. The second, when that returns
// null, is to point *this* window at the ad instead: `location.href = …`. From
// the reader's side that is "I pressed Play and got a casino", and every tap
// costs one more site. The ad domains rotate weekly, so a host list cannot keep
// up; what does not rotate is the shape of the act — a navigation to another
// site that no tap of the reader's asked for.
//
// So the rule is: a page may take the reader anywhere on its own site, and to
// another site only by a link the reader actually tapped. Script does not get
// to leave the site. The exceptions below are the app's own requests, the app's
// own server (an OAuth handshake comes back to it by a server redirect that no
// tap started), and the very first load, when there is nothing yet to hijack.
//
// Known cost: a link the reader taps that *redirects* to a third site is
// refused at the second hop, because a redirect and a hijack arrive here as the
// same thing — a script-shaped navigation right after a tap. On a reader that
// is rare, and the page simply stays; the alternative is the casino.
//
// Android's WebView cannot say whether a navigation was a tap or a script —
// every request reports 'other' — so there a cross-site link tap is refused
// along with the hijacks. The reader sees a link that does nothing rather than
// an ad, which is the right way round.

/**
 * The registrable domain, near enough for this one decision.
 *
 * The same rule popup-guard.js uses, and the same admission: the real answer
 * needs the public suffix list, and the last two labels are right for the .com,
 * .fr, .to and .rip domains these sites live on. TWO_PART is the bounded list of
 * second-level labels under which a country hands out domains (the "x.co.uk",
 * "x.ne.jp", "x.com.br" shapes), and a test holds it to a table of hosts. Wrong
 * means two domains taken as one site, which loses a refusal, never a page the
 * reader wanted. The same test holds the two copies to the same answers.
 */
const TWO_PART = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'mil', 'sch', 'nom', 'web']);
export function siteOf(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length < 3) return parts.join('.');
  return parts.slice(TWO_PART.has(parts[parts.length - 2]) ? -3 : -2).join('.');
}

/** The host of a URL, lower-cased, or '' for anything unparseable. */
export function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

/** Whether this host is on a list — the entry itself, or under it. */
export const listed = (host, list) => (list || []).some((h) => host === h || host.endsWith(`.${h}`));

const sameSite = (a, b) => !!a && !!b && siteOf(hostOf(a)) === siteOf(hostOf(b));

/**
 * The navigation types the reader's own hand produces, as React Native's
 * WebView reports them. Anything else — 'other', 'reload', 'backforward' — is
 * either script or the browser itself.
 */
const BY_HAND = new Set(['click', 'formsubmit', 'formresubmit']);

/**
 * Decide one navigation.
 *
 * @param {object} req  what the WebView reported: `url`, `navigationType`,
 *   `isTopFrame` (absent on some platforms — then assumed to be the top frame,
 *   because that is the frame this rule protects)
 * @param {object} ctx  what the screen knows:
 *   `here`      the URL of the page currently on screen, '' before the first
 *   `asked`     the URL the app itself last told the WebView to load
 *   `trusted`   hosts script may always go to — the app's own server
 *   `blocked`   ad hosts, refused in every frame and by every means
 *   `stores`    app-store hosts, likewise (a universal link leaves the app)
 * @returns {{allow: boolean, reason: string}}  the reason is for the log line,
 *   so that "the page did not move" can be looked up rather than guessed at
 */
export function decide(req, ctx) {
  const url = String(req?.url ?? '');
  if (!/^https?:/i.test(url) && url !== 'about:blank') return { allow: false, reason: 'scheme' };

  const host = hostOf(url);
  if (listed(host, ctx.stores)) return { allow: false, reason: 'store' };
  if (listed(host, ctx.blocked)) return { allow: false, reason: 'ad host' };

  // A frame inside the page — a video player, usually — may come from anywhere;
  // rn-adblock.js has already had its say about the ones on the list. What is
  // guarded here is where the *window* goes.
  if (req?.isTopFrame === false) return { allow: true, reason: 'frame' };

  if (url === 'about:blank') return { allow: true, reason: 'blank' };
  if (sameSite(url, ctx.here)) return { allow: true, reason: 'same site' };
  if (sameSite(url, ctx.asked)) return { allow: true, reason: 'asked for' };
  if (listed(host, ctx.trusted)) return { allow: true, reason: 'own server' };
  if (!ctx.here) return { allow: true, reason: 'first load' };
  if (BY_HAND.has(req?.navigationType)) return { allow: true, reason: 'tapped' };

  return { allow: false, reason: 'script left the site' };
}
