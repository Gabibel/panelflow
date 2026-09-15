// The icons on disk are the ones scripts/build-icons.mjs draws.
//
// The same discipline as every other generated file here: the script is the
// source, the PNGs are its output, and a difference between them fails the
// suite. What that catches is specific — an Expo upgrade that quietly puts its
// blueprint placeholder back in native/assets/, an icon "improved" by hand in
// one size and not the others, a change of the mark in the web header that
// never reached the home screen.
//
// And it is where "check copyright on images" becomes a standing fact rather
// than a one-off audit: every raster image the four surfaces ship is listed in
// ICONS and drawn from geometry this repository owns. An image file that is
// not in that list is one nobody has accounted for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS, INK, ACCENT, render } from '../../scripts/build-icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p));

test('every icon on disk is what the script draws', () => {
  for (const [path, bytes] of render()) {
    assert.ok(read(path).equals(bytes), `${path} is stale or hand-edited — run \`npm run build:icons\``);
  }
});

test('the two colours are the palette\'s', () => {
  const css = readFileSync(join(root, 'shared', 'theme.css'), 'utf8');
  const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  assert.ok(css.includes(`--dark-bg: ${hex(INK)};`), 'the icon ink is not --dark-bg');
  assert.ok(css.includes(`--dark-accent: ${hex(ACCENT)};`), 'the icon accent is not --dark-accent');
});

test('the sizes are the ones each platform asks for', () => {
  const size = (path) => {
    const b = read(path);
    assert.equal(b.toString('ascii', 1, 4), 'PNG', `${path} is not a PNG`);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };
  assert.deepEqual(size('native/assets/icon.png'), [1024, 1024], 'App Store Connect takes a 1024-pixel icon');
  assert.deepEqual(size('native/assets/android-icon-foreground.png'), [1024, 1024]);
  assert.deepEqual(size('extension/icons/icon128.png'), [128, 128]);
  assert.deepEqual(size('extension/icons/icon48.png'), [48, 48]);
  assert.deepEqual(size('extension/icons/icon16.png'), [16, 16]);
  for (const [d, s] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
    assert.deepEqual(size(`android/app/src/main/res/mipmap-${d}/ic_launcher.png`), [s, s]);
  }
});

test('the iOS icon is opaque: transparent corners come out black on the App Store', () => {
  // Alpha is the fourth byte of every pixel once the IDAT is inflated; rather
  // than inflate it here, the recipe is checked: an opaque background and no
  // corner radius is what makes the file opaque.
  const [, , opts] = ICONS.find(([p]) => p === 'native/assets/icon.png');
  assert.ok(opts.bg, 'the iOS icon has no background');
  assert.equal(opts.radius ?? 0, 0, 'the iOS icon has rounded (transparent) corners');
});

test('every raster image the surfaces ship is one this script accounts for', () => {
  // Walk the directories that hold shipped images. A PNG that is not in ICONS
  // is artwork of unknown origin, and that is the question this test exists
  // to keep answered.
  const listed = new Set(ICONS.map(([p]) => p));
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!/node_modules|\.expo|dist|build|www/.test(name)) walk(full);
      } else if (/\.(png|jpe?g|gif|webp|ico)$/i.test(name)) {
        found.push(relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  for (const dir of ['native/assets', 'extension/icons', 'android/app/src/main/res', 'web', 'mobile/www']) {
    try { walk(join(root, dir)); } catch { /* a surface without images */ }
  }
  const strangers = found.filter((f) => !listed.has(f));
  assert.deepEqual(strangers, [], 'raster images nobody drew: ' + strangers.join(', '));
});
