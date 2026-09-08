// Finding a series you do not already have a link to.
//
// This used to ask the backend, which asked DuckDuckGo, which answers a
// datacenter IP with a challenge — so on a phone the first search failed, every
// time, and the screen was a dead end with an error on it. The server route is
// still there and still useful to the surfaces that have no browser of their
// own; this one has a browser, and a browser is allowed to ask.
//
// So the search happens where the reading happens: the words go into the in-app
// browser as a plain web search, with the injected engine already in the page.
// A result that is a chapter is detected the moment it opens, which is the same
// answer the compatibility check used to give a round trip earlier.
//
// The store-compliance note in docs/ARCHITECTURE.md holds either way: PanelFlow
// hosts no catalogue, ships no site list, ranks nothing. An empty query goes
// nowhere.
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { t } from '../i18n.js';
import { Button, Hint } from '../ui.js';

// The same bias the server applied (`scanQuery` in backend/src/routes/search.js):
// a bare title mostly returns Wikipedia and MyAnimeList, and what the reader is
// after is somewhere to read it.
const SCAN_WORDS = 'scan lecture en ligne chapitre';

export default function SearchScreen({ colors, onOpen }) {
  const [q, setQ] = useState('');
  const [scansOnly, setScansOnly] = useState(true);

  const run = () => {
    const query = q.trim();
    if (!query) return;
    onOpen(`https://duckduckgo.com/?q=${encodeURIComponent(
      scansOnly ? `${query} ${SCAN_WORDS}` : query,
    )}`);
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.bar}>
        <TextInput
          value={q}
          onChangeText={setQ}
          onSubmitEditing={run}
          returnKeyType="search"
          placeholder={t('mobileSearchPlaceholder')}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, {
            color: colors.text, backgroundColor: colors.surface, borderColor: colors.line,
          }]}
        />
        <View style={styles.go}>
          <Button colors={colors} label={t('mobileGo')} onPress={run} />
        </View>
      </View>

      <View style={styles.toggle}>
        <Switch
          value={scansOnly}
          onValueChange={setScansOnly}
          trackColor={{ true: colors.accent, false: colors.line }}
        />
        <Text style={{ color: colors.text }}>{t('mobileScansOnly')}</Text>
      </View>
      <Hint colors={colors}>{t('mobileSearchWebHint')}</Hint>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  go: { width: 92 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
});
