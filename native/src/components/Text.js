// Every line of text in the app, in the app's typeface.
//
// React Native has no stylesheet to say "this font everywhere", and a custom
// face is not one family with weights in it but one file per weight, each its
// own name. So this stands in for react-native's Text: it reads the weight a
// style asks for and hands the matching file over. Screens keep writing
// `fontWeight: '700'` as they always have.
//
// Schibsted Grotesk (SIL OFL, @expo-google-fonts/schibsted-grotesk), chosen in
// the dark redesign of October 2026 after Inter read as a default. Loaded once
// in Shell.js; until it is, the phone's own face is drawn rather than nothing.
import { StyleSheet, Text as NativeText } from 'react-native';
import { useFontsReady } from '../fonts.js';

const FAMILY = {
  400: 'SchibstedGrotesk_400Regular',
  500: 'SchibstedGrotesk_500Medium',
  600: 'SchibstedGrotesk_600SemiBold',
  700: 'SchibstedGrotesk_700Bold',
  800: 'SchibstedGrotesk_800ExtraBold',
};

/** The file for a weight as a style writes it: 'bold', '600', 600 or nothing. */
export function familyFor(weight) {
  if (weight === 'bold') return FAMILY[700];
  const n = Number(weight) || 400;
  if (n >= 800) return FAMILY[800];
  return FAMILY[Math.max(400, Math.round(n / 100) * 100)];
}

export default function Text({ style, ...props }) {
  const ready = useFontsReady();
  if (!ready) return <NativeText style={style} {...props} />;
  const flat = StyleSheet.flatten(style) || {};
  // A family set on purpose (the report page's monospace) is left alone. The
  // weight is spent on picking the file: kept, Android would thicken an
  // already bold face.
  if (flat.fontFamily) return <NativeText style={style} {...props} />;
  return (
    <NativeText
      style={[style, { fontFamily: familyFor(flat.fontWeight), fontWeight: 'normal' }]}
      {...props}
    />
  );
}
