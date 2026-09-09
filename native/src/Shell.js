// The app: four tabs and a browser that covers them.
//
// The browser is a screen and not a tab on purpose. Reading is what the phone
// is for, and coming back from a chapter has to land you where you left —
// the shelf, the search results, the site list — rather than on a tab bar with
// the chapter still under it.
import { useCallback, useEffect, useState } from 'react';
import {
  Appearance, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { palette } from './theme.js';
import { useStore } from './store.js';
import { on } from './core.js';
import { t } from './i18n.js';
import LibraryScreen from './screens/LibraryScreen.js';
import RecentScreen from './screens/RecentScreen.js';
import SitesScreen from './screens/SitesScreen.js';
import SearchScreen from './screens/SearchScreen.js';
import SettingsScreen from './screens/SettingsScreen.js';
import BrowserScreen from './screens/BrowserScreen.js';
import EntrySheet from './EntrySheet.js';
import ErrorBoundary from './components/ErrorBoundary.js';

/**
 * Four, and the account is not one of them.
 *
 * Signing in is something you do once and then never think about, which is
 * exactly what a settings page is for — it sits inside Settings with the other
 * things you set once. What is left on the bar is what a reader actually moves
 * between: the shelf, somewhere to start reading, a search, and the drawer.
 */
const TABS = [
  ['library', 'navLibrary'],
  // "What do I have" and "what was I doing" are different questions that sort
  // differently — a library by what it holds, a history by when you last
  // touched it — so they are two screens rather than a filter on one.
  ['recent', 'navHistory'],
  ['sites', 'navSites'],
  ['search', 'navSearch'],
  ['settings', 'navSettings'],
];

export default function Shell() {
  const store = useStore();
  const [tab, setTab] = useState('library');
  const [browsing, setBrowsing] = useState(null);   // the URL the in-app browser is on
  const [entry, setEntry] = useState(null);         // the series whose sheet is up
  const [note, setNote] = useState(null);
  const [system, setSystem] = useState(Appearance.getColorScheme());

  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => setSystem(colorScheme));
    return () => sub.remove();
  }, []);

  // A new chapter found while the app is open is worth a line on the screen as
  // well as a banner — the banner is for a phone in a pocket, and this is for
  // the one in your hand.
  useEffect(() => on('notify', (n) => setNote(n?.title || null)), []);

  // The account's answer where it has one, the phone's where it does not. Kept
  // in that order deliberately: someone who chose Dark on the desktop chose it
  // for their reading, not for that machine.
  const scheme = store.theme === 'system' ? system : store.theme;
  const colors = palette(scheme);
  const toast = useCallback((message) => {
    setNote(message);
    setTimeout(() => setNote((was) => (was === message ? null : was)), 2600);
  }, []);

  const openUrl = useCallback((url) => setBrowsing(url), []);

  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
      <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={['top', 'bottom']}>
        {browsing ? (
          <BrowserScreen
            initial={browsing}
            colors={colors}
            whitelist={store.whitelist}
            onChanged={store.refresh}
            onClose={() => { setBrowsing(null); store.refresh(); }}
          />
        ) : (
          <>
            {/* One boundary per screen, named after the tab. A screen that
                throws takes itself down and nothing else: the bar still works,
                the other three still work, and the one that broke says which
                it was and what the message said. Before this, any render error
                anywhere was a black app with no way back. */}
            <View style={styles.body}>
              <ErrorBoundary name={t(TABS.find(([id]) => id === tab)[1])} colors={colors}>
                {tab === 'library' && (
                  <LibraryScreen
                    store={store}
                    colors={colors}
                    onOpen={openUrl}
                    onEntry={setEntry}
                  />
                )}
                {tab === 'recent' && (
                  <RecentScreen
                    store={store}
                    colors={colors}
                    onOpen={openUrl}
                    onEntry={setEntry}
                  />
                )}
                {tab === 'sites' && <SitesScreen colors={colors} onOpen={openUrl} toast={toast} />}
                {tab === 'search' && <SearchScreen colors={colors} onOpen={openUrl} />}
                {tab === 'settings' && (
                  <SettingsScreen
                    store={store}
                    colors={colors}
                    toast={toast}
                    onOpen={openUrl}
                    onChanged={store.refresh}
                  />
                )}
              </ErrorBoundary>
            </View>

            <View style={[styles.tabs, { borderColor: colors.line, backgroundColor: colors.surface }]}>
              {TABS.map(([id, key]) => (
                <Pressable key={id} style={styles.tab} onPress={() => setTab(id)}>
                  <Text
                    numberOfLines={1}
                    style={{ color: tab === id ? colors.accent : colors.muted, fontSize: 11 }}
                  >
                    {t(key)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {note && (
          <View style={[styles.toast, { backgroundColor: colors.surfaceHi, borderColor: colors.line }]}>
            <Text style={{ color: colors.text }} numberOfLines={3}>{note}</Text>
          </View>
        )}

        <EntrySheet
          entry={entry}
          store={store}
          colors={colors}
          onClose={() => setEntry(null)}
          onOpen={openUrl}
          toast={toast}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  toast: {
    position: 'absolute', left: 16, right: 16, bottom: 76,
    borderRadius: 10, borderWidth: 1, padding: 12,
  },
});
