// Turns shared/adblock-list.json into the per-platform files that actually
// block anything.
//
// Three engines, three syntaxes, one list: Chrome wants declarativeNetRequest
// rules, Safari wants a WKContentRuleList, and Android has no rule engine at
// all so it pulls bare hostnames back out of Chrome's file. Before this script
// the three were maintained by hand and had already drifted — the Safari list
// blocked 8 of the 20 hosts the extension blocked, which is not a policy, it is
// an accident nobody noticed.
//
// Chrome's syntax is not written here: shared/adblock.js owns it, because the
// extension also has to build those rules at runtime out of a list fetched from
// the backend, and that has to be the same code.
//
// Called by `npm run sync:shared`; the backend test suite fails if a generated
// file is edited by hand or left stale.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../shared/adblock.js';

const { flatten, sitesOf, toDnr } = globalThis.PanelFlowAdblock;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const listPath = join(root, 'shared', 'adblock-list.json');

/** The maintained list, flattened. */
export function loadList(text = readFileSync(listPath, 'utf8')) {
  return flatten(JSON.parse(text));
}

/**
 * The sites the extension works on — every site the rules file names — as
 * bare hosts, sorted.
 *
 * Two answers come out of this one list: where the extension may run (the
 * manifest's host lists, written by scripts/sync-shared.mjs) and where it
 * blocks ads (the `initiatorDomains` of every rule below). They are the same
 * question — "is this one of the reading sites?" — and a second list would be
 * a second answer to it.
 *
 * Both halves of the rules file: `domains` for the reader, `videoDomains` for
 * the speed control. Keys beginning with `_` are notes to whoever edits that
 * file, not hostnames.
 */
export function readingSites(text = readFileSync(join(root, 'shared', 'detection-rules.json'), 'utf8')) {
  const rules = JSON.parse(text);
  const named = [...Object.keys(rules.domains || {}), ...Object.keys(rules.videoDomains || {})];
  return sitesOf(named.filter((key) => !key.startsWith('_')));
}

/**
 * Safari's content-blocker input.
 *
 * `url-filter` is a regex over the whole URL, and WebKit only implements a
 * subset of regex — no non-capturing groups, no negated classes — so the host
 * is anchored with `([a-z0-9-]+\.)*`, which every version accepts. Anchoring
 * matters: a bare `adsterra\.com` also matches `example.com/?ref=adsterra.com`.
 *
 * `if-domain` would be the natural way to say this and is the wrong tool: in a
 * content blocker it restricts by the *page's* domain, not the request's.
 */
export function toSafari(list) {
  return flatten(list).entries.map((e) => ({
    trigger: {
      'url-filter': `^https?://([a-z0-9-]+\\.)*${e.host.replace(/\./g, '\\.')}[:/]`,
      'load-type': ['third-party'],
    },
    action: { type: 'block' },
  }));
}

/**
 * Every generated file, as `{ path, content }` — the exact bytes expected on
 * disk. Both are JSON, which has nowhere to put a "do not edit by hand" line,
 * so they are written one rule per line instead: an edit made in the wrong file
 * shows up as a one-line diff that the sync test then refuses.
 */
export function generated(list = loadList(), sites = readingSites()) {
  const lines = (rules) => `[\n${rules.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]\n`;
  return [
    // Confined to the reading sites, like the rules the worker installs later
    // (extension/background.js): the bundled set is the one in force on a
    // fresh install, and it has no more licence to block ads everywhere than
    // the fetched one does.
    { path: join(root, 'extension', 'rules', 'adblock.json'), content: lines(toDnr(list, { sites })) },
    { path: join(root, 'ios', 'Resources', 'blocker-rules.json'), content: lines(toSafari(list)) },
  ];
}
