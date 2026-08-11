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

const { flatten, toDnr } = globalThis.PanelFlowAdblock;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const listPath = join(root, 'shared', 'adblock-list.json');

/** The maintained list, flattened. */
export function loadList(text = readFileSync(listPath, 'utf8')) {
  return flatten(JSON.parse(text));
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
export function generated(list = loadList()) {
  const lines = (rules) => `[\n${rules.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]\n`;
  return [
    { path: join(root, 'extension', 'rules', 'adblock.json'), content: lines(toDnr(list)) },
    { path: join(root, 'ios', 'Resources', 'blocker-rules.json'), content: lines(toSafari(list)) },
  ];
}
