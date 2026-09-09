// The settings, as a menu of pages rather than one long scroll.
//
// Five pages, and the split is not cosmetic: each one is a question somebody
// arrives with. "Where do I sign in", "why is it in English", "which way do the
// pages turn", "when does it look for new chapters", "where is my AniList".
// A single screen with all of it made every one of those a scroll.
//
// This file is only the menu and the frame. Each page is its own file under
// `settings/`, takes the preferences it needs and a `set`, and knows nothing
// about the others — so a page that breaks is a page you can open on its own,
// and adding one is a file plus a line in the list below.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { readPrefs, writePrefs } from '../prefs.js';
import { t } from '../i18n.js';
import ErrorBoundary from '../components/ErrorBoundary.js';
import AccountScreen from './AccountScreen.js';
import AppearancePage from './settings/AppearancePage.js';
import ReaderPage from './settings/ReaderPage.js';
import UpdatesPage from './settings/UpdatesPage.js';
import TrackersPage from './settings/TrackersPage.js';
import StatsPage from './settings/StatsPage.js';

/**
 * The menu, in the order the questions come up.
 *
 * `prefs: false` marks a page that manages its own state — the account and the
 * trackers both talk to the server rather than to the preference store, and
 * handing them a snapshot of settings they do not use would only suggest they
 * did.
 */
const PAGES = [
  { id: 'account', title: 'optionsAccountLegend', Page: AccountScreen, prefs: false },
  { id: 'appearance', title: 'optionsAppearanceLegend', Page: AppearancePage, prefs: true },
  { id: 'reader', title: 'optionsReaderLegend', Page: ReaderPage, prefs: true },
  { id: 'updates', title: 'optionsUpdatesLegend', Page: UpdatesPage, prefs: true },
  { id: 'trackers', title: 'navTrackers', Page: TrackersPage, prefs: false },
  { id: 'stats', title: 'navStatistics', Page: StatsPage, prefs: false },
];

export default function SettingsScreen({ store, colors, toast, onOpen, onChanged }) {
  const [open, setOpen] = useState(null);
  const [prefs, setPrefs] = useState(null);

  const load = useCallback(async () => setPrefs(await readPrefs()), []);
  useEffect(() => { load(); }, [load]);

  /**
   * Drawn first, saved after.
   *
   * A switch that waits for a round trip before it moves feels broken on a
   * phone, and the write cannot fail in a way this screen could act on — the
   * account ignores a value it does not accept, and the next `readPrefs` is
   * what would show that.
   */
  const set = async (key, value) => {
    setPrefs((was) => ({ ...was, [key]: value }));
    await writePrefs({ [key]: value });
    // The language and the theme are drawn by the shell around this screen.
    if (key === 'uiLang' || key === 'theme') onChanged?.();
  };

  if (!open) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        {PAGES.map(({ id, title }) => (
          <Pressable
            key={id}
            onPress={() => setOpen(id)}
            style={[styles.row, { borderColor: colors.line }]}
          >
            <Text style={[styles.rowText, { color: colors.text }]}>{t(title)}</Text>
            <Text style={{ color: colors.muted, fontSize: 18 }}>›</Text>
          </Pressable>
        ))}
      </ScrollView>
    );
  }

  const entry = PAGES.find((p) => p.id === open);
  const { Page } = entry;

  return (
    <View style={styles.frame}>
      <View style={[styles.header, { borderColor: colors.line }]}>
        <Pressable onPress={() => setOpen(null)} hitSlop={10}>
          <Text style={{ color: colors.accent, fontSize: 15 }}>{`‹ ${t('actionBack')}`}</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>{t(entry.title)}</Text>
      </View>

      {/* Named, so the screen that breaks says which one it was. */}
      <ErrorBoundary name={t(entry.title)} colors={colors}>
        {entry.prefs
          ? (prefs && (
            <ScrollView contentContainerStyle={styles.page}>
              <Page prefs={prefs} set={set} colors={colors} />
            </ScrollView>
          ))
          // A page that manages its own state brings its own scrolling with
          // it. The trackers page learnt that the hard way: rendered into a
          // fixed box, its third card was cut off behind the tab bar with no
          // way to reach it.
          : (
            <Page
              store={store}
              colors={colors}
              toast={toast}
              onOpen={onOpen}
              onChanged={onChanged}
            />
          )}
      </ErrorBoundary>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  page: { padding: 16, paddingBottom: 40 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { fontSize: 16 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 16, fontWeight: '600' },
});
