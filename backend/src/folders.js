// ESM face of shared/folders.js — same reasoning as series-match.js: that file
// stays a plain script because Chrome content scripts cannot be modules, so it
// publishes itself on globalThis and this re-export keeps the server idiomatic
// while there is still only one copy of what a folder means.
import '../../shared/folders.js';

export const {
  BUILTIN,
  BUILTIN_IDS,
  DEFAULT_FOLDER,
  WATCHED,
  PREFIX,
  NAME_MAX,
  isBuiltin,
  isCustom,
  isFolder,
  categoryId,
  folderFor,
  folderStatus,
  folderLabel,
  folderTabs,
  sortCategories,
  cleanName,
} = globalThis.PanelFlowFolders;
