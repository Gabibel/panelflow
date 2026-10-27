// A column chart of one series: weeks, months, hours, weekdays.
//
// Drawn with Views, no chart library: it is a row of rectangles, and a
// dependency for that would be a native module and a build for nothing.
//
// One series, so no legend: the heading above it says what is counted. The
// marks follow the app's chart rules (the dataviz guide): columns no wider
// than 24 points with a 2-point gap of black between them, a 4-point rounded
// top and a square foot on one hairline baseline, the accent for the data
// and the text tokens for every word. Values are not printed on every bar;
// the line above the chart says the one being looked at, the latest by
// default, and a tap on another bar says that one instead (the phone's
// version of a tooltip). Each bar is also a button VoiceOver reads in full,
// which is the table view a screen reader needs.
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Text from './Text.js';

/**
 * @param {{ data: { key: string, value: number, caption: string, tick?: string }[],
 *   colors: object, height?: number, summary: string, initial?: number }} props
 *   `caption` is the bar's whole sentence ("Week of 13 Oct: 12 chapters"),
 *   `tick` an optional short label under it (only a few bars get one).
 */
export default function Bars({ data, colors, height = 96, summary, initial = null }) {
  const [picked, setPicked] = useState(initial ?? data.length - 1);
  const max = Math.max(1, ...data.map((d) => d.value));
  const shown = data[picked] ?? data[data.length - 1];
  return (
    <View accessibilityLabel={summary}>
      <Text style={[styles.caption, { color: colors.text }]} accessibilityLiveRegion="polite">
        {shown?.caption ?? ''}
      </Text>
      <View style={[styles.plot, { height, borderColor: colors.line }]}>
        {data.map((d, i) => (
          <Pressable
            key={d.key}
            onPress={() => setPicked(i)}
            accessibilityRole="button"
            accessibilityLabel={d.caption}
            accessibilityState={{ selected: i === picked }}
            style={styles.slot}
          >
            <View
              style={[styles.bar, {
                height: d.value > 0 ? Math.max(2, Math.round((d.value / max) * (height - 4))) : 0,
                backgroundColor: colors.accent,
                opacity: i === picked ? 1 : 0.55,
              }]}
            />
          </Pressable>
        ))}
      </View>
      {/* Under a dozen bars or fewer, each one's label fits under it; past
          that only the two ends are named, and the caption does the rest. */}
      <View style={styles.ticks} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {data.length <= 12
          ? data.map((d) => (
            <Text key={d.key} numberOfLines={1} style={[styles.tick, { color: colors.muted }]}>{d.tick ?? ''}</Text>
          ))
          : (
            <View style={styles.edges}>
              <Text style={[styles.edge, { color: colors.muted }]}>{data[0]?.tick ?? ''}</Text>
              <Text style={[styles.edge, { color: colors.muted }]}>{data[data.length - 1]?.tick ?? ''}</Text>
            </View>
          )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: { fontSize: 13, minHeight: 18, marginBottom: 6 },
  plot: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // The whole column is the target, not the bar: a bar a few points high is
  // still a full-height place to tap.
  slot: { flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center' },
  bar: { width: '100%', maxWidth: 24, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  ticks: { flexDirection: 'row', gap: 2, marginTop: 4 },
  tick: { flex: 1, fontSize: 10, textAlign: 'center' },
  edges: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' },
  edge: { fontSize: 10 },
});
