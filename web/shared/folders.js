// Where a series lives, and what that place means.
//
// Every entry sits in exactly one folder. Five of them are built in and are the
// reading statuses themselves — reading, paused, plan, completed, dropped — and
// the rest are shelves the user invented, stored as "cat:<id>".
//
// A custom category is not a sixth status. It *stands for* one: a category
// called "Weekly" whose status is `reading` is watched for new chapters and
// exports to MyAnimeList as Reading, exactly as the built-in folder would. That
// indirection is the whole design, and it is why this file exists rather than
// five string comparisons scattered across the server and two clients — the
// watcher silently skipping a series because the user filed it under a shelf of
// their own is the bug this prevents.
//
// Tags are the other axis and stay the other axis: a series carries any number
// of them, and lives in one category. Neither replaces the other.
//
// Plain script, not a module: Chrome content scripts and the extension's own
// pages cannot be ESM. The copies under extension/shared, web/shared and
// mobile/www/shared are generated — run `npm run sync:shared` after editing.
(function (root) {
  'use strict';

  /** The folders every account has, whether it is signed in or not. */
  const BUILTIN = [
    { id: 'reading', label: 'Reading' },
    { id: 'paused', label: 'Paused' },
    { id: 'plan', label: 'Plan' },
    { id: 'completed', label: 'Completed' },
    { id: 'dropped', label: 'Dropped' },
  ];

  const BUILTIN_IDS = BUILTIN.map((f) => f.id);
  const DEFAULT_FOLDER = 'reading';

  // Folders the chapter watcher looks at: still being published, still being
  // read. A completed or dropped series is not news, and a plan-to-read one has
  // no "new" to be behind on because the reader has not started.
  const WATCHED = ['reading', 'paused'];

  // "cat:" and not a separate column, because a folder is one value and an
  // entry that is somehow in both a built-in folder and a category is a state
  // that then has to be resolved on every read. One string, one meaning.
  const PREFIX = 'cat:';

  const isBuiltin = (folder) => BUILTIN_IDS.indexOf(folder) !== -1;
  const isCustom = (folder) => typeof folder === 'string' && folder.slice(0, 4) === PREFIX;
  const categoryId = (folder) => (isCustom(folder) ? folder.slice(PREFIX.length) : null);
  const folderFor = (category) => PREFIX + (category && category.id ? category.id : category);

  const find = (folder, categories) => {
    const id = categoryId(folder);
    if (!id) return null;
    for (const c of categories || []) if (c && c.id === id) return c;
    return null;
  };

  /**
   * The reading status a folder stands for.
   * A category nobody can find — deleted on another device, or a backup written
   * by an account that had it — reads as the default rather than as nothing:
   * the alternative is an entry that belongs to no status at all, and every
   * caller here is deciding something (watch it? export it as what?) that has
   * to have an answer.
   */
  function folderStatus(folder, categories) {
    if (isBuiltin(folder)) return folder;
    const c = find(folder, categories);
    return c && isBuiltin(c.status) ? c.status : DEFAULT_FOLDER;
  }

  /** What to write on a chip or a tab. */
  function folderLabel(folder, categories) {
    const c = find(folder, categories);
    if (c) return c.name;
    for (const f of BUILTIN) if (f.id === folder) return f.label;
    return BUILTIN[0].label;
  }

  /** Whether this folder can be stored at all — ownership is the server's call. */
  const isFolder = (folder) => isBuiltin(folder) || (isCustom(folder) && folder.length > PREFIX.length);

  /** The built-in folders, then the user's own, in the order they chose. */
  function folderTabs(categories) {
    const custom = sortCategories(categories)
      .map((c) => ({ id: folderFor(c), label: c.name, status: c.status, custom: true }));
    return [...BUILTIN.map((f) => ({ ...f, status: f.id, custom: false })), ...custom];
  }

  const sortCategories = (categories) => (categories || []).slice().sort((a, b) =>
    ((a.position ?? 0) - (b.position ?? 0)) || String(a.name).localeCompare(String(b.name)));

  // Collapsed whitespace and a length the UI can actually draw. Returns '' for
  // anything unusable so callers have one thing to test.
  const NAME_MAX = 40;
  const cleanName = (name) => String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

  root.PanelFlowFolders = {
    BUILTIN, BUILTIN_IDS, DEFAULT_FOLDER, WATCHED, PREFIX, NAME_MAX,
    isBuiltin, isCustom, isFolder, categoryId, folderFor,
    folderStatus, folderLabel, folderTabs, sortCategories, cleanName,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
