// What has been read, and where the number comes from.
//
// Two answers to one question, and the difference matters: signed in, the
// account holds every device you read on and the server adds them up; signed
// out, this is what this phone alone recorded. `getStats` returns one or the
// other and says which with `local`, so the screen never has to guess — and
// never quietly shows one device's total under a heading that implies all of
// them.
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { send } from '../../core.js';
import { t } from '../../i18n.js';
import { duration } from '../../format.js';
import { Empty, Heading, Hint } from '../../ui.js';

export default function StatsPage({ colors }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await send({ type: 'getStats' });
      if (r?.error) return setError(r.error);
      return setStats(r?.stats || null);
    })();
  }, []);

  if (error) return <Empty colors={colors}>{t('statsLoadError', [error])}</Empty>;
  if (!stats) return <Hint colors={colors}>{t('trackerAsking')}</Hint>;
  if (!stats.chapters) return <Empty colors={colors}>{t('statsNothingRead')}</Empty>;

  const cards = [
    [t('statChaptersRead'), String(stats.chapters ?? 0)],
    [t('statSeriesRead'), String(stats.series ?? 0)],
    [t('statTimeRead'), duration(stats.seconds)],
    [t('statPerReadingDay'), duration(stats.secondsPerDay)],
    [t('statCurrentStreak'), t('statDays', [String(stats.currentStreak ?? 0)])],
    [t('statLongestStreak'), t('statDays', [String(stats.longestStreak ?? 0)])],
  ];

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.cards}>
        {cards.map(([label, value]) => (
          <View key={label} style={[styles.card, { borderColor: colors.line }]}>
            <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
            <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
          </View>
        ))}
      </View>

      {/* Said plainly rather than implied. A total that counts one device is a
          different number from a total that counts an account, and the two look
          identical on a screen. */}
      {stats.local && <Hint colors={colors}>{t('statsLocalOnly')}</Hint>}

      {stats.topSeries?.length > 0 && (
        <>
          <Heading colors={colors}>{t('statsMostRead')}</Heading>
          {stats.topSeries.map((s) => (
            <View key={s.id} style={[styles.row, { borderColor: colors.line }]}>
              <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.text }]}>
                {s.title}
              </Text>
              <Text style={[styles.rowSide, { color: colors.muted }]}>
                {`${s.chapters} · ${duration(s.seconds)}`}
              </Text>
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 48 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, flexGrow: 1, minWidth: '46%' },
  value: { fontSize: 20, fontWeight: '700' },
  label: { fontSize: 12, marginTop: 2 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 12,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTitle: { fontSize: 14, flex: 1 },
  rowSide: { fontSize: 12 },
});
