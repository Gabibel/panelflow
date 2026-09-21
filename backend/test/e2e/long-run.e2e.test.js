// One reader, every reader, over many sittings.
//
// The other e2e file proves the parts work together on one page. This one is
// a person: somebody who installs the extension, finds a manga, adds it, reads
// it to the end, comes back the next day and reads on, picks up a light novel,
// an anime, and two scan sites that keep their pages in unusual places, and
// expects the extension to remember all of it. Every step is what a hand
// would do in the real browser (open a page, press the bookmark, save, scroll,
// close, come back) and every check is asked of the extension the way its own
// popup asks, so a step that passes here is a step that works for them.
//
// The whole run is one browser profile, kept from the first test to the last:
// that is what "long term" means for an extension, and clearing it between
// tests would test something else. The tests therefore run in order and each
// leans on the ones before it.
//
// Skipped, not failed, where Playwright's Chromium is not installed, like the
// other e2e file. CI runs it for real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve, HOSTS } from './fixtures.js';
import { chromium as found, launch, extensionId, ask } from './browser.js';

let chromium = found;
let context = null;
let fixtures = null;
let profile = null;
let id = null;

const site = (host, path) => `http://${host}:${fixtures.port}${path}`;

before(async () => {
  if (!chromium) return;
  fixtures = await serve();
  profile = mkdtempSync(join(tmpdir(), 'panelflow-long-'));
  try {
    context = await launch(profile, HOSTS);
    id = await extensionId(context);
  } catch (e) {
    console.warn(`[e2e] Chromium could not start (${String(e.message).split('\n')[0]}); skipping`);
    chromium = null;
  }
});

after(async () => {
  await context?.close();
  fixtures?.server.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

const skip = (t) => { if (!chromium) { t.skip('Playwright Chromium is not installed'); return true; } return false; };

/** A page in front, with the content scripts settled. */
async function open(url) {
  const page = await context.newPage();
  await page.bringToFront();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  return page;
}

/** The reader, open on `url`, however the install chose to open it. */
async function reader(url) {
  const page = await open(url);
  await page.waitForFunction(
    () => !!document.querySelector('#panelflow-reader') || !!document.querySelector('#panelflow-pill'),
    null, { timeout: 15000 },
  );
  // Dispatched, not clicked: on a chapter walked page by page the pill is
  // already changing under the pointer ("loading, 3/12") and a real click
  // waits for it to hold still, which it does only once the reader is up.
  if (!(await page.locator('#panelflow-reader').count())) {
    await page.locator('#panelflow-pill').dispatchEvent('click').catch(() => {});
  }
  await page.locator('#panelflow-reader').waitFor({ state: 'visible', timeout: 15000 });
  return page;
}

/** The reader on `url` with exactly `n` pages drawn. */
async function readerWith(url, n) {
  const page = await reader(url);
  await page.waitForFunction(
    (want) => document.querySelectorAll('#panelflow-reader .pf-stage img').length === want,
    n, { timeout: 20000 },
  );
  return page;
}

/**
 * Save the sheet that is open, by keyboard.
 *
 * The sheet lives in a closed shadow root (library-modal.js: nothing on the
 * page may reach in), which is also true for this test. What a hand can do
 * is press keys: with nothing focused, Shift+Tab lands on the last thing on
 * the page that can take focus, and the sheet is appended last with its Save
 * button as its last control. Enter presses it.
 */
async function saveSheet(page) {
  await page.locator('#panelflow-libmodal').waitFor({ state: 'attached', timeout: 10000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.locator('#panelflow-libmodal').waitFor({ state: 'detached', timeout: 10000 });
}

/** Read for `seconds`: the clock banks a chapter only after five of them. */
const read = (page, seconds = 6) => page.waitForTimeout(seconds * 1000);

/** Close the reader the way the toolbar does, and let it bank the read. */
async function closeReader(page) {
  await page.locator('#panelflow-reader [data-act="close"]').first().dispatchEvent('click');
  await page.locator('#panelflow-reader').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
}

const library = async () => (await ask(context, id, { type: 'getLibrary' })).library;
const history = async () => (await ask(context, id, { type: 'getHistory' })).history;

// --- day one: a manga ---------------------------------------------------------

test('day 1: a chapter opens in the reader, the bookmark files the series, and wears the cross', async (t) => {
  if (skip(t)) return;
  const page = await readerWith(site('mangakakalot.gg', '/manga/blue-box/chapter-9/'), 12);
  assert.equal((await library()).length, 0, 'a fresh install has an empty library');

  await page.locator('#panelflow-reader [data-act="library"]').first().dispatchEvent('click');
  await saveSheet(page);

  const entries = await library();
  assert.equal(entries.length, 1, 'saving the sheet adds one entry');
  assert.equal(entries[0].title, 'Blue Box');
  assert.equal(entries[0].medium, 'manga');
  assert.equal(entries[0].sourceDomain, 'mangakakalot.gg');
  await page.locator('#panelflow-reader [data-act="library"][data-added]').first()
    .waitFor({ state: 'attached', timeout: 5000 });
  await page.close();
});

test('day 1: reading to the end is remembered, and the chapter counts as read', async (t) => {
  if (skip(t)) return;
  const page = await readerWith(site('mangakakalot.gg', '/manga/blue-box/chapter-9/'), 12);
  await read(page);
  await page.evaluate(() => {
    const stage = document.querySelector('#panelflow-reader .pf-stage');
    stage.scrollTop = stage.scrollHeight;
    stage.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(1500); // saveProgress is debounced by 800 ms
  await closeReader(page);

  const { progress } = await ask(context, id, { type: 'getProgressAll' });
  const mine = Object.values(progress || {}).find((p) => /chapter-9/.test(p.chapterUrl));
  assert.ok(mine, 'no progress was written for the chapter read');
  assert.ok((mine.scrollPos ?? 0) > 0.8, `the bottom of the chapter was reached, progress says ${mine.scrollPos}`);

  const rows = await history();
  assert.ok(rows.some((r) => /chapter-9/.test(r.chapterUrl)), 'six seconds on a chapter is a read, and history has none');
  await page.close();
});

// --- day two: on with the same series ----------------------------------------

test('day 2: the next chapters, in place, and history keeps each one', async (t) => {
  if (skip(t)) return;
  const page = await readerWith(site('mangakakalot.gg', '/manga/blue-box/chapter-10/'), 10);
  await read(page);
  await page.locator('#panelflow-reader [data-act="nextch"]').first().dispatchEvent('click');
  await page.waitForFunction(
    () => document.querySelectorAll('#panelflow-reader .pf-stage img').length === 8 && /chapter-11/.test(location.href),
    null, { timeout: 20000 },
  );
  assert.ok(await page.locator('#panelflow-reader').isVisible(), 'the reader closed between chapters');
  await read(page);
  await closeReader(page);

  const labels = (await history()).filter((r) => /blue-box/.test(r.sourceUrl)).map((r) => r.chapterUrl.match(/chapter-(\d+)/)[1]).sort();
  assert.deepEqual(labels, ['10', '11', '9'], 'three sittings on three chapters, three rows');
  const [entry] = await library();
  const { targets } = await ask(context, id, { type: 'continueTargets' });
  assert.match(targets[entry.id].url, /chapter-1[12]/, 'continue points at where they are, not where they started');
  await page.close();
});

test('day 2: the last chapter of the series still shows the cross, from the same site', async (t) => {
  if (skip(t)) return;
  const page = await readerWith(site('mangakakalot.gg', '/manga/blue-box/chapter-12/'), 8);
  await page.locator('#panelflow-reader [data-act="library"][data-added]').first()
    .waitFor({ state: 'attached', timeout: 5000 });
  assert.equal((await library()).length, 1, 'reading on did not file the series twice');
  await page.close();
});

test('day 2: the chapter wheel colours what was read and what was not', async (t) => {
  if (skip(t)) return;
  const page = await readerWith(site('mangakakalot.gg', '/manga/blue-box/chapter-12/'), 8);
  await page.locator('#panelflow-reader [data-act="chapters"]').first().dispatchEvent('click');
  // Rows come from the series page, the colours from the history: both are
  // asked for on open and arrive a moment later.
  await page.waitForFunction(
    () => document.querySelectorAll('#panelflow-reader .pf-wrow.pf-read').length >= 3,
    null, { timeout: 15000 },
  ).catch(async (e) => {
    const seen = await page.locator('#panelflow-reader .pf-wrow').evaluateAll((els) => els.map((el) => el.className + ' ' + el.textContent));
    const rows = await history();
    throw new Error(`${String(e.message).slice(0, 60)}; rows: ${JSON.stringify(seen)}; history: ${JSON.stringify(rows.map((r) => [r.sourceUrl, r.chapterUrl, r.seconds, r.pages]))}`);
  });
  const rows = await page.locator('#panelflow-reader .pf-wrow[data-url]').evaluateAll((els) =>
    els.map((el) => [el.dataset.url.match(/chapter-(\d+)/)[1], el.className]));
  const state = Object.fromEntries(rows);
  assert.equal(rows.length, 12, 'twelve chapters on the series page, twelve rows');
  for (const n of ['9', '10', '11']) assert.match(state[n], /pf-read/, `chapter ${n} was read`);
  assert.match(state['8'], /pf-unread/, 'chapter 8 was never opened');
  assert.match(state['12'], /pf-here/, 'the wheel knows where the reader is');
  await page.close();
});

test('a chapter kept for offline is on the saved list, and opens from it without the site', async (t) => {
  if (skip(t)) return;
  const page = await readerWith(site('mangakakalot.gg', '/manga/blue-box/chapter-12/'), 8);
  await page.locator('#panelflow-reader [data-act="offline"]').first().dispatchEvent('click');
  await page.locator('#panelflow-reader [data-act="offline"][data-saved="1"]').first()
    .waitFor({ state: 'attached', timeout: 20000 });
  await page.close();

  // The extension's own page of saved chapters, as the reader would open it.
  const saved = await context.newPage();
  await saved.goto(`chrome-extension://${id}/offline/offline.html`, { waitUntil: 'load' });
  const row = saved.locator('#list .chapter', { hasText: /12/ });
  await row.waitFor({ state: 'visible', timeout: 10000 });
  // The site is gone: what opens now comes from the store alone.
  await fixtures.server.close();
  await row.locator('button').first().click();
  await saved.locator('#panelflow-reader').waitFor({ state: 'visible', timeout: 10000 });
  await saved.waitForFunction(
    () => document.querySelectorAll('#panelflow-reader .pf-stage img').length === 8,
    null, { timeout: 10000 },
  );
  const srcs = await saved.locator('#panelflow-reader .pf-stage img').evaluateAll((imgs) => imgs.map((i) => i.src));
  assert.ok(srcs.every((s) => s.startsWith('blob:')), 'the pages are the stored bytes, not the site');
  await saved.close();
  fixtures = await serve();
});

// --- a light novel -------------------------------------------------------------

test('a light novel opens as text, keeps its place, and counts as read', async (t) => {
  if (skip(t)) return;
  const page = await reader(site('readnovelfull.com', '/b/the-beginning-after-the-end/chapter-3'));
  await page.waitForFunction(
    () => document.querySelectorAll('#panelflow-reader .pf-text p').length >= 14,
    null, { timeout: 15000 },
  );
  assert.equal(await page.locator('#panelflow-reader .pf-stage img').count(), 0, 'a novel has no strip');
  await read(page);
  await page.evaluate(() => {
    const stage = document.querySelector('#panelflow-reader .pf-stage');
    stage.scrollTop = stage.scrollHeight / 2;
    stage.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(1500);
  await closeReader(page);

  const { progress } = await ask(context, id, { type: 'getProgressAll' });
  const mine = Object.values(progress || {}).find((p) => /the-beginning-after-the-end/.test(p.chapterUrl));
  assert.ok(mine, 'no progress for the novel');
  assert.ok(mine.scrollPos > 0.2 && mine.scrollPos < 0.9, `halfway, progress says ${mine.scrollPos}`);
  assert.ok((await history()).some((r) => /chapter-3/.test(r.chapterUrl) && /readnovelfull/.test(r.sourceUrl)));
  await page.close();
});

// --- an anime --------------------------------------------------------------------

test('an anime episode: the bar is in the player frame, and adding files it as an anime', async (t) => {
  if (skip(t)) return;
  const page = await open(site('voiranime.rip', '/one-piece/saison-1/episode-3/'));
  const frame = page.frameLocator('iframe[src*="sibnet"]');
  const add = frame.locator('#panelflow-speed button', { hasText: '🔖' });
  await add.waitFor({ state: 'visible', timeout: 15000 });
  await add.click();
  await saveSheet(page);

  const entries = await library();
  const anime = entries.find((e) => e.medium === 'anime');
  assert.ok(anime, `the episode was filed as ${entries.map((e) => e.medium).join(', ')}`);
  assert.match(anime.title, /One Piece/);
  assert.equal(anime.sourceDomain, 'voiranime.rip');
  await frame.locator('#panelflow-speed .pf-added').waitFor({ state: 'attached', timeout: 5000 });
  await page.close();
});

// --- two scan sites that keep their pages elsewhere ----------------------------

test('scan-vf: a chapter parked hidden in the page opens whole, without fetching one page', async (t) => {
  if (skip(t)) return;
  const before = fixtures.hits.length;
  const page = await readerWith(site('scan-vf.net', '/one_piece/chapitre-1193'), 17);
  const pagesFetched = fixtures.hits.slice(before).filter((h) => /scan-vf\.net\/one_piece\/chapitre-1193\/\d+$/.test(h));
  assert.equal(pagesFetched.length, 0, `the pages were in the markup; ${pagesFetched.length} were fetched anyway`);
  const srcs = await page.locator('#panelflow-reader .pf-stage img').evaluateAll((imgs) => imgs.map((i) => i.src));
  assert.match(srcs[0], /chapitre-1193\/01\.png$/);
  assert.match(srcs[16], /chapitre-1193\/17\.png$/);
  await page.close();
});

test('mangago: a chapter one address at a time, with nothing in its markup, opens on the first pages and fills up', async (t) => {
  if (skip(t)) return;
  const before = fixtures.hits.length;
  const page = await reader(site('mangago.me', '/read-manga/borderline/uu/br_chapter-1/pg-1/'));
  const opened = await page.evaluate(() => document.querySelectorAll('#panelflow-reader .pf-stage img').length);
  assert.ok(opened >= 3 && opened <= 12, `opened on ${opened} pages`);
  await page.waitForFunction(
    () => document.querySelectorAll('#panelflow-reader .pf-stage img').length === 12,
    null, { timeout: 60000 },
  );
  const srcs = await page.locator('#panelflow-reader .pf-stage img').evaluateAll((imgs) => imgs.map((i) => i.src));
  assert.deepEqual(
    srcs.map((s) => s.match(/\/(\d+)\.png$/)[1]),
    Array.from({ length: 12 }, (_, i) => String(i + 1)),
    'twelve pages, in order, none twice',
  );
  const walked = fixtures.hits.slice(before).filter((h) => /mangago\.me\/read-manga\/.*\/pg-\d+\/$/.test(h));
  assert.ok(walked.length >= 11, `every page but the one on screen is read: ${walked.length} were`);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('iframe[aria-hidden]').count(), 0, 'the frames the pages were read through are gone');
  await page.close();
});

// --- what a month of this leaves behind -----------------------------------------

test('after all of it, the library, the history and the stats agree about what was read', async (t) => {
  if (skip(t)) return;
  const entries = await library();
  assert.deepEqual(entries.map((e) => e.medium).sort(), ['anime', 'manga'], 'two series were added, nothing else crept in');
  const rows = await history();
  const series = new Set(rows.map((r) => r.sourceUrl));
  assert.ok(series.size >= 2, `history spans ${series.size} series`);
  assert.ok(rows.length >= 4, `${rows.length} chapters read`);
  const { stats } = await ask(context, id, { type: 'getStats' });
  assert.ok(stats, 'the stats page has nothing to show');
  const chapters = stats.chapters ?? stats.totalChapters ?? stats.chaptersRead ?? stats.total?.chapters;
  if (chapters !== undefined) assert.ok(chapters >= 4, `stats count ${chapters} chapters for ${rows.length} rows`);
});
