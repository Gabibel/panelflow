// Finding something you do not already have a link to.
//
// This used to ask the backend, which asked DuckDuckGo, which answers a
// datacenter IP with a challenge — so on a phone the first search failed, every
// time, and the screen was a dead end with an error on it. The server route is
// still there for the surfaces that have no browser of their own; this one has
// a browser, and a browser is allowed to ask.
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
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Choice from '../components/Choice.js';
import { t } from '../i18n.js';
import { Button, Heading, Hint } from '../ui.js';

/**
 * What to bias the words toward, and the words that do it.
 *
 * A bare title mostly returns Wikipedia and MyAnimeList; what somebody is after
 * is somewhere to read or watch the thing. The scans line is the same one the
 * server applies (`scanQuery` in backend/src/routes/search.js) — the other
 * three are its counterparts for the media the library already knows about, so
 * "one piece" can mean the manga, the anime or the novel depending on what you
 * came for.
 *
 * French words, deliberately: these are French-language reading and streaming
 * sites, and a French query is what surfaces them.
 */
const KINDS = [
  { id: 'scans', label: 'mobileMediumManga', words: 'scan lecture en ligne chapitre' },
  { id: 'anime', label: 'mobileMediumAnime', words: 'anime streaming vostfr épisode' },
  { id: 'novel', label: 'popupGroupNovels', words: 'light novel lecture en ligne chapitre' },
  { id: 'webtoon', label: 'popupGroupWebtoons', words: 'webtoon lecture en ligne chapitre' },
  // Nothing added at all, for when the bias is the thing getting in the way.
  { id: 'any', label: 'folder_all', words: '' },
];

export default function SearchScreen({ colors, onOpen }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('scans');

  const run = () => {
    const query = q.trim();
    if (!query) return;
    const { words } = KINDS.find((k) => k.id === kind) || KINDS[0];
    onOpen(`https://duckduckgo.com/?q=${encodeURIComponent(words ? `${query} ${words}` : query)}`);
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

      <Heading colors={colors}>{t('mobileSearchKind')}</Heading>
      <Choice
        colors={colors}
        value={kind}
        onChange={setKind}
        options={KINDS.map((k) => ({ value: k.id, label: t(k.label) }))}
      />

      <Hint colors={colors}>{t('mobileSearchWebHint')}</Hint>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  go: { width: 92 },
});
