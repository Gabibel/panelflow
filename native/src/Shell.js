// The app: five tabs and a browser that covers them.
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
import SitesScreen from './screens/SitesScreen.js';
import SearchScreen from './screens/SearchScreen.js';
import AccountScreen from './screens/AccountScreen.js';
import SettingsScreen from './screens/SettingsScreen.js';
import BrowserScreen from './screens/BrowserScreen.js';
import EntrySheet from './EntrySheet.js';

const TABS = [
  ['library', 'navLibrary'],
  ['sites', 'navSites'],
  ['search', 'navSearch'],
  ['account', 'navAccount'],
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
            toast={toast}
            onChanged={store.refresh}
            onClose={() => { setBrowsing(null); store.refresh(); }}
          />
        ) : (
          <>
            <View style={styles.body}>
              {tab === 'library' && (
                <LibraryScreen
                  store={store}
                  colors={colors}
                  onOpen={openUrl}
                  onEntry={setEntry}
                />
              )}
              {tab === 'sites' && <SitesScreen colors={colors} onOpen={openUrl} toast={toast} />}
              {tab === 'search' && <SearchScreen store={store} colors={colors} onOpen={openUrl} />}
              {tab === 'account' && <AccountScreen store={store} colors={colors} toast={toast} />}
              {tab === 'settings' && <SettingsScreen colors={colors} onChanged={store.refresh} />}
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
