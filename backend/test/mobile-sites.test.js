// The way into the phone's in-app browser.
//
// The browser itself has existed on both shells for a while: BrowserActivity on
// Android, BrowserViewController on iOS, both injecting the extension's own
// content scripts so a scan site becomes readable. What it never had was a
// door. `openUrl` was reachable from a library cover and from a search result,
// and from nothing else — so a fresh install, whose shelf is empty and who has
// no URL to hand, could not reach a scan site from inside the app at all. The
// only ways in were a link shared from another app, or a notification.
//
// That is what this tab is. It also spends `favouriteSites`, which
// shared/prefs.js has always described as being for "the phone they were never
// chosen on" — the tour writes it, the popup and the website read it, and until
// now the phone did neither.
//
// Same lifting trick as welcome.test.js: the shell is one browser IIFE with no
// exports, so the slice under test is pulled out of the shipping source and run
// here, and a test cannot pass against a rule that only exists in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const js = read('mobile/www/app.js');
const html = read('mobile/www/index.html');

/** One slice of app.js, run as written, with its free names passed in. */
const lift = (startMark, endMark, params, exported) => {
  const from = js.indexOf(startMark);
  const to = js.indexOf(endMark);
  assert.ok(from !== -1 && to > from, `${startMark.trim()} is not where this test expects it`);
  return new Function(...params, `${js.slice(from, to)}\nreturn ${exported};`);
};

// --- a DOM small enough to read and real enough to draw into -----------------

function node(tag = 'div') {
  const self = {
    tag,
    className: '',
    textContent: '',
    hidden: false,
    title: '',
    type: '',
    children: [],
    attrs: {},
    handlers: {},
    append: (...kids) => { self.children.push(...kids.filter(Boolean)); },
    replaceChildren: (...kids) => { self.children = kids.filter(Boolean); },
    setAttribute: (k, v) => { self.attrs[k] = v; },
    getAttribute: (k) => self.attrs[k],
    addEventListener: (ev, fn) => { self.handlers[ev] = fn; },
    click: () => self.handlers.click && self.handlers.click(),
  };
  return self;
}

/** The real el()/text() out of app.js, so the nodes below are built as shipped. */
const { el, text } = lift(
  '  const el = (tag, props = {}, kids = []) => {', '  let toastTimer = null;',
  ['document'], '{ el, text }',
)({ createElement: (tag) => node(tag) });

/** Everything the sites slice reaches for, and a record of what it did. */
function harness({ rules, prefs, failRules = false, failWrite = false } = {}) {
  const ids = ['#sites-note', '#sites-yours', '#sites-all',
    '#sites-yours-head', '#sites-all-head'];
  const byId = Object.fromEntries(ids.map((id) => [id, node()]));
  const sent = [];
  const opened = [];
  const toasted = [];

  const send = async (msg) => {
    sent.push(msg);
    if (msg.type === 'getRules') {
      if (failRules) throw new Error('offline');
      return { rules };
    }
    if (msg.type === 'getAccountPrefs') return { prefs };
    if (msg.type === 'setAccountPrefs') {
      if (failWrite) throw new Error('refused');
      return { ok: true, prefs: msg.patch };
    }
    return {};
  };

  const state = { sites: [], favourites: [], sitesLoaded: false };
  const api = lift(
    '  // --- sites ---------', '  // --- views ---------',
    ['$', 'send', 'state', 'el', 'text', 't', 'window', 'toast'],
    '{ loadSites, renderSites, siteRow, toggleFavourite, bareHost }',
  )(
    (sel) => byId[sel], send, state, el, text, t,
    { PanelFlow: { openUrl: (url, meta) => opened.push({ url, meta }) } },
    (m) => toasted.push(m),
  );
  return { api, state, byId, sent, opened, toasted };
}

/** The hostnames drawn into one of the two lists, in order. */
const hostsIn = (box) => box.children.map(
  (row) => row.children[0].children.find((k) => k.className === 'site-host').textContent);

const RULES = { domains: {
  '*.sushiscan.fr': {}, '*.mangadex.org': {}, 'japscan.lol': {}, '*.bato.to': {},
} };

// --- the list ----------------------------------------------------------------

test('a rules key becomes a hostname a person would recognise', () => {
  const { api } = harness();
  assert.equal(api.bareHost('*.sushiscan.fr'), 'sushiscan.fr');
  assert.equal(api.bareHost('japscan.lol'), 'japscan.lol');
  assert.equal(api.bareHost(null), '');
});

test('the list is the real rules file, deduped and sorted', async () => {
  const { api, state } = harness({ rules: RULES, prefs: {} });
  await api.loadSites();
  assert.deepEqual(state.sites, ['bato.to', 'japscan.lol', 'mangadex.org', 'sushiscan.fr']);
});

test('the sites picked in the tour come first, in the order they were picked', async () => {
  const { api, byId } = harness({
    rules: RULES, prefs: { favouriteSites: ['mangadex.org', 'bato.to'] },
  });
  await api.loadSites();
  // Not alphabetical: the order somebody starred them in is an answer, and
  // sorting it away is the same as not having asked.
  assert.deepEqual(hostsIn(byId['#sites-yours']), ['mangadex.org', 'bato.to']);
  assert.deepEqual(hostsIn(byId['#sites-all']), ['japscan.lol', 'sushiscan.fr']);
});

test('a favourite whose tuned rule was retired is still a favourite', async () => {
  const { api, byId } = harness({
    rules: RULES, prefs: { favouriteSites: ['gone.example'] },
  });
  await api.loadSites();
  // A site somebody said they read does not stop being one because we stopped
  // shipping a rule for it.
  assert.deepEqual(hostsIn(byId['#sites-yours']), ['gone.example']);
  assert.equal(byId['#sites-all'].children.length, 4);
});

test('no heading over the only list on the screen', async () => {
  const bare = harness({ rules: RULES, prefs: {} });
  await bare.api.loadSites();
  assert.equal(bare.byId['#sites-yours-head'].hidden, true);
  assert.equal(bare.byId['#sites-all-head'].hidden, true, '"All sites" over the whole tab');

  const picked = harness({ rules: RULES, prefs: { favouriteSites: ['bato.to'] } });
  await picked.api.loadSites();
  assert.equal(picked.byId['#sites-yours-head'].hidden, false);
  assert.equal(picked.byId['#sites-all-head'].hidden, false);
});

// --- what tapping does -------------------------------------------------------

test('tapping a site opens it in the in-app browser', async () => {
  const { api, byId, opened } = harness({ rules: RULES, prefs: {} });
  await api.loadSites();
  byId['#sites-all'].children[0].children[0].click();
  // The scheme and the trailing slash are the difference between a home page
  // and a search query — `bato.to` on its own is not a URL.
  assert.deepEqual(opened, [{ url: 'https://bato.to/', meta: null }]);
});

test('starring a site writes it to the account', async () => {
  const { api, byId, sent, state } = harness({ rules: RULES, prefs: {} });
  await api.loadSites();
  byId['#sites-all'].children[0].children[1].click();
  await new Promise(setImmediate);
  assert.deepEqual(state.favourites, ['bato.to']);
  const write = sent.find((m) => m.type === 'setAccountPrefs');
  assert.deepEqual(write.patch, { favouriteSites: ['bato.to'] },
    'the star has to reach the same pref the tour and the popup use');
  // And the row moved: it is drawn before it is saved.
  assert.deepEqual(hostsIn(byId['#sites-yours']), ['bato.to']);
});

test('starring twice takes it back off', async () => {
  const { api, byId, state } = harness({
    rules: RULES, prefs: { favouriteSites: ['bato.to'] },
  });
  await api.loadSites();
  byId['#sites-yours'].children[0].children[1].click();
  await new Promise(setImmediate);
  assert.deepEqual(state.favourites, []);
});

test('a refused write puts the star back rather than lying', async () => {
  const { api, byId, state, toasted } = harness({
    rules: RULES, prefs: {}, failWrite: true,
  });
  await api.loadSites();
  byId['#sites-all'].children[0].children[1].click();
  await new Promise(setImmediate);
  assert.deepEqual(state.favourites, [], 'a star that forgets is worse than no star');
  assert.equal(toasted.length, 1);
});

// --- when the list cannot be had ---------------------------------------------

test('an unreachable rules file is a note, not a blank tab', async () => {
  const { api, byId, state } = harness({ prefs: {}, failRules: true });
  await api.loadSites();
  assert.equal(byId['#sites-note'].hidden, false);
  assert.equal(byId['#sites-note'].textContent, t('webSitesUnavailable'));
  assert.deepEqual(state.sites, []);
});

test('the list is fetched once, not on every visit to the tab', async () => {
  const { api, sent } = harness({ rules: RULES, prefs: {} });
  await api.loadSites();
  await api.loadSites();
  assert.equal(sent.filter((m) => m.type === 'getRules').length, 1);
});

// --- the tab is actually wired -----------------------------------------------

test('the shell ships the tab, and reaching it loads the list', () => {
  assert.match(html, /<section id="view-sites"/, 'no sites view in the markup');
  assert.match(html, /data-view="sites"/, 'no sites tab to reach it with');
  // The five ids the slice above writes into have to exist as real nodes, or
  // every test in this file passes against a screen that draws nothing.
  for (const id of ['sites-note', 'sites-yours', 'sites-all',
    'sites-yours-head', 'sites-all-head']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is not in index.html`);
  }
  assert.match(js, /if \(view === 'sites'\) loadSites\(\);/,
    'the tab would open on an empty list');
});

test('the sentences come from the shared locales, not from this screen', () => {
  // The website already asks this exact question and had already been given
  // these words. A second wording on the phone is how one product starts
  // sounding like two.
  for (const key of ['navSites', 'webSitesTitle', 'webSitesLede',
    'webSitesYours', 'webSitesAll', 'webSitesPin', 'webSitesUnpin']) {
    for (const lang of ['en', 'fr']) {
      const msgs = JSON.parse(read(`shared/_locales/${lang}/messages.json`));
      assert.ok(msgs[key], `${key} is missing from ${lang}`);
    }
  }
});
