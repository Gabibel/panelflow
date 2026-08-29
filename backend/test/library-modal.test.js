// The "Add to library" sheet, run for real.
//
// It is a content script that builds its form with DOM calls, so it is loaded
// here into a DOM small enough to fit in this file — enough to click a chip and
// read what came back. The subject is the tracker prefill: a form that fills
// itself in from AniList or MyAnimeList is one keystroke away from filling
// itself in *over* what the reader just chose, and the rules that stop it
// happening are invisible from the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { I18N_SRC, i18n } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(root, 'extension/content/library-modal.js'), 'utf8');

// --- a DOM the sheet can be built in ----------------------------------------

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.handlers = {};
    this._text = '';
    this.className = '';
    this.classList = {
      add: (c) => { this.className = `${this.className} ${c}`.trim(); },
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }

  get textContent() { return this._text; }

  set textContent(v) { this._text = String(v); this.childNodes = []; }

  set innerHTML(v) { if (v === '') this.childNodes = []; }

  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) { for (const n of nodes) this.appendChild(n); }

  remove() {
    const p = this.parentNode;
    if (p) p.childNodes = p.childNodes.filter((n) => n !== this);
    this.parentNode = null;
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return this.attrs[k] ?? null; }

  // An img's src is a property rather than an attribute in this stand-in, so
  // a cover that fails to load has to lose both to count as removed.
  removeAttribute(k) { delete this.attrs[k]; delete this[k]; }

  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }

  removeEventListener() {}

  focus() {}

  // A real closed root is not a child and not reachable from the page; here it
  // is hung off the host so the tests can read what the reader would see.
  attachShadow() { return this.appendChild(new El('#shadow')); }

  querySelector(sel) {
    for (const n of this.childNodes) {
      if (matches(n, sel)) return n;
      const deep = n.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }

  querySelectorAll(sel, out = []) {
    for (const n of this.childNodes) {
      if (matches(n, sel)) out.push(n);
      n.querySelectorAll(sel, out);
    }
    return out;
  }
}

const matches = (el, sel) => (sel.startsWith('.')
  ? el.classList.contains(sel.slice(1))
  : el.tagName === sel.toUpperCase());

/** Every character the reader would see under `el`. */
const text = (el) => (el.childNodes.length
  ? el.childNodes.map(text).join(' ')
  : el.textContent);

const fire = (el, type, ev = {}) => {
  for (const fn of el.handlers[type] || []) fn({ currentTarget: el, target: el, ...ev });
};

/** The first element carrying `class` whose text contains `needle`. */
function findByText(el, cls, needle) {
  return el.querySelectorAll(`.${cls}`).find((n) => text(n).includes(needle)) ?? null;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Let the un-awaited tracker lookup land. */
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

// --- booting the sheet ------------------------------------------------------

const META = {
  title: 'Ao no Hako',
  sourceDomain: 'sushiscan.fr',
  sourceUrl: 'https://sushiscan.fr/manga/ao-no-hako/',
  chapterLabel: 'Ch. 883',
  genres: ['Romance'],
};

/**
 * Load library-modal.js into a fresh fake page.
 * @param {object} replies  message type -> response (or a function of the message)
 * @param {Function} [tweak]  last look at the stub `chrome` before it is used
 */
function boot(replies = {}, tweak) {
  const sent = [];
  const documentEl = new El('html');
  const doc = {
    documentElement: documentEl,
    createElement: (tag) => new El(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const answers = {
    findSimilar: { matches: [] },
    getAccount: { authUser: { id: 'u1' } },
    getProgressAll: { progress: {} },
    trackerEntry: { entries: [], connected: [] },
    ...replies,
  };
  const chrome = {
    // The real chrome.i18n over the real English locale file, so the strings
    // asserted below are the ones the sheet will actually draw.
    i18n,
    runtime: {
      sendMessage: (msg, cb) => {
        sent.push(msg);
        const a = answers[msg.type];
        setTimeout(() => cb(typeof a === 'function' ? a(msg) : a), 0);
      },
    },
  };
  tweak?.(chrome);
  const win = { __proto__: null };
  const sandbox = {
    window: win, document: doc, chrome, setTimeout, clearTimeout, Date, console,
  };
  win.top = win;
  win.addEventListener = (type, fn) => { (win.handlers ||= {})[type] = fn; };
  vm.createContext(sandbox);
  // i18n.js first: the manifest injects it ahead of the content scripts, and
  // library-modal.js calls t() while it is still being evaluated.
  vm.runInContext(I18N_SRC, sandbox);
  vm.runInContext(SRC, sandbox);
  return {
    sent,
    win,
    modal: win.PanelFlowLibraryModal,
    /** The shadow root the sheet was rendered into. */
    root: () => documentEl.childNodes.at(-1)?.childNodes.at(-1) ?? null,
    sheet: () => documentEl.querySelector('.sheet'),
  };
}

/** The chip currently pressed in the section titled `title`. */
function chosen(sheet, title) {
  const section = sheet.querySelectorAll('SECTION')
    .find((s) => s.querySelector('H3') && text(s.querySelector('H3')) === title);
  assert.ok(section, `no section titled ${title}`);
  const on = section.querySelectorAll('.chip').find((c) => c.getAttribute('aria-pressed') === 'true');
  return on ? text(on).trim() : null;
}

const press = (sheet, title, label) => {
  const section = sheet.querySelectorAll('SECTION')
    .find((s) => s.querySelector('H3') && text(s.querySelector('H3')) === title);
  const chip = section.querySelectorAll('.chip').find((c) => text(c).trim() === label);
  assert.ok(chip, `no chip ${label} under ${title}`);
  fire(chip, 'click');
};

const ANILIST = {
  entries: [{
    service: 'anilist',
    remoteId: '30002',
    remoteTitle: 'Ao no Hako',
    folder: 'paused',
    chaptersRead: 880,
    score: 8,
    startDate: '2025-03-04',
    finishDate: null,
  }],
  connected: ['anilist'],
  errors: [],
};

// --- the sheet without a tracker --------------------------------------------

test('the sheet opens before the tracker answers, and asks for the page title', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const app = boot({ trackerEntry: () => held });
  // A promise as the reply never resolves through the callback, so this stands
  // in for a tracker that is simply slow: the sheet must already be complete.
  await app.modal.open(META);

  assert.ok(app.sheet(), 'the sheet is rendered without waiting');
  assert.equal(chosen(app.sheet(), 'Folder'), 'Reading');
  assert.equal(app.sheet().querySelector('.tk'), null, 'nothing is claimed before an answer');
  const ask = app.sent.find((m) => m.type === 'trackerEntry');
  // Objects built inside the vm have that realm's prototype, so compare the
  // fields rather than the shape.
  assert.equal(ask?.title, 'Ao no Hako');
  release?.();
});

test('signed out, the sheet neither asks a tracker nor offers to connect one', async () => {
  const app = boot({ getAccount: {}, trackerEntry: ANILIST });
  await app.modal.open(META);
  await settle();
  // Connecting stores a token on the PanelFlow account, so there is nothing to
  // offer someone who has not got one — and the strip must not appear either.
  assert.equal(app.sheet().querySelector('.tk'), null);
  assert.equal(app.sent.some((m) => m.type === 'trackerEntry'), false,
    'no account, no tokens, nothing to ask');
});

// --- prefilling -------------------------------------------------------------

test('a new entry is filled in from the reader’s own list, and says where from', async () => {
  const app = boot({ trackerEntry: ANILIST });
  await app.modal.open(META);
  assert.equal(chosen(app.sheet(), 'Folder'), 'Reading');
  await settle();

  const sheet = app.sheet();
  assert.equal(chosen(sheet, 'Folder'), 'Paused', 'the shelf comes from AniList');
  assert.equal(chosen(sheet, 'Score'), '8');
  assert.equal(sheet.querySelector('.tk').querySelector('.tkname').textContent, 'AniList');
  assert.match(text(sheet.querySelector('.tk')), /Paused · 880 ch\. · 8\/10/);
  // The date field is not a chip; read it off the input.
  const dates = sheet.querySelectorAll('INPUT').map((i) => i.value);
  assert.ok(dates.includes('2025-03-04'), `start date not applied: ${dates.join()}`);
});

test('the chapter the reader is on beats the one the tracker remembers', async () => {
  const app = boot({ trackerEntry: ANILIST });
  await app.modal.open(META);
  await settle();

  // AniList says 880; the page in front of them says 883. Filling the form with
  // 880 and saving would move their bookmark backwards.
  assert.equal(chosen(app.sheet(), 'Current progress'), 'Ch. 883');
  assert.match(text(app.sheet()), /880 ch\./, 'what the tracker holds is still shown');
});

test('a form the reader has started answering is offered the prefill, not given it', async () => {
  let answer;
  const app = boot({ trackerEntry: () => new Promise((r) => { answer = r; }) });
  await app.modal.open(META);
  await tick(); // the lookup is in flight, and will stay there until we say so
  press(app.sheet(), 'Folder', 'Completed');
  assert.equal(chosen(app.sheet(), 'Folder'), 'Completed');

  // Now the tracker replies. Too late to overrule them.
  answer(ANILIST);
  await settle();
  assert.equal(chosen(app.sheet(), 'Folder'), 'Completed');
  assert.equal(chosen(app.sheet(), 'Score'), 'None');

  // But it is on the table, one press away.
  const use = findByText(app.sheet(), 'tkbtn', 'Use');
  assert.ok(use, 'the prefill must still be offered');
  fire(use, 'click');
  assert.equal(chosen(app.sheet(), 'Folder'), 'Paused');
  assert.equal(chosen(app.sheet(), 'Score'), '8');
});

test('an entry that already exists keeps its own values until asked', async () => {
  const existing = {
    id: 'lib1', title: 'Ao no Hako', sourceDomain: 'sushiscan.fr',
    sourceUrl: META.sourceUrl, folder: 'completed', score: 3,
    startDate: '2024-02-02', tags: ['Romance'],
  };
  const app = boot({
    findSimilar: { matches: [{ confidence: 'same-page', entry: existing }] },
    trackerEntry: ANILIST,
  });
  await app.modal.open(META);
  await settle();

  // These are the reader's own saved answers. A remote list does not get to
  // overwrite them because it happens to disagree.
  assert.equal(chosen(app.sheet(), 'Folder'), 'Completed');
  assert.equal(chosen(app.sheet(), 'Score'), '3');
  assert.ok(findByText(app.sheet(), 'tkbtn', 'Use'));
});

test('a prefill can be taken back', async () => {
  const app = boot({ trackerEntry: ANILIST });
  await app.modal.open(META);
  await settle();
  assert.equal(chosen(app.sheet(), 'Folder'), 'Paused');

  fire(findByText(app.sheet(), 'tkbtn', 'Undo'), 'click');

  assert.equal(chosen(app.sheet(), 'Folder'), 'Reading', 'back to what the page implied');
  assert.equal(chosen(app.sheet(), 'Score'), 'None');
  assert.ok(findByText(app.sheet(), 'tkbtn', 'Use'), 'and it can be applied again');
});

test('a match on a different title says so, because that is the one to catch', async () => {
  const app = boot({ trackerEntry: {
    ...ANILIST,
    entries: [{ ...ANILIST.entries[0], remoteTitle: 'Blue Box' }],
  } });
  await app.modal.open(META);
  await settle();
  assert.match(text(app.sheet().querySelector('.tk')), /matched as .Blue Box./);
});

// --- the two nos ------------------------------------------------------------

test('connected but unlisted is said out loud, per service, with a way out', async () => {
  const app = boot({ trackerEntry: { entries: [], connected: ['anilist', 'mal'], errors: [] } });
  await app.modal.open(META);
  await settle();

  const strip = text(app.sheet().querySelector('.tk'));
  assert.match(strip, /Not on your AniList list yet/);
  assert.match(strip, /Not on your MyAnimeList list yet/);
  // Saying it and stopping there was the whole of the old strip: the one
  // screen that knows both the title and the chapter told the reader their
  // list was missing the series, and gave them nothing to press.
  assert.equal(app.sheet().querySelectorAll('.tkbtn').filter((b) => text(b) === 'Add').length, 2);
  // Offering to add it is not filling the form in.
  assert.equal(chosen(app.sheet(), 'Folder'), 'Reading');
  assert.equal(findByText(app.sheet(), 'chip', 'Connect AniList'), null);
});

test('a tracker that could not be reached is named, not hidden', async () => {
  const app = boot({ trackerEntry: {
    entries: [], connected: ['anilist'], errors: [{ service: 'anilist', error: 'socket hang up' }],
  } });
  await app.modal.open(META);
  await settle();
  const strip = text(app.sheet().querySelector('.tk'));
  assert.match(strip, /AniList could not be reached/);
  assert.match(strip, /socket hang up/);
  // "We asked and you have not listed it" would be a lie here.
  assert.doesNotMatch(strip, /Not on your/);
});

// --- adding it to the tracker from here -------------------------------------
//
// Reported by a reader with AniList connected: the series was not on their
// AniList list, and PanelFlow — which knew the title, the chapter and the
// account — could only say so. Everything below is one press of that button.

/** Boot with AniList connected, nothing listed, and press Add. */
async function pressAdd(replies) {
  const app = boot({
    trackerEntry: { entries: [], connected: ['anilist'], errors: [] },
    addToLibrary: { entry: { remoteId: 'lib1', sourceUrl: META.sourceUrl } },
    ...replies,
  });
  await app.modal.open(META);
  await settle();
  fire(findByText(app.sheet(), 'tkbtn', 'Add'), 'click');
  await settle();
  return app;
}

test('Add saves the series and sends the chapter the reader is on', async () => {
  const app = await pressAdd({
    trackerPushOne: { trackers: [{ service: 'anilist', chapter: 883 }] },
  });

  assert.match(text(app.sheet().querySelector('.tk')), /Added to AniList at chapter 883/);
  // Saved first, then pushed: the push lives on the progress route and works
  // from a library row, so there is nothing to send until the row exists.
  const saved = app.sent.find((m) => m.type === 'addToLibrary');
  assert.equal(saved?.entry?.title, 'Ao no Hako');
  const pushed = app.sent.find((m) => m.type === 'trackerPushOne');
  assert.equal(pushed?.sourceUrl, META.sourceUrl);
  assert.ok(app.sent.indexOf(saved) < app.sent.indexOf(pushed));
  // Done is done: the button goes, so a second press cannot re-send it.
  assert.equal(findByText(app.sheet(), 'tkbtn', 'Add'), null);
});

test('a tracker already further along is reported, not treated as a failure', async () => {
  const app = await pressAdd({
    trackerPushOne: { trackers: [{ service: 'anilist', skipped: 'not-further' }] },
  });
  assert.match(text(app.sheet().querySelector('.tk')),
    /AniList is already at this chapter or further/);
});

test('a refusal is quoted rather than swallowed', async () => {
  const app = await pressAdd({
    trackerPushOne: { trackers: [{ service: 'anilist', error: 'invalid token' }] },
  });
  const strip = text(app.sheet().querySelector('.tk'));
  assert.match(strip, /AniList refused it/);
  assert.match(strip, /invalid token/);
  // Still offered: a token that expired is renewed and the button pressed again.
  assert.ok(findByText(app.sheet(), 'tkbtn', 'Add'));
});

test('a title the service does not know becomes a question for the reader', async () => {
  // The match rule is deliberately strict — a weak match writes a chapter
  // count onto a stranger's series — so a common title landing as 'unmatched'
  // is the ordinary case, and the service's own candidates are the way out.
  let pushes = 0;
  const app = await pressAdd({
    trackerPushOne: () => (pushes++ === 0
      ? { trackers: [{ service: 'anilist', skipped: 'unmatched' }] }
      : { trackers: [{ service: 'anilist', chapter: 883 }] }),
    trackerSearch: { hits: [{ id: '30002', title: 'Blue Box' }, { id: '7', title: 'Ao Box' }] },
  });

  assert.match(text(app.sheet().querySelector('.tk')), /AniList does not know this title/);
  const pick = findByText(app.sheet(), 'chip', 'Blue Box');
  assert.ok(pick, 'the candidates the service offered are not shown');

  fire(pick, 'click');
  await settle();
  const link = app.sent.find((m) => m.type === 'trackerLink');
  assert.equal(link?.remoteId, '30002');
  assert.equal(link?.state, 'linked');
  assert.equal(link?.libraryId, 'lib1', 'the row just saved is the one being linked');
  assert.match(text(app.sheet().querySelector('.tk')), /Added to AniList at chapter 883/);
});

test('nothing found at all says so instead of showing an empty picker', async () => {
  const app = await pressAdd({
    trackerPushOne: { trackers: [{ service: 'anilist', skipped: 'unmatched' }] },
    trackerSearch: { hits: [] },
  });
  assert.match(text(app.sheet().querySelector('.tk')), /AniList found nothing for/);
});

// --- what the chapter page did not know -------------------------------------
//
// The sheet opens from the reader with the chapter page's own metadata, which
// has no cover — its og:image is a panel — and no genres but the ones in the
// site's menu. Kingdom, a war epic, was offered "Adulte" and "Romance" beside
// a broken image, because those are the first two entries in sushiscan's genre
// dropdown. The series page has the real answers, and detect.js already knows
// how to fetch it.

const KINGDOM = {
  title: 'Kingdom',
  sourceDomain: 'sushiscan.fr',
  sourceUrl: 'https://sushiscan.fr/kingdom-chapitre-874/',
  chapterLabel: 'Chapitre 874',
  genres: ['Adulte', 'Romance'],
};

/** The chips of the section with this title, in order. */
const chipsUnder = (sheet, title) => {
  const section = sheet.querySelectorAll('SECTION')
    .find((x) => x.querySelector('H3') && text(x.querySelector('H3')) === title);
  assert.ok(section, 'no section titled ' + title);
  // The remove cross is a child of the chip and the label is the chip's own
  // text, so textContent here is the word without the cross after it.
  return section.querySelectorAll('.chip').map((c) => c.textContent.trim());
};

test('the series page corrects the cover and the tags behind the sheet', async () => {
  const app = boot();
  app.win.__panelflowDetect = {
    enrichedMeta: async () => ({
      coverUrl: 'https://sushiscan.fr/img/kingdom.jpg',
      genres: ['Action', 'Historique', 'Seinen'],
      enriched: true,
    }),
  };
  await app.modal.open(KINGDOM);
  assert.equal(app.sheet().querySelector('IMG').src, undefined, 'there was no cover to show');
  await settle();

  assert.equal(app.sheet().querySelector('IMG').src, 'https://sushiscan.fr/img/kingdom.jpg');
  assert.deepEqual(chipsUnder(app.sheet(), 'Tags'), ['Action', 'Historique', 'Seinen']);
});

test('a cover the site will not serve leaves the placeholder, not a broken icon', async () => {
  // Scan-site covers are hotlink-protected often enough that this is the
  // ordinary case rather than the accident.
  const app = boot();
  await app.modal.open({ ...KINGDOM, coverUrl: 'https://sushiscan.fr/img/403.jpg' });
  const img = app.sheet().querySelector('IMG');
  fire(img, 'error');
  assert.equal(img.src, undefined);
});

test('what the reader has already answered survives the enrichment', async () => {
  // Same rule as the tracker prefill above: metadata fills the gaps, it does
  // not overwrite the reader.
  const app = boot({
    findSimilar: { matches: [{ confidence: 'same-page', entry: {
      id: 'lib1', title: 'Kingdom', sourceUrl: KINGDOM.sourceUrl, tags: ['A relire'] } }] },
  });
  app.win.__panelflowDetect = {
    enrichedMeta: async () => ({ genres: ['Action', 'Historique'], enriched: true }),
  };
  await app.modal.open(KINGDOM);
  await settle();
  assert.deepEqual(chipsUnder(app.sheet(), 'Tags'), ['A relire']);
});

test('a page with no detector behind it still opens', async () => {
  // The sheet is loaded on surfaces where detect.js is not running, and an
  // optional call on a missing object is one keystroke from throwing.
  const app = boot();
  await app.modal.open(KINGDOM);
  await settle();
  assert.ok(app.sheet());
  assert.deepEqual(chipsUnder(app.sheet(), 'Tags'), ['Adulte', 'Romance']);
});

// --- connecting from the sheet ----------------------------------------------

test('with nothing connected, both services are offered from the sheet itself', async () => {
  const app = boot({
    trackerEntry: { entries: [], connected: [] },
    trackerConnectTab: { authorizeUrl: 'https://anilist.co/api/v2/oauth/authorize?x=1' },
  });
  await app.modal.open(META);
  await settle();

  const connect = findByText(app.sheet(), 'chip', 'Connect AniList');
  assert.ok(connect, 'the offer must be here, not buried in the options page');
  assert.ok(findByText(app.sheet(), 'chip', 'Connect MyAnimeList'));

  fire(connect, 'click');
  await settle();
  // The sheet lives in a closed shadow root inside the page and has no
  // chrome.tabs; the worker opens the authorisation page for it.
  assert.equal(app.sent.find((m) => m.type === 'trackerConnectTab')?.service, 'anilist');
});

test('in the phone app the offer becomes an address, because there is no tab to open', async () => {
  const app = boot({ trackerEntry: { entries: [], connected: [] } }, (chrome) => {
    chrome.runtime.__panelflowShim = true;
  });
  await app.modal.open(META);
  await settle();

  // Native has no tracker screen and the in-app browser has no tabs; a button
  // here would be a button that goes nowhere.
  assert.equal(findByText(app.sheet(), 'chip', 'Connect AniList'), null);
  assert.match(text(app.sheet().querySelector('.tk')), /in the PanelFlow web app/);
});

test('a deployment with no AniList credentials says so where the button was pressed', async () => {
  const app = boot({
    trackerEntry: { entries: [], connected: [] },
    trackerConnectTab: { error: 'service not configured: set PANELFLOW_ANILIST_CLIENT_ID' },
  });
  await app.modal.open(META);
  await settle();
  fire(findByText(app.sheet(), 'chip', 'Connect AniList'), 'click');
  await settle();
  assert.match(text(app.sheet().querySelector('.tk')), /AniList: service not configured/);
});

test('coming back from the authorisation tab asks again', async () => {
  let connected = [];
  const app = boot({
    trackerEntry: () => ({ entries: connected.length ? ANILIST.entries : [], connected, errors: [] }),
    trackerConnectTab: { authorizeUrl: 'https://anilist.co/x' },
  });
  await app.modal.open(META);
  await settle();
  fire(findByText(app.sheet(), 'chip', 'Connect AniList'), 'click');
  await settle();

  // The reader authorises in the other tab and comes back to this window.
  connected = ['anilist'];
  app.win.handlers.focus();
  await settle();

  assert.equal(chosen(app.sheet(), 'Folder'), 'Paused',
    'the prefill should arrive without reopening the sheet');
});

// --- after the sheet is gone -------------------------------------------------

test('a tracker answering after the sheet was closed touches nothing', async () => {
  let answer;
  const app = boot({ trackerEntry: () => new Promise((r) => { answer = r; }) });
  await app.modal.open(META);
  await tick();
  app.modal.close();
  answer(ANILIST);
  await settle();
  assert.equal(app.modal.isOpen(), false);
  assert.equal(app.sheet(), null, 'a closed sheet must not be redrawn from a late reply');
});
