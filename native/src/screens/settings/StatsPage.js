// What has been read, and where the number comes from.
//
// Two answers to one question, and the difference matters: signed in, the
// account holds every device you read on and the server adds them up; signed
// out, this is what this phone alone recorded. `getStats` returns one or the
// other and says which with `local`, so the screen never has to guess — and
// never quietly shows one device's total under a heading that implies all of
// them.
//
// All of it, or one type of work: a manga's chapters and an anime's episodes
// are not one count, so the chips above the figures narrow them, and the words
// follow (Shelf.statWords) — "episodes watched" for anime, "chapters and
// episodes" when everything is counted together.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { send } from '../../core.js';
import { explain, t } from '../../i18n.js';
import { duration } from '../../format.js';
import { Shelf } from '../../shared.js';
import { Empty, Heading, Hint } from '../../ui.js';

/** What a chip drawn 32 points high adds to reach 44 under a finger. */
const SLOP = { top: 6, bottom: 6, left: 2, right: 2 };

export default function StatsPage({ colors }) {
  const [medium, setMedium] = useState('all');
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setStats(null);
    setError(null);
    (async () => {
      const r = await send({ type: 'getStats', medium: medium === 'all' ? null : medium });
      if (!alive) return;
      if (r?.error) setError(explain(r));
      else setStats(r?.stats || null);
    })();
    return () => { alive = false; };
  }, [medium]);

  const words = Shelf.statWords(medium);
  const options = [{ id: 'all', label: t('mediumAll') },
    ...Shelf.MEDIA.map((m) => ({ id: m.id, label: t('medium_' + m.id) || m.label }))];

  const chips = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {options.map(({ id, label }) => {
        const on = medium === id;
        return (
          <Pressable
            key={id}
            onPress={() => setMedium(id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            hitSlop={SLOP}
            style={[styles.chip, {
              backgroundColor: on ? colors.surfaceHi : 'transparent',
              borderColor: on ? colors.line : 'transparent',
            }]}
          >
            <Text style={{ color: on ? colors.text : colors.muted, fontSize: 14 }}>{label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  let body;
  if (error) body = <Empty colors={colors}>{t('statsLoadError', [error])}</Empty>;
  else if (!stats) body = <Hint colors={colors}>{t('trackerAsking')}</Hint>;
  else if (!stats.chapters) body = <Empty colors={colors}>{t('statsNothingRead')}</Empty>;
  else {
    const cards = [
      [t(words.units), String(stats.chapters ?? 0)],
      [t(words.series), String(stats.series ?? 0)],
      [t(words.time), duration(stats.seconds)],
      [t(words.perDay), duration(stats.secondsPerDay)],
      // `current` and `longest` are what both the server and the core answer
      // (routes/history.js, streaks()); this page read two names nothing wrote,
      // and said 0 days to everyone (QA report, F-34).
      [t('statCurrentStreak'), t('statDays', [String(stats.current ?? 0)])],
      [t('statLongestStreak'), t('statDays', [String(stats.longest ?? 0)])],
    ];
    const byMedium = stats.byMedium || {};
    const types = medium === 'all' ? Shelf.MEDIA.filter((m) => byMedium[m.id]) : [];
    body = (
      <>
        <View style={styles.cards}>
          {cards.map(([label, value]) => (
            <View key={label} style={[styles.card, { borderColor: colors.line }]}>
              <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
              <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
            </View>
          ))}
        </View>

        {/* Said plainly rather than implied. A total that counts one device is a
            different number from a total that counts an account, and the two
            look identical on a screen. */}
        {stats.local && <Hint colors={colors}>{t('statsLocalOnly')}</Hint>}

        {types.length > 0 && (
          <>
            <Heading colors={colors}>{t('statsByType')}</Heading>
            {types.map((m) => (
              <View key={m.id} style={[styles.row, { borderColor: colors.line }]}>
                <Text style={[styles.rowTitle, { color: colors.text }]}>{t('medium_' + m.id) || m.label}</Text>
                <Text style={[styles.rowSide, { color: colors.muted }]}>
                  {t(Shelf.statWords(m.id).unitsAndTime,
                    [String(byMedium[m.id].chapters), duration(byMedium[m.id].seconds)])}
                </Text>
              </View>
            ))}
          </>
        )}

        {stats.topSeries?.length > 0 && (
          <>
            <Heading colors={colors}>{t(words.top)}</Heading>
            {stats.topSeries.map((s) => (
              <View key={s.id} style={[styles.row, { borderColor: colors.line }]}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.text }]}>
                  {s.title}
                </Text>
                <Text style={[styles.rowSide, { color: colors.muted }]}>
                  {t(Shelf.statWords(s.medium).unitsAndTime, [String(s.chapters), duration(s.seconds)])}
                </Text>
              </View>
            ))}
          </>
        )}
      </>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {chips}
      {body}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 48 },
  chipRow: { paddingBottom: 12, gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
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
