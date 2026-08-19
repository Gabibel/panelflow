// The settings that follow the reader instead of the machine.
//
// Two verbs and no cleverness. GET hands back what the account has actually
// answered — not the defaults, and not a merge: a device that has just signed
// in needs to see the difference between "the account says light" and "the
// account has never been asked", because in the second case its own settings
// are the better answer and must not be overwritten by a shrug.
//
// PUT merges. It never replaces, for the same reason core.setSettings does not:
// the options page knows about ten settings and the phone knows about four, and
// a phone that PUT its whole idea of the account would delete the six it has
// never heard of.
import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import { clean } from '../prefs.js';

export const prefsRouter = Router();

/** What this account has answered, as an object. Never null. */
export async function readPrefs(userId) {
  const row = await db.prepare('SELECT data, updated_at FROM prefs WHERE user_id = ?').get(userId);
  if (!row) return { prefs: {}, updatedAt: null };
  let stored;
  // A row that will not parse is a row written by something that is not this
  // code. Answering "no opinion" lets the reader set their settings again,
  // which is a recovery; answering 500 leaves them with a settings page that
  // never loads on any device at once.
  try { stored = JSON.parse(row.data); } catch { stored = {}; }
  // Cleaned on the way out as well as in: the allowed values are a list that
  // shrinks sometimes, and a setting that was legal when it was written is not
  // a setting this version may hand to a client as though it still were.
  return { prefs: clean(stored).prefs, updatedAt: row.updated_at };
}

prefsRouter.get('/', wrap(async (req, res) => {
  res.json(await readPrefs(req.user.id));
}));

prefsRouter.put('/', wrap(async (req, res) => {
  const { prefs: patch, errors } = clean(req.body?.prefs ?? req.body);
  // Refused values are named, and the rest of the patch is still applied. The
  // alternative — 400 for the whole body — means one unknown-to-this-server
  // value stops a theme change that was perfectly valid and in the same
  // request, on the surface where the reader is watching it not happen.
  if (!Object.keys(patch).length) {
    return res.status(400).json({
      error: errors.length ? [...new Set(errors)].join('; ') : 'nothing to change',
    });
  }

  const { prefs: current } = await readPrefs(req.user.id);
  const merged = { ...current, ...patch };
  await db.prepare(
    `INSERT INTO prefs (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(req.user.id, JSON.stringify(merged));

  const saved = await readPrefs(req.user.id);
  // The refusals travel with the success. A client that sent a value this
  // server will not store should be able to say so rather than show a tick.
  res.json(errors.length ? { ...saved, refused: [...new Set(errors)] } : saved);
}));
