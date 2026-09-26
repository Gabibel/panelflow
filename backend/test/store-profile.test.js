// What the store builds may not contain.
//
// The QA pass of September 2026 read the iOS build the way an App Store
// reviewer would, and found what docs/ARCHITECTURE.md's store note forbids in
// so many words: a directory of about a hundred and seventy scan and streaming
// sites, a search that added "scan lecture en ligne" to what the reader typed,
// a download of third-party chapters as a .cbz, chapters kept offline, a
// playback-speed control for streaming players, and an adult domain in the
// bundled rules. Each is held out below, by reading the files that ship.
//
// The Chrome Web Store half lives next to the code it is about: the manifest
// packed without localhost (pack.test.js) and ad blocking confined to the
// reading sites (adblock.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATE, LATE_IN_FRAMES, EARLY } from '../../scripts/build-native-inject.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

/** A file with its comments taken out: what it does, not what it remembers. */
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

test('the phone injects no playback-speed control into streaming players', () => {
  for (const list of [EARLY, LATE, LATE_IN_FRAMES]) assert.ok(!list.includes('video-speed.js'));
  assert.ok(!read('native', 'generated', 'injected.js').includes('playbackRate'),
    'the bundle the in-app browser injects still reaches for a video element');
  assert.ok(!code('ios', 'Sources', 'PageScripts.swift').includes('video-speed'));
});

test('no chapter is downloaded or kept on the phone', () => {
  const reader = code('extension', 'content', 'reader.js');
  assert.doesNotMatch(reader, /cbz/i, 'the reader can still export a chapter as an archive');
  // The extension keeps an expiring reading cache; the phone keeps nothing.
  assert.match(reader, /\$\{inShell\(\) \? '' : `<button[^`]*data-act="offline"/);
  assert.match(reader, /if \(!btn \|\| inShell\(\)\) return;/);
  for (const gone of [['native', 'src', 'offline.js'], ['native', 'src', 'screens', 'settings', 'SavedPage.js'],
    ['native', 'generated', 'shared', 'offline-store.js']]) {
    assert.ok(!existsSync(join(root, ...gone)), `${gone.join('/')} is back`);
  }
  assert.doesNotMatch(code('native', 'src', 'screens', 'SettingsScreen.js'), /SavedPage/);
  for (const lang of ['en', 'fr']) {
    const messages = JSON.parse(read('shared', '_locales', lang, 'messages.json'));
    assert.equal(messages.readerDownloadCbz, undefined);
  }
});

test('the Sites tab lists the reader\'s own sites, never a directory', () => {
  const sites = code('native', 'src', 'screens', 'SitesScreen.js');
  assert.doesNotMatch(sites, /getRules|\.domains|videoDomains|detection-rules/,
    'the tab reads the rules file again, which is a list of every scan site');
  assert.match(sites, /store\.library/);
  assert.match(sites, /favouriteSites/);
  // The rules file's notes to its editors are not sites, on any surface.
  assert.match(read('web', 'app.js'), /if \(key\.startsWith\('_'\)\) continue;/);
  assert.match(read('mobile', 'www', 'app.js'), /if \(key\.startsWith\('_'\)\) continue;/);
});

test('a search is the reader\'s own words, with nothing added', () => {
  for (const file of ['SearchScreen.js', 'SitesScreen.js']) {
    const src = code('native', 'src', 'screens', file);
    assert.doesNotMatch(src, /\bscans?\b|vostfr|streaming|lecture en ligne|chapitre/i, `${file} adds words`);
  }
  const search = code('native', 'src', 'screens', 'SearchScreen.js');
  assert.match(search, /send\(\{ type: 'search', q: words\(\) \}\)/);
  assert.doesNotMatch(search, /scans:/);
});

test('no adult site is in the rules the app ships', () => {
  const rules = JSON.parse(read('shared', 'detection-rules.json'));
  const hosts = [...Object.keys(rules.domains || {}), ...Object.keys(rules.videoDomains || {})]
    .filter((k) => !k.startsWith('_'));
  // toonily and manhwa18 were the two the QA pass found: sites whose catalogue
  // is adult first. The rest are the words such a host is usually named with.
  const ADULT = /hentai|porn|xxx|nsfw|manhwa18|toonily|18\+|adult|doujin/i;
  assert.deepEqual(hosts.filter((h) => ADULT.test(h)), []);
});

test('the iOS build declares what it collects, and that it tracks nobody', () => {
  // App Store Connect reads the app's privacy manifest next to the "App
  // Privacy" answers; an app with none is the question asked back by review.
  const manifest = JSON.parse(read('native', 'app.json')).expo.ios.privacyManifests;
  assert.ok(manifest, 'native/app.json has no ios.privacyManifests');
  assert.equal(manifest.NSPrivacyTracking, false);
  assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);
  const collected = new Map(manifest.NSPrivacyCollectedDataTypes.map((d) => [d.NSPrivacyCollectedDataType, d]));
  // What the privacy page's table lists, in Apple's words.
  for (const type of ['EmailAddress', 'UserID', 'OtherUserContent', 'BrowsingHistory', 'ProductInteraction']) {
    const entry = collected.get(`NSPrivacyCollectedDataType${type}`);
    assert.ok(entry, `${type} is collected and not declared`);
    assert.equal(entry.NSPrivacyCollectedDataTypeLinked, true);
  }
  // Expo's update check carries a random installation id, tied to no account.
  assert.equal(collected.get('NSPrivacyCollectedDataTypeDeviceID')?.NSPrivacyCollectedDataTypeLinked, false);
  for (const d of collected.values()) {
    assert.equal(d.NSPrivacyCollectedDataTypeTracking, false);
    assert.deepEqual(d.NSPrivacyCollectedDataTypePurposes, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']);
  }
  // The "required reason" APIs React Native and the Expo modules in the build use.
  const apis = new Map(manifest.NSPrivacyAccessedAPITypes.map((a) => [a.NSPrivacyAccessedAPIType, a.NSPrivacyAccessedAPITypeReasons]));
  assert.deepEqual(apis.get('NSPrivacyAccessedAPICategoryUserDefaults'), ['CA92.1']);
  assert.deepEqual(apis.get('NSPrivacyAccessedAPICategoryFileTimestamp'), ['C617.1']);
  assert.deepEqual(apis.get('NSPrivacyAccessedAPICategorySystemBootTime'), ['35F9.1']);
  assert.deepEqual(apis.get('NSPrivacyAccessedAPICategoryDiskSpace'), ['E174.1']);
});
