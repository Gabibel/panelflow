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
    'popup-guard': 'extension/content/popup-guard.js',
    'chrome-shim': 'mobile/inject/chrome-shim.js',
    'series-match': 'shared/series-match.js',
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

test('the fallback backend url is the same one in all four places', () => {
  // Three build systems and a JavaScript file each carry their own copy of the
  // default, because each is read at a different moment: Gradle at compile time,
  // the plist at launch, NativeMessages when the plist is missing, worker.js
  // when nothing was passed on the query string. Four copies, no shared
  // constant — a rename of the Vercel project silently leaves some clients
  // pointed at a host that answers, but is not ours.
  const sources = {
    'mobile/www/worker.js': read('mobile/www/worker.js'),
    'ios/project.yml': read('ios/project.yml'),
    'ios/Sources/NativeMessages.swift': read('ios/Sources/NativeMessages.swift'),
    'android/app/build.gradle.kts': gradle,
  };
  const urls = new Map();
  for (const [file, source] of Object.entries(sources)) {
    const found = [...source.matchAll(/https:\/\/[a-z0-9-]+\.vercel\.app/g)].map((m) => m[0]);
    assert.equal(found.length, 1, `${file} should name exactly one vercel.app fallback, found ${found.length}`);
    urls.set(file, found[0]);
  }
  const distinct = new Set(urls.values());
  assert.equal(distinct.size, 1,
    `the shells disagree on the backend: ${[...urls].map(([f, u]) => `${f} -> ${u}`).join(', ')}`);
});

test('every library folder has a status colour', () => {
  // The folders are declared in JavaScript and coloured in CSS, and an entry
  // whose folder has no rule gets a transparent bar — invisible, so the tile
  // just silently stops carrying the cue instead of looking wrong.
  const js = read('mobile/www/app.js');
  const css = read('mobile/www/app.css');
  const block = js.match(/const FOLDERS = \[(.*?)\];/s);
  assert.ok(block, 'FOLDERS not found in app.js');
  const ids = [...block[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]).filter((id) => id !== 'all');
  assert.ok(ids.length >= 5, 'expected the reading-status folders');
  for (const id of ids) {
    assert.ok(css.includes(`[data-status='${id}']`), `no status colour for the ${id} folder`);
  }
});

test('every client names the same five reading folders', () => {
  // The backend rejects a folder outside its list with a 400, so a client that
  // spells one differently does not degrade — it stops being able to file
  // anything into it. The web app spent its whole life doing that: it offered
  // "complete" where the column says "completed", and had no "dropped" at all.
  const list = (source, re, what) => {
    const block = source.match(re);
    assert.ok(block, `${what} not found`);
    return new Set([...block[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
  };

  const backend = list(
    read('backend/src/routes/library.js'), /const FOLDERS = \[(.*?)\];/s, 'backend FOLDERS');
  const web = list(
    read('web/app.js'), /const STATUSES = \[(.*?)\];/s, 'web STATUSES');
  const mobileBlock = read('mobile/www/app.js').match(/const FOLDERS = \[(.*?)\];/s);
  assert.ok(mobileBlock, 'mobile FOLDERS not found');
  const mobile = new Set(
    [...mobileBlock[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]).filter((id) => id !== 'all'));

  assert.equal(backend.size, 5);
  assert.deepEqual(web, backend, 'web/app.js disagrees with the backend');
  assert.deepEqual(mobile, backend, 'mobile/www/app.js disagrees with the backend');

  // And the markup the web app reads its two folder controls from, which is
  // hand-written next to the list rather than generated from it.
  const html = read('web/index.html');
  const tabs = new Set([...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]));
  tabs.delete('all');
  assert.deepEqual(tabs, backend, 'the web tab row disagrees with the backend');
  const select = html.match(/<select id="f-status">(.*?)<\/select>/s);
  assert.ok(select, 'the add-series status select is gone');
  const options = new Set([...select[1].matchAll(/value="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(options, backend, 'the add-series status select disagrees with the backend');
});

test('the generated web layer is not committed', () => {
  // Both are build output. Committing them means the same JavaScript exists
  // twice with no script keeping the copies honest — the exact thing
  // scripts/sync-shared.mjs and its drift test exist to prevent elsewhere.
  const ignore = read('.gitignore');
  assert.ok(ignore.includes('ios/Generated/'));
  assert.ok(ignore.includes('android/app/build/'));
});
