// Finding a series you do not already have a link to.
//
// The one screen that genuinely needs the server: no search engine allows a
// cross-origin query, so the hub carries the call and the backend makes it. The
// compatibility verdict on each row comes back with it — "would the reader work
// there" answered before the tap, rather than after a page load on a phone
// connection.
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { send } from '../core.js';
import { t } from '../i18n.js';
import { Button, Empty, Hint } from '../ui.js';

/** One key per answer the check can give. */
const VERDICT = {
  ready: 'mobileVerdictReady',
  likely: 'mobileVerdictLikely',
  unknown: 'mobileVerdictUnknown',
  unlikely: 'mobileVerdictUnlikely',
};

export default function SearchScreen({ store, colors, onOpen }) {
  const [q, setQ] = useState('');
  const [scansOnly, setScansOnly] = useState(true);
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const verdictColor = (verdict) => ({
    ready: colors.ok, likely: colors.accent, unlikely: colors.danger,
  }[verdict] || colors.muted);

  const run = async () => {
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setResults([]);
    setStatus(t('statusSearching'));
    const resp = await send({ type: 'search', q: query, scans: scansOnly, check: true });
    setBusy(false);
    if (resp?.error) {
      // Say which half failed rather than showing an empty list: signed out,
      // the answer is not "nothing found", it is "the server will not look".
      setStatus(store.account ? t('mobileSearchFailed', [resp.error]) : t('mobileSearchNeedsAccount'));
      return;
    }
    const found = resp?.results || [];
    setResults(found);
    setStatus(found.length ? null : t('searchNoResults'));
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

      <View style={styles.toggle}>
        <Switch
          value={scansOnly}
          onValueChange={setScansOnly}
          trackColor={{ true: colors.accent, false: colors.line }}
        />
        <Text style={{ color: colors.text }}>{t('mobileScansOnly')}</Text>
      </View>
      <Hint colors={colors}>{t('mobileSearchHint')}</Hint>

      {results.map((r) => (
        <Pressable
          key={r.url}
          onPress={() => onOpen(r.url)}
          style={[styles.result, { backgroundColor: colors.surface, borderColor: colors.line }]}
        >
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>{r.title}</Text>
          <Text style={[styles.domain, { color: colors.muted }]} numberOfLines={1}>
            {r.domain || r.url}
          </Text>
          {r.compat && (
            <Text style={[styles.verdict, { color: verdictColor(r.compat.verdict) }]} numberOfLines={1}>
              {VERDICT[r.compat.verdict] ? t(VERDICT[r.compat.verdict]) : r.compat.verdict}
              {r.compat.reason ? ` · ${r.compat.reason}` : ''}
            </Text>
          )}
        </Pressable>
      ))}

      {status && <Empty colors={colors}>{status}</Empty>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  go: { width: 92 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  result: { borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 10 },
  title: { fontSize: 15, fontWeight: '600' },
  domain: { fontSize: 12, marginTop: 2 },
  verdict: { fontSize: 12, marginTop: 6 },
});
