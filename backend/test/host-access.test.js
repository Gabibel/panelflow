// Where the extension is allowed to be.
//
// The manifest asked for `<all_urls>` and injected five content scripts into
// every page on the web: the bank, the mail, the intranet. Nothing about
// PanelFlow ever needed that — it reads scan sites, and it has a file naming
// them — but it is the line Chrome quotes back at the reader when they install
// the zip, and it was the one place PanelFlow asked for more than the app it is
// chasing.
//
// So the manifest names the sites, generated from shared/detection-rules.json
// by scripts/sync-shared.mjs, and `<all_urls>` moves to
// `optional_host_permissions` — which is asked for one origin at a time, by
// someone standing on that site, and never at install.
//
// Two things have to hold for that to be more than a smaller number in a
// dialog, and both are tested here:
//
//   - nothing quietly puts `<all_urls>` back, and
//   - a site the reader does grant actually gets the scripts, because Chrome
//     grants the permission and stops there. The worker registers them, and it
//     mirrors the manifest rather than keeping a second copy of the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostMatches } from '../../scripts/sync-shared.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const MANIFEST = JSON.parse(read('extension/manifest.json'));
const RULES = JSON.parse(read('shared/detection-rules.json'));

/** The relay on PanelFlow's own site is a fixed origin, not a scan site. */
const isRelay = (entry) => (entry.js || []).includes('content/site-bridge.js');
const injected = MANIFEST.content_scripts.filter((c) => !isRelay(c));

// --- what the install prompt says --------------------------------------------

test('nothing the extension asks for at install covers the whole web', () => {
  assert.ok(!(MANIFEST.host_permissions || []).includes('<all_urls>'),
    'host_permissions is back to <all_urls> — the install prompt says "all websites" again');
  for (const entry of MANIFEST.content_scripts) {
    assert.ok(!entry.matches.includes('<all_urls>'),
      `${entry.js.join(', ')} is injected everywhere`);
    // A pattern with no host is the same thing spelled differently, and it is
    // how this comes back without anyone typing the words.
    for (const m of entry.matches) {
      assert.ok(!/^\*:\/\/\*\/|^https?:\/\/\*\//.test(m), `${m} is <all_urls> in another spelling`);
    }
  }
});

test('the whole web is what the reader may add later, not what they start with', () => {
  assert.deepEqual(MANIFEST.optional_host_permissions, ['<all_urls>']);
  // Optional permissions are useless without the API that acts on them: Chrome
  // grants the origin and injects nothing.
  assert.ok(MANIFEST.permissions.includes('scripting'),
    'a granted site can be permitted and still have no scripts in it');
});

// --- and it is the rules file that decides ----------------------------------

test('every site the manifest names is one the rules file knows', () => {
  // Both lists, because there are two reasons to be in the manifest. `domains`
  // is where the reader works; `videoDomains` is where the speed control and the
  // ad blocking work, and an entry there is deliberately *not* under `domains` —
  // that would be worth knownDomain 100 and put a Reader Mode pill over a video.
  // Keys starting with `_` are notes to whoever edits the file, not hostnames.
  const named = [...Object.keys(RULES.domains), ...Object.keys(RULES.videoDomains || {})];
  const known = new Set(named.filter((d) => !d.startsWith('_'))
    .map((d) => d.replace(/^\*\./, '')));
  const listed = [...injected.flatMap((c) => c.matches), ...MANIFEST.host_permissions];
  for (const m of new Set(listed)) {
    const host = /^\*:\/\/\*\.([^/]+)\/\*$/.exec(m);
    assert.ok(host, `${m} is not a site pattern this test can read`);
    assert.ok(known.has(host[1]), `the manifest injects into ${host[1]}, which no rule mentions`);
  }
});

test('and every site the rules file knows is in the manifest', () => {
  // Generated, so this is drift and not a judgement call: a domain added to the
  // rules file and not to the manifest is a site PanelFlow claims to support
  // and silently does not run on.
  const want = hostMatches();
  assert.deepEqual(MANIFEST.host_permissions, want,
    'extension/manifest.json is stale — run `npm run sync:shared`');
  for (const entry of injected) {
    assert.deepEqual(entry.matches, want,
      `${entry.js.join(', ')} runs on a different set of sites than the rest`);
  }
  // The relay keeps its own two origins and is not swept into the list — see
  // site-bridge.test.js, which is what actually guards its shape.
  const relay = MANIFEST.content_scripts.find(isRelay);
  assert.ok(relay && !relay.matches.some((m) => want.includes(m)));
});

// --- the site the reader adds by hand ----------------------------------------
//
// Lifted out of the shipping worker: background.js is a service worker with no
// exports, and a copy of this logic in the test would be a copy that agrees
// with itself while the extension does something else.

const bg = read('extension/background.js');
const slice = (from, to) => {
  const a = bg.indexOf(from);
  const b = bg.indexOf(to);
  assert.ok(a !== -1 && b > a, `${from} is not where this test expects it`);
  return bg.slice(a, b);
};

const buildWorker = new Function('chrome', 'console',
  `${slice("const OPTIONAL_PREFIX = 'pf-site-';", '// A permission granted from the popup')}
   return { syncOptionalSites, extraOrigins, injections };`);

const GRANTED = 'https://scan-nobody-added.test/*';

const stub = ({ origins = [], registered = [] } = {}) => {
  const calls = { unregistered: [], registered: [], warned: [] };
  const chrome = {
    runtime: { getManifest: () => MANIFEST },
    permissions: { getAll: async () => ({ origins, permissions: [] }) },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      unregisterContentScripts: async (arg) => { calls.unregistered.push(arg); },
      registerContentScripts: async (arg) => { calls.registered.push(arg); },
    },
  };
  const api = buildWorker(chrome, { warn: (...a) => calls.warned.push(a) });
  return { ...api, calls };
};

test('the sites already in the manifest are not registered a second time', async () => {
  // permissions.getAll() reports everything granted, the manifest's own
  // included. Registering those again would double every content script on the
  // fifty sites that work out of the box.
  const w = stub({ origins: [...MANIFEST.host_permissions] });
  assert.deepEqual(await w.extraOrigins(), []);
  await w.syncOptionalSites();
  assert.deepEqual(w.calls.registered, []);
});

test('a granted site gets exactly what the manifest would have injected', async () => {
  const w = stub({ origins: [...MANIFEST.host_permissions, GRANTED] });
  await w.syncOptionalSites();

  assert.equal(w.calls.registered.length, 1);
  const [scripts] = w.calls.registered;
  assert.equal(scripts.length, injected.length,
    'the granted site gets a different number of scripts than a listed one');

  for (const [i, entry] of injected.entries()) {
    const got = scripts[i];
    // Mirrored, not copied: a file added to the manifest reaches granted sites
    // without anyone remembering the worker keeps a list too.
    assert.deepEqual(got.js, entry.js);
    assert.equal(got.runAt, entry.run_at);
    // The popup guard replaces window.open, which only exists in the page's own
    // world. Registered into the isolated world it would go on looking correct
    // and block nothing — the bug that already cost this file once.
    assert.equal(got.world, entry.world === 'MAIN' ? 'MAIN' : 'ISOLATED');
    if (entry.css) assert.deepEqual(got.css, entry.css);
    // The granted origin and nothing else: `matches` here is what the script
    // runs on, so the manifest's fifty must not be repeated into it.
    assert.deepEqual(got.matches, [GRANTED]);
    // The worker is killed seconds after this returns; without it the site
    // would work until the first idle timeout and never again.
    assert.equal(got.persistAcrossSessions, true);
    // And the manifest's own sites are cut back out, so that a wide grant
    // cannot end up layered on top of the static injection.
    assert.deepEqual(got.excludeMatches, MANIFEST.host_permissions);
  }
  // The relay is the extension's own door into the web app, on a fixed origin.
  // Mirroring it onto a scan site would put that door on the scan site.
  assert.ok(!scripts.some((s) => s.js.includes('content/site-bridge.js')));
});

test('a site taken back is a site the scripts stop running on', async () => {
  // Revoked from Chrome's own settings page, which the popup never sees: the
  // registration outlives the permission and has to be removed by hand.
  const before = stub({ origins: [...MANIFEST.host_permissions, GRANTED] });
  await before.syncOptionalSites();
  const registered = before.calls.registered[0];

  const after = stub({ origins: [...MANIFEST.host_permissions], registered });
  await after.syncOptionalSites();
  assert.deepEqual(after.calls.unregistered, [{ ids: registered.map((s) => s.id) }]);
  assert.deepEqual(after.calls.registered, [], 'the site came back');
});

test('it only ever unregisters its own scripts', async () => {
  const w = stub({
    origins: [...MANIFEST.host_permissions],
    registered: [{ id: 'someone-elses', js: ['x.js'] }, { id: 'pf-site-0', js: ['y.js'] }],
  });
  await w.syncOptionalSites();
  assert.deepEqual(w.calls.unregistered, [{ ids: ['pf-site-0'] }]);
});

test('a registration Chrome refuses costs the sites, not the worker', async () => {
  // Everything below this in background.js — the alarms, Alt+R, the message hub
  // — is still being evaluated when this runs, and a rejection here would take
  // the whole extension with it.
  const w = stub({ origins: [GRANTED] });
  w.calls.registered = null; // make the push throw
  await w.syncOptionalSites();
  assert.equal(w.calls.warned.length, 1, 'the failure passed in silence');
});

test('granting the whole web does not run the reader twice on a listed site', async () => {
  // The settings page offers `<all_urls>` in one click — for covers on
  // hotlink-protected image hosts, and for chapter downloads, both of which go
  // to domains no site list names. Chrome then reports that single origin and
  // drops the fifty it subsumes, so `matches` here covers every listed site as
  // well, and without excludeMatches each of them would get detect.js, the
  // reader and the modal a second time: two readers, each undoing the other.
  const w = stub({ origins: ['<all_urls>'] });
  await w.syncOptionalSites();

  const [scripts] = w.calls.registered;
  for (const got of scripts) {
    assert.deepEqual(got.matches, ['<all_urls>']);
    assert.deepEqual(got.excludeMatches, MANIFEST.host_permissions,
      'the listed sites are inside a registration that already runs there statically');
  }
});

// --- the two doors that are left ---------------------------------------------

test('the popup asks for one origin, and the worker is what registers it', () => {
  const popup = read('extension/popup/popup.js');
  assert.match(popup, /chrome\.permissions[\s\S]{0,80}\.request\(\{ origins: \[`\$\{state\.origin\}\/\*`\]/,
    'the popup no longer asks for the current origin, or asks for something wider');
  assert.ok(!/permissions[\s\S]{0,120}<all_urls>/.test(popup),
    'the popup asks for the whole web from a button');

  // Chrome sends the worker the permission event on its own, but it arrives
  // whenever it arrives; `syncSites` is what the popup can wait on. It names the
  // tab, because a registration only reaches the *next* page load and the reader
  // is standing on this one.
  assert.match(popup, /send\(\{ type: 'syncSites', tabId: state\.tab\.id \}\)/);
  assert.match(bg, /syncSites: async \(msg\) => \{/);
  assert.match(bg, /injectNow\(msg\.tabId\)/);
  // Which is also why nothing here reloads: the site has to start working where
  // the reader already is.
  assert.ok(!/chrome\.tabs\.reload/.test(popup.slice(popup.indexOf("act === 'grant'"))),
    'the grant button reloads the tab instead of injecting it');

  // And revocation happens somewhere the popup cannot see.
  assert.match(bg, /chrome\.permissions\.onRemoved\.addListener/);
  assert.match(bg, /chrome\.permissions\.onAdded\.addListener/);
  // A profile whose registrations were lost, or whose manifest just grew, is
  // reconciled without anyone opening the popup.
  assert.match(bg, /onStartup[\s\S]*?syncOptionalSites\(\)/);
});

test('the settings page is the only place the whole web can be asked for', () => {
  const options = read('extension/options/options.js');
  const html = read('extension/options/options.html');

  // The one control that exists for it, and it has to be reachable: a hint the
  // page never paints is a permission nobody can find a reason to grant.
  assert.match(html, /id="allSites"/);
  assert.match(html, /data-i18n="optionsAllSitesHint"/);
  for (const locale of ['en', 'fr']) {
    const msgs = JSON.parse(read(`extension/_locales/${locale}/messages.json`));
    for (const key of ['optionsSitesLegend', 'optionsAllSites', 'optionsAllSitesHint']) {
      assert.ok(msgs[key]?.message, `${key} is missing from ${locale}`);
    }
    // The hint is the only place the reader is told what saying yes buys them.
    assert.ok(msgs.optionsAllSitesHint.message.length > 120, `${locale} explains nothing`);
  }

  assert.match(options, /chrome\.permissions\.request\(ALL_SITES\)/);
  // Revocable from the same box. A permission that can only be granted here and
  // taken back from a Chrome settings page nobody opens is a one-way door.
  assert.match(options, /chrome\.permissions\.remove\(ALL_SITES\)/);
  // Same reason as the popup: Chrome grants, the worker injects.
  assert.match(options, /send\(\{ type: 'syncSites' \}\)/);
  // And the box says what is true, not what was clicked.
  assert.match(options, /chrome\.permissions\.contains\(ALL_SITES\)/);
});

test('the tab already open is injected, minus the one script that cannot be', () => {
  // popup-guard.js replaces window.open before the page's own scripts run. Put
  // into a page that has already loaded it would look installed and stop
  // nothing — so it is registered like the rest and starts at the next page
  // load, which is the first moment it could have mattered anyway.
  const start = MANIFEST.content_scripts.filter((c) => c.run_at === 'document_start');
  assert.ok(start.some((c) => c.js.includes('content/popup-guard.js')));
  assert.match(bg, /run_at \|\| 'document_idle'\) === 'document_start'\) continue;/);
  // And the stylesheet goes with the scripts, or the reader gets a reader with
  // no styling at all.
  assert.match(bg, /insertCSS\(\{ target: \{ tabId \}, files: c\.css \}\)/);
  // A tab that cannot be injected — closed, navigated away, a scheme Chrome
  // will not touch — is not worth taking the grant down with it.
  assert.match(bg, /executeScript\([\s\S]{0,120}\.catch\(/);
});

// --- the pages, which are almost never on the site's own domain --------------
//
// The cost of the list above, and the one nobody saw coming. Naming the sites
// covers the site: it does not cover gg.asuracomic.net, which is where
// asurascans keeps the pages, or meo.comick.pictures, which is where comick.io
// keeps them. Displaying a page needs no permission — an <img> is not a read —
// but taking its bytes back for a .cbz or for offline reading does, and a host
// outside the set is refused from both sides.
//
// Manga is where this bites: long-running titles are the ones kept on a
// separate image CDN, and webtoons are commonly served from the site itself.
// Which is exactly how it was reported — downloading worked on manhwa and did
// nothing at all on manga, with a warning glyph and no explanation.

const askAccess = (allowed) => {
  const asked = [];
  const chrome = {
    permissions: {
      contains: async ({ origins }) => {
        asked.push(...origins);
        return origins.every((o) => allowed.includes(o));
      },
    },
  };
  const { missingImageHosts } = new Function('chrome',
    `${slice('/**\n * The hosts among `urls` this extension is not allowed to fetch from.',
      "// --- cross-origin image fetch for the reader's CBZ download")}
     return { missingImageHosts };`)(chrome);
  return { missingImageHosts, asked };
};

test('the hosts the pages sit on are named, not the pages', async () => {
  const { missingImageHosts, asked } = askAccess(['https://scan.test/*']);
  const missing = await missingImageHosts([
    'https://gg.asuracomic.net/storage/media/1/conversions/01-optimized.webp',
    'https://gg.asuracomic.net/storage/media/1/conversions/02-optimized.webp',
    'https://scan.test/pages/03.jpg',
  ]);
  // One name for forty pages: the answer is about the host, and a reader given
  // a list of forty URLs has been told nothing they can act on.
  assert.deepEqual(missing, ['gg.asuracomic.net']);
  // And asked once per origin, not once per page.
  assert.deepEqual(asked, ['https://gg.asuracomic.net/*', 'https://scan.test/*']);
});

test('the reader\'s own bytes are nobody\'s to permit', async () => {
  // Half the pages the detector hands over are blob: URLs — images the page
  // already decoded, which the reader can read without asking anyone. Treating
  // them as a host to be granted would refuse every chapter on those sites.
  const { missingImageHosts, asked } = askAccess([]);
  assert.deepEqual(await missingImageHosts([
    'blob:https://scan.test/2b0f-4a11',
    'data:image/png;base64,iVBORw0KGgo=',
    'not a url at all',
  ]), []);
  assert.deepEqual(asked, []);
});

test('a permission check that cannot be made is not a refusal', async () => {
  // If Chrome will not answer, the fetch is still worth trying: it may well
  // work, and refusing it here would turn a question into a wall.
  const chrome = { permissions: { contains: async () => { throw new Error('no'); } } };
  const { missingImageHosts } = new Function('chrome',
    `${slice('/**\n * The hosts among `urls` this extension is not allowed to fetch from.',
      "// --- cross-origin image fetch for the reader's CBZ download")}
     return { missingImageHosts };`)(chrome);
  assert.deepEqual(await missingImageHosts(['https://cdn.test/1.jpg']), []);
});

test('the reader can be sent to the one page that can grant them', () => {
  // `chrome.permissions.request` needs a real click on an extension page, and a
  // content script is not one — so the reader cannot ask for the host itself.
  // The checkbox that grants it has been in the settings the whole time, which
  // is worth nothing to someone who has no idea it is what they need.
  assert.match(bg, /openOptions:[\s\S]{0,200}openOptionsPage\(\)/,
    'the worker can no longer open the page that grants the hosts');
  assert.match(read('extension/content/reader.js'), /type: 'openOptions'/,
    'the reader no longer offers a way to grant them');
  assert.match(read('extension/options/options.html'), /allSites/,
    'the settings page no longer has the checkbox the message points at');
});
