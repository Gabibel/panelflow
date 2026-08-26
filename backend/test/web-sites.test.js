// The Sites tab in the web app.
//
// The extension has had a list of the domains PanelFlow knows since the
// beginning; this page never did, which made the website the one surface that
// could not answer "where do I read, then". It is also the only place the sites
// picked during the setup tour could ever show up on a computer that never ran
// the tour — the whole reason `favouriteSites` sits on the account rather than
// in the browser that asked.
//
// So three things are checked here. That the view exists and is wired into the
// switcher like the other six, because a view nothing can reach is dead code.
// That the order is the account's — chosen first, then the rest alphabetically,
// with a retired rule not costing anybody a site they said they read. And that
// the star writes the key the tour writes, since two surfaces disagreeing about
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
  // the two headings and the star's tooltip.
  assert.match(src, /activeView === 'sites'\) renderSites\(\)/,
    'switching language leaves this view in the old one');
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

/** The sites block over that stub. */
function build({ token = 'a-token', rules, prefs, fail = false, failSave = false } = {}) {
  const els = {};
  const $ = (id) => (els[id] ??= element());

  const puts = [];
  const statuses = [];
  const api = async (path, options) => {
    if (options) {
      puts.push(options.body.prefs);
      if (failSave) throw new Error('offline');
      return { prefs: options.body.prefs };
    }
    if (fail) throw new Error('offline');
    if (path === '/rules') return rules ?? { domains: {} };
    return { prefs: prefs ?? {} };
  };

  const fn = new Function('$', 'document', 'api', 'token', 't', 'setStatus',
    `${SITES}\nreturn { loadSites, renderSites, siteCard, toggleSiteFavourite };`);
  const page = fn($, { createElement: () => element() }, api, token, t,
    (message) => statuses.push(message));
  return { els, puts, statuses, ...page };
}

const hostsOf = (el) => el.children.map((card) => card.dataset.host);

const RULES = {
  domains: { '*.mangadex.org': {}, 'sushiscan.fr': {}, 'aaa.example': {}, '*.*': {} },
};

// --- what it draws -------------------------------------------------------------

test('the sites the reader chose come first, then the rest in order', async () => {
  const page = build({ rules: RULES, prefs: { favouriteSites: ['sushiscan.fr', 'mangadex.org'] } });
  await page.loadSites();

  // Their own order, not the alphabet: it is the order they picked them in
  // during the tour, and re-sorting it would be this page having an opinion
  // about somebody else's reading.
  assert.deepEqual(hostsOf(page.els['sites-yours']), ['sushiscan.fr', 'mangadex.org']);
  assert.deepEqual(hostsOf(page.els['sites-all']), ['aaa.example']);
  assert.equal(page.els['sites-yours-head'].hidden, false);
  assert.equal(page.els['sites-all-head'].hidden, false);
});

test('a pattern is not an address', async () => {
  // The rules are keyed by pattern: `*.mangadex.org` covers the site and its
  // subdomains, and `*.*` is not a place at all.
  const page = build({ rules: RULES });
  await page.loadSites();
  const hosts = hostsOf(page.els['sites-all']);
  assert.deepEqual(hosts, ['aaa.example', 'mangadex.org', 'sushiscan.fr']);
});

test('an account that has chosen nothing gets one list and no headings', async () => {
  const page = build({ rules: RULES });
  await page.loadSites();
  assert.equal(page.els['sites-yours'].children.length, 0);
  assert.equal(page.els['sites-yours-head'].hidden, true);
  // "All sites" over the only list on the page is a label for nothing.
  assert.equal(page.els['sites-all-head'].hidden, true);
});

test('a favourite whose tuned rule was retired is still a favourite', async () => {
  // The rules file is ours and changes without asking anybody. A site somebody
  // told us they read does not stop being one because we stopped shipping a
  // rule for it.
  const page = build({ rules: RULES, prefs: { favouriteSites: ['gone.example'] } });
  await page.loadSites();
  assert.deepEqual(hostsOf(page.els['sites-yours']), ['gone.example']);
});

test('the list is redrawn, not appended to', async () => {
  const page = build({ rules: RULES });
  await page.loadSites();
  await page.loadSites();
  assert.equal(page.els['sites-all'].children.length, 3);
});

test('a site opens in a tab of its own, told nothing about this one', async () => {
  const page = build({ rules: RULES });
  await page.loadSites();
  const [link] = page.els['sites-all'].children[0].children;
  assert.equal(link.href, 'https://aaa.example/');
  assert.equal(link.target, '_blank');
  // These are other people's sites: no window.opener back to the account page,
  // and no referrer telling them where the reader came from.
  assert.equal(link.rel, 'noopener noreferrer');
});

test('the list failing to load says so instead of showing an empty page', async () => {
  const page = build({ fail: true });
  await page.loadSites();
  assert.equal(page.els['sites-note'].hidden, false);
  // The point of the sentence is that nothing is broken: the extension finds
  // chapters by itself and this list is a convenience.
  assert.equal(page.els['sites-note'].textContent, t('webSitesUnavailable'));
  assert.notEqual(page.els['sites-note'].textContent, 'webSitesUnavailable');
  assert.equal(page.els['sites-all'].children.length, 0);
});

// --- the star ------------------------------------------------------------------

test('starring a site puts it at the top and on the account', async () => {
  const page = build({ rules: RULES });
  await page.loadSites();
  const card = page.els['sites-all'].children.find((c) => c.dataset.host === 'mangadex.org');
  const star = card.children[1];
  assert.equal(star.attrs['aria-pressed'], 'false');

  await star.handlers.click();
  assert.deepEqual(hostsOf(page.els['sites-yours']), ['mangadex.org']);
  assert.equal(hostsOf(page.els['sites-all']).includes('mangadex.org'), false);
  // The same key the setup tour writes, which is the whole point of putting it
  // on the account: two surfaces, one answer.
  assert.deepEqual(page.puts, [{ favouriteSites: ['mangadex.org'] }]);
  assert.match(read('shared', 'prefs.js'), /favouriteSites: \{ hosts: true/);
});

test('un-starring takes it back off', async () => {
  const page = build({ rules: RULES, prefs: { favouriteSites: ['mangadex.org'] } });
  await page.loadSites();
  const star = page.els['sites-yours'].children[0].children[1];
  assert.equal(star.attrs['aria-pressed'], 'true');

  await star.handlers.click();
  assert.equal(page.els['sites-yours'].children.length, 0);
  assert.deepEqual(page.puts, [{ favouriteSites: [] }]);
});

test('a star the server would not take is drawn anyway, and said out loud', async () => {
  // Drawn first and saved after, like every other control on this page: a
  // failed PUT is something to retry, not a reason to snap a star back out
  // from under somebody's finger. But it is not silence either.
  const page = build({ rules: RULES, failSave: true });
  await page.loadSites();
  await page.els['sites-all'].children[0].children[1].handlers.click();

  assert.deepEqual(hostsOf(page.els['sites-yours']), ['aaa.example']);
  assert.deepEqual(page.statuses, [t('webSavedHereOnly')]);
});

test('signed out there is no star, because there is nowhere to put the answer', async () => {
  const page = build({ rules: RULES, token: '' });
  await page.loadSites();
  assert.equal(page.els['sites-all'].children.length, 3);
  for (const card of page.els['sites-all'].children) {
    assert.equal(card.children.length, 1, 'a star that forgets by morning is worse than no star');
  }
});
