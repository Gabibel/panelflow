// Anime, on the sites the owner watches on.
//
// Two reports from September 2026, both about the bookmark in the video bar.
// On Crunchyroll it did nothing: the page names its series nowhere a pattern
// could read, builds its player after loading, and changes episode without
// loading a page, so the bar never learnt what it would add, and its bookmark
// was still on screen because `hidden` does nothing under the bar's own
// styles. And on a site with one address per season and language, every
// series ended in /vostfr/, which the library took for the series' name: the
// second anime opened the first one's sheet, and saving it overwrote it.
//
// One browser profile for the file, the sites turned on as from the popup
// (withGranted). Skipped where Playwright's Chromium is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve, HOSTS } from './fixtures.js';
import { chromium as found, launch, extensionId, ask, withGranted } from './browser.js';

let chromium = found;
let context = null;
let fixtures = null;
let profile = null;
let granted = null;
let id = null;

const site = (host, path) => `http://${host}:${fixtures.port}${path}`;

before(async () => {
  if (!chromium) return;
  fixtures = await serve();
  profile = mkdtempSync(join(tmpdir(), 'panelflow-anime-'));
  try {
    granted = withGranted(['*://*.crunchyroll.com/*', '*://*.anime-sama.to/*', '*://*.vidmoly.to/*']);
    context = await launch(profile, HOSTS, { extension: granted });
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
  if (granted) rmSync(granted, { recursive: true, force: true });
});

const skip = (t) => { if (!chromium) { t.skip('Playwright Chromium is not installed'); return true; } return false; };

async function open(url) {
  const page = await context.newPage();
  await page.bringToFront();
  await page.goto(url, { waitUntil: 'load' });
  return page;
}

/** Save the sheet that is open, by keyboard (see long-run.e2e.test.js). */
async function saveSheet(page) {
  await page.locator('#panelflow-libmodal').waitFor({ state: 'attached', timeout: 10000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.locator('#panelflow-libmodal').waitFor({ state: 'detached', timeout: 10000 });
}

const library = async () => (await ask(context, id, { type: 'getLibrary' })).library;
const progress = async () => (await ask(context, id, { type: 'getProgressAll' })).progress || {};
const history = async () => (await ask(context, id, { type: 'getHistory' })).history || [];

/** The bar's bookmark, in the page or in the player's frame. */
const bookmark = (scope) => scope.locator('#panelflow-speed button', { hasText: '🔖' });

test('a Crunchyroll episode: the bookmark appears once the page says what it is, and files the series and its season', async (t) => {
  if (skip(t)) return;
  const page = await open(site('www.crunchyroll.com', '/fr/watch/GE00000001/first'));
  await bookmark(page).waitFor({ state: 'visible', timeout: 15000 });

  // On the player, not on the site's logo and menu.
  const bar = await page.locator('#panelflow-speed').boundingBox();
  const video = await page.locator('video').boundingBox();
  const header = await page.locator('#site-header').boundingBox();
  assert.ok(bar.y >= header.y + header.height, `the bar sits over the site's header (y ${bar.y})`);
  assert.ok(bar.y >= video.y && bar.x >= video.x, 'the bar is not on the player');

  await bookmark(page).click();
  await saveSheet(page);
  const [entry] = (await library()).filter((e) => e.sourceDomain === 'crunchyroll.com');
  assert.ok(entry, 'nothing was added');
  assert.equal(entry.title, 'Moi, quand je me réincarne en Slime Saison 4');
  assert.equal(entry.medium, 'anime');
  assert.match(entry.sourceUrl, /\/series\/GYZJ43JMR\/that-time-i-got-reincarnated-as-a-slime\?season=4$/);
  assert.equal(progress && (await progress())[entry.sourceUrl]?.chapterLabel, 'Episode 1');

  // The next episode, reached without loading a page: the same entry, one
  // episode further, and no second series.
  await page.locator('#next').click();
  await page.waitForTimeout(1500);
  await bookmark(page).click();
  await saveSheet(page);
  const again = (await library()).filter((e) => e.sourceDomain === 'crunchyroll.com');
  assert.equal(again.length, 1, `the next episode was filed as another series: ${again.map((e) => e.title)}`);
  assert.equal((await progress())[again[0].sourceUrl]?.chapterLabel, 'Episode 2');
  await page.close();
});

test('a page with a video but no episode offers no bookmark to press', async (t) => {
  if (skip(t)) return;
  const page = await open(site('www.crunchyroll.com', '/fr/'));
  await page.locator('#panelflow-speed').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(1500);
  assert.equal(await bookmark(page).isVisible(), false, 'a bookmark that cannot say what it would add is on screen');
  await page.close();
});

test('two anime on a site that files them by season and language are two anime, and a second season a third', async (t) => {
  if (skip(t)) return;
  const add = async (path) => {
    const page = await open(site('anime-sama.to', path));
    const frame = page.frameLocator('iframe[src*="vidmoly"]');
    await bookmark(frame).waitFor({ state: 'visible', timeout: 15000 });
    await bookmark(frame).click();
    await saveSheet(page);
    await page.close();
  };
  await add('/catalogue/cyberpunk-edgerunners/saison1/vostfr/');
  await add('/catalogue/frieren/saison1/vostfr/');
  await add('/catalogue/frieren/saison2/vostfr/');

  const titles = (await library()).filter((e) => e.sourceDomain === 'anime-sama.to').map((e) => e.title).sort();
  assert.deepEqual(titles, ['Cyberpunk : Edgerunners', 'Frieren', 'Frieren Saison 2'],
    'one anime was written over another');
});

test('the next episode, on the same page: once it is watched, the library is there too', async (t) => {
  // Owner's report, September 2026: an anime stayed at the episode it was
  // added from. On this kind of site the next one does not even load a page:
  // the picker moves and the player is replaced.
  if (skip(t)) return;
  const page = await open(site('anime-sama.to', '/catalogue/code-geass/saison1/vostfr/'));
  await bookmark(page.frameLocator('#player')).waitFor({ state: 'visible', timeout: 15000 });
  await bookmark(page.frameLocator('#player')).click();
  await saveSheet(page);
  const entry = (await library()).find((e) => e.title === 'Code Geass');
  assert.ok(entry, 'the series was not added');
  assert.equal((await progress())[entry.sourceUrl]?.chapterLabel, 'Episode 1');

  await page.locator('#nextEpisode').click();
  let player = null;
  for (let i = 0; i < 50 && !player; i++) {
    player = page.frames().find((f) => /embed-code-geass\.html\?ep=2$/.test(f.url())) || null;
    if (!player) await page.waitForTimeout(200);
  }
  assert.ok(player, 'the player was not replaced');
  await player.waitForSelector('#panelflow-speed', { timeout: 15000 });
  // Watched: two minutes of it, at 4× so that it takes half a minute.
  await player.evaluate(async () => {
    const v = document.querySelector('video');
    await v.play();
    v.playbackRate = 4;
  });
  let saved = null;
  for (let i = 0; i < 60; i++) {
    saved = (await progress())[entry.sourceUrl];
    if (saved?.chapterLabel === 'Episode 2') break;
    await page.waitForTimeout(1000);
  }
  assert.equal(saved?.chapterLabel, 'Episode 2', 'the library stayed at the episode it was added from');
  assert.equal(saved.furthest?.chapterLabel, 'Episode 2', 'the bookmark did not move on');
  // Its own address, though the page has one for the whole season: filed
  // under the season's, twenty episodes were one row of history.
  assert.match(saved.chapterUrl, /#episode-2$/);
  const rows = (await history()).filter((r) => r.chapterLabel === 'Episode 2');
  assert.equal(rows.length, 1);
  assert.match(rows[0].chapterUrl, /#episode-2$/);
  // And the bar said so.
  assert.equal(await player.locator('#panelflow-speed .pf-saved').count(), 1);
  await page.close();
});

test('the popup\'s "Add" on an episode page files it as the bar does', async (t) => {
  // The same page, another button: the popup's (and the phone browser's) goes
  // through the detector, which took Crunchyroll's title, "Saison 2 | E3 -
  // …", for the series. It now reads the page as the bar does
  // (shared/episode-page.js).
  if (skip(t)) return;
  const url = site('www.crunchyroll.com', '/fr/watch/GF00000003/dandadan');
  const page = await open(url);
  await page.waitForTimeout(1200);
  const opener = await context.newPage();
  await opener.goto(`chrome-extension://${id}/popup/popup.html`, { waitUntil: 'load' });
  await opener.evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target });
    await chrome.tabs.sendMessage(tab.id, { type: 'openLibraryModal' });
  }, url);
  await opener.close();
  await page.bringToFront();
  await saveSheet(page);
  const entry = (await library()).find((e) => /Dandadan/.test(e.title));
  assert.ok(entry, 'nothing was added');
  assert.equal(entry.title, 'Dandadan Saison 2');
  assert.equal(entry.medium, 'anime');
  assert.match(entry.sourceUrl, /\/series\/GG5H5XQX4\/dan-da-dan\?season=2$/);
  assert.equal((await progress())[entry.sourceUrl]?.chapterLabel, 'Episode 3');
  await page.close();
});
