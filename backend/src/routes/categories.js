// The user's own shelves.
//
// Five folders fit most libraries and not all of them: "Weekly", "With my
// brother", "Waiting for the physical release" are all reading, and filing them
// together is the thing a category fixes. What a category is *not* is a second
// tag system — tags already do that, a series has any number of them, and this
// one is the single place an entry lives. See shared/folders.js.
import { Router } from 'express';
import { db, uid } from '../db.js';
import { wrap } from '../wrap.js';
import { BUILTIN_IDS, DEFAULT_FOLDER, PREFIX, cleanName, NAME_MAX } from '../folders.js';

export const categoriesRouter = Router();

// A shelf list is a thing you scroll past, not a database. The cap is here so
// one client bug cannot write ten thousand rows onto an account.
export const MAX_CATEGORIES = 50;

const toCategory = (row) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  position: Number(row.position),
});

export async function listCategories(userId) {
  const rows = await db.prepare(
    'SELECT * FROM categories WHERE user_id = ? ORDER BY position ASC, name ASC',
  ).all(userId);
  return rows.map(toCategory);
}

/**
 * The folder value to store, or an error message.
 * Ownership is checked here and nowhere else: "cat:" plus somebody else's id is
 * a well-formed folder, and the only thing that makes it wrong is whose it is.
 */
export async function checkFolder(userId, folder) {
  if (folder === undefined || folder === null) return { folder: null };
  if (BUILTIN_IDS.includes(folder)) return { folder };
  if (typeof folder === 'string' && folder.startsWith(PREFIX)) {
    const row = await db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?')
      .get(folder.slice(PREFIX.length), userId);
    if (row) return { folder };
    return { error: 'that category does not exist' };
  }
  return { error: `folder must be one of ${BUILTIN_IDS.join(', ')} or one of your categories` };
}

const readBody = (body) => {
  const errors = [];
  const name = cleanName(body?.name);
  if (body?.name !== undefined && !name) errors.push(`name must be 1-${NAME_MAX} characters`);
  let status;
  if (body?.status !== undefined) {
    if (!BUILTIN_IDS.includes(body.status)) errors.push(`status must be one of ${BUILTIN_IDS.join(', ')}`);
    else status = body.status;
  }
  return { errors, name, status };
};

categoriesRouter.get('/', wrap(async (req, res) => {
  res.json(await listCategories(req.user.id));
}));

categoriesRouter.post('/', wrap(async (req, res) => {
  const { errors, name, status } = readBody(req.body);
  if (!name) errors.push(`name must be 1-${NAME_MAX} characters`);
  if (errors.length) return res.status(400).json({ error: [...new Set(errors)].join('; ') });

  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM categories WHERE user_id = ?')
    .get(req.user.id);
  if (Number(n) >= MAX_CATEGORIES) {
    return res.status(400).json({ error: `at most ${MAX_CATEGORIES} categories` });
  }
  // NOCASE, so this is the same check the UNIQUE index makes — done here to
  // answer with a sentence instead of a constraint violation.
  const clash = await db.prepare('SELECT id FROM categories WHERE user_id = ? AND name = ?')
    .get(req.user.id, name);
  if (clash) return res.status(409).json({ error: 'you already have a category with that name' });

  const id = uid();
  await db.prepare(
    `INSERT INTO categories (id, user_id, name, status, position)
     VALUES (?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM categories WHERE user_id = ?), 0))`,
  ).run(id, req.user.id, name, status ?? DEFAULT_FOLDER, req.user.id);
  res.status(201).json(toCategory(await db.prepare('SELECT * FROM categories WHERE id = ?').get(id)));
}));

// Before /:id, or "order" is read as an id and the reorder becomes a rename.
categoriesRouter.put('/order', wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: 'ids must be an array of category ids' });
  const mine = new Set((await listCategories(req.user.id)).map((c) => c.id));
  // One batch: a half-applied order is a list nobody asked for, and the client
  // that sent it has already redrawn itself in the order it expects.
  const statements = ids
    .filter((id) => mine.has(id))
    .map((id, i) => ({
      sql: 'UPDATE categories SET position = ? WHERE id = ? AND user_id = ?',
      args: [i, id, req.user.id],
    }));
  if (statements.length) await db.batch(statements);
  res.json(await listCategories(req.user.id));
}));

categoriesRouter.put('/:id', wrap(async (req, res) => {
  const row = await db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const { errors, name, status } = readBody(req.body);
  if (errors.length) return res.status(400).json({ error: [...new Set(errors)].join('; ') });

  if (name && name.toLowerCase() !== String(row.name).toLowerCase()) {
    const clash = await db.prepare('SELECT id FROM categories WHERE user_id = ? AND name = ?')
      .get(req.user.id, name);
    if (clash) return res.status(409).json({ error: 'you already have a category with that name' });
  }
  await db.prepare('UPDATE categories SET name = ?, status = ? WHERE id = ?')
    .run(name || row.name, status ?? row.status, row.id);
  res.json(toCategory(await db.prepare('SELECT * FROM categories WHERE id = ?').get(row.id)));
}));

/**
 * Removing a shelf must never remove what was on it. Every entry filed here
 * moves to the built-in folder the category stood for — which is the folder it
 * has effectively been in all along, so nothing about the series changes except
 * which tab it is under.
 */
categoriesRouter.delete('/:id', wrap(async (req, res) => {
  const row = await db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  // A transaction, because the window between the two is a library with entries
  // pointing at a category that no longer exists.
  await db.batch([
    {
      sql: `UPDATE library SET folder = ?, updated_at = datetime('now')
            WHERE user_id = ? AND folder = ?`,
      args: [BUILTIN_IDS.includes(row.status) ? row.status : DEFAULT_FOLDER,
        req.user.id, PREFIX + row.id],
    },
    { sql: 'DELETE FROM categories WHERE id = ? AND user_id = ?', args: [row.id, req.user.id] },
  ]);
  res.status(204).end();
}));
