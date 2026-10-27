// The settings, as a menu of pages rather than one long scroll.
//
// Ten pages, and the split is not cosmetic: each one is a question somebody
// arrives with. "Where do I sign in", "why is it in English", "which way do the
// pages turn", "when does it look for new chapters", "where is my AniList".
// A single screen with all of it made every one of those a scroll.
//
// This file is only the menu and the frame. Each page is its own file under
// `settings/`, takes the preferences it needs and a `set`, and knows nothing
// about the others — so a page that breaks is a page you can open on its own,
// and adding one is a file plus a line in the list below.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Text from '../components/Text.js';
import { readPrefs, writePrefs } from '../prefs.js';
import { t } from '../i18n.js';
import { ScreenTitle } from '../ui.js';
import ErrorBoundary from '../components/ErrorBoundary.js';
import AccountScreen from './AccountScreen.js';
import AppearancePage from './settings/AppearancePage.js';
import ReaderPage from './settings/ReaderPage.js';
import UpdatesPage from './settings/UpdatesPage.js';
import TrackersPage from './settings/TrackersPage.js';
import StatsPage from './settings/StatsPage.js';
import LegalPage from './settings/LegalPage.js';
import AdblockPage from './settings/AdblockPage.js';
import ReportPage from './settings/ReportPage.js';
import SavedPage from './settings/SavedPage.js';
import PremiumPage from './settings/PremiumPage.js';
import Icon from '../components/Icon.js';

/**
 * The menu, grouped the way the dark redesign drew it (owner, October 2026):
 * the account first, as a row of its own at the top, then what concerns
 * reading, what follows the series, the app itself, and help.
 *
 * `prefs: false` marks a page that manages its own state — the account, the
 * trackers and the offline chapters talk to the core rather than to the
 * preference store, and handing them a snapshot of settings they do not use
 * would only suggest they did.
 */
const PAGES = [
  { id: 'account', title: 'optionsAccountLegend', Page: AccountScreen, prefs: false },
  { id: 'reader', title: 'optionsReaderLegend', Page: ReaderPage, prefs: true, group: 'webReading' },
  // The chapters kept for reading with no network: a tab of their own until
  // the redesign put five on the bar.
  { id: 'saved', title: 'navSaved', Page: SavedPage, prefs: false, group: 'webReading' },
  { id: 'adblock', title: 'optionsAdblockLegend', Page: AdblockPage, prefs: true, group: 'webReading' },
  { id: 'trackers', title: 'navTrackers', Page: TrackersPage, prefs: false, group: 'mobileGroupFollowing' },
  { id: 'updates', title: 'optionsUpdatesLegend', Page: UpdatesPage, prefs: true, group: 'mobileGroupFollowing' },
  { id: 'stats', title: 'navStatistics', Page: StatsPage, prefs: false, group: 'mobileGroupFollowing' },
  // What the subscription adds and costs (./settings/PremiumPage.js).
  { id: 'premium', title: 'premiumTitle', Page: PremiumPage, prefs: false, group: 'mobileGroupApp' },
  // The language: the theme left it when the app became dark only.
  { id: 'appearance', title: 'optionsUiLanguage', Page: AppearancePage, prefs: true, group: 'mobileGroupApp' },
  // What a tester needs to tell us, gathered for them (diagnostics.js).
  { id: 'report', title: 'mobileReport', Page: ReportPage, prefs: false, group: 'webHelp' },
  // Last, because it is the one nobody arrives with a question for — until
  // they do, and then it has to be findable: the help page is its first row,
  // so the title says so.
  { id: 'legal', title: 'mobileHelpLegal', Page: LegalPage, prefs: false, group: 'webHelp' },
];

/** The groups, in order, each with its pages. */
const GROUPS = [...new Set(PAGES.map((p) => p.group).filter(Boolean))]
  .map((group) => ({ group, pages: PAGES.filter((p) => p.group === group) }));

export default function SettingsScreen({ store, colors, toast, onOpen, onChanged, initialPage = null }) {
  // A page to open on: the library's "I already have an account" lands on the
  // account page itself, not on a menu to find it in.
  const [open, setOpen] = useState(PAGES.some((p) => p.id === initialPage) ? initialPage : null);
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
    // The language and the theme are drawn by the shell around this screen,
    // and the whitelist is handed to the browser by the store — all three are
    // read from there, not from this page's state.
    if (key === 'uiLang' || key === 'theme' || key === 'whitelist') onChanged?.();
  };

  if (!open) {
    const row = ({ id, title }) => (
      <Pressable
        key={id}
        onPress={() => setOpen(id)}
        accessibilityRole="button"
        accessibilityLabel={t(title)}
        style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
      >
        <Text style={[styles.rowText, { color: colors.text }]}>{t(title)}</Text>
        <Text style={{ color: colors.muted, fontSize: 20 }} importantForAccessibility="no" accessibilityElementsHidden>›</Text>
      </Pressable>
    );
    return (
      <ScrollView contentContainerStyle={styles.menu}>
        <ScreenTitle colors={colors} title={t('navAccount')} />
        {/* Who is signed in, as the menu's first row: the account page is
            where the rest of it lives. */}
        <Pressable
          onPress={() => setOpen('account')}
          accessibilityRole="button"
          accessibilityLabel={t('optionsAccountLegend')}
          style={({ pressed }) => [styles.profile, { borderColor: colors.line }, pressed && { opacity: 0.6 }]}
        >
          <View style={[styles.avatar, { backgroundColor: colors.surfaceHi }]}>
            <Icon name="account" size={24} color={colors.muted} />
          </View>
          <View style={styles.profileText}>
            <Text numberOfLines={1} style={[styles.profileName, { color: colors.text }]}>
              {store.account?.email || t('actionSignIn')}
            </Text>
            <Text style={{ color: colors.muted, fontSize: 13 }}>{t('optionsAccountLegend')}</Text>
          </View>
          <Text style={{ color: colors.muted, fontSize: 20 }} importantForAccessibility="no" accessibilityElementsHidden>›</Text>
        </Pressable>
        {GROUPS.map(({ group, pages }) => (
          <View key={group} style={[styles.group, { borderColor: colors.line }]}>
            <Text accessibilityRole="header" style={[styles.groupTitle, { color: colors.muted }]}>{t(group)}</Text>
            {pages.map(row)}
          </View>
        ))}
      </ScrollView>
    );
  }

  const entry = PAGES.find((p) => p.id === open);
  const { Page } = entry;

  return (
    <View style={styles.frame}>
      <View style={[styles.header, { borderColor: colors.line }]}>
        <Pressable
          onPress={() => setOpen(null)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('actionBack')}
          style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}
        >
          <Text style={{ color: colors.accent, fontSize: 16 }}>{`‹ ${t('actionBack')}`}</Text>
        </Pressable>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]} numberOfLines={2}>{t(entry.title)}</Text>
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
              /* Another page of this menu, for a page that points at one: the
                 statistics' "Discover Premium" opens the Premium page. */
              onPage={setOpen}
            />
          )}
      </ErrorBoundary>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  page: { padding: 16, paddingBottom: 40 },
  menu: { paddingHorizontal: 16, paddingBottom: 40 },
  back: { minHeight: 44, justifyContent: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: 48, paddingVertical: 10,
  },
  rowText: { fontSize: 16, fontWeight: '600' },
  profile: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  profileText: { flex: 1, minWidth: 0, gap: 2 },
  profileName: { fontSize: 16, fontWeight: '700' },
  group: { paddingTop: 12, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  groupTitle: { fontSize: 13, fontWeight: '600', paddingBottom: 2 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
});
