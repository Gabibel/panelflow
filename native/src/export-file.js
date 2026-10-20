// The account written out for the share sheet.
//
// A phone has no downloads folder, so "Export" writes the account to this
// app's cache and hands that file to the share sheet (AccountScreen.js). The
// file is the whole account: library, history, settings, the e-mail address.
// It is overwritten by the next export, and it goes when the account's data
// leaves this phone (core.js, onForget): a copy of an account that was closed
// or signed out of is not this phone's to keep.
import { File, Paths } from 'expo-file-system';

const NAME = 'panelflow-export.json';

/** Where the export is written: the app's cache, never the phone's Files. */
export const exportFile = () => new File(Paths.cache, NAME);

/** The last export gone, if there is one. Never throws: there may be none. */
export function forgetExport() {
  try {
    const file = exportFile();
    if (file.exists) file.delete();
  } catch {
    // Nothing was ever written, or the cache was already cleared by the system.
  }
}
