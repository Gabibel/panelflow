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
