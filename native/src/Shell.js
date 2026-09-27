// The app: five tabs and a browser that covers them.
//
// The browser is a screen and not a tab on purpose. Reading is what the phone
// is for, and coming back from a chapter has to land you where you left —
// the shelf, the search results, the site list — rather than on a tab bar with
// the chapter still under it. Covers, not replaces: the tabs stay mounted
// underneath, so what was typed, found or filtered is still there on the way
// back. Swapping the tabs out for the browser wiped the search, the sign-in
// form and the shelf's filter every time (QA re-test It.5, N-A13).
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  AccessibilityInfo, Animated, AppState, Appearance, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { palette } from './theme.js';
import { useStore } from './store.js';
import { on, send } from './core.js';
import { t } from './i18n.js';
import { DURATION } from './motion.js';
import Icon from './components/Icon.js';
import LibraryScreen from './screens/LibraryScreen.js';
import RecentScreen from './screens/RecentScreen.js';
import SitesScreen from './screens/SitesScreen.js';
import SearchScreen from './screens/SearchScreen.js';
import SettingsScreen from './screens/SettingsScreen.js';
import BrowserScreen from './screens/BrowserScreen.js';
import EntrySheet, { trackerName } from './EntrySheet.js';
import ErrorBoundary from './components/ErrorBoundary.js';
import { watchForeground } from './ota.js';

/**
 * Five, and the account is not one of them.
 *
 * Signing in is something you do once and then never think about, which is
 * exactly what a settings page is for — it sits inside Settings with the other
 * things you set once. What is left on the bar is what a reader actually moves
 * between: the shelf, what they read last, their sites, a search, and the
 * drawer. Each with a picture: a bar of five words at 11 points was a bar
 * nobody could read at a glance (QA report, F-19).
 */
const TABS = [
  ['library', 'navLibrary', 'library'],
  // "What do I have" and "what was I doing" are different questions that sort
  // differently — a library by what it holds, a history by when you last
  // touched it — so they are two screens rather than a filter on one.
  ['recent', 'navHistory', 'history'],
  ['sites', 'mobileMySites', 'sites'],
  ['search', 'navSearch', 'search'],
  ['settings', 'navSettings', 'settings'],
];

/** How long "Removed — Undo" stays up before the removal is written. */
const UNDO_MS = 5000;
/**
 * The same, with VoiceOver on: the toast is read out, then the button has to
 * be found, and five seconds was gone before a listener got there (QA re-test
 * It.5, N26). React Native says nothing about where VoiceOver's cursor is, so
 * the wait is simply long enough.
 */
const UNDO_MS_SPOKEN = 20000;

export default function Shell() {
  const store = useStore();
  const [tab, setTab] = useState('library');
  const [settingsPage, setSettingsPage] = useState(null); // a page to open Settings on
  const [browsing, setBrowsing] = useState(null);   // the URL the in-app browser is on
  const [entry, setEntry] = useState(null);         // the series whose sheet is up
  const [note, setNote] = useState(null);           // { message, action? }
  const [removing, setRemoving] = useState(null);   // a removal waiting out its undo
  const [system, setSystem] = useState(Appearance.getColorScheme());
  const [spoken, setSpoken] = useState(false);      // VoiceOver is on
  const noteTimer = useRef(0);
  const removeTimer = useRef(0);
  const noteShown = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => setSystem(colorScheme));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    AccessibilityInfo.isScreenReaderEnabled?.().then(setSpoken).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('screenReaderChanged', setSpoken);
    return () => sub?.remove?.();
  }, []);
  const undoMs = spoken ? UNDO_MS_SPOKEN : UNDO_MS;

  /**
   * One line at the bottom of the screen, and — when it is about something
   * that can be taken back — the button that takes it back. Said aloud as
   * well: a toast VoiceOver never reads is a change nobody using it was told
   * about. A fade, which the charter keeps under "reduce" (n° 9).
   */
  const toast = useCallback((message, action = null) => {
    clearTimeout(noteTimer.current);
    setNote({ message, action });
    noteShown.setValue(0);
    Animated.timing(noteShown, { toValue: 1, duration: DURATION.fade, useNativeDriver: true }).start();
    AccessibilityInfo.announceForAccessibility?.(action ? `${message}. ${action.label}` : message);
    noteTimer.current = setTimeout(() => {
      Animated.timing(noteShown, { toValue: 0, duration: DURATION.fade, useNativeDriver: true })
        .start(() => setNote((was) => (was?.message === message ? null : was)));
    }, action ? undoMs : 2600);
  }, [noteShown, undoMs]);

  // A new chapter found while the app is open is worth a line on the screen as
  // well as a banner — the banner is for a phone in a pocket, and this is for
  // the one in your hand.
  useEffect(() => on('notify', (n) => { if (n?.title) toast(n.title); }), [toast]);

  // Newer JavaScript, fetched for the next launch whenever the app comes back
  // to the front (native/src/ota.js). Never applied under a reader's thumb.
  useEffect(() => watchForeground(), []);

  // The detection rules, asked for as the app opens rather than when the first
  // chapter does: the store build carries no copy of its own, and a first
  // chapter on a slow server waited nearly nine seconds for its reader (QA
  // re-test It.4). A cached copy makes every later ask instant.
  useEffect(() => { send({ type: 'getRules' }).catch(() => {}); }, []);

  /**
   * Removing a series is written five seconds late, with "Undo" on screen
   * until then (QA report, F-39: it went at once, with no confirmation and no
   * way back). Until it is written the series is simply not drawn; undoing is
   * forgetting that. Leaving the app writes it at once, so a removal is never
   * lost to the phone locking.
   */
  const commitRemoval = useCallback(async (pending) => {
    clearTimeout(removeTimer.current);
    if (!pending) return;
    setRemoving((was) => (was?.id === pending.id ? null : was));
    // Written before its time — the app left the screen — the offer to take
    // it back goes with it: an "Undo" that no longer undoes anything lost the
    // series it promised to keep (QA re-test It.5, N-A16).
    setNote((was) => {
      if (was?.action?.removal !== pending.id) return was;
      clearTimeout(noteTimer.current);
      return null;
    });
    const resp = await send({ type: 'removeFromLibrary', id: pending.id, trackers: pending.trackers || [] });
    await store.refresh();
    // "Remove everywhere": what each list did, once the Undo is over. Only the
    // failure asks anything of the reader, so it is the one that is said
    // however the rest went.
    const said = (resp?.trackers || []).map((r) => t(
      !r.ok ? 'trackerRemoveFailed' : r.removed ? 'trackerRemovedFrom' : 'trackerRemoveNothing',
      [trackerName(r.service)]));
    if (said.length) toast(said.join(' '));
  }, [store, toast]);

  const remove = useCallback((victim, { trackers = [] } = {}) => {
    // One at a time: a second removal writes the first.
    if (removing && removing.id !== victim.id) commitRemoval(removing);
    const pending = { id: victim.id, title: victim.title, trackers };
    setRemoving(pending);
    setEntry(null);
    clearTimeout(removeTimer.current);
    removeTimer.current = setTimeout(() => commitRemoval(pending), undoMs);
    toast(t('libraryRemovedTitle', [victim.title || '']), {
      label: t('actionUndo'),
      removal: pending.id,
      run: () => { clearTimeout(removeTimer.current); setRemoving(null); },
    });
  }, [removing, commitRemoval, toast, undoMs]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && removing) commitRemoval(removing);
    });
    return () => sub.remove();
  }, [removing, commitRemoval]);

  // What the screens draw: the store, less a series on its way out.
  const view = useMemo(() => (removing
    ? { ...store, library: store.library.filter((e) => e.id !== removing.id) }
    : store), [store, removing]);

  // The sheet follows the series as it changes: a score set in the sheet used
  // to stay unlit until the sheet was opened again, because the sheet held the
  // snapshot it was opened with.
  const live = entry && (view.library.find((e) => e.id === entry.id) || entry);

  // The account's answer where it has one, the phone's where it does not. Kept
  // in that order deliberately: someone who chose Dark on the desktop chose it
  // for their reading, not for that machine.
  const scheme = store.theme === 'system' ? system : store.theme;
  const colors = palette(scheme);

  const openUrl = useCallback((url) => setBrowsing(url), []);
  const go = useCallback((id, page = null) => { setSettingsPage(page); setTab(id); }, []);
  const label = t(TABS.find(([id]) => id === tab)[1]);

  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
      <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={['top', 'bottom']}>
        <View style={styles.body}>
          {/* The tabs, kept mounted while the browser covers them — and
              hidden from VoiceOver meanwhile, which would otherwise read the
              screen under the chapter. */}
          <View
            style={styles.body}
            accessibilityElementsHidden={!!browsing}
            importantForAccessibility={browsing ? 'no-hide-descendants' : 'auto'}
          >
            {/* One boundary per screen, named after the tab. A screen that
                throws takes itself down and nothing else: the bar still works,
                the other four still work, and the one that broke says which
                it was and what the message said. Before this, any render error
                anywhere was a black app with no way back. */}
            <View style={styles.body}>
              <ErrorBoundary name={label} colors={colors}>
                {tab === 'library' && (
                  <LibraryScreen store={view} colors={colors} onOpen={openUrl} onEntry={setEntry} onTab={go} />
                )}
                {tab === 'recent' && (
                  <RecentScreen store={view} colors={colors} onOpen={openUrl} onEntry={setEntry} onTab={go} />
                )}
                {tab === 'sites' && <SitesScreen store={view} colors={colors} onOpen={openUrl} toast={toast} />}
                {tab === 'search' && <SearchScreen store={view} colors={colors} onOpen={openUrl} />}
                {tab === 'settings' && (
                  <SettingsScreen
                    key={settingsPage || 'menu'}
                    initialPage={settingsPage}
                    store={view}
                    colors={colors}
                    toast={toast}
                    onOpen={openUrl}
                    onChanged={store.refresh}
                  />
                )}
              </ErrorBoundary>
            </View>

            <View
              accessibilityRole="tablist"
              style={[styles.tabs, { borderColor: colors.line, backgroundColor: colors.surface }]}
            >
              {TABS.map(([id, key, icon]) => {
                const selected = tab === id;
                const tint = selected ? colors.accent : colors.muted;
                return (
                  <Pressable
                    key={id}
                    style={({ pressed }) => [styles.tab, pressed && { opacity: 0.6 }]}
                    onPress={() => go(id)}
                    accessibilityRole="tab"
                    accessibilityLabel={t(key)}
                    accessibilityState={{ selected }}
                  >
                    {/* Not by colour alone (WCAG 1.4.1, QA re-test It.5, N29):
                        the selected tab has a mark above its picture and a
                        heavier name, which read the same in either theme. */}
                    <View style={[styles.tabMark, selected && { backgroundColor: colors.accent }]} />
                    <Icon name={icon} size={24} color={tint} />
                    <Text
                      numberOfLines={1}
                      style={[styles.tabLabel, { color: tint }, selected && styles.tabLabelOn]}
                    >
                      {t(key)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {browsing && (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
              <BrowserScreen
                initial={browsing}
                colors={colors}
                whitelist={store.whitelist}
                // The one host script may always send the window to: a tracker's
                // OAuth page hands the reader back to our server by a redirect no
                // tap started, and navigation-policy.js would otherwise refuse it
                // as a hijack. See that file for the rule this is an exception to.
                trusted={[store.settings?.backendUrl].filter(Boolean)}
                onChanged={store.refresh}
                onClose={() => { setBrowsing(null); store.refresh(); }}
              />
            </View>
          )}
        </View>

        {note && (
          <Animated.View
            accessibilityLiveRegion="polite"
            style={[styles.toast, {
              backgroundColor: colors.surfaceHi, borderColor: colors.line, opacity: noteShown,
            }]}
          >
            <Text style={[styles.toastText, { color: colors.text }]} numberOfLines={3}>{note.message}</Text>
            {note.action && (
              <Pressable
                onPress={() => { note.action.run(); setNote(null); }}
                accessibilityRole="button"
                hitSlop={10}
                style={({ pressed }) => [styles.toastAction, pressed && { opacity: 0.6 }]}
              >
                <Text style={{ color: colors.accent, fontWeight: '700', fontSize: 15 }}>{note.action.label}</Text>
              </Pressable>
            )}
          </Animated.View>
        )}

        <EntrySheet
          entry={live}
          store={view}
          colors={colors}
          onClose={() => setEntry(null)}
          onOpen={openUrl}
          onRemove={remove}
          toast={toast}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  // 49 points, the height iOS gives its own tab bar, before the home indicator.
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, minHeight: 49 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 2, paddingBottom: 4, gap: 2 },
  tabMark: { width: 20, height: 3, borderRadius: 2, marginBottom: 1 },
  tabLabel: { fontSize: 10, fontWeight: '500' },
  tabLabelOn: { fontWeight: '600' },
  toast: {
    position: 'absolute', left: 16, right: 16, bottom: 72,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  toastText: { flex: 1, fontSize: 14, lineHeight: 19 },
  toastAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
});
