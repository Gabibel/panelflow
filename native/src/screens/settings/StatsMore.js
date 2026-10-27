// The detailed statistics, below the free ones on the statistics page.
//
// What it draws comes whole from the server (backend/src/advanced-stats.js),
// which only sends it to an account it knows is PanelFlow Premium. This file
// decides nothing about who may see it: given `advanced`, it draws it; given
// none, the page shows what Premium would add (StatsPage.js).
//
// Four parts, each answering one question: how much, week by week and month
// by month; this year and the last; when (the hour, the weekday); and when
// each series being read will have caught up with the site.
import { StyleSheet, View } from 'react-native';
import Text from '../../components/Text.js';
import Bars from '../../components/Bars.js';
import { currentLang, t } from '../../i18n.js';
import { duration } from '../../format.js';
import { Shelf } from '../../shared.js';
import { Heading, Hint } from '../../ui.js';

const locale = () => (currentLang() === 'fr' ? 'fr-FR' : 'en-GB');

/** "13 Oct", from a YYYY-MM-DD day. */
const shortDay = (day) => new Date(`${day}T00:00:00Z`)
  .toLocaleDateString(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** "Oct" or "October 2026", from a YYYY-MM month. */
const monthName = (month, long = false) => new Date(`${month}-01T00:00:00Z`)
  .toLocaleDateString(locale(), long ? { month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' });
/** Monday first, as the server counts them; 2024-01-01 was a Monday. */
const weekdayName = (i, long = false) => new Date(Date.UTC(2024, 0, 1 + i))
  .toLocaleDateString(locale(), { weekday: long ? 'long' : 'narrow', timeZone: 'UTC' });

/** The index of the largest value, or -1 when there is nothing at all. */
export function peakOf(values) {
  let best = -1;
  values.forEach((v, i) => { if (v > 0 && (best === -1 || v > values[best])) best = i; });
  return best;
}

export default function StatsMore({ advanced, medium, colors }) {
  const words = Shelf.statWords(medium);
  const count = (n, seconds) => t(Shelf.countKey(medium, n), [String(n), duration(seconds)]);

  const weeks = advanced.weeks.map((w, i) => ({
    key: w.week,
    value: w.chapters,
    caption: t('statsWeekCaption', [shortDay(w.week), count(w.chapters, w.seconds)]),
    tick: i === 0 || i === advanced.weeks.length - 1 ? shortDay(w.week) : '',
  }));
  // The last twelve months on the chart; the year review reads all of them.
  const months = advanced.months.slice(-12).map((m) => ({
    key: m.month,
    value: m.chapters,
    caption: t('statsMonthCaption', [monthName(m.month, true), count(m.chapters, m.seconds)]),
    tick: monthName(m.month).slice(0, 3),
  }));
  const hours = advanced.hours.map((n, h) => ({
    key: String(h),
    value: n,
    caption: t('statsHourCaption', [String(h), t('statsTimes', [String(n)])]),
    tick: h % 6 === 0 ? `${h}` : '',
  }));
  const weekdays = advanced.weekdays.map((n, i) => ({
    key: String(i),
    value: n,
    caption: t('statsMonthCaption', [weekdayName(i, true), t('statsTimes', [String(n)])]),
    tick: weekdayName(i),
  }));
  const hour = peakOf(advanced.hours);
  const day = peakOf(advanced.weekdays);

  const year = (y) => {
    if (!y || !y.chapters) return null;
    const cards = [
      [t(words.units), String(y.chapters)],
      [t(words.time), duration(y.seconds)],
      [t(words.series), String(y.series)],
      [t('statsDaysRead'), String(y.days)],
      [t('statsNewSeries'), String(y.newSeries)],
      [t('statLongestStreak'), t('statDays', [String(y.longestStreak)])],
    ];
    return (
      <View key={y.year} style={styles.block}>
        <Heading colors={colors}>{t('statsYearTitle', [String(y.year)])}</Heading>
        <View style={styles.cards}>
          {cards.map(([label, value]) => (
            <View key={label} style={[styles.card, { borderColor: colors.line }]}>
              <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
              <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
            </View>
          ))}
        </View>
        {y.bestMonth && (
          <Hint colors={colors}>
            {t('statsBestMonth', [monthName(y.bestMonth.month, true), String(y.bestMonth.chapters)])}
          </Hint>
        )}
        {y.top.length > 0 && y.top.map((s, i) => (
          <View key={s.id} style={[styles.row, { borderColor: colors.line }]}>
            <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.text }]}>{`${i + 1}. ${s.title}`}</Text>
            <Text style={[styles.rowSide, { color: colors.muted }]}>{String(s.chapters)}</Text>
          </View>
        ))}
      </View>
    );
  };

  return (
    <View style={styles.more}>
      <Heading colors={colors}>{t('statsWeeks')}</Heading>
      <Bars colors={colors} data={weeks} summary={t('statsWeeks')} />

      <Heading colors={colors}>{t('statsMonths')}</Heading>
      <Bars colors={colors} data={months} summary={t('statsMonths')} />

      {year(advanced.year)}
      {year(advanced.lastYear)}

      <Heading colors={colors}>{t('statsWhen')}</Heading>
      {hour >= 0 && day >= 0 && (
        <Hint colors={colors}>{t('statsPeak', [String(hour), weekdayName(day, true)])}</Hint>
      )}
      <Bars colors={colors} data={hours} summary={t('statsWhen')} initial={hour >= 0 ? hour : null} />
      <View style={styles.gap} />
      <Bars colors={colors} data={weekdays} height={64} summary={t('statsWhen')} initial={day >= 0 ? day : null} />

      <Heading colors={colors}>{t('statsCatchUp')}</Heading>
      {advanced.catchUp.length === 0
        ? <Hint colors={colors}>{t('statsCatchUpNone')}</Hint>
        : (
          <>
            <Hint colors={colors}>{t('statsCatchUpHint')}</Hint>
            {advanced.catchUp.map((s) => (
              <View key={s.id} style={[styles.row, { borderColor: colors.line }]}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.text }]}>{s.title}</Text>
                <Text style={[styles.rowSide, { color: colors.muted }]}>
                  {s.weeks === null
                    ? t('statsCatchUpIdle', [String(s.behind)])
                    : t('statsCatchUpRow', [String(s.behind), String(s.weeks)])}
                </Text>
              </View>
            ))}
          </>
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  more: { gap: 10, marginTop: 8 },
  block: { gap: 8 },
  gap: { height: 8 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, flexGrow: 1, minWidth: '30%' },
  value: { fontSize: 18, fontWeight: '700' },
  label: { fontSize: 12, marginTop: 2 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 12,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTitle: { fontSize: 14, flex: 1 },
  rowSide: { fontSize: 12 },
});
