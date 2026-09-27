// The ad-block list, read the same way everywhere.
//
// shared/adblock-list.json is grouped and annotated because a human maintains
// it; every consumer wants a flat list of hosts and a rule engine's syntax.
// That translation lives here rather than in each client, because the list is
// remote config: the extension fetches a newer one from /api/adblock and has to
// turn it into declarativeNetRequest rules at runtime, which is the same job
// the build script does at build time. Two implementations of it would be two
// answers to "is this host blocked", and the one nobody tested would be the one
// running on the user's machine.
//
// Pure: no fetch, no storage, no chrome.*.
(function (root) {
  'use strict';

  // A blocked host is never content, so the types are about coverage, not
  // taste: script for the loader, sub_frame for the iframe it writes,
  // xmlhttprequest for the bid call, ping for the `navigator.sendBeacon` an
  // analytics tag fires as the page goes away — that last one is a separate
  // resource type in Chrome, so a list without it blocks the measurement a
  // reader makes while reading and lets through the one it sends on exit.
  // `image` is added only where the group serves creatives or pixels, so a CDN
  // shared with a site's own artwork cannot be caught by a rule meant for a
  // banner.
  // `main_frame` is the tab itself, and it is here because of what these sites
  // actually do: the interstitial. Clicking the site's own "next chapter"
  // control hands the tab to an advertiser first and lets it come back a few
  // seconds later, and every request on the way is a top-level navigation — not
  // a script, not a frame. Blocking the script that arranges it does nothing
  // once the tab has already been sent. A blocked navigation leaves the reader
  // where they were, which is where they were going.
  const TYPES = ['main_frame', 'script', 'sub_frame', 'xmlhttprequest', 'ping'];
  const TYPES_WITH_IMAGES = [
    'main_frame', 'script', 'sub_frame', 'image', 'xmlhttprequest', 'ping'];

  /**
   * The grouped file as `{ version, updated, entries: [{ host, images }] }`.
   * Accepts an already-flat list unchanged, so a client can hand back whatever
   * the server sent it without checking which shape arrived.
   */
  function flatten(list) {
    const raw = list || {};
    const version = Number(raw.version) || 1;
    const updated = raw.updated || null;
    if (Array.isArray(raw.entries)) {
      const entries = raw.entries
        .filter((e) => e && typeof e.host === 'string' && e.host)
        .map((e) => ({ host: e.host, images: !!e.images }));
      return { version, updated, entries };
    }
    const entries = [];
    for (const group of Object.values(raw.groups || {})) {
      for (const host of (group && group.hosts) || []) {
        if (host) entries.push({ host: String(host), images: !!group.images });
      }
    }
    return { version, updated, entries };
  }

  /**
   * The sites a list of match patterns names, as bare hosts, sorted.
   *
   * `*://*.example.com/*` is how the manifest names a reading site and
   * `https://example.com/*` is how the popup asks for one more; both come out
   * as `example.com`, which declarativeNetRequest reads as that host and every
   * subdomain of it. A pattern with no host of its own, such as `<all_urls>`,
   * names no site and adds none: granting the whole web to the reader does not
   * turn the ad blocking into a whole-web blocker.
   */
  function sitesOf(patterns) {
    const hosts = new Set();
    for (const raw of patterns || []) {
      const text = String(raw || '').trim().toLowerCase();
      const m = /^(?:\*|https?):\/\/(?:\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:\/|$)/.exec(text)
        || /^(?:\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(text);
      if (m) hosts.add(m[1]);
    }
    return [...hosts].sort();
  }

  /**
   * Chrome's declarativeNetRequest block rules. Ids are positional from
   * `startId`, which is all they have to be: the caller replaces the whole set
   * at once rather than patching it, so an id never has to mean the same host
   * across two versions of the list.
   *
   * `sites` confines every rule to requests *made by* those sites' pages
   * (`initiatorDomains`). The extension always passes them: it blocks ads on
   * the reading sites it works on and nowhere else, which is what its listing
   * and its privacy policy say, and what the Chrome Web Store's single-purpose
   * rule asks of it. A request with no initiator — an address typed into the
   * omnibox — is never matched, and neither is one an advert's own frame makes:
   * the frame itself was already refused, which is the one that mattered.
   * Chrome refuses an empty `initiatorDomains`, so no sites means no condition.
   */
  function toDnr(list, opts) {
    const startId = (opts && opts.startId) || 1;
    const sites = (opts && opts.sites) || [];
    return flatten(list).entries.map((e, i) => ({
      id: startId + i,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: `||${e.host}^`,
        resourceTypes: e.images ? TYPES_WITH_IMAGES : TYPES,
        ...(sites.length ? { initiatorDomains: [...sites] } : {}),
      },
    }));
  }

  /**
   * The whitelist, as rules that beat the block rules above.
   *
   * `allowAllRequests` on the frame — not `allow` on each request — because the
   * user whitelisting a site means "stop blocking here", and what has to stop
   * is a request to some ad network *made by* that site's pages. Matching the
   * request's own domain would only ever exempt the site's own assets, which
   * were never blocked in the first place.
   *
   * A bare domain covers its subdomains: someone typing `example.com` into the
   * options page has not undertaken to also think of `www.example.com`.
   */
  function allowRules(domains, opts) {
    const startId = (opts && opts.startId) || 10000;
    const clean = (d) => String(d || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/:].*$/, '');
    return (domains || []).map(clean).filter(Boolean).map((domain, i) => ({
      id: startId + i,
      // Above the block rules' 1, and above anything a future list adds: the
      // whitelist is the user overruling the list, so it cannot be a tie.
      priority: 100,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] },
    }));
  }

  root.PanelFlowAdblock = { flatten, sitesOf, toDnr, allowRules, TYPES, TYPES_WITH_IMAGES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
