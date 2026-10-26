// The phone app's dark redesign (owner, October 2026): black, one typeface,
// five entries on the bar.
//
// Nothing here renders React Native. It reads the shipped sources for the
// promises that fail quietly when they stop being true: a screen that imports
// react-native's own Text draws in the phone's face again, a theme picked on
// the desktop lights the app up again, a font package bumped past the one the
// installed app was built with breaks every update sent to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

function sources(dir = join(root, 'native', 'src'), out = []) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) sources(full, out);
    else if (item.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// components/Text.js imports react-native, so the rule is lifted out of the
// source rather than reimplemented: the one under test is the one that ships.
const textSrc = read('native', 'src', 'components', 'Text.js');
const from = textSrc.indexOf('const FAMILY = {');
const to = textSrc.indexOf('export default function Text');
const familyFor = new Function(`${textSrc.slice(from, to).replace('export function', 'function')}\nreturn familyFor;`)();

test('every weight a style asks for finds a file of the typeface', () => {
  assert.equal(familyFor(undefined), 'SchibstedGrotesk_400Regular');
  assert.equal(familyFor('normal'), 'SchibstedGrotesk_400Regular');
  assert.equal(familyFor('500'), 'SchibstedGrotesk_500Medium');
  assert.equal(familyFor('600'), 'SchibstedGrotesk_600SemiBold');
  assert.equal(familyFor('bold'), 'SchibstedGrotesk_700Bold');
  assert.equal(familyFor(700), 'SchibstedGrotesk_700Bold');
  assert.equal(familyFor('800'), 'SchibstedGrotesk_800ExtraBold');
  assert.equal(familyFor('900'), 'SchibstedGrotesk_800ExtraBold', 'no 900 is loaded');
  assert.equal(familyFor('300'), 'SchibstedGrotesk_400Regular', 'no 300 is loaded');
  // Each name is one the loader registers.
  const fonts = read('native', 'src', 'fonts.js');
  for (const w of ['400Regular', '500Medium', '600SemiBold', '700Bold', '800ExtraBold']) {
    assert.match(fonts, new RegExp(`SchibstedGrotesk_${w},`));
    assert.ok(existsSync(join(root, 'native', 'node_modules', '@expo-google-fonts', 'schibsted-grotesk', w, `SchibstedGrotesk_${w}.ttf`)),
      `${w} is not installed`);
  }
});

test('no screen draws text in the phone\'s own face', () => {
  for (const file of sources()) {
    const name = relative(root, file).replace(/\\/g, '/');
    if (name.endsWith('components/Text.js')) continue;
    const imports = [...read(relative(root, file)).matchAll(/import\s*\{([^}]*)\}\s*from\s*'react-native';/g)];
    for (const [, names] of imports) {
      assert.doesNotMatch(names, /(^|[\s,])Text([\s,]|$)/, `${name} takes Text from react-native`);
    }
  }
});

test('the typeface module is the one the installed app was built with', () => {
  // expo-font has native code. An update sent over the air runs on the app
  // already installed (build 25 and later carry 57.0.3, inside expo), so the
  // JavaScript must not move past it without a new build.
  const pkg = JSON.parse(read('native', 'package.json'));
  assert.equal(pkg.dependencies['expo-font'], '57.0.3');
});

test('the app is dark, whatever the phone or the account says', () => {
  const shell = read('native', 'src', 'Shell.js');
  assert.match(shell, /const colors = palette\('dark'\);/);
  assert.match(shell, /<StatusBar style="light" \/>/);
  assert.doesNotMatch(shell, /Appearance/);
  assert.doesNotMatch(read('native', 'src', 'screens', 'settings', 'AppearancePage.js'), /set\('theme'/);
  const app = JSON.parse(read('native', 'app.json')).expo;
  assert.equal(app.userInterfaceStyle, 'dark');
});

test('the dark palette is black with neutral greys, and still legible', () => {
  const css = read('shared', 'theme.css');
  for (const [token, value] of [['bg', '#000000'], ['surface', '#121212'], ['surface-hi', '#1c1c1e'],
    ['line', '#2c2c2e'], ['text', '#ffffff'], ['muted', '#a1a1aa'], ['accent', '#3fb0c9'], ['unread', '#f5a623']]) {
    assert.ok(css.includes(`--dark-${token}: ${value};`), `--dark-${token} is not ${value}`);
  }
});
