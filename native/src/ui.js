// The handful of pieces every screen is built out of.
//
// Deliberately small and unstyled-by-default: the palette lives in theme.js and
// arrives as a prop, so a colour is written once there and nowhere here.
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Text from './components/Text.js';
import Icon from './components/Icon.js';

export function Button({ label, onPress, colors, kind = 'solid', disabled, busy, hint }) {
  const solid = kind === 'solid';
  const danger = kind === 'danger';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      // What VoiceOver says: the label as a button, and whether it can be
      // pressed now — a dimmed button read as an ordinary one is a press that
      // does nothing and says nothing (QA report, F-42).
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      style={({ pressed }) => [
        styles.button,
        {
          // The dark redesign's two kinds (owner, October 2026): the accent
          // for the one thing to do, a raised grey for the rest. A red edge
          // still marks the one that removes something.
          backgroundColor: solid ? colors.accent : (danger ? 'transparent' : colors.surfaceHi),
          borderColor: colors.danger,
          borderWidth: danger ? 1 : 0,
          opacity: (disabled || busy) ? 0.5 : (pressed ? 0.75 : 1),
        },
      ]}
    >
      {/* Not white on the accent: in the dark theme that is 3.4:1, a primary
          button nobody can read. `onAccent` is the palette's answer for each
          theme — see native/src/theme.js. */}
      {busy
        ? <ActivityIndicator color={solid ? colors.onAccent : colors.text} />
        : (
          <Text style={[styles.buttonText, solid && styles.buttonTextSolid, {
            color: solid ? colors.onAccent : (danger ? colors.danger : colors.text),
          }]}
          >
            {label}
          </Text>
        )}
    </Pressable>
  );
}

/**
 * A labelled text field. The label is drawn above it and is also its name:
 * VoiceOver used to announce "text field" for the e-mail and the password
 * alike (QA report, F-42), because a label beside a field is two things to a
 * screen reader until one is told it names the other.
 */
export function Field({ label, colors, ...props }) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.muted }]} importantForAccessibility="no" accessibilityElementsHidden>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        {...props}
        placeholderTextColor={colors.muted}
        style={[styles.input, {
          // `fieldBorder`, not `line`: the edge that says "type here" at 3:1.
          color: colors.text, backgroundColor: colors.surface, borderColor: colors.fieldBorder,
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
  <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>{children}</Text>
);

/**
 * The name of the screen, large, at the top of what scrolls — the way iOS
 * titles its own tabs. The tabs used to open onto a row of chips with nothing
 * saying where you were (QA report, F-19). A header for VoiceOver's rotor.
 */
export const ScreenTitle = ({ title, subtitle, colors, right, inset = 0 }) => (
  // `inset`: on the two screens whose page is 12 points in, for a grid whose
  // tiles bring their own 4 — so the title lines up with the covers and with
  // every other screen's 16 (QA verification, It.5).
  <View style={[styles.titleRow, inset ? { paddingHorizontal: inset } : null]}>
    <View style={styles.titleText}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]} numberOfLines={1}>
        {title}
      </Text>
      {!!subtitle && <Text style={[styles.subtitle, { color: colors.muted }]}>{subtitle}</Text>}
    </View>
    {right}
  </View>
);

/**
 * What a screen with nothing on it says: a picture, what this place is for,
 * and the way to put something in it. A sentence alone, grey on black, was
 * every empty screen in the app — a first launch that asked the reader to
 * work out the app from a hint (QA report, F-19).
 */
export function EmptyState({ icon = 'book', title, body, colors, actions = [] }) {
  return (
    <View style={styles.emptyState}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.surfaceHi }]}>
        <Icon name={icon} size={34} color={colors.accent} />
      </View>
      {!!title && (
        <Text accessibilityRole="header" style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
      )}
      {!!body && <Text style={[styles.emptyBody, { color: colors.muted }]}>{body}</Text>}
      <View style={styles.emptyActions}>
        {actions.map(({ label, onPress, kind }, i) => (
          <Button key={label} colors={colors} label={label} onPress={onPress} kind={kind || (i === 0 ? 'solid' : 'ghost')} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginVertical: 4,
  },
  // 15 points at least, so iOS does not shrink the label on a narrow phone;
  // the primary action a step heavier than the rest.
  buttonText: { fontSize: 15, fontWeight: '700' },
  buttonTextSolid: { fontSize: 16, fontWeight: '800' },
  field: { marginVertical: 6 },
  label: { fontSize: 12, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.6 },
  // 44 high at least: 42 with the text alone.
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, minHeight: 44 },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 6 },
  empty: { fontSize: 14, textAlign: 'center', marginTop: 32, paddingHorizontal: 24, lineHeight: 20 },
  heading: { fontSize: 17, fontWeight: '700', marginTop: 18, marginBottom: 8 },
  // Centred, short and heavy, the way the redesign titles a screen (owner,
  // October 2026): the content is what is large, not the name of the place.
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 16, paddingBottom: 10 },
  titleText: { flex: 1, minWidth: 0, alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '800' },
  subtitle: { fontSize: 13, marginTop: 2 },
  emptyState: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 36, paddingBottom: 24 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontSize: 19, fontWeight: '700', textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  emptyActions: { alignSelf: 'stretch', marginTop: 18, gap: 2 },
});
