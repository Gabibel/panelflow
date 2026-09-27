// "My sites" in the web app.
//
// This page used to list every domain the rules file names — about a hundred
// and seventy scan and streaming hosts — with the reader's own on top. The
// phone's in-app browser and the extension's options both lead here, which made
// it the directory the store builds had just had taken out of them (QA re-test,
// September 2026). It now shows the reader's own sites: the starred ones, then
// the ones the library comes from, with how many series each holds.
//
// Three things are checked here. That the view exists and is wired into the
// switcher like the other six, because a view nothing can reach is dead code.
// That the list is the reader's — starred first in their order, then the
// library's sites by weight — and never the rules file. And that the star
// writes the key the other surfaces read, since two surfaces disagreeing about
// the name of a setting is exactly the bug this feature would produce.
//
// The behaviour is lifted out of the shipping web/app.js with `new Function`,
// the way web-settings.test.js does it, so a test cannot pass against a page
// that does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const src = read('web', 'app.js');
const html = read('web', 'index.html');

const SITES = (() => {
  const a = src.indexOf('/* ---------- Sites ---------- */');
  const b = src.indexOf('/* ---------- Settings ---------- */', a);
  assert.ok(a !== -1 && b > a, 'web/app.js no longer keeps its sites block where this test looks');
  return src.slice(a, b);
})();

// --- the view is reachable ----------------------------------------------------

test('the tab, the panel and the switcher all know about it', () => {
  assert.match(src, /const VIEWS = \[[^\]]*'sites'/, 'the switcher has never heard of it');
  assert.match(src, /activeView === 'sites'\) loadSites\(\)/, 'opening the tab loads nothing');
  assert.match(html, /data-view="sites"/, 'there is no tab to click');
  // showView() shows and hides by `${view}-view`, so the panel's id is not a
  // naming preference — a panel named anything else never hides again.
  assert.match(html, /id="sites-view"/, 'there is no panel to show');
  // Switching language repaints the open view. This one is drawn from strings:
  // the counts and the star's tooltip.
  assert.match(src, /activeView === 'sites'\) renderSites\(\)/,
    'switching language leaves this view in the old one');
  // The tab can be opened while the library is still on its way; the library
  // arriving redraws it.
  const refresh = src.slice(src.indexOf('async function refresh()'), src.indexOf('/**', src.indexOf('async function refresh()')));
  assert.match(refresh, /activeView === 'sites'\) \{ countSites\(\); renderSites\(\); \}/);
});

// --- the page, stubbed ---------------------------------------------------------

/** One element, with the handful of DOM the sites block actually touches. */
function element() {
  const el = {
    hidden: false, textContent: '', className: '', title: '',
    href: '', target: '', rel: '', type: '',
    dataset: {}, attrs: {}, children: [], handlers: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
  };
  // `innerHTML = ''` is how the renderer empties a list, and a stub that lets
  // that be a no-op would hide every duplicate this file is here to catch.
  Object.defineProperty(el, 'innerHTML', { get: () => '', set() { el.children.length = 0; } });
  return el;
}

/** A library entry, as the server hands it back. */
const entry = (sourceDomain, sourceUrl = `https://${sourceDomain}/series/x`) => ({ sourceDomain, sourceUrl });

const LIBRARY = [
  entry('mangadex.org'), entry('mangadex.org'), entry('mangadex.org'),
  entry('www.webtoons.com'), entry('webtoons.com'),
  entry('bato.to'),
];

/** The sites block over that stub. */
function build({ token = 'a-token', library = LIBRARY, prefs, fail = false, failSave = false } = {}) {
  const els = {};
  const $ = (id) => (els[id] ??= element());
  // As index.html ships them: both notes start hidden.
  $('sites-note').hidden = true;
  $('sites-empty').hidden = true;

  const puts = [];
  const gets = [];
  const statuses = [];
  const api = async (path, options) => {
    if (options) {
      puts.push(options.body.prefs);
      if (failSave) throw new Error('offline');
      return { prefs: options.body.prefs };
    }
    gets.push(path);
    if (fail) throw new Error('offline');
    return { prefs: prefs ?? {} };
  };

  const shelf = { library };
  const fn = new Function('$', 'document', 'api', 'token', 't', 'setStatus', 'shelf',
    `let library = shelf.library;\n${SITES}\nreturn { loadSites, renderSites, siteCard, toggleSiteFavourite, countSites,
      setLibrary: (l) => { library = l; } };`);
  const page = fn($, { createElement: () => element() }, api, token, t,
    (message) => statuses.push(message), shelf);
  return { els, puts, gets, statuses, ...page };
}

const hostsOf = (el) => el.children.map((card) => card.dataset.host);
/** The count drawn under a host's name, or undefined. */
const countOf = (el, host) => el.children.find((c) => c.dataset.host === host)
  ?.children[0].children.find((k) => k.className === 'site-count')?.textContent;

// --- what it draws -------------------------------------------------------------

test('the sites the library comes from, most of it first', async () => {
  const page = build();
  await page.loadSites();
  // www. and the bare domain are one site; ties go by name.
  assert.deepEqual(hostsOf(page.els['sites-all']), ['mangadex.org', 'webtoons.com', 'bato.to']);
  assert.equal(countOf(page.els['sites-all'], 'mangadex.org'), t('mobileSeriesMany', ['3']));
  assert.equal(countOf(page.els['sites-all'], 'webtoons.com'), t('mobileSeriesMany', ['2']));
  assert.equal(countOf(page.els['sites-all'], 'bato.to'), t('mobileSeriesOne'));
});

test('the rules file is not a list of places to go', async () => {
  // The directory the store builds lost: the page asks for the account's
  // stars and nothing else, and a site the reader never read on is not drawn.
  const page = build();
  await page.loadSites();
  assert.deepEqual(page.gets, ['/prefs']);
  assert.doesNotMatch(SITES, /api\('\/rules'\)/);
});

test('the sites the reader starred come first, in their order', async () => {
  const page = build({ prefs: { favouriteSites: ['bato.to', 'mangadex.org'] } });
  await page.loadSites();
  // Their own order, not the library's weight: re-sorting it would be this
  // page having an opinion about somebody else's reading.
  assert.deepEqual(hostsOf(page.els['sites-yours']), ['bato.to', 'mangadex.org']);
  assert.deepEqual(hostsOf(page.els['sites-all']), ['webtoons.com']);
  assert.equal(page.els['sites-yours-head'].hidden, false);
  assert.equal(page.els['sites-all-head'].hidden, false);
  assert.equal(countOf(page.els['sites-yours'], 'mangadex.org'), t('mobileSeriesMany', ['3']));
});

test('a star written as a pattern or with www. is the same site', async () => {
  const page = build({ prefs: { favouriteSites: ['*.mangadex.org', 'www.bato.to'] } });
  await page.loadSites();
  assert.deepEqual(hostsOf(page.els['sites-yours']), ['mangadex.org', 'bato.to']);
  assert.deepEqual(hostsOf(page.els['sites-all']), ['webtoons.com']);
});

test('an account that has starred nothing gets one list and no headings', async () => {
  const page = build();
  await page.loadSites();
  assert.equal(page.els['sites-yours'].children.length, 0);
  assert.equal(page.els['sites-yours-head'].hidden, true);
  // A heading over the only list on the page is a label for nothing.
  assert.equal(page.els['sites-all-head'].hidden, true);
  assert.equal(page.els['sites-empty'].hidden, true);
});

test('a starred site the library no longer uses is still starred', async () => {
  // A site somebody told us they read does not stop being one because the last
  // series they had there was removed.
  const page = build({ prefs: { favouriteSites: ['gone.example'] } });
  await page.loadSites();
  assert.deepEqual(hostsOf(page.els['sites-yours']), ['gone.example']);
  assert.equal(countOf(page.els['sites-yours'], 'gone.example'), undefined, 'no "0 series"');
});

test('the list is redrawn, not appended to', async () => {
  const page = build();
  await page.loadSites();
  await page.loadSites();
  assert.equal(page.els['sites-all'].children.length, 3);
});

test('a site opens in a tab of its own, told nothing about this one', async () => {
  const page = build();
  await page.loadSites();
  const [link] = page.els['sites-all'].children[0].children;
  assert.equal(link.href, 'https://mangadex.org/');
  assert.equal(link.target, '_blank');
  // These are other people's sites: no window.opener back to the account page,
  // and no referrer telling them where the reader came from.
  assert.equal(link.rel, 'noopener noreferrer');
});

// --- an empty shelf, a late library, a missing answer ------------------------------

test('nothing yet says how a site gets here, and goes once the library arrives', async () => {
  const page = build({ library: [] });
  await page.loadSites();
  assert.equal(page.els['sites-empty'].hidden, false);
  assert.equal(page.els['sites-all'].children.length, 0);
  // Its words are the markup's own, translated with the rest of the page.
  assert.match(html, /id="sites-empty"[^>]*data-i18n="webMySitesEmpty"/);

  // What refresh() does when the library lands with this tab open.
  page.setLibrary(LIBRARY);
  page.countSites();
  page.renderSites();
  assert.equal(page.els['sites-empty'].hidden, true);
  assert.equal(page.els['sites-all'].children.length, 3);
});

test('stars that cannot be read are said, and the library\'s sites stay', async () => {
  const page = build({ fail: true });
  await page.loadSites();
  assert.equal(page.els['sites-note'].hidden, false);
  assert.equal(page.els['sites-note'].textContent, t('webSitesUnavailable'));
  assert.notEqual(page.els['sites-note'].textContent, 'webSitesUnavailable');
  assert.deepEqual(hostsOf(page.els['sites-all']), ['mangadex.org', 'webtoons.com', 'bato.to']);
  assert.equal(page.els['sites-empty'].hidden, true);
});

// --- the star ------------------------------------------------------------------

test('starring a site puts it at the top and on the account', async () => {
  const page = build();
  await page.loadSites();
  const card = page.els['sites-all'].children.find((c) => c.dataset.host === 'bato.to');
  const star = card.children[1];
  assert.equal(star.attrs['aria-pressed'], 'false');

  await star.handlers.click();
  assert.deepEqual(hostsOf(page.els['sites-yours']), ['bato.to']);
  assert.equal(hostsOf(page.els['sites-all']).includes('bato.to'), false);
  // The same key the popup and the phone read, which is the whole point of
  // putting it on the account: several surfaces, one answer.
  assert.deepEqual(page.puts, [{ favouriteSites: ['bato.to'] }]);
  assert.match(read('shared', 'prefs.js'), /favouriteSites: \{ hosts: true/);
});

test('un-starring takes it back off', async () => {
  const page = build({ prefs: { favouriteSites: ['mangadex.org'] } });
  await page.loadSites();
  const star = page.els['sites-yours'].children[0].children[1];
  assert.equal(star.attrs['aria-pressed'], 'true');

  await star.handlers.click();
  assert.equal(page.els['sites-yours'].children.length, 0);
  // Back among the library's sites, where it came from.
  assert.equal(hostsOf(page.els['sites-all'])[0], 'mangadex.org');
  assert.deepEqual(page.puts, [{ favouriteSites: [] }]);
});

test('a star the server would not take is drawn anyway, and said out loud', async () => {
  // Drawn first and saved after, like every other control on this page: a
  // failed PUT is something to retry, not a reason to snap a star back out
  // from under somebody's finger. But it is not silence either.
  const page = build({ failSave: true });
  await page.loadSites();
  await page.els['sites-all'].children[0].children[1].handlers.click();

  assert.deepEqual(hostsOf(page.els['sites-yours']), ['mangadex.org']);
  assert.deepEqual(page.statuses, [t('webSavedHereOnly')]);
});

test('signed out there is no star, because there is nowhere to put the answer', async () => {
  const page = build({ token: '' });
  await page.loadSites();
  assert.deepEqual(page.gets, [], 'no account to ask');
  assert.equal(page.els['sites-all'].children.length, 3);
  for (const card of page.els['sites-all'].children) {
    assert.equal(card.children.length, 1, 'a star that forgets by morning is worse than no star');
  }
});
