import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = process.env.PANELFLOW_RULES_PATH
  ?? join(here, '..', '..', '..', 'shared', 'detection-rules.json');

export const rulesRouter = Router();

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

// Remote config: detection heuristics + per-domain extraction rules.
// Clients cache by version and re-fetch periodically; updating the JSON on
// the server updates every client without an app-store release.
rulesRouter.get('/', (_req, res) => {
  try {
    const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: 'rules unavailable', detail: String(err.message) });
  }
});
