// The app's typeface, loaded once and said when it is there.
//
// Shell.js calls `loadFonts()` at start; components/Text.js asks
// `useFontsReady()`. Until the files are in, text is drawn in the phone's own
// face rather than not at all, and a font that fails to load costs the look,
// never the app.
import { useSyncExternalStore } from 'react';
import { loadAsync } from 'expo-font';
import { SchibstedGrotesk_400Regular } from '@expo-google-fonts/schibsted-grotesk/400Regular';
import { SchibstedGrotesk_500Medium } from '@expo-google-fonts/schibsted-grotesk/500Medium';
import { SchibstedGrotesk_600SemiBold } from '@expo-google-fonts/schibsted-grotesk/600SemiBold';
import { SchibstedGrotesk_700Bold } from '@expo-google-fonts/schibsted-grotesk/700Bold';
import { SchibstedGrotesk_800ExtraBold } from '@expo-google-fonts/schibsted-grotesk/800ExtraBold';

let ready = false;
let started = null;
const listeners = new Set();

export function loadFonts() {
  started ??= loadAsync({
    SchibstedGrotesk_400Regular,
    SchibstedGrotesk_500Medium,
    SchibstedGrotesk_600SemiBold,
    SchibstedGrotesk_700Bold,
    SchibstedGrotesk_800ExtraBold,
  }).then(() => {
    ready = true;
    for (const l of listeners) l();
  }).catch((e) => console.warn('[panelflow] the typeface did not load', e));
  return started;
}

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

export const useFontsReady = () => useSyncExternalStore(subscribe, () => ready);
