// The palette, transcribed from shared/theme.css.
//
// Not generated, and it is the one duplication in this client that a script
// does not maintain: React Native has no CSS custom properties to read, and
// parsing a stylesheet at runtime to find five hex values would be a worse
// trade than these twelve lines. `backend/test/native-shell.test.js` compares
// them against the stylesheet, so a colour changed there fails here rather than
// drifting quietly — which is exactly how the four surfaces once ended up with
// two palettes.
export const dark = {
  bg: '#12100f',
  surface: '#1c1917',
  surfaceHi: '#262220',
  line: '#38332f',
  text: '#fafaf9',
  muted: '#a8a29e',
  accent: '#e8613c',
  danger: '#f2705f',
  ok: '#6cc08b',
  warn: '#e3b341',
  scrim: 'rgba(0, 0, 0, .6)',
  unread: '#e0a15c',
  onAccent: '#12100f',
};

export const light = {
  bg: '#f7f4ec',
  surface: '#ffffff',
  surfaceHi: '#ede8dc',
  line: '#ddd5c6',
  text: '#1a1714',
  muted: '#6b635c',
  accent: '#b44324',
  danger: '#be3629',
  ok: '#2b764d',
  warn: '#8b600d',
  scrim: 'rgba(26, 23, 20, .35)',
  unread: '#866137',
  onAccent: '#ffffff',
};

// `unread` and `onAccent` used to be one value each, outside both palettes.
// They are in them now for the reason shared/theme.css gives: the amber that
// reads on a dark ground is 2.0:1 as text on a light one, and white on the
// dark accent is 3.4:1. Same hue, two values, and the stylesheet's contrast
// test holds every pairing to 4.5:1.

/**
 * Which colour a shelf is drawn in. The same mapping app.css makes, so the cue
 * — a stripe on the cover, a dot on the tab — is learnable across surfaces.
 */
export const statusColor = (status, c) => ({
  reading: c.accent,
  plan: c.muted,
  completed: c.ok,
  paused: c.warn,
  dropped: c.danger,
}[status] || c.muted);

export const palette = (scheme) => (scheme === 'light' ? light : dark);
