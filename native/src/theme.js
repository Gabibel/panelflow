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
  fieldBorder: '#78716c',
  dropped: '#9aa6f7',
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
  fieldBorder: '#857c73',
  dropped: '#5a4fb0',
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
  // Not the danger red: it sat one step from the accent, and "reading" and
  // "dropped" were one colour on every stripe (QA report, F-44).
  dropped: c.dropped,
}[status] || c.muted);

// `fieldBorder` is the edge of anything you type into: `line` is a divider and
// meant to be quiet, 1.3–1.5:1, where a field's edge is asked 3:1 (F-46).

export const palette = (scheme) => (scheme === 'light' ? light : dark);

// --- a series with no cover ---------------------------------------------------
//
// The web shelf's answer (web/app.js, fallbackCover, and `.cover-fallback` in
// styles.css): the title's first letter on a tint the title decides — somewhere
// between the accent and the amber, laid on the raised surface by an amount the
// title also decides. Deterministic, so a series looks like itself every time,
// and made of palette colours only. The app used to draw grey tiles with the
// title in grey on them, one like the next (QA report, F-54).

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (parts) => `#${parts.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** CSS's `color-mix(in srgb, a w, b)`, for two #rrggbb colours. */
export const mix = (a, b, w) => {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((v, i) => v * w + y[i] * (1 - w)));
};

/** The same colour with an alpha, as React Native writes it. */
export const alpha = (color, a) => {
  const [r, g, b] = rgb(color);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/** The same hash the web uses, so a series has one colour on both. */
export function hashOf(title) {
  let h = 5381;
  for (let i = 0; i < title.length; i++) h = ((h * 33) ^ title.charCodeAt(i)) >>> 0;
  return h;
}

export function coverTint(title, c) {
  const h = hashOf(title);
  const tint = (h % 101) / 100;
  const weight = (22 + ((h >>> 9) % 19)) / 100;
  return mix(mix(c.accent, c.warn, tint), c.surfaceHi, weight);
}
