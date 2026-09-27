// A sheet from the bottom edge, over a scrim — the one way this app shows a
// panel on top of a screen.
//
// Two things used to be wrong with the three sheets that each wrote this out:
// the scrim slid up with the sheet (a dark block travelling up the screen, where
// iOS fades it in place), and "Reduce motion" changed nothing (QA report,
// F-43). Here the scrim fades and only the sheet moves; under "reduce" the
// sheet fades too, and nothing travels. It stays mounted while it leaves, so
// closing is the same movement backwards rather than a cut.
import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, View } from 'react-native';
import { DURATION, EASE_OUT, useReducedMotion } from '../motion.js';
import { t } from '../i18n.js';

export default function Sheet({ visible, onClose, onHidden, colors, style, label, children }) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const shown = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(shown, {
      toValue: visible ? 1 : 0,
      duration: reduced ? DURATION.quick : DURATION.sheet,
      easing: EASE_OUT,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) { setMounted(false); onHidden?.(); }
    });
  }, [visible, reduced]);

  if (!mounted) return null;
  const travel = shown.interpolate({ inputRange: [0, 1], outputRange: [reduced ? 0 : 520, 0] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.frame}>
        {/* The scrim fades where it is; it is a dimmer, not a panel. */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: shown }]}>
          <Pressable
            style={[styles.scrim, { backgroundColor: colors.scrim }]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('actionClose')}
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          accessibilityLabel={label}
          style={[
            styles.sheet,
            { backgroundColor: colors.surface, borderColor: colors.line },
            style,
            { opacity: reduced ? shown : 1, transform: [{ translateY: travel }] },
          ]}
        >
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, justifyContent: 'flex-end' },
  scrim: { flex: 1 },
  sheet: {
    borderTopLeftRadius: 16, borderTopRightRadius: 16, borderTopWidth: 1,
    padding: 16, paddingBottom: 28,
  },
});
