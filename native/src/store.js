// Everything the screens draw, loaded in one place.
//
// The shelf, the bookmarks, the account's own folders and where each cover
// leads are four answers to the same question — "what does this library look
// like right now" — and asking for them separately is how a screen ends up
// drawn half-informed: covers with no progress under them, or a folder tab for
// a shelf that was deleted on another device. So they are fetched together and
// handed down as one object.
import { useCallback, useEffect, useState } from 'react';
import { send, on, boot } from './core.js';
import { setLang } from './i18n.js';
import { seedLocalDefaults } from './prefs.js';
import { fillMissingCovers } from './covers.js';
import { registerChapterChecks } from './background.js';

const EMPTY = {
  library: [],
  progress: {},
  targets: {},
  categories: [],
  account: null,
  settings: {},
  // 'system' means "ask the phone", which is a real answer and not the absence
  // of one — see shared/prefs.js.
  theme: 'system',
  // Sites the reader asked the blocker to leave alone. An account setting, so
  // whitelisting on the desktop is whitelisting on the phone.
  whitelist: [],
};

export function useStore() {
  const [state, setState] = useState(EMPTY);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [lib, prog, targets, cats, account, settings, prefs] = await Promise.all([
      send({ type: 'getLibrary' }),
      send({ type: 'getProgressAll' }),
      send({ type: 'continueTargets' }),
      send({ type: 'getCategories' }),
      send({ type: 'getAccount' }),
      send({ type: 'getSettings' }),
      send({ type: 'getAccountPrefs' }),
    ]);
    // The account's language is a preference like any other, and it is adopted
    // here rather than in the settings screen so that a phone signing in on a
    // train comes back in the language the desktop chose, without being asked.
    setLang(prefs?.prefs?.uiLang ?? 'auto');
    const library = lib?.library || [];
    setState({
      library,
      progress: prog?.progress || {},
      targets: targets?.targets || {},
      categories: cats?.categories || [],
      account: account?.authUser || null,
      settings: settings?.settings || {},
      theme: prefs?.prefs?.theme ?? 'system',
      whitelist: prefs?.prefs?.whitelist ?? settings?.settings?.whitelist ?? [],
    });
    setLoading(false);
    // Handed back as well as stored: the caller below wants the library it just
    // loaded, and reading it out of React state on the next line would read the
    // render before this one.
    return library;
  }, []);

  useEffect(() => {
    let alive = true;

    (async () => {
      // Draw what is already on the device first, then let the boot sync
      // repaint it. The alternative — waiting for the server — is a spinner on
      // every launch for a library that was already there.
      const library = await refresh();
      if (!alive) return;
      // Before the sync, because the first chapter this install opens may be
      // opened before a network round trip finishes, and the reader reads these
      // out of the store when it loads rather than when it is told to.
      await seedLocalDefaults().catch(() => {});
      boot();
      // Every launch, because that is also how a changed interval reaches the
      // OS — registering the same name twice replaces, it does not duplicate.
      // Asked for again rather than read off the render above: this runs before
      // React has committed anything.
      const settings = await send({ type: 'getSettings' });
      registerChapterChecks(settings?.settings?.checkIntervalMin);
      // And last, quietly: the grey rectangles. A cover lives on a series page,
      // so an entry added from a chapter page never had one to sync — going and
      // looking is the only thing that fills them in. Only redraws if it found
      // something.
      if (await fillMissingCovers(library).catch(() => false) && alive) refresh();
    })();

    const off = on('changed', () => { if (alive) refresh(); });
    return () => { alive = false; off(); };
  }, [refresh]);

  return { ...state, loading, refresh };
}

/**
 * Covers are hotlink-protected on most scan sites: loading one straight into an
 * <Image> gets a 403. The backend proxies them with the site as Referer.
 */
export function coverSrc(entry, settings) {
  if (!entry?.coverUrl) return null;
  const base = settings?.backendUrl;
  if (!base) return entry.coverUrl;
  return `${base}/api/cover?url=${encodeURIComponent(entry.coverUrl)}`
    + `&ref=${encodeURIComponent(entry.sourceUrl || '')}`;
}
