// The legal pages, from the phone.
//
// Three rows, each opening one of the pages the web app serves — mentions
// légales, confidentialité, conditions — in the app's own browser. They are
// not copied into the app: a policy is a promise about what the *server* does,
// it changes when the server does, and a copy baked into an app-store build is
// the one that would be wrong for the weeks between a change and a release.
// One page, one place, every surface links to it.
//
// The store's `backendUrl` is where the account lives and therefore where its
// policy lives. Opened through `onOpen` — the same in-app browser as a chapter —
// and navigation-policy.js lets it through as the page the app asked for.
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { t } from '../../i18n.js';
import { Hint } from '../../ui.js';

// The page itself is named by the locale file (legalPrivacyPage is
// `confidentialite.html` in French and `privacy.html` in English), so the
// policy opens in the language the app is showing.
const PAGES = [
  { page: 'legalNoticePage', label: 'webLegalNotice' },
  { page: 'legalPrivacyPage', label: 'webPrivacy' },
  { page: 'legalTermsPage', label: 'webTerms' },
];

export default function LegalPage({ store, colors, onOpen }) {
  const base = String(store.settings?.backendUrl || '').replace(/\/+$/, '');
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Hint colors={colors}>{t('webLegalLede')}</Hint>
      {PAGES.map(({ page, label }) => (
        <Pressable
          key={page}
          accessibilityRole="link"
          onPress={() => onOpen(`${base}/${t(page)}`)}
          style={[styles.row, { borderColor: colors.line }]}
        >
          <Text style={[styles.rowText, { color: colors.text }]}>{t(label)}</Text>
          <Text style={{ color: colors.muted, fontSize: 18 }}>›</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { fontSize: 16 },
});
