// Ad blocking that happens before a request leaves the phone.
//
// The QA campaign of October 2026 counted five to ten advertising requests per
// chapter page on Android and three to six on iOS, against none in the Chrome
// extension (NEW-11): react-native-webview has no hook for the requests a page
// makes, and native/inject/rn-adblock.js, working from inside the page, comes
// too late for what the page's own HTML asks for. PanelFlow now patches
// react-native-webview (native/patches/) so the WebView refuses the list
// itself. Nothing here can run the Java or the Objective-C; what this pins is
// that the pieces stay connected, which is how a fix like this one quietly
// stops working: a dependency bumped past the patch, a prop renamed, a list
// that stops being handed over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const pkg = JSON.parse(read('native', 'package.json'));
const webviewVersion = pkg.dependencies['react-native-webview'];
const patchName = `react-native-webview+${webviewVersion}.patch`;

test('the patch is applied on every install, for the version of the library the app uses', () => {
  assert.equal(pkg.scripts.postinstall, 'patch-package',
    'without the postinstall, an EAS build installs react-native-webview unpatched');
  assert.ok(pkg.devDependencies?.['patch-package'], 'patch-package is not installed');
  assert.match(webviewVersion, /^\d+\.\d+\.\d+$/,
    'react-native-webview must be pinned: patch-package refuses a patch made for another version');
  assert.ok(existsSync(join(root, 'native', 'patches', patchName)),
    `native/patches/${patchName} is missing: was react-native-webview upgraded without the patch?`);
});

test('Android: the client refuses listed hosts in shouldInterceptRequest', () => {
  const patch = read('native', 'patches', patchName);
  assert.match(patch, /\+\+\+ b\/node_modules\/react-native-webview\/android\/src\/main\/java\/com\/reactnativecommunity\/webview\/PanelFlowAdblock\.java/);
  assert.match(patch, /\+\s+public WebResourceResponse shouldInterceptRequest\(WebView view, WebResourceRequest request\) \{/);
  assert.match(patch, /\+\s+WebResourceResponse refused = PanelFlowAdblock\.refuse\(view, request\);/);
  // It reads the list from the prop the app sets, under the key the app uses.
  assert.match(patch, /injectedJavaScriptObject/);
  assert.match(patch, /optJSONObject\("panelflowAdblock"\)/);
  for (const key of ['hosts', 'imageHosts', 'whitelist']) {
    assert.match(patch, new RegExp(`optJSONArray\\("${key}"\\)`), `the Java side does not read "${key}"`);
  }
});

test('iOS: the web view gets a WKContentRuleList built from the same list', () => {
  const patch = read('native', 'patches', patchName);
  assert.match(patch, /\+\+\+ b\/node_modules\/react-native-webview\/apple\/RNCWebViewImpl\.m/);
  assert.match(patch, /\+- \(void\)panelflowInstallAdblock:\(WKUserContentController \*\)controller/);
  assert.match(patch, /\+\s+\[self panelflowInstallAdblock:wkWebViewConfig\.userContentController\];/,
    'the rules are not installed with a new configuration');
  assert.match(patch, /\+\s+\[self panelflowInstallAdblock:_webView\.configuration\.userContentController\];/,
    'a new list (a whitelist change) is not installed');
  assert.match(patch, /compileContentRuleListForIdentifier:identifier/);
  assert.match(patch, /@"panelflowAdblock"/);
  // Only resource types WebKit has accepted since iOS 11: an unknown type
  // makes the whole list fail to compile, which blocks nothing.
  const types = /notImages = @\[([^\]]*)\]/.exec(patch)?.[1] ?? '';
  for (const t of types.match(/@"([^"]+)"/g) || []) {
    assert.ok(['@"document"', '@"script"', '@"style-sheet"', '@"font"', '@"raw"', '@"svg-document"',
      '@"media"', '@"popup"'].includes(t), `${t} is not a type every supported iOS knows`);
  }
});

test('the app hands the WebView the list, the image list and the whitelist', () => {
  const screen = read('native', 'src', 'screens', 'BrowserScreen.js');
  assert.match(screen, /import \{ blockedHosts, blockedImageHosts, early, late \} from '\.\.\/\.\.\/generated\/injected\.js';/);
  assert.match(screen, /injectedJavaScriptObject=\{nativeAdblock\}/);
  assert.match(screen, /panelflowAdblock: \{\s*hosts: blockedHosts,\s*imageHosts: blockedImageHosts,\s*whitelist:/);
  // Memoised on the whitelist's contents: iOS recompiles on every change.
  assert.match(screen, /useMemo\(\(\) => \(\{\s*panelflowAdblock/);
});

test('the image list handed over is the shared list\'s `images: true` entries, exactly', async () => {
  const injected = await import(pathToFileURL(join(root, 'native', 'generated', 'injected.js')).href);
  const list = JSON.parse(read('shared', 'adblock-list.json'));
  const all = Object.values(list.groups).flatMap((g) => g.hosts);
  const withImages = Object.values(list.groups).filter((g) => g.images).flatMap((g) => g.hosts);
  assert.deepEqual([...injected.blockedHosts].sort(), [...all].sort());
  assert.deepEqual([...injected.blockedImageHosts].sort(), [...withImages].sort());
});

test('NEW-13: the popup guard runs in the player frames too, not only in the page', () => {
  const manifest = JSON.parse(read('extension', 'manifest.json'));
  const guard = manifest.content_scripts.find((cs) => cs.js.includes('content/popup-guard.js'));
  assert.equal(guard.all_frames, true, 'a tap inside an anime player frame opened an ad tab');
  assert.equal(guard.match_about_blank, true, 'and the blank frames ad scripts build by hand');
  assert.equal(guard.world, 'MAIN');
  assert.equal(guard.run_at, 'document_start');
});

test('GAP-1: the ad hosts seen getting through on real sites are on the list', () => {
  const list = JSON.parse(read('shared', 'adblock-list.json'));
  const all = new Set(Object.values(list.groups).flatMap((g) => g.hosts));
  for (const host of ['pubadx.one', 'onclckbn.net', 'onclcktg.com', 'onclckmetrics.com', 'onclckinp.com',
    'creativecdn.com', 'impact-ad.jp', 'socdm.com', 'genieesspv.jp', 'adingo.jp']) {
    assert.ok(all.has(host), `${host} is not blocked`);
  }
});
