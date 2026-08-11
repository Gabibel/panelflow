import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatten } from '../adblock.js';

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, '..', '..', '..', 'shared');
const rulesPath = process.env.PANELFLOW_RULES_PATH ?? join(shared, 'detection-rules.json');
const adblockPath = process.env.PANELFLOW_ADBLOCK_PATH ?? join(shared, 'adblock-list.json');

export const rulesRouter = Router();
export const adblockRouter = Router();

/**
 * The detection rules as an object, for server-side code that needs them
 * (the compatibility check consults `domains`). Never throws: a missing or
 * malformed file degrades the caller to generic heuristics, which is what the
 * clients already fall back to.
 */
export function loadRules() {
  try {
    return JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch {
    return { heuristics: {}, domains: {} };
  }
}

/**
 * The ad-block list, flat and versioned. Never throws: a client that cannot
 * read this falls back to the copy it shipped with, so an empty list here would
 * be worse than an error — it reads as "nothing is blocked any more".
 */
export function loadFilterList() {
  return flatten(JSON.parse(readFileSync(adblockPath, 'utf8')));
}

// Remote config: detection heuristics + per-domain extraction rules.
// Clients cache by version and re-fetch periodically; updating the JSON on
// the server updates every client without an app-store release.
rulesRouter.get('/', (_req, res) => {
  try {
    const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
    // Advisory, and derived rather than stored, so the number in the detection
    // file cannot claim a filter list version that was never shipped. A client
    // that only wants to know whether its blocking is current can read it here
    // instead of pulling the whole list.
    try { rules.filterListVersion = loadFilterList().version; } catch { /* keep the bundled number */ }
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: 'rules unavailable', detail: String(err.message) });
  }
});

// The list itself, on its own endpoint: it changes on a different clock from
// the detection rules, and it is the bigger of the two.
adblockRouter.get('/', (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(loadFilterList());
  } catch (err) {
    res.status(500).json({ error: 'filter list unavailable', detail: String(err.message) });
  }
});
