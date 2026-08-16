// Why the popup's page actions are off.
//
// "Add to library" and the reader button grey out whenever the popup cannot act
// on the current tab, and for a long time that was all they did. Two very
// different situations looked identical: a page that genuinely holds no chapter,
// and a page the content script never ran on — a tab already open when the
// extension was installed, reloaded or updated keeps no content script, so
// `readerState` goes unanswered for the life of that tab. On sushiscan.fr, a
// domain the rules name and the detector clears at score 140, the popup sat
// there with everything greyed out and nothing to say. The cure is a reload,
// and only the popup was in a position to know that.
//
// So the popup now classifies the tab, and this test pins that classification:
// no answer from an http(s) page is the fixable one, an answer that says
// `detected:false` is the honest "nothing here", and a browser page was never
// in scope. Both halves are lifted out of the shipping popup.js, which is a
// plain browser script with no exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'popup', 'popup.js'), 'utf8');

const lift = (startMark, endMark, params, exported) => {
  const from = src.indexOf(startMark);
  const to = src.indexOf(endMark);
  assert.ok(from !== -1 && to > from, `${startMark.trim()} is not where this test expects it`);
  // Every free name the slice needs arrives as a parameter, so the code runs
  // exactly as written with no copy of it kept here.
  return new Function(...params, `${src.slice(from, to)}\nreturn ${exported};`);
};

const buildPageState = lift(
  'const PAGE_STATE = {', '// The active tab drives three things',
  ['$', 'state', 'chrome', 'window', 't'],
  '{ PAGE_STATE, pageStateFor, renderPageState }');

const CHAPTER = { id: 7, url: 'https://sushiscan.fr/kingdom-chapitre-883/' };

/** The popup's DOM, reduced to the two elements this slice touches. */
const stubDom = () => {
  const els = {
    '#page-state': { hidden: true, disabled: false, textContent: '', onclick: null },
    '#open-sites': { clicked: 0, click() { this.clicked++; } },
  };
  return { els, $: (sel) => els[sel] };
};

const setup = () => {
  const dom = stubDom();
  const state = { tab: CHAPTER, pageState: 'ok' };
  const calls = { reloaded: [], closed: 0 };
  const chrome = { tabs: { reload: (id) => calls.reloaded.push(id) } };
  const window = { close: () => { calls.closed++; } };
  const api = buildPageState(dom.$, state, chrome, window, t);
  return { ...api, dom, state, calls };
};

test('a tab that never answered is told apart from one with no chapter', () => {
  const { pageStateFor } = setup();
  // The failure this whole thing exists for: the content script is not there.
  assert.equal(pageStateFor(CHAPTER, null), 'unreachable');
  // It answered, and the answer was no.
  assert.equal(pageStateFor(CHAPTER, { detected: false }), 'undetected');
  assert.equal(pageStateFor(CHAPTER, { detected: true }), 'ok');
});

test('pages that could never carry a content script are their own case', () => {
  const { pageStateFor } = setup();
  for (const url of ['chrome://extensions', 'file:///C:/x.html', 'about:blank',
    'chrome-extension://abc/popup.html', 'view-source:https://a.fr/']) {
    assert.equal(pageStateFor({ id: 3, url }, null), 'scheme', url);
  }
  assert.equal(pageStateFor(null, null), 'noTab');
  assert.equal(pageStateFor(undefined, { detected: true }), 'noTab');
});

test('only http and https are treated as reachable', () => {
  const { pageStateFor } = setup();
  assert.equal(pageStateFor({ id: 1, url: 'http://old.example/ch-1/' }, null), 'unreachable');
  assert.equal(pageStateFor({ id: 1, url: 'HTTPS://A.FR/c/' }, null), 'unreachable');
  // A tab whose url the popup cannot see (no `tabs` host access yet) is not
  // claimed as reachable — that would promise a reload that fixes nothing.
  assert.equal(pageStateFor({ id: 1 }, null), 'scheme');
});

test('every state except ok says something, and only the fixable one is clickable', () => {
  const { PAGE_STATE, pageStateFor } = setup();
  assert.equal(PAGE_STATE.ok, null);
  for (const key of ['noTab', 'scheme', 'unreachable', 'undetected']) {
    assert.ok(PAGE_STATE[key].text.length > 10, `${key} needs a sentence`);
  }
  // The one the user can act on has to lead somewhere.
  assert.equal(PAGE_STATE.unreachable.act, 'reload');
  assert.equal(PAGE_STATE.scheme.act, undefined);
  // And it has to name the remedy, not just the symptom.
  assert.match(PAGE_STATE.unreachable.text, /reload/i);
  assert.equal(pageStateFor(CHAPTER, null), 'unreachable');
});

test('the unreachable row reloads the tab it is talking about', () => {
  const { renderPageState, dom, state, calls } = setup();
  state.pageState = 'unreachable';
  renderPageState();
  const row = dom.els['#page-state'];
  assert.equal(row.hidden, false);
  assert.equal(row.disabled, false);
  row.onclick();
  assert.deepEqual(calls.reloaded, [CHAPTER.id]);
  assert.equal(calls.closed, 1);
});

test('a page with no chapter offers the compatible-sites list instead', () => {
  const { renderPageState, dom, state, calls } = setup();
  state.pageState = 'undetected';
  renderPageState();
  dom.els['#page-state'].onclick();
  assert.equal(dom.els['#open-sites'].clicked, 1);
  assert.deepEqual(calls.reloaded, [], 'nothing to reload here');
});

test('a detected page shows no explanation at all', () => {
  const { renderPageState, dom, state } = setup();
  state.pageState = 'ok';
  renderPageState();
  assert.equal(dom.els['#page-state'].hidden, true);
  assert.equal(dom.els['#page-state'].onclick, null,
    'a stale handler would reload the wrong tab on the next popup');
});

test('a row that leads nowhere is disabled, so it does not look like a button', () => {
  const { renderPageState, dom, state } = setup();
  for (const key of ['scheme', 'noTab']) {
    state.pageState = key;
    renderPageState();
    assert.equal(dom.els['#page-state'].disabled, true, key);
    assert.equal(dom.els['#page-state'].onclick, null, key);
  }
});
