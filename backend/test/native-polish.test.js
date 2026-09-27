// The phone app as the store will see it: the fifth round of the September 2026
// QA pass (F-16, F-19, F-34, F-35, F-39, F-42, F-43, F-45, F-48, F-54).
//
// Nothing here renders React Native. It reads the shipped sources for the
// promises a reviewer and a VoiceOver user can check in thirty seconds — an
// icon on every tab, a name on every field, no sheet that ignores "Reduce
// motion", no system prompt out of nowhere — because each of these was true
// once, and none of them fails loudly when it stops being true.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

test('every icon the app asks for exists at the three iOS scales', () => {
  const icon = read('native', 'src', 'components', 'Icon.js');
  const names = [...icon.matchAll(/require\('\.\.\/\.\.\/assets\/icons\/([\w-]+)\.png'\)/g)].map((m) => m[1]);
  assert.ok(names.length >= 6, 'the icon set is gone');
  for (const name of names) {
    for (const suffix of ['', '@2x', '@3x']) {
      assert.ok(existsSync(join(root, 'native', 'assets', 'icons', `${name}${suffix}.png`)), `${name}${suffix}.png is missing`);
    }
  }
  // And every name a screen uses is one the set has.
  const known = new Set(names);
  for (const file of sources()) {
    for (const m of read(relative(root, file)).matchAll(/<Icon name="([\w-]+)"/g)) {
      assert.ok(known.has(m[1]), `${relative(root, file)} asks for an icon "${m[1]}" the set does not have`);
    }
  }
});

test('the tab bar is a tab bar to VoiceOver, with a picture and a name on each tab', () => {
  const shell = read('native', 'src', 'Shell.js');
  assert.match(shell, /accessibilityRole="tablist"/);
  assert.match(shell, /accessibilityRole="tab"/);
  assert.match(shell, /accessibilityState=\{\{ selected \}\}/);
  const tabs = shell.slice(shell.indexOf('const TABS = ['), shell.indexOf('];', shell.indexOf('const TABS = [')));
  assert.equal([...tabs.matchAll(/\['\w+', '\w+', '\w+'\]/g)].length, 5, 'five tabs, each with its icon');
  // 49 points: the height iOS gives its own bar.
  assert.match(shell, /minHeight: 49/);
});

test('nothing slides without asking whether the reader wants less motion', () => {
  // One component draws every sheet, and it reads the setting; the toast only
  // fades, which the charter keeps under "reduce" (docs/redesign.md §6, n° 9).
  for (const file of sources()) {
    const src = read(relative(root, file));
    const name = relative(root, file);
    if (/<Modal\b/.test(src)) {
      assert.equal(name, join('native', 'src', 'components', 'Sheet.js'), `${name} draws its own Modal; use components/Sheet.js`);
    }
    if (/\bAnimated\./.test(src)) {
      assert.match(src, /from '\.\.?\/?(\.\.\/)?motion\.js'|from '\.\/motion\.js'|from '\.\.\/motion\.js'/, `${name} animates without motion.js`);
    }
  }
  const sheet = read('native', 'src', 'components', 'Sheet.js');
  assert.match(sheet, /useReducedMotion\(\)/);
  assert.match(sheet, /animationType="none"/, 'the Modal must not slide the scrim with the sheet');
  assert.match(sheet, /outputRange: \[reduced \? 0 : 520, 0\]/, 'under "reduce" the sheet does not travel');
  const motion = read('native', 'src', 'motion.js');
  assert.match(motion, /isReduceMotionEnabled/);
  assert.match(motion, /reduceMotionChanged/);
});

test('every field has a name, and the score is one adjustable control', () => {
  const ui = read('native', 'src', 'ui.js');
  assert.match(ui, /<TextInput\s+accessibilityLabel=\{label\}/);
  // The edge that says "type here" clears 3:1 (contrast.test.js).
  assert.match(ui, /borderColor: colors\.fieldBorder/);
  const sheet = read('native', 'src', 'EntrySheet.js');
  assert.match(sheet, /accessibilityRole="adjustable"/);
  assert.match(sheet, /accessibilityActions=\{\[\{ name: 'increment' \}, \{ name: 'decrement' \}\]\}/);
});

test('a card says what it is and offers its sheet without a secret gesture', () => {
  const lib = read('native', 'src', 'screens', 'LibraryScreen.js');
  assert.match(lib, /accessibilityLabel=\{spoken\(entry, n, mark, shelf\)\}/);
  assert.match(lib, /\{ name: 'details', label: t\('mobileCardDetails'\) \}/);
  assert.match(lib, /<Icon name="more"/, 'the visible way to the sheet is gone');
});

test('a removal can be taken back for five seconds', () => {
  const shell = read('native', 'src', 'Shell.js');
  assert.match(shell, /const UNDO_MS = 5000;/);
  assert.match(shell, /label: t\('actionUndo'\)/);
  // Written when the app leaves the screen, so it is never lost to a lock.
  assert.match(shell, /if \(state !== 'active' && removing\) commitRemoval\(removing\);/);
  const sheet = read('native', 'src', 'EntrySheet.js');
  // Asked first (QA of 27 September), then handed to the Shell and its Undo.
  assert.match(sheet, /onPress=\{askRemove\}/);
  assert.match(sheet, /style: 'destructive', onPress: \(\) => onRemove\(entry\)/);
  assert.match(sheet, /style: 'cancel'/, 'the question has no way to say no');
  assert.ok(!/removeFromLibrary'/.test(sheet.replace("t('actionRemoveFromLibrary')", '')),
    'the sheet removes directly again');
});

test('the empty shelf is a welcome with three ways in, not a grey sentence', () => {
  const lib = read('native', 'src', 'screens', 'LibraryScreen.js');
  assert.match(lib, /title=\{t\('mobileWelcomeTitle'\)\}/);
  for (const way of ["onTab?.('search')", "onTab?.('sites')", "onTab?.('settings', 'account')"]) {
    assert.ok(lib.includes(way), `the welcome lost ${way}`);
  }
  assert.match(read('native', 'src', 'screens', 'SettingsScreen.js'), /initialPage/);
});

test('notifications are asked for by the switch, never by a check', () => {
  const notify = read('native', 'src', 'notify.js');
  // The system prompt lives behind the switch and nowhere else.
  const ask = notify.indexOf('requestPermissionsAsync');
  assert.ok(ask > notify.indexOf('export async function setNotifications'), 'the prompt is outside the switch');
  assert.equal(notify.match(/requestPermissionsAsync/g).length, 1);
  const raise = notify.slice(notify.indexOf('export async function raise'));
  assert.match(raise, /if \(!\(await notificationState\(\)\)\.on\) return;/);
  assert.match(read('native', 'src', 'screens', 'settings', 'UpdatesPage.js'), /<Switch/);
});

test('the phone does not talk about browsers, extensions or Alt+R', () => {
  const pages = ['AppearancePage.js', 'ReaderPage.js', 'AdblockPage.js', 'UpdatesPage.js']
    .map((f) => read('native', 'src', 'screens', 'settings', f)).join('\n') + read('native', 'src', 'screens', 'AccountScreen.js');
  for (const key of ['optionsLanguageAuto', 'optionsLanguageHint', 'optionsReaderHint', 'optionsAdblockHint', 'optionsUpdatesHint', 'webPasswordHint']) {
    assert.ok(!pages.includes(`t('${key}')`), `the app still says ${key}`);
  }
  const fr = JSON.parse(read('shared', '_locales', 'fr', 'messages.json'));
  for (const key of ['mobileLanguageAuto', 'mobileLanguageHint', 'mobileReaderHint', 'mobileAdblockHint', 'mobileUpdatesHint', 'mobilePasswordHint']) {
    assert.doesNotMatch(fr[key].message, /Alt\+R|navigateur|extension|onglet/i, `${key}: ${fr[key].message}`);
  }
});

test('the streaks are read under the names the server and the core answer with', () => {
  const stats = read('native', 'src', 'screens', 'settings', 'StatsPage.js');
  assert.match(stats, /stats\.current \?\? 0/);
  assert.match(stats, /stats\.longest \?\? 0/);
  assert.ok(!/currentStreak|longestStreak/.test(stats.replace(/statCurrentStreak|statLongestStreak/g, '')));
});

test('the store build shows a version, not the code-update tools', () => {
  const report = read('native', 'src', 'screens', 'settings', 'ReportPage.js');
  assert.match(report, /\{isTestBuild\(\) && \(/);
  assert.match(read('native', 'src', 'ota.js'), /Updates\.channel !== 'production'/);
});

test('no iPad layout is claimed that the app does not have', () => {
  const app = JSON.parse(read('native', 'app.json'));
  assert.equal(app.expo.ios.supportsTablet, false);
});

test('the app opens on its own paper, not on a white flash', () => {
  // Left unconfigured, the launch screen is white — in front of an app whose
  // first frame is dark (QA report, F-53). Both colours are the palette's own.
  const plugins = JSON.parse(read('native', 'app.json')).expo.plugins;
  const splash = plugins.find((p) => Array.isArray(p) && p[0] === 'expo-splash-screen')?.[1];
  assert.ok(splash, 'no launch screen is configured');
  const theme = read('shared', 'theme.css');
  const token = (name) => theme.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1].toLowerCase();
  assert.equal(splash.backgroundColor.toLowerCase(), token('light-bg'));
  assert.equal(splash.dark.backgroundColor.toLowerCase(), token('dark-bg'));
  for (const image of [splash.image, splash.dark.image]) {
    assert.ok(existsSync(join(root, 'native', image)), `${image} is missing`);
  }
});

test('the Keychain is used for the token, and Face ID is not claimed', () => {
  // expo-secure-store declares a Face ID purpose string unless told not to;
  // the app never asks for Face ID, and a reviewer reads Info.plist.
  const plugins = JSON.parse(read('native', 'app.json')).expo.plugins;
  const secure = plugins.find((p) => Array.isArray(p) && p[0] === 'expo-secure-store');
  assert.ok(secure, 'expo-secure-store is not configured');
  assert.equal(secure[1].faceIDPermission, false);
  assert.match(read('native', 'src', 'storage.js'), /AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/);
});

// --- the re-test of It.5 -----------------------------------------------------

test('coming back from the browser finds the screen as it was left', () => {
  // N-A13: the tabs were swapped out for the browser, and the search, the
  // sign-in form and the shelf's filter were gone on the way back.
  const shell = read('native', 'src', 'Shell.js');
  assert.doesNotMatch(shell, /\{browsing \? \(/, 'the browser replaces the tabs again');
  assert.match(shell, /\{browsing && \(\n\s*<View style=\{\[StyleSheet\.absoluteFill/);
  // And VoiceOver does not read the covered screen under the chapter.
  assert.match(shell, /accessibilityElementsHidden=\{!!browsing\}/);
  assert.match(shell, /importantForAccessibility=\{browsing \? 'no-hide-descendants' : 'auto'\}/);
});

test('the selected tab is marked by more than its colour', () => {
  const shell = read('native', 'src', 'Shell.js');
  assert.match(shell, /<View style=\{\[styles\.tabMark, selected && \{ backgroundColor: colors\.accent \}\]\} \/>/);
  assert.match(shell, /selected && styles\.tabLabelOn/);
});

test('"Undo" is only offered while it can still undo, and waits for VoiceOver', () => {
  const shell = read('native', 'src', 'Shell.js');
  // N-A16: written early when the app left the screen, the toast went on
  // offering an Undo that brought nothing back.
  assert.match(shell, /if \(was\?\.action\?\.removal !== pending\.id\) return was;/);
  // N26: five seconds is gone before a listener reaches the button.
  assert.match(shell, /const UNDO_MS_SPOKEN = 20000;/);
  assert.match(shell, /isScreenReaderEnabled/);
});

test('every control says what it is, and the faint marks are not faint any more', () => {
  const reader = read('native', 'src', 'screens', 'settings', 'ReaderPage.js');
  assert.match(reader, /<Switch[\s\S]*?accessibilityLabel=\{t\(label\)\}/);
  const sheet = read('native', 'src', 'EntrySheet.js');
  assert.match(sheet, /onPress=\{\(\) => file\(f\.id\)\}[\s\S]{0,200}accessibilityRole="radio"/);
  assert.match(sheet, /n <= entry\.score \? colors\.accent : colors\.muted/);
  const account = read('native', 'src', 'screens', 'AccountScreen.js');
  assert.match(account, /borderColor: adult \? colors\.accent : colors\.fieldBorder/);
  assert.match(account, /announceForAccessibility\?\.\(error\)/);
  const browser = read('native', 'src', 'screens', 'BrowserScreen.js');
  assert.match(browser, /accessibilityLabel=\{spoken\}/);
  assert.match(browser, /bar\('›', \(\) => web\.current\?\.goForward\(\), !canGoForward, t\('mobileBrowserNext'\)\)/);
  assert.match(browser, /barButton: \{ minHeight: 44, minWidth: 44/);
  // Nothing to add from PanelFlow's own pages.
  assert.match(browser, /\{!page\.detected && !ours && \(/);
});

test('a sheet born open still rises', () => {
  assert.match(read('native', 'src', 'components', 'Sheet.js'), /useRef\(new Animated\.Value\(0\)\)/);
});
