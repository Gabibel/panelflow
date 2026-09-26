// "My sites" in the phone's legacy shell.
//
// This tab used to be the way into the in-app browser from a fresh install: a
// list of every site the rules file names, a hundred and seventy scan and
// streaming hosts. That is a directory, and a directory of scan sites is the
// one thing neither store accepts (QA re-test, September 2026). So the tab now
// shows what every other surface shows: the sites the reader starred, then the
// ones their library comes from, with how many series each holds. The rules
// still decide what a chapter looks like; they are not a list of places to go.
//
// It still spends `favouriteSites`, which shared/prefs.js describes as being
// for "the phone they were never chosen on" — starred on one device, at the top
// on all of them.
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

/** A library entry, as the server hands it back. */
const entry = (sourceDomain, sourceUrl = `https://${sourceDomain}/series/x`) => ({ sourceDomain, sourceUrl });

const LIBRARY = [
  entry('mangadex.org'), entry('mangadex.org'), entry('mangadex.org'),
  entry('www.webtoons.com'), entry('webtoons.com'),
  entry('bato.to'),
];

const IDS = ['#sites-note', '#sites-empty', '#sites-yours', '#sites-all',
  '#sites-yours-head', '#sites-all-head'];

/** Everything the sites slice reaches for, and a record of what it did. */
function harness({ library = LIBRARY, prefs, failPrefs = false, failWrite = false } = {}) {
  const byId = Object.fromEntries(IDS.map((id) => [id, node()]));
  // As index.html ships them: both notes start hidden.
  byId['#sites-note'].hidden = true;
  byId['#sites-empty'].hidden = true;
  const sent = [];
  const opened = [];
  const toasted = [];

  const send = async (msg) => {
    sent.push(msg);
    if (msg.type === 'getAccountPrefs') {
      if (failPrefs) throw new Error('offline');
      return { prefs };
    }
    if (msg.type === 'setAccountPrefs') {
      if (failWrite) throw new Error('refused');
      return { ok: true, prefs: msg.patch };
    }
    return {};
  };

  const state = { sites: [], favourites: [], library };
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

/** The series count drawn beside a host, or undefined. */
const countOf = (box, host) => {
  const row = box.children.find((r) => r.children[0].children.some((k) => k.textContent === host));
  return row?.children[0].children.find((k) => k.className === 'site-count')?.textContent;
};

// --- the list ----------------------------------------------------------------

test('a stored domain becomes a hostname a person would recognise', () => {
  const { api } = harness();
  assert.equal(api.bareHost('*.mangadex.org'), 'mangadex.org');
  assert.equal(api.bareHost('bato.to'), 'bato.to');
  assert.equal(api.bareHost(null), '');
});

test('the list is where the library comes from, most of it first', async () => {
  const { api, state, byId } = harness({ prefs: {} });
  await api.loadSites();
  // www. and the bare domain are one site; ties go by name.
  assert.deepEqual(state.sites, ['mangadex.org', 'webtoons.com', 'bato.to']);
  assert.deepEqual(hostsIn(byId['#sites-all']), ['mangadex.org', 'webtoons.com', 'bato.to']);
  assert.equal(countOf(byId['#sites-all'], 'mangadex.org'), t('mobileSeriesMany', ['3']));
  assert.equal(countOf(byId['#sites-all'], 'bato.to'), t('mobileSeriesOne'));
});

test('the rules file is not a list of places to go', async () => {
  // The directory the store builds lost: nothing here asks for the rules, and
  // a site the reader has never read on is not drawn.
  const { api, sent, state } = harness({ prefs: {} });
  await api.loadSites();
  assert.equal(sent.some((m) => m.type === 'getRules'), false);
  assert.equal(state.sites.includes('sushiscan.fr'), false);
  assert.doesNotMatch(js.slice(js.indexOf('  // --- sites ---------'), js.indexOf('  // --- views ---------')),
    /getRules/);
});

test('an entry without a domain is placed by its address', async () => {
  const { api, state } = harness({
    prefs: {}, library: [{ sourceUrl: 'https://www.asura.example/series/1' }, { sourceUrl: 'not a url' }],
  });
  await api.loadSites();
  assert.deepEqual(state.sites, ['asura.example']);
});

test('the starred sites come first, in the order they were starred', async () => {
  const { api, byId } = harness({ prefs: { favouriteSites: ['bato.to', 'mangadex.org'] } });
  await api.loadSites();
  // Not re-sorted: the order somebody starred them in is an answer.
  assert.deepEqual(hostsIn(byId['#sites-yours']), ['bato.to', 'mangadex.org']);
  assert.deepEqual(hostsIn(byId['#sites-all']), ['webtoons.com']);
  // And still say how much of the library is there.
  assert.equal(countOf(byId['#sites-yours'], 'mangadex.org'), t('mobileSeriesMany', ['3']));
});

test('a starred site the library no longer uses is still starred', async () => {
  const { api, byId } = harness({ prefs: { favouriteSites: ['gone.example'] } });
  await api.loadSites();
  // A site somebody said they read does not stop being one because the last
  // series they had there was removed.
  assert.deepEqual(hostsIn(byId['#sites-yours']), ['gone.example']);
  assert.equal(countOf(byId['#sites-yours'], 'gone.example'), undefined, 'no "0 series"');
  assert.equal(byId['#sites-all'].children.length, 3);
});

test('no heading over the only list on the screen', async () => {
  const bare = harness({ prefs: {} });
  await bare.api.loadSites();
  assert.equal(bare.byId['#sites-yours-head'].hidden, true);
  assert.equal(bare.byId['#sites-all-head'].hidden, true, 'a heading over the whole tab');

  const picked = harness({ prefs: { favouriteSites: ['bato.to'] } });
  await picked.api.loadSites();
  assert.equal(picked.byId['#sites-yours-head'].hidden, false);
  assert.equal(picked.byId['#sites-all-head'].hidden, false);
});

// --- an empty shelf --------------------------------------------------------------

test('nothing yet says how a site gets here, and goes once one has', async () => {
  const h = harness({ prefs: {}, library: [] });
  await h.api.loadSites();
  assert.equal(h.byId['#sites-empty'].hidden, false);
  assert.equal(h.byId['#sites-all'].children.length, 0);
  // Its words are the markup's own, translated with the rest of the page.
  assert.match(html, /id="sites-empty"[^>]*data-i18n="webMySitesEmpty"/);

  h.state.library = [entry('mangadex.org')];
  await h.api.loadSites();
  assert.equal(h.byId['#sites-empty'].hidden, true);
});

// --- what tapping does -------------------------------------------------------

test('tapping a site opens it in the in-app browser', async () => {
  const { api, byId, opened } = harness({ prefs: {} });
  await api.loadSites();
  byId['#sites-all'].children[2].children[0].click();
  // The scheme and the trailing slash are the difference between a home page
  // and a search query — `bato.to` on its own is not a URL.
  assert.deepEqual(opened, [{ url: 'https://bato.to/', meta: null }]);
});

test('starring a site writes it to the account', async () => {
  const { api, byId, sent, state } = harness({ prefs: {} });
  await api.loadSites();
  byId['#sites-all'].children[2].children[1].click();
  await new Promise(setImmediate);
  assert.deepEqual(state.favourites, ['bato.to']);
  const write = sent.find((m) => m.type === 'setAccountPrefs');
  assert.deepEqual(write.patch, { favouriteSites: ['bato.to'] },
    'the star has to reach the same pref the popup and the website use');
  // And the row moved: it is drawn before it is saved.
  assert.deepEqual(hostsIn(byId['#sites-yours']), ['bato.to']);
});

test('starring twice takes it back off', async () => {
  const { api, byId, state } = harness({ prefs: { favouriteSites: ['bato.to'] } });
  await api.loadSites();
  byId['#sites-yours'].children[0].children[1].click();
  await new Promise(setImmediate);
  assert.deepEqual(state.favourites, []);
});

test('a refused write puts the star back and says the star was not saved', async () => {
  const { api, byId, state, toasted } = harness({ prefs: {}, failWrite: true });
  await api.loadSites();
  byId['#sites-all'].children[0].children[1].click();
  await new Promise(setImmediate);
  assert.deepEqual(state.favourites, [], 'a star that forgets is worse than no star');
  // Not "the list could not be loaded": the list is right there.
  assert.deepEqual(toasted, [t('sitesStarNotSaved')]);
});

// --- when the stars cannot be had ------------------------------------------------

test('unreadable stars are a note, and the library\'s sites stay', async () => {
  const { api, byId, state } = harness({ failPrefs: true });
  await api.loadSites();
  assert.equal(byId['#sites-note'].hidden, false);
  assert.equal(byId['#sites-note'].textContent, t('webSitesUnavailable'));
  assert.deepEqual(state.sites, ['mangadex.org', 'webtoons.com', 'bato.to']);
  assert.equal(byId['#sites-empty'].hidden, true);
});

test('the list is worked out again on every visit to the tab', async () => {
  // The library changes, and so does where it comes from: a tab cached from
  // the first visit would miss the series added since.
  const h = harness({ prefs: {} });
  await h.api.loadSites();
  h.state.library = [...LIBRARY, entry('newsite.example')];
  await h.api.loadSites();
  assert.ok(h.state.sites.includes('newsite.example'));
});

// --- the tab is actually wired -----------------------------------------------

test('the shell ships the tab, and reaching it loads the list', () => {
  assert.match(html, /<section id="view-sites"/, 'no sites view in the markup');
  assert.match(html, /data-view="sites"/, 'no sites tab to reach it with');
  // The ids the slice above writes into have to exist as real nodes, or every
  // test in this file passes against a screen that draws nothing.
  for (const id of IDS) {
    assert.ok(html.includes(`id="${id.slice(1)}"`), `${id} is not in index.html`);
  }
  assert.match(js, /if \(view === 'sites'\) loadSites\(\);/,
    'the tab would open on an empty list');
});

test('the sentences come from the shared locales, not from this screen', () => {
  // The website and the app say the same things with the same words. A second
  // wording on the phone is how one product starts sounding like two.
  for (const key of ['navSites', 'mobileMySites', 'mobileMySitesLede', 'webSitesYours',
    'webSitesFromLibrary', 'webSitesPin', 'webSitesUnpin', 'webMySitesEmpty',
    'webSitesUnavailable', 'sitesStarNotSaved', 'mobileSeriesOne', 'mobileSeriesMany']) {
    for (const lang of ['en', 'fr']) {
      const msgs = JSON.parse(read(`shared/_locales/${lang}/messages.json`));
      assert.ok(msgs[key], `${key} is missing from ${lang}`);
    }
  }
});
