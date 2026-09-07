// Where you read.
//
// The only screen on the phone that can start a first read. Everything else
// needs a URL you already have: the library needs an entry, search needs a
// query that found one. A fresh install has neither, so without this tab the
// app cannot reach a scan site at all unless a link is shared into it.
//
// Same two sources as the website's sites page — `getRules` for what exists,
// `favouriteSites` for what this reader starred, here or anywhere else.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { send } from '../core.js';
import { t } from '../i18n.js';
import { Empty, Heading, Hint } from '../ui.js';

/** `*.example.com` and `example.com` are the same site to a person. */
const bareHost = (pattern) => String(pattern || '').replace(/^\*\./, '').trim();

export default function SitesScreen({ colors, onOpen, toast }) {
  const [sites, setSites] = useState([]);
  const [favourites, setFavourites] = useState([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Asked together and failing together: half this screen is the list and
      // half is the order.
      const [rules, prefs] = await Promise.all([
        send({ type: 'getRules' }),
        send({ type: 'getAccountPrefs' }),
      ]);
      if (!alive) return;
      const seen = new Set();
      for (const key of Object.keys(rules?.rules?.domains || {})) {
        const host = bareHost(key);
        if (host && !host.includes('*')) seen.add(host);
      }
      // Not a blank screen when the rules cannot be reached: the list is a
      // convenience — the reader still works on a page reached any other way,
      // and that is the part worth saying.
      setFailed(seen.size === 0);
      setSites([...seen].sort((a, b) => a.localeCompare(b)));
      setFavourites((prefs?.prefs?.favouriteSites || []).filter(Boolean));
    })();
    return () => { alive = false; };
  }, []);

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

  const row = (host) => {
    const pinned = favourites.includes(host);
    return (
      <View key={host} style={[styles.site, { borderColor: colors.line }]}>
        <Pressable style={styles.open} onPress={() => onOpen(`https://${host}/`)}>
          <View style={[styles.mono, { backgroundColor: colors.surfaceHi }]}>
            <Text style={{ color: colors.muted, fontWeight: '700' }}>
              {host.charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text style={[styles.host, { color: colors.text }]} numberOfLines={1}>{host}</Text>
        </Pressable>
        <Pressable
          onPress={() => toggle(host)}
          hitSlop={10}
          accessibilityLabel={t(pinned ? 'webSitesUnpin' : 'webSitesPin')}
        >
          <Text style={{ fontSize: 20, color: pinned ? colors.accent : colors.muted }}>
            {pinned ? '★' : '☆'}
          </Text>
        </Pressable>
      </View>
    );
  };

  const rest = sites.filter((h) => !favourites.includes(h));

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Heading colors={colors}>{t('webSitesTitle')}</Heading>
      <Hint colors={colors}>{t('webSitesLede')}</Hint>
      {failed && <Empty colors={colors}>{t('webSitesUnavailable')}</Empty>}
      {favourites.length > 0 && <Heading colors={colors}>{t('webSitesYours')}</Heading>}
      {favourites.map(row)}
      {/* No heading over the only list on the screen: "All sites" above the
          whole tab is a label for nothing. */}
      {favourites.length > 0 && rest.length > 0 && <Heading colors={colors}>{t('webSitesAll')}</Heading>}
      {rest.map(row)}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  site: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10,
  },
  open: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, paddingRight: 12 },
  mono: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  host: { fontSize: 15, flexShrink: 1 },
});
