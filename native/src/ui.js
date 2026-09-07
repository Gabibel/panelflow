// The handful of pieces every screen is built out of.
//
// Deliberately small and unstyled-by-default: the palette lives in theme.js and
// arrives as a prop, so a colour is written once there and nowhere here.
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export function Button({ label, onPress, colors, kind = 'solid', disabled, busy }) {
  const solid = kind === 'solid';
  const danger = kind === 'danger';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: solid ? colors.accent : 'transparent',
          borderColor: danger ? colors.danger : colors.line,
          borderWidth: solid ? 0 : 1,
          opacity: (disabled || busy) ? 0.5 : (pressed ? 0.75 : 1),
        },
      ]}
    >
      {busy
        ? <ActivityIndicator color={solid ? '#ffffff' : colors.text} />
        : (
          <Text style={[styles.buttonText, {
            color: solid ? '#ffffff' : (danger ? colors.danger : colors.text),
          }]}
          >
            {label}
          </Text>
        )}
    </Pressable>
  );
}

export function Field({ label, colors, ...props }) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={colors.muted}
        style={[styles.input, {
          color: colors.text, backgroundColor: colors.surface, borderColor: colors.line,
        }]}
      />
    </View>
  );
}

/** A line of explanation under a control, in the colour explanations are in. */
export const Hint = ({ children, colors }) => (
  <Text style={[styles.hint, { color: colors.muted }]}>{children}</Text>
);

export const Empty = ({ children, colors }) => (
  <Text style={[styles.empty, { color: colors.muted }]}>{children}</Text>
);

export const Heading = ({ children, colors }) => (
  <Text style={[styles.heading, { color: colors.text }]}>{children}</Text>
);

const styles = StyleSheet.create({
  button: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
    marginVertical: 4,
  },
  // 15px and 600: the same weight the other surfaces give a primary action, and
  // large enough that iOS does not shrink the label on a narrow phone.
  buttonText: { fontSize: 15, fontWeight: '600' },
  field: { marginVertical: 6 },
  label: { fontSize: 12, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.6 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 6 },
  empty: { fontSize: 14, textAlign: 'center', marginTop: 32, paddingHorizontal: 24, lineHeight: 20 },
  heading: { fontSize: 17, fontWeight: '600', marginTop: 18, marginBottom: 8 },
});
