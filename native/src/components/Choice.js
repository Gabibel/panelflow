// One answer out of a few, as a row of chips.
//
// A phone has no `<select>` worth using: the platform picker is a modal for a
// choice between three words. Chips show every option and which one is in
// force, which is also what makes a settings screen readable at a glance rather
// than a list of closed boxes.
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function Choice({ options, value, onChange, colors }) {
  return (
    <View style={styles.row}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => onChange(option.value)}
            // Announced as what it is, so the row is usable by somebody who
            // cannot see which chip is filled.
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[styles.chip, {
              borderColor: on ? colors.accent : colors.line,
              backgroundColor: on ? colors.surfaceHi : 'transparent',
            }]}
          >
            <Text style={{ color: on ? colors.text : colors.muted, fontSize: 14 }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1 },
});
