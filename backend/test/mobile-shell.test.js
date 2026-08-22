// The phone apps cannot be compiled here — this repo lives on Windows, and one
// of the two toolchains needs a Mac regardless. So what can go wrong silently is
// not a type error, it is *drift*: a file renamed in `extension/content/`, a
// message renamed in `bridge.js`, an injected script added to Android and
// forgotten on iOS. Nothing fails at that moment. It fails on a device, weeks
// later, as a reader that does not open.
//
// These tests read the Kotlin, the Swift, the Gradle task and the shell script
// as text and check they still agree with each other and with the files they
// name. Reading source as text is a poor way to test behaviour and a good way to
// test that two hand-maintained lists are the same list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_PREFS } from '../src/prefs.js';
import { bootCore, json } from '../test-support/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const has = (...p) => existsSync(join(root, ...p));

const androidPageScripts = read('android/app/src/main/java/dev/panelflow/PageScripts.kt');
const iosPageScripts = read('ios/Sources/PageScripts.swift');
const gradle = read('android/app/build.gradle.kts');
const bundleSh = read('ios/Scripts/bundle-assets.sh');

/** The bare script names, in injection order, out of a Kotlin `listOf(...)`. */
function kotlinList(source, name) {
  const block = source.match(new RegExp(`${name} = listOf\\(([^)]*)\\)`, 's'));
  assert.ok(block, `${name} not found in PageScripts.kt`);
  return [...block[1].matchAll(/"inject\/([^"]+)"/g)].map((m) => m[1].replace(/\.js$/, ''));
}

/** The same, out of a Swift array literal. */
function swiftList(source, name) {
  const block = source.match(new RegExp(`${name} = \\[([^\\]]*)\\]`, 's'));
  assert.ok(block, `${name} not found in PageScripts.swift`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test('both shells inject the same scripts in the same order', () => {
  // Order is not cosmetic. popup-guard.js has to land before the page can open
  // its first popunder, and chrome-shim.js before anything tries to call
  // chrome.runtime. A platform that reorders these is a platform where the
  // reader works slightly worse and nobody can say why.
  assert.deepEqual(kotlinList(androidPageScripts, 'EARLY'), swiftList(iosPageScripts, 'early'));
  assert.deepEqual(kotlinList(androidPageScripts, 'LATE'), swiftList(iosPageScripts, 'late'));
});

test('every injected script is a file that exists', () => {
  const names = [
    ...kotlinList(androidPageScripts, 'EARLY'),
    ...kotlinList(androidPageScripts, 'LATE'),
  ];
  // Where each one is copied *from* — the copy itself is the build's job, so
  // this checks the source, which is what a rename would break.
  const sources = {
    'report-failure': 'mobile/inject/report-failure.js',
    'popup-guard': 'extension/content/popup-guard.js',
    'chrome-shim': 'mobile/inject/chrome-shim.js',
    'series-match': 'shared/series-match.js',
    'site-rules': 'shared/site-rules.js',
    detect: 'extension/content/detect.js',
    'library-modal': 'extension/content/library-modal.js',
    reader: 'extension/content/reader.js',
  };
  for (const name of names) {
    assert.ok(sources[name], `${name} is injected but this test does not know where it comes from`);
    assert.ok(has(sources[name]), `${sources[name]} is injected but does not exist`);
  }
  assert.ok(has('extension/content/reader.css'), 'reader.css is injected as a style');
});

test('both build steps copy every file the shells then ask for', () => {
  // The two are hand-written in different languages against the same repo, so
  // the interesting failure is one of them being edited and the other not.
  const copied = [
    'mobile/www',
    'mobile/inject',
    'shared/series-match.js',
    'extension/content',
    'popup-guard.js',
    'detect.js',
    'library-modal.js',
    'reader.js',
    'reader.css',
    'extension/rules/adblock.json',
    'shared/detection-rules.json',
  ];
  for (const item of copied) {
    assert.ok(gradle.includes(item), `bundleWebAssets does not copy ${item}`);
    assert.ok(bundleSh.includes(item), `bundle-assets.sh does not copy ${item}`);
  }
});

test('the injected scripts are copied verbatim, never forked', () => {
  // A `mobile/inject/detect.js` would compile, run, and quietly become a second
  // reader that drifts from the browser's. chrome-shim.js is the one file that
  // is allowed to be mobile-specific.
  const forked = ['detect.js', 'reader.js', 'library-modal.js', 'popup-guard.js', 'series-match.js'];
  for (const name of forked) {
    assert.ok(!has('mobile/inject', name),
      `mobile/inject/${name} exists — the phone must inject extension/content/${name} itself`);
  }
});

test('the page bridge names the same globals on both sides', () => {
  const bridge = read('mobile/www/bridge.js');
  const shim = read('mobile/inject/chrome-shim.js');
  const worker = read('mobile/www/worker.js');

  // JS declares these; native evaluates them by name. A rename on either side
  // is a silent no-op at runtime — evaluateJavaScript on a missing global
  // throws into a callback nobody reads.
  assert.match(bridge, /window\.PanelFlowBridge = \{/);
  assert.match(shim, /window\.PanelFlowPage = \{/);
  assert.match(worker, /window\.PanelFlowWorker = \{/);

  for (const source of [
    read('android/app/src/main/java/dev/panelflow/WorkerHost.kt'),
    read('ios/Sources/WorkerHost.swift'),
  ]) {
    assert.match(source, /window\.PanelFlowWorker\.handle\(/);
    assert.match(source, /window\.PanelFlowWorker\.boot\(\)/);
    assert.match(source, /window\.PanelFlowPage && window\.PanelFlowPage\.dispatch\(/);
  }

  for (const shell of [
    read('android/app/src/main/java/dev/panelflow/MainActivity.kt'),
    read('ios/Sources/ShellViewController.swift'),
  ]) {
    assert.match(shell, /window\.PanelFlowBridge\.deliver\(/);
    assert.match(shell, /window\.PanelFlowBridge\.emit\(/);
  }
});

test('each platform installs the transport bridge.js looks for', () => {
  const bridge = read('mobile/www/bridge.js');
  assert.match(bridge, /window\.PanelFlowNative && window\.PanelFlowNative\.post/);
  assert.match(bridge, /window\.webkit\?\.messageHandlers\?\.panelflow/);

  // Android's interface name and iOS's handler name are what those two lines
  // resolve to. They are strings on both sides, checked by nothing else.
  assert.match(read('android/app/src/main/java/dev/panelflow/WorkerHost.kt'),
    /addJavascriptInterface\(NativeBridge\(WorkerClient\), "PanelFlowNative"\)/);
  assert.match(read('ios/Sources/WorkerHost.swift'),
    /controller\.add\(MessageProxy\(client: WorkerReplyClient\(\)\), name: "panelflow"\)/);
});

test('the shells load the two documents the web layer actually ships', () => {
  assert.ok(has('mobile/www/index.html'));
  assert.ok(has('mobile/www/worker.html'));
  assert.match(read('android/app/src/main/java/dev/panelflow/AssetHost.kt'),
    /assets\/www\/index\.html/);
  assert.match(read('android/app/src/main/java/dev/panelflow/AssetHost.kt'),
    /assets\/www\/worker\.html\?backend=/);
  assert.match(read('ios/Sources/ShellViewController.swift'),
    /forResource: "index", withExtension: "html",\s*subdirectory: "www"/);
  assert.match(read('ios/Sources/WorkerHost.swift'),
    /forResource: "worker", withExtension: "html",\s*subdirectory: "www"/);
});

test('the backend url reaches the worker the same way on both platforms', () => {
  // worker.js reads it off its own URL, so anything that stops appending the
  // query gives every user the production backend and no way to tell.
  assert.match(read('mobile/www/worker.js'),
    /new URLSearchParams\(location\.search\)\.get\('backend'\)/);
  assert.match(read('android/app/src/main/java/dev/panelflow/AssetHost.kt'), /\?backend=/);
  assert.match(read('ios/Sources/WorkerHost.swift'), /URLQueryItem\(name: "backend"/);
});

test('the background chapter check exists on both platforms and calls the core', () => {
  // Not "does it run" — that needs a device. Only that both still send the one
  // message the core answers, spelled the same way.
  assert.match(read('android/app/src/main/java/dev/panelflow/ChapterCheckWorker.kt'),
    /"type", "checkNow"/);
  assert.match(read('ios/Sources/ChapterCheck.swift'), /"type":"checkNow"/);
});

test('the iOS background task identifier is declared to the system', () => {
  // BGTaskScheduler.register throws at launch if the identifier is not in
  // BGTaskSchedulerPermittedIdentifiers — a crash on every cold start, from a
  // typo in a plist.
  const swift = read('ios/Sources/ChapterCheck.swift');
  const id = swift.match(/identifier = "([^"]+)"/)?.[1];
  assert.ok(id, 'ChapterCheck has no identifier');
  const project = read('ios/project.yml');
  assert.ok(project.includes('BGTaskSchedulerPermittedIdentifiers'));
  assert.ok(project.includes(`- ${id}`), `${id} is not in BGTaskSchedulerPermittedIdentifiers`);
});

// --- the two settings native has to act on itself ---------------------------
//
// Most preferences reach the phones inside reader.js, which both shells inject
// verbatim: which way a chapter opens, where the tap zones are, whether the
// reader is dark. Nothing can drift there, because there is only one copy.
//
// These two are different. `checkIntervalMin` schedules WorkManager and
// BGTaskScheduler, `whitelist` is consulted by a request interceptor and
// compiled into a WKContentRuleList — all four in native code, none of which
// can wait on a bridge round-trip, and the background check runs in a process
// where there may be no worker at all. Native has to hold a copy, and holding a
// copy is how both of these came to be ignored: the shells hard-coded six hours
// while the options page went on offering five intervals, and the whitelist was
// read off the wrong level of the reply on Android and never read on iOS.

const kotlinSettings = read('android/app/src/main/java/dev/panelflow/AdBlockList.kt');
const kotlinWorker = read('android/app/src/main/java/dev/panelflow/ChapterCheckWorker.kt');
const kotlinApp = read('android/app/src/main/java/dev/panelflow/PanelFlowApp.kt');
const swiftSettings = read('ios/Sources/Settings.swift');
const swiftCheck = read('ios/Sources/ChapterCheck.swift');
const swiftBlocker = read('ios/Sources/ContentBlocker.swift');

test('neither phone hard-codes how often to look for new chapters', () => {
  // Six hours is the default, which is why this was invisible: the phones
  // agreed with the desktop for as long as nobody changed the answer.
  assert.doesNotMatch(kotlinWorker, /\(6, TimeUnit\.HOURS\)/,
    'Android is back to a fixed period');
  assert.match(kotlinWorker, /Settings\.checkIntervalMin,\s+TimeUnit\.MINUTES/,
    'Android no longer builds its period from the preference');

  assert.doesNotMatch(swiftCheck, /6 \* 60 \* 60/, 'iOS is back to a fixed delay');
  assert.match(swiftCheck, /Settings\.checkIntervalMin \* 60/,
    'iOS no longer builds its earliest-begin date from the preference');
});

test("the phones' default interval is the shared default, not a fourth opinion", () => {
  // The same argument as the backend URL in build.gradle.kts and project.yml:
  // neither language can read shared/prefs.js, so the copy is anchored here.
  const fallback = ACCOUNT_PREFS.checkIntervalMin.fallback;
  assert.equal(
    Number(kotlinSettings.match(/DEFAULT_CHECK_INTERVAL_MIN = (\d+)L/)?.[1]), fallback,
    'Settings.DEFAULT_CHECK_INTERVAL_MIN drifted from ACCOUNT_PREFS.checkIntervalMin');
  assert.equal(
    Number(swiftSettings.match(/defaultCheckIntervalMin = (\d+)/)?.[1]), fallback,
    'Settings.defaultCheckIntervalMin drifted from ACCOUNT_PREFS.checkIntervalMin');
  // And it has to be one of the answers the settings pages offer, or a phone
  // starts on a value no reader can see, choose, or change back to.
  assert.ok(ACCOUNT_PREFS.checkIntervalMin.of.includes(fallback));
});

test('a reader who shortens the interval is not made to wait out the old one', () => {
  // KEEP is right for a cold start — it is what stops a phone opened often from
  // resetting the countdown forever — and wrong for the one case it used to
  // cover unconditionally: the answer changing. WorkManager silently ignores a
  // re-enqueue under KEEP, so "every hour" would have meant nothing until the
  // app was reinstalled.
  assert.match(kotlinWorker,
    /if \(replace\) ExistingPeriodicWorkPolicy\.UPDATE else ExistingPeriodicWorkPolicy\.KEEP/,
    'Android picks one policy for both cases again');
  assert.match(kotlinApp, /replace = true/,
    'nothing on Android ever re-schedules with the new interval');
  // BGTaskScheduler has the same shape of problem: a second submit under an
  // identifier that already has a pending request is dropped.
  assert.match(swiftCheck, /cancel\(taskRequestWithIdentifier: identifier\)/,
    'iOS submits over a pending request instead of replacing it');
});

test('both phones ask the core for those settings, and read the level it answers at', () => {
  // Android needs `getSettings` too, for the backend URL; iOS takes that from
  // Info.plist. What both need is the account's answers.
  assert.match(kotlinApp, /"getSettings", "pullAccountPrefs"/);
  assert.match(swiftSettings, /"type":"pullAccountPrefs"/);

  // The bug this is written against: `Settings.apply` was handed the whole
  // reply envelope and read `whitelist` off the top of it, where the field is
  // not. Every lookup missed, and an empty whitelist is indistinguishable from
  // a reader who whitelisted nothing — so Android blocked on sites the reader
  // had exempted, quietly, for as long as the shell has existed.
  assert.match(kotlinSettings, /body\.optJSONObject\("prefs"\)/,
    'Android reads the account settings off the envelope again');
  assert.match(swiftSettings, /body\["prefs"\]/,
    'iOS reads the account settings off the envelope again');

  // And the two wrappers must not be merged: `getSettings` answers with this
  // device's checkIntervalMin, which is the core's default, so a merged read
  // lets whichever reply lands second decide.
  assert.doesNotMatch(kotlinSettings, /optJSONObject\("settings"\) \?: body/,
    'Android is back to reading both replies as one bag');
});

test('the hub answers those messages in the shape the shells parse', async () => {
  // The half of this that can actually be run here. The shells are text; the
  // replies they are written against are not.
  const { hub } = bootCore({
    storage: { authToken: 'token' },
    fetch: async () => json({ prefs: { whitelist: ['keep.test'], checkIntervalMin: 60 } }),
  });

  const prefs = await hub({ type: 'pullAccountPrefs' });
  assert.deepEqual(prefs.prefs.whitelist, ['keep.test'],
    'the whitelist does not come back under `prefs`');
  assert.equal(prefs.prefs.checkIntervalMin, 60);

  // Why the shells ask that question rather than the older one: `getSettings`
  // has a checkIntervalMin of its own, and it is the default whatever the
  // account says. Reading the interval from here is how a phone answers 360 to
  // a reader who chose 60.
  const settings = await hub({ type: 'getSettings' });
  assert.equal(settings.settings.checkIntervalMin, ACCOUNT_PREFS.checkIntervalMin.fallback);
  assert.equal('whitelist' in settings.settings, false);
});

test('iOS blocks with the whitelist compiled in, not around it', () => {
  // Safari has no `allowAllRequests`; the equivalent is a rule that cancels the
  // ones above it. Which means it has to be *below* them — an exemption placed
  // first cancels nothing and blocks the site the reader exempted.
  assert.match(swiftBlocker, /ignore-previous-rules/);
  assert.match(swiftBlocker, /if-domain/);
  // `if-domain` matches the top-level document, which is what the extension's
  // allowAllRequests on main_frame/sub_frame means: "on this site, stop
  // blocking", not "stop blocking this server".
  assert.doesNotMatch(swiftBlocker, /unless-domain/);
  // The leading `*` is WebKit's spelling of "and its subdomains".
  assert.match(swiftBlocker, /"\*\\\#\(escaped\)"/);

  // WKContentRuleListStore is a cache keyed by identifier. Compiling the new
  // list under the old name hands back the old list — the reader's change
  // applies on the next install and not before.
  assert.match(swiftBlocker, /forIdentifier: identifier/);
  assert.match(swiftBlocker, /panelflow-adblock-\\\(fingerprint\(whitelist\)\)/);
  assert.doesNotMatch(swiftBlocker, /forIdentifier: "panelflow-adblock"/,
    'the identifier is fixed again, so a changed whitelist recompiles to the old list');

  // Swift's hasher is seeded per process; a fingerprint built on it would
  // change the identifier on every launch and recompile the list every launch.
  assert.doesNotMatch(swiftBlocker, /hashValue/);

  assert.match(read('ios/Sources/AppDelegate.swift'),
    /compile\(whitelist: Settings\.whitelist\)/,
    'the app launches with an empty whitelist again');
});

test('both phones still consult the whitelist where they block', () => {
  assert.match(read('android/app/src/main/java/dev/panelflow/MangaWebViewClient.kt'),
    /whitelist\(\)/);
  assert.match(kotlinSettings, /adblockWhitelist/);
  assert.match(swiftBlocker, /whitelist/);
});

// The fallback backend URL used to be checked here, across the four shells
// that carry a copy. It moved to backend/test/backend-url.test.js, which anchors
// every copy in the repo to DEFAULTS in shared/panelflow-core.js rather than
// only checking the four against each other — two of the four have since been
// deleted in favour of reading the value.

test('every library folder has a status colour', () => {
  // The folders are declared in JavaScript and coloured in CSS, and an entry
  // whose folder has no rule gets a transparent bar — invisible, so the tile
  // just silently stops carrying the cue instead of looking wrong.
  //
  // The shell reads its folder list from shared/folders.js, so that is where
  // the ids to colour come from — and a shelf of the user's own is coloured as
  // the built-in folder it stands for, so it needs no rule of its own.
  const css = read('mobile/www/app.css');
  const block = read('shared/folders.js').match(/const BUILTIN = \[(.*?)\];/s);
  assert.ok(block, 'BUILTIN not found in shared/folders.js');
  const ids = [...block[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, 'expected the reading-status folders');
  for (const id of ids) {
    assert.ok(css.includes(`[data-status='${id}']`), `no status colour for the ${id} folder`);
  }
});

test('every client reads the five reading folders from shared/folders.js', () => {
  // The backend rejects a folder outside its list with a 400, so a client that
  // spells one differently does not degrade — it stops being able to file
  // anything into it. The web app spent its whole life doing that: it offered
  // "complete" where the column says "completed", and had no "dropped" at all.
  //
  // Every client used to carry its own copy of the list and this test compared
  // them. They now all read one file, so what is worth checking is that none of
  // them has quietly grown a second copy again.
  const block = read('shared/folders.js').match(/const BUILTIN = \[(.*?)\];/s);
  assert.ok(block, 'shared/folders.js BUILTIN not found');
  const ids = [...block[1].matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['reading', 'paused', 'plan', 'completed', 'dropped']);

  // Each of these names a folder somewhere, and the file it is expected to get
  // the names from. `folders.js` for the backend, `PanelFlowFolders` for the
  // three clients, which load it as a plain script and cannot import.
  const sources = {
    'web/app.js': 'PanelFlowFolders',
    'mobile/www/app.js': 'PanelFlowFolders',
    'extension/popup/popup.js': 'PanelFlowFolders',
    'backend/src/routes/library.js': "from './categories.js'",
    'backend/src/routes/watch.js': "from '../folders.js'",
    'backend/src/routes/export.js': "from '../folders.js'",
    'backend/src/routes/history.js': "from '../folders.js'",
  };
  // Three of the five ids mean nothing else in this codebase. 'reading' is also
  // a SQL default and 'completed' is also a *publication* status, so neither is
  // evidence of a second copy of the list.
  const telltale = ["'paused'", "'plan'", "'dropped'"];
  for (const [file, expected] of Object.entries(sources)) {
    const source = read(file);
    assert.ok(source.includes(expected), `${file} does not read folders from ${expected}`);
    for (const id of telltale) {
      assert.ok(!source.includes(id), `${file} names ${id} itself — folders.js is the list`);
    }
  }

  // And the pages that have to load it, since a client that reads
  // `PanelFlowFolders` from a page that never included the script is a blank
  // screen, not a wrong folder.
  const loads = {
    'web/index.html': 'shared/folders.js',
    'mobile/www/index.html': 'shared/folders.js',
    'mobile/www/worker.html': 'shared/folders.js',
    'extension/popup/popup.html': '../shared/folders.js',
    'extension/background.js': "'shared/folders.js'",
  };
  for (const [file, needle] of Object.entries(loads)) {
    assert.ok(read(file).includes(needle), `${file} does not load ${needle}`);
  }
});

test('the generated web layer is not committed', () => {
  // Both are build output. Committing them means the same JavaScript exists
  // twice with no script keeping the copies honest — the exact thing
  // scripts/sync-shared.mjs and its drift test exist to prevent elsewhere.
  const ignore = read('.gitignore');
  assert.ok(ignore.includes('ios/Generated/'));
  assert.ok(ignore.includes('android/app/build/'));
});
