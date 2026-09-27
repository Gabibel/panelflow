// "Reduce motion", as the phone says it.
//
// The web and the extension read `prefers-reduced-motion` (docs/redesign.md
// §6); the app used to read nothing, and its sheets slid in over a scrim that
// slid with them whatever the reader had asked the system for (QA report,
// F-43). Everything in the app that moves asks this first, and
// backend/test/native-motion.test.js holds every Modal and Animated to it.
//
// The rule is the charter's: under "reduce", nothing travels — a sheet fades in
// where it would have slid — and a fade is kept wherever the fade *is* the
// information (a toast appearing, a sheet arriving). Short, and never a spring.
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Easing } from 'react-native';

/** Whether the reader asked the system for less motion; follows the switch live. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((on) => { if (live) setReduced(!!on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (on) => setReduced(!!on));
    return () => { live = false; sub?.remove?.(); };
  }, []);
  return reduced;
}

/** The app's durations, in one place: the same numbers the charter gives the web. */
export const DURATION = {
  fade: 200,      // n° 9, a toast; and a scrim
  sheet: 240,     // a sheet rising from the bottom edge, as iOS draws its own
  quick: 150,     // a sheet arriving under "reduce": opacity only
};

export const EASE_OUT = Easing.out(Easing.cubic);
