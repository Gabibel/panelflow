// Finding something you do not already have a link to.
//
// The hub asks the engine from the phone's own address (`searchFetch` in
// native/src/core.js, parsed by shared/search.js) and falls back to the server
// when it cannot, so this screen draws the same list the website and the popup
// draw: a title, a site, a tap that opens it in the in-app browser, where the
// injected engine recognises a chapter the moment it opens. The whole results
// page is one tap further, in that same browser.
//
// Neutral, on purpose. This screen used to add words of its own to what the
// reader typed — "scan lecture en ligne chapitre", "anime streaming vostfr" —
// which made a store app into a machine for finding scan and streaming sites.
// docs/ARCHITECTURE.md's store note is plain about it: PanelFlow hosts no
// catalogue, suggests no site, ranks nothing. The reader's words go out as
// they were typed, and an empty query goes nowhere (QA, September 2026).
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { send } from '../core.js';
import { t } from '../i18n.js';
import { Button, Hint } from '../ui.js';

export default function SearchScreen({ store, colors, onOpen }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // null: nothing asked yet
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const words = () => q.trim();

  /** The whole results page, in the browser: the fallback and the escape. */
  const openAll = () => onOpen(`https://duckduckgo.com/?q=${encodeURIComponent(words())}`);

  const run = async () => {
    if (!words()) return;
    setBusy(true);
    setFailed(false);
    const r = await send({ type: 'search', q: words() });
    setBusy(false);
    if (!r || r.error) {
      // Neither the phone nor the server could search. The browser can.
      setResults([]);
      setFailed(true);
      return;
    }
    setResults(r.results || []);
  };

  // Why a search came back empty-handed, in the reader's terms: signed out,
  // the server is the half that could not be asked; signed in, the search did
  // not come through — which is not the sync's sentence it used to borrow
  // (re-test, September 2026). Never the server's own ("missing bearer token").
  const trouble = failed && (store?.account ? t('mobileSearchFailed') : t('mobileSearchNeedsAccount'));

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
          accessibilityLabel={t('mobileSearchPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          style={[styles.input, {
            color: colors.text, backgroundColor: colors.surface, borderColor: colors.line,
          }]}
        />
        <View style={styles.go}>
          <Button colors={colors} label={t('mobileSearchGo')} onPress={run} busy={busy} disabled={!words()} />
        </View>
      </View>

      {results !== null && (
        <View style={styles.results}>
          {trouble && <Text style={[styles.note, { color: colors.muted }]}>{trouble}</Text>}
          {!failed && results.length === 0 && (
            <Text style={[styles.note, { color: colors.muted }]}>{t('searchNoResults')}</Text>
          )}
          {results.map((r) => (
            <Pressable
              key={r.url}
              onPress={() => onOpen(r.url)}
              accessibilityRole="link"
              style={({ pressed }) => [styles.hit, { borderColor: colors.line }, pressed && { opacity: 0.6 }]}
            >
              <Text numberOfLines={2} style={[styles.hitTitle, { color: colors.text }]}>{r.title}</Text>
              <Text numberOfLines={1} style={[styles.hitDomain, { color: colors.muted }]}>{r.domain || r.url}</Text>
            </Pressable>
          ))}
          <Button colors={colors} kind="ghost" label={t('mobileSearchAllResults')} onPress={openAll} />
        </View>
      )}

      <Hint colors={colors}>{t('mobileSearchWebHint')}</Hint>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1, minWidth: 0, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11,
    fontSize: 16, minHeight: 46,
  },
  // Its own width, never a fixed one: "Rechercher" and "Search" are not the
  // same length, and a fixed 92 pushed the button off a 320-point screen.
  go: { flexShrink: 0 },
  results: { marginTop: 12 },
  note: { fontSize: 14, lineHeight: 20, marginVertical: 8 },
  hit: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 44 },
  hitTitle: { fontSize: 15 },
  hitDomain: { fontSize: 12, marginTop: 2 },
});
