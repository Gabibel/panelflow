// Where you read — your sites, and a way to reach any other.
//
// This tab used to list every site the detection rules know: about a hundred
// and seventy scan and streaming hosts, one tap each, with two comment keys of
// the rules file ("_medium", "_unverified") drawn as if they were sites. The
// store note in docs/ARCHITECTURE.md says in so many words that the app must
// not pre-load, suggest or bundle links to any manga site: a browser with a
// reading mode has a precedent in review (Safari Reader), a directory of scan
// sites has none (App Store 5.2). The QA pass of September 2026 put it first.
//
// So the tab shows what is already the reader's — the sites their library
// comes from and the ones they starred — and a field that opens any address,
// which is how a first read starts on a fresh install. The rules still decide
// what a chapter looks like on every site; they are just not a list any more.
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { send } from '../core.js';
import { t } from '../i18n.js';
import { Button, Heading, Hint } from '../ui.js';

/** `www.scan.fr` and `scan.fr` are the same site to a person. */
const siteName = (host) => String(host || '').trim().toLowerCase().replace(/^www\./, '');

/** The site of an entry: its own domain, or the host of its address. */
const siteOf = (entry) => {
  if (entry?.sourceDomain) return siteName(entry.sourceDomain);
  try { return siteName(new URL(entry.sourceUrl).hostname); } catch { return ''; }
};

/**
 * What the reader typed, as somewhere to go.
 *
 * An address is opened as it is; a bare host gets https in front; anything
 * else is words, and words are an ordinary web search — the reader's own
 * words, with nothing added (see SearchScreen.js).
 */
export function destination(typed) {
  const text = String(typed || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

export default function SitesScreen({ store, colors, onOpen, toast }) {
  const [favourites, setFavourites] = useState([]);
  const [address, setAddress] = useState('');

  useEffect(() => {
    let alive = true;
    send({ type: 'getAccountPrefs' }).then((prefs) => {
      if (alive) setFavourites((prefs?.prefs?.favouriteSites || []).map(siteName).filter(Boolean));
    });
    return () => { alive = false; };
  }, []);

  // Every site the library comes from, with how many series it holds there.
  const counts = useMemo(() => {
    const out = new Map();
    for (const entry of store.library || []) {
      const site = siteOf(entry);
      if (site) out.set(site, (out.get(site) || 0) + 1);
    }
    return out;
  }, [store.library]);

  // Starred first, then by how much of the library each one holds.
  const sites = useMemo(() => {
    const all = new Set([...favourites, ...counts.keys()]);
    return [...all].sort((a, b) => (Number(favourites.includes(b)) - Number(favourites.includes(a)))
      || ((counts.get(b) || 0) - (counts.get(a) || 0)) || a.localeCompare(b));
  }, [favourites, counts]);

  const toggle = async (host) => {
    const was = favourites;
    const next = was.includes(host) ? was.filter((h) => h !== host) : [...was, host];
    // Drawn first and saved after. A failed write is worth a word, but not
    // worth snapping a star back under somebody's finger.
    setFavourites(next);
    const r = await send({ type: 'setAccountPrefs', patch: { favouriteSites: next } });
    if (r?.error) {
      setFavourites(was);
      toast(t('webSitesUnavailable'));
    }
  };

  const go = () => {
    const url = destination(address);
    if (url) onOpen(url);
  };

  const row = (host) => {
    const pinned = favourites.includes(host);
    const n = counts.get(host) || 0;
    return (
      <View key={host} style={[styles.site, { borderColor: colors.line }]}>
        <Pressable
          style={({ pressed }) => [styles.open, pressed && { opacity: 0.6 }]}
          onPress={() => onOpen(`https://${host}/`)}
          accessibilityRole="button"
          accessibilityLabel={host}
        >
          <View style={[styles.mono, { backgroundColor: colors.surfaceHi }]}>
            <Text style={{ color: colors.muted, fontWeight: '700' }}>{host.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.names}>
            <Text style={[styles.host, { color: colors.text }]} numberOfLines={1}>{host}</Text>
            {n > 0 && (
              <Text style={[styles.count, { color: colors.muted }]}>
                {n === 1 ? t('mobileSeriesOne') : t('mobileSeriesMany', [String(n)])}
              </Text>
            )}
          </View>
        </Pressable>
        <Pressable
          onPress={() => toggle(host)}
          style={styles.star}
          accessibilityRole="button"
          accessibilityState={{ selected: pinned }}
          accessibilityLabel={pinned ? t('webSitesUnpin') : t('webSitesPin')}
        >
          <Text style={{ fontSize: 22, color: pinned ? colors.accent : colors.muted }}>{pinned ? '★' : '☆'}</Text>
        </Pressable>
      </View>
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Heading colors={colors}>{t('mobileOpenAddress')}</Heading>
      <View style={styles.bar}>
        <TextInput
          value={address}
          onChangeText={setAddress}
          onSubmitEditing={go}
          placeholder={t('mobileAddressPlaceholder')}
          placeholderTextColor={colors.muted}
          accessibilityLabel={t('mobileOpenAddress')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          clearButtonMode="while-editing"
          style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.line }]}
        />
        <View style={styles.goButton}>
          <Button colors={colors} label={t('mobileOpenGo')} onPress={go} disabled={!address.trim()} />
        </View>
      </View>

      <Heading colors={colors}>{t('mobileMySites')}</Heading>
      {sites.length === 0 ? (
        <View style={[styles.empty, { borderColor: colors.line, backgroundColor: colors.surface }]}>
          <Text style={[styles.emptyText, { color: colors.text }]}>{t('mobileMySitesEmpty')}</Text>
        </View>
      ) : (
        <>
          <Hint colors={colors}>{t('mobileMySitesLede')}</Hint>
          {sites.map(row)}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, minHeight: 46,
  },
  goButton: { flexShrink: 0 },
  empty: { borderWidth: 1, borderRadius: 12, padding: 16, marginTop: 4 },
  emptyText: { fontSize: 15, lineHeight: 22 },
  site: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 56,
  },
  open: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, paddingVertical: 8, paddingRight: 12 },
  mono: { width: 36, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  names: { flexShrink: 1 },
  host: { fontSize: 16 },
  count: { fontSize: 13, marginTop: 1 },
  star: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
