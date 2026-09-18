// Finding something you do not already have a link to.
//
// This used to ask the backend, which asked DuckDuckGo, which answers a
// datacenter IP with a challenge — so on a phone the first search failed, every
// time. For a while the screen sent the words to the in-app browser instead,
// which worked and made the phone the one surface with no result list.
//
// Now the hub asks the engine from the phone's own address (`searchFetch` in
// native/src/core.js, parsed by shared/search.js) and falls back to the server
// on its own, so this screen draws the same list the website and the popup
// draw: a title, a site, a tap that opens it in the in-app browser, where the
// injected engine recognises a chapter the moment it opens. The browser is
// still one tap away, for the reader who wants the whole results page.
//
// The store-compliance note in docs/ARCHITECTURE.md holds either way: PanelFlow
// hosts no catalogue, ships no site list, ranks nothing. An empty query goes
// nowhere.
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Choice from '../components/Choice.js';
import { send } from '../core.js';
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
  const [results, setResults] = useState(null); // null: nothing asked yet
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fullQuery = () => {
    const query = q.trim();
    const { words } = KINDS.find((k) => k.id === kind) || KINDS[0];
    return words ? `${query} ${words}` : query;
  };

  /** The whole results page, in the browser: the fallback and the escape. */
  const openAll = () => onOpen(`https://duckduckgo.com/?q=${encodeURIComponent(fullQuery())}`);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    // The kind's own words rather than the hub's `scans` bias: this screen
    // knows four kinds, the hub one.
    const r = await send({ type: 'search', q: fullQuery() });
    setBusy(false);
    if (!r || r.error) {
      // Neither the phone nor the server could search. The browser can.
      setResults([]);
      setError(r?.error || t('authNoAnswer'));
      return;
    }
    setResults(r.results || []);
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
          <Button colors={colors} label={t('mobileGo')} onPress={run} busy={busy} />
        </View>
      </View>

      {results !== null && (
        <View style={styles.results}>
          {error && <Text style={[styles.note, { color: colors.danger }]}>{t('mobileSearchFailed', [String(error)])}</Text>}
          {!error && results.length === 0 && <Text style={[styles.note, { color: colors.muted }]}>{t('searchNoResults')}</Text>}
          {results.map((r) => (
            <Pressable
              key={r.url}
              onPress={() => onOpen(r.url)}
              accessibilityRole="link"
              style={[styles.hit, { borderColor: colors.line }]}
            >
              <Text numberOfLines={2} style={[styles.hitTitle, { color: colors.text }]}>{r.title}</Text>
              <Text numberOfLines={1} style={[styles.hitDomain, { color: colors.muted }]}>{r.domain || r.url}</Text>
            </Pressable>
          ))}
          <Button colors={colors} kind="ghost" label={t('mobileSearchAllResults')} onPress={openAll} />
        </View>
      )}

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
  results: { marginTop: 12 },
  note: { fontSize: 13, marginVertical: 8 },
  hit: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  hitTitle: { fontSize: 15 },
  hitDomain: { fontSize: 12, marginTop: 2 },
});
