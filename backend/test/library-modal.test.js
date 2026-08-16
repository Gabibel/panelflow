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

test('connected but unlisted is said out loud, and nothing is filled in', async () => {
  const app = boot({ trackerEntry: { entries: [], connected: ['anilist', 'mal'], errors: [] } });
  await app.modal.open(META);
  await settle();

  assert.match(text(app.sheet().querySelector('.tk')), /Not on your AniList or MyAnimeList list yet/);
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
