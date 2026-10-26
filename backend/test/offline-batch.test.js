// Keeping many chapters for offline reading at once, from a series' sheet
// (owner, October 2026: "all the chapters show, the read ones greyed, pick
// some or all of them"; no limit on how many, as MangaPin does it).
//
// Four parts, each tested on its own:
//   1. the chapter list of a series, built from its page and its bookmark
//      (shared/panelflow-core.js: seriesChapterLinks, seriesChapterRows,
//      core.seriesChapters);
//   2. the queue that saves them one after the other (native/src/offline-queue.js),
//      driven here by a stand-in for the hidden browser;
//   3. the signed command that asks a page's reader to save its chapter,
//      which a page itself cannot send (mobile/inject/chrome-shim.js);
//   4. the words on screen, in both languages and never "download".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import '../src/site-rules.js';
import { seriesChapterLinks, seriesChapterRows } from '../src/panelflow-core.js';
import { bootCore, json, html } from '../test-support/core.js';
import { createSaveQueue, HIDDEN_PAGE_TYPES } from '../../native/src/offline-queue.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const SERIES = 'https://scan.test/manga/blue-box-7a1f/';
const chapter = (n) => `https://scan.test/manga/blue-box-7a1f/chapter-${n}/`;

/** A series page: its own chapters (one relative, one twice), and a sidebar. */
const PAGE = `
  <a href="/manga/martial-peak/chapter-2007/">Chapter 2007</a>
  <a href="https://scan.test/manga/blue-box-7a1f/chapter-3/">Chapter 3</a>
  <a href="/manga/blue-box-7a1f/chapter-2/?x=1&amp;y=2">Chapter 2</a>
  <a href="https://scan.test/manga/blue-box-7a1f/chapter-3/">Chapter 3 again</a>
  <a href="https://scan.test/manga/blue-box-7a1f/chapter-1/">Chapter 1</a>`;

// --- 1. the list ------------------------------------------------------------

test("a series page gives its own chapters, not the sidebar's, each once", () => {
  const links = seriesChapterLinks(PAGE, SERIES);
  assert.deepEqual(links.map((l) => l.n).sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(links.find((l) => l.n === 2).url, 'https://scan.test/manga/blue-box-7a1f/chapter-2/?x=1&y=2');
  // An address that names no series has nothing to tell its links apart by.
  assert.deepEqual(seriesChapterLinks(PAGE, 'https://scan.test/read/6'), []);
});

test('the list is every chapter once, in order, a real link beating a worked-out one', () => {
  const rows = seriesChapterRows({
    links: [{ n: 3, url: 'https://scan.test/real/3' }],
    range: [3, 2, 1, 4].map((n) => ({ n, url: chapter(n) })),
    readUrls: [chapter(1).replace(/\/$/, '')],
    readUpTo: 2,
    savedUrls: [chapter(4) + '#top'],
  });
  assert.deepEqual(rows.map((r) => r.n), [1, 2, 3, 4]);
  assert.equal(rows[2].url, 'https://scan.test/real/3');
  assert.deepEqual(rows.map((r) => r.read), [true, true, false, false], 'read: in the history, or up to the bookmark');
  assert.deepEqual(rows.map((r) => r.saved), [false, false, false, true], 'the same chapter however its address ends');
});

test("the phone's core builds the list from the page and from the bookmark", async () => {
  const entry = {
    id: 'a', title: 'Blue Box', sourceDomain: 'scan.test', sourceUrl: SERIES, lastKnownChapter: '5',
  };
  const progress = { [SERIES]: { sourceUrl: SERIES, chapterUrl: chapter(2), chapterLabel: 'Chapter 2', updatedAt: '2025-01-01T00:00:00.000Z' } };
  const dev = bootCore({
    storage: { library: [entry], progress },
    fetch: async (url) => (String(url) === SERIES ? html(PAGE) : json({})),
  });
  const r = await dev.hub({ type: 'seriesChapters', sourceUrl: SERIES, saved: [chapter(5)] });
  assert.deepEqual(r.chapters.map((c) => c.n), [1, 2, 3, 4, 5], 'the page had 1 to 3, the bookmark and the latest give 4 and 5');
  assert.deepEqual(r.chapters.filter((c) => c.read).map((c) => c.n), [1, 2]);
  assert.deepEqual(r.chapters.filter((c) => c.saved).map((c) => c.n), [5]);

  // A wall in front of the page: only what the bookmark can work out.
  const walled = bootCore({
    storage: { library: [entry], progress },
    fetch: async () => html('<title>Just a moment...</title><div id="cf-browser-verification"></div>'),
  });
  const w = await walled.hub({ type: 'seriesChapters', sourceUrl: SERIES });
  assert.deepEqual(w.chapters.map((c) => c.n), [1, 2, 3, 4, 5]);
});

// --- 2. the queue -------------------------------------------------------------

/** A queue with no real waiting, and a browser stand-in answering from a table. */
function queueWith(answers, opts = {}) {
  const asked = [];
  const saved = [];
  const queue = createSaveQueue({
    pauseMs: 0,
    timeoutMs: opts.timeoutMs ?? 1000,
    retries: 1,
    storage: { load: async () => opts.stored ?? [], save: async (jobs) => saved.push(jobs) },
  });
  queue.setDriver(async (job) => {
    asked.push(job.url);
    const a = answers[job.url];
    const next = Array.isArray(a) ? a.shift() : a;
    if (next === 'hang') return new Promise(() => {});
    return next ?? { ok: true };
  });
  return { queue, asked, saved };
}

const settled = (queue) => new Promise((resolve) => {
  const check = () => { if (queue.snapshot().status !== 'running') resolve(queue.snapshot()); };
  queue.subscribe(check);
  check();
});

test('chapters are saved one after the other, a failure tried once more', async () => {
  const { queue, asked } = queueWith({ [chapter(2)]: [{ ok: false, error: 'page 3' }, { ok: true }], [chapter(3)]: { ok: false, error: 'gone' } });
  queue.add([1, 2, 3, 4].map((n) => ({ url: chapter(n), n, sourceUrl: SERIES })));
  const end = await settled(queue);
  assert.deepEqual(asked, [chapter(1), chapter(2), chapter(2), chapter(3), chapter(3), chapter(4)]);
  assert.deepEqual(end.jobs.map((j) => j.state), ['saved', 'saved', 'failed', 'saved']);
  assert.equal(end.saved, 3);
  assert.equal(end.failed, 1);
});

test('a full store stops the queue and keeps what was left to do', async () => {
  const { queue } = queueWith({ [chapter(2)]: { ok: false, error: 'offline-full' } });
  queue.add([1, 2, 3].map((n) => ({ url: chapter(n), n, sourceUrl: SERIES })));
  const end = await settled(queue);
  assert.equal(end.status, 'stopped');
  assert.equal(end.reason, 'full');
  assert.deepEqual(end.jobs.map((j) => j.state), ['saved', 'waiting', 'waiting']);
});

test('a chapter that never answers costs its time, not the queue', async () => {
  const { queue } = queueWith({ [chapter(1)]: 'hang' }, { timeoutMs: 30 });
  queue.add([1, 2].map((n) => ({ url: chapter(n), n, sourceUrl: SERIES })));
  const end = await settled(queue);
  assert.deepEqual(end.jobs.map((j) => j.state), ['failed', 'saved']);
});

test('cancelling stops after the chapter under way and forgets the rest', async () => {
  let release;
  const { queue, asked } = queueWith({ [chapter(1)]: new Promise((r) => { release = r; }) });
  queue.setDriver(async (job) => { asked.push(job.url); return job.url === chapter(1) ? new Promise((r) => { release = r; }) : { ok: true }; });
  queue.add([1, 2, 3].map((n) => ({ url: chapter(n), n, sourceUrl: SERIES })));
  await new Promise((r) => setTimeout(r, 5));
  queue.cancel();
  release({ ok: true });
  const end = await settled(queue);
  assert.equal(end.reason, 'cancelled');
  assert.deepEqual(asked, [chapter(1)]);
  assert.deepEqual(end.jobs.filter((j) => j.state === 'waiting'), [], 'nothing left waiting after a cancel');
});

test('the same chapter asked twice is queued once, and an unfinished queue is kept and taken up again', async () => {
  const { queue, saved } = queueWith({ [chapter(2)]: 'hang' }, { timeoutMs: 200 });
  queue.add([{ url: chapter(1), n: 1 }, { url: chapter(2), n: 2 }]);
  queue.add([{ url: chapter(2), n: 2 }, { url: chapter(3), n: 3 }]);
  assert.equal(queue.snapshot().jobs.length, 3);
  await new Promise((r) => setTimeout(r, 10));
  const kept = saved.at(-1);
  assert.deepEqual(kept.map((j) => j.url), [chapter(2), chapter(3)], 'what is still to do is written down');

  const again = queueWith({}, { stored: kept });
  await again.queue.restore();
  const end = await settled(again.queue);
  assert.deepEqual(end.jobs.map((j) => [j.url, j.state]), [[chapter(2), 'saved'], [chapter(3), 'saved']]);
});

test('a chapter kept for later is not a chapter read: the hidden reader cannot write', () => {
  for (const type of ['recordRead', 'saveProgress', 'addToLibrary', 'migrateEntry', 'pageDetected',
    'trackerPushOne', 'trackerAdd', 'trackerLink', 'storageSet', 'storageRemove', 'offlineRemove', 'openUrl', 'share', 'goHome']) {
    assert.ok(!HIDDEN_PAGE_TYPES.has(type), `${type} is open to the hidden reader`);
  }
  for (const type of ['getRules', 'offlinePage', 'offlineFetchPage', 'offlineCommit', 'chapterPages', 'storageGet']) {
    assert.ok(HIDDEN_PAGE_TYPES.has(type), `${type} is closed to the hidden reader`);
  }
  const saver = read('native', 'src', 'components', 'OfflineSaver.js');
  assert.match(saver, /if \(!HIDDEN_PAGE_TYPES\.has\(payload\.msg\.type\)\)/);
  assert.match(saver, /if \(payload\.k !== secret\) return;/);
});

// --- 3. the command a page cannot send ------------------------------------------

const KEY = 'k'.repeat(64);

function shellPage() {
  const posted = [];
  const context = vm.createContext({ console: { warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval });
  context.window = context;
  context.globalThis = context;
  context.location = { href: chapter(1) };
  context.document = { title: 'x' };
  context.ReactNativeWebView = { postMessage: (s) => posted.push(s) };
  vm.runInContext(`(function(__pfKey){'use strict';\n${read('native', 'inject', 'rn-bridge.js')}\n${read('mobile', 'inject', 'chrome-shim.js')}\n})(${JSON.stringify(KEY)});`, context);
  const chrome = vm.runInContext(`window.__pfPrivateChrome(${JSON.stringify(KEY)})`, context);
  return { chrome, posted, page: (code) => vm.runInContext(code, context) };
}

test('only the shell, holding the key, reaches a content script as the shell', async () => {
  const p = shellPage();
  const senders = [];
  p.chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    senders.push(!!(sender && sender.shell));
    respond({ ok: true });
  });
  // The page itself, through the door the toolbar uses, and with a guessed key.
  p.page(`window.PanelFlowPage.dispatch({ type: 'saveOfflineNow' }, 1)`);
  assert.equal(p.page(`window.PanelFlowPage.command({ type: 'saveOfflineNow' }, 2, 'guess')`), false);
  // The shell.
  p.page(`window.PanelFlowPage.command({ type: 'saveOfflineNow' }, 3, ${JSON.stringify(KEY)})`);
  assert.deepEqual(senders, [false, true]);
  // Its answer comes back signed, so the shell can tell it from a forged one.
  const reply = p.posted.map((s) => JSON.parse(s)).find((m) => m.reply && m.reply.id === 3);
  assert.equal(reply.k, KEY);
});

test('the reader saves on command only when the shell sent it', () => {
  const reader = read('extension', 'content', 'reader.js');
  assert.match(reader, /msg\?\.type !== 'saveOfflineNow' \|\| !sender \|\| sender\.shell !== true/);
});

// --- 4. the words -----------------------------------------------------------------

const KEYS = [
  'mobileOfflineTitle', 'mobileOfflineCount', 'mobileOfflineUnread', 'mobileOfflineAll', 'mobileOfflineNone',
  'mobileOfflineChapter', 'mobileOfflineRead', 'mobileOfflineSaved', 'mobileOfflineQueued', 'mobileOfflineSaving',
  'mobileOfflineSpace', 'mobileOfflineSaveOne', 'mobileOfflineSaveN', 'mobileOfflinePick', 'mobileOfflineLoading',
  'mobileOfflineNoList', 'mobileOfflineProgress', 'mobileOfflineCancel', 'mobileOfflineDone', 'mobileOfflineFull',
  'mobileOfflineSomeFailed',
];

test('every sentence of the offline list is in both languages, and none says "download"', () => {
  for (const lang of ['en', 'fr']) {
    const messages = JSON.parse(read('shared', '_locales', lang, 'messages.json'));
    for (const key of KEYS) {
      assert.ok(messages[key]?.message, `${lang}: ${key} is missing`);
      assert.doesNotMatch(messages[key].message, /download|télécharg/i, `${lang}: ${key}`);
    }
  }
});

test('the sheet opens the list, under the offline name', () => {
  const sheet = read('native', 'src', 'EntrySheet.js');
  assert.match(sheet, /onOffline\?\.\(entry\)/);
  assert.match(sheet, /t\('navSaved'\)/);
});
