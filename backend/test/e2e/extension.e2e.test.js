// The shipping extension, in a real Chromium, on a synthetic scan site.
//
// Every other test in this directory lifts a function out of a file and runs
// it against a stub. This one loads extension/ unpacked into Chromium and
// visits pages served by fixtures.js, which is the one way to find out that
// the manifest, the injection order, the detector, the reader and the popup
// guard work *together* in the place they run. The audit of 18 September
// asked for exactly this before any real site is tried.
//
// The pages are served on a domain the manifest names (mangakakalot.gg),
// mapped to this machine with Chromium's host resolver: content scripts only
// run on listed sites, and a test that added a test domain to the rules
// would ship it to every user. Match patterns ignore the port, so the fixture
// server's random port is fine.
//
// Skipped, not failed, where Playwright's Chromium is not installed: the unit
// suite must keep passing on a clone that never ran `npx playwright install`.
// CI installs it (ci.yml, job e2e) and runs this for real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve, HOSTS } from './fixtures.js';
import { chromium as found, launch } from './browser.js';

const HOST = 'mangakakalot.gg';
let chromium = found;

let context = null;
let fixtures = null;
let profile = null;
const base = () => `http://${HOST}:${fixtures.port}`;

before(async () => {
  if (!chromium) return;
  fixtures = await serve();
  profile = mkdtempSync(join(tmpdir(), 'panelflow-e2e-'));
  try {
    context = await launch(profile, HOSTS);
  } catch (e) {
    // No browser binary: the same "skipped" as no Playwright at all.
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

/** A page of the fixture site, in front, with the content scripts settled. */
async function open(path) {
  const page = await context.newPage();
  // In front, on purpose: the detector does not measure a hidden tab (its
  // images are never laid out) and waits for it to be seen. The extension's
  // own welcome tab, opened on install, would otherwise stay in front.
  await page.bringToFront();
  await page.goto(base() + path, { waitUntil: 'load' });
  // document_idle plus the detector's own settle; the pill is drawn on a timer.
  await page.waitForTimeout(1500);
  return page;
}

/**
 * The reader, open on `path`, with `pages` pages in it.
 *
 * A fresh install opens the reader by itself on a chapter (the setup tour's
 * recommended answer is the default), so most runs find it already open;
 * an install that chose the pill finds the pill and presses it. Either way
 * the assertion is the same: the reader is up and holds exactly the page's
 * images, nothing dropped and nothing (a cover, a logo) picked up by mistake.
 */
async function readerOn(path, pages) {
  const page = await open(path);
  await page.waitForFunction(
    () => !!document.querySelector('#panelflow-reader') || !!document.querySelector('#panelflow-pill'),
    null, { timeout: 15000 },
  );
  if (await page.locator('#panelflow-pill').count()) await page.locator('#panelflow-pill').click();
  await page.locator('#panelflow-reader').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    (n) => document.querySelectorAll('#panelflow-reader .pf-stage img').length === n,
    pages, { timeout: 15000 },
  );
  return page;
}

test('a chapter page opens the reader with every page of the chapter, and only those', async (t) => {
  if (skip(t)) return;
  const page = await readerOn('/manga/blue-box/chapter-9/', 12);
  // The page's own scroll is gone: the reader is what is on screen.
  assert.ok(await page.locator('#panelflow-reader').isVisible());
  await page.close();
});

test('a series index is not a chapter: no pill, no reader', async (t) => {
  if (skip(t)) return;
  const page = await open('/manga/blue-box/');
  await page.waitForTimeout(2000);
  assert.equal(await page.locator('#panelflow-pill').count(), 0, 'a pill on an index page');
  assert.equal(await page.locator('#panelflow-reader').count(), 0, 'the reader opened on an index page');
  await page.close();
});

test('the popup guard keeps a hijacked page from opening an ad, and from swapping a link', async (t) => {
  if (skip(t)) return;
  // The reader opens over the page; the guard is about the page itself, so
  // the reader is closed first and the page clicked bare.
  const page = await readerOn('/manga/hijacked/chapter-1/', 8);
  // The toolbar hides itself a few seconds after the reader opens (it comes
  // back on a tap); a dispatched click does not wait for it to be visible.
  await page.locator('#panelflow-reader [data-act="close"]').dispatchEvent('click');
  await page.locator('#panelflow-reader').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  const before = context.pages().length;

  // The page's own listener opens an advertiser on any click. The guard
  // replaced window.open: no new page may appear.
  await page.click('h1');
  await page.waitForTimeout(800);
  assert.equal(context.pages().length, before, 'the hijack opened a tab');

  // And the "next" link swaps its address under the finger. The guard notes
  // the address at pointerdown and refuses the click when it moved off-site.
  await page.click('#next');
  await page.waitForTimeout(800);
  assert.equal(new URL(page.url()).hostname, HOST, `the swapped link took the page to ${page.url()}`);
  await page.close();
});

test('the reader turns to the next chapter without leaving the reader', async (t) => {
  if (skip(t)) return;
  const page = await readerOn('/manga/blue-box/chapter-9/', 12);
  // The toolbar's own "next chapter" control, hidden or not (see above).
  await page.locator('#panelflow-reader [data-act="nextch"]').dispatchEvent('click');
  await page.waitForFunction(
    () => document.querySelectorAll('#panelflow-reader .pf-stage img').length === 10,
    null, { timeout: 20000 },
  );
  assert.ok(await page.locator('#panelflow-reader').isVisible(), 'the reader closed on the way to the next chapter');
  assert.match(page.url(), /chapter-10/, 'the address bar did not follow the chapter');
  await page.close();
});

/** The reader's chapter button, as the reader reads it. */
const chapterButton = (page) => page.locator('#panelflow-reader .pf-chapbtn').textContent();

/**
 * Press a chapter control and wait for that chapter's strip — and for the
 * reader to take presses again: a press in the moment after a swap is taken
 * as the second half of a double tap, and ignored.
 */
async function turn(page, act, pages) {
  await page.locator(`#panelflow-reader [data-act="${act}"]`).dispatchEvent('click');
  await page.waitForFunction(
    (n) => document.querySelectorAll('#panelflow-reader .pf-stage img').length === n
      && !document.querySelector('#panelflow-reader')?.hasAttribute('aria-busy'),
    pages, { timeout: 20000 },
  );
}

test('going back in place names the chapter on screen, and next does not skip one', async (t) => {
  if (skip(t)) return;
  // QA, September 2026: after ⏭ then ⏮ the reader showed chapter 9 as
  // "Ch. 10", saved it under that name, and the next ⏭ went to chapter 11.
  const page = await readerOn('/manga/blue-box/chapter-9/', 12);
  await turn(page, 'nextch', 10);
  assert.match(page.url(), /chapter-10/);
  await turn(page, 'prevch', 12);
  assert.match(page.url(), /chapter-9\//, 'back did not land on chapter 9');
  assert.match(await chapterButton(page), /\b9\b/, 'chapter 9 is on screen under another name');
  await turn(page, 'nextch', 10);
  assert.match(page.url(), /chapter-10/, `next skipped a chapter: ${page.url()}`);
  await page.close();
});

test('a double press turns one chapter, not two', async (t) => {
  if (skip(t)) return;
  // QA, September 2026: two quick presses read the chapter list a moment
  // apart, and the second one went on from where the first had landed.
  const page = await readerOn('/manga/blue-box/chapter-9/', 12);
  const next = page.locator('#panelflow-reader [data-act="nextch"]');
  await next.dispatchEvent('click');
  await next.dispatchEvent('click');
  await page.waitForFunction(
    () => document.querySelectorAll('#panelflow-reader .pf-stage img').length === 10
      && !document.querySelector('#panelflow-reader')?.hasAttribute('aria-busy'),
    null, { timeout: 20000 },
  );
  await page.waitForTimeout(500);
  assert.match(page.url(), /chapter-10/, `a double press went to ${page.url()}`);
  await page.close();
});

test('a series that is not in the library keeps going past the second chapter', async (t) => {
  if (skip(t)) return;
  // The derived chapter list stops at the chapter being read when nothing
  // says how far the series goes; the next page's own "next" link does.
  const page = await readerOn('/manga/blue-box/chapter-9/', 12);
  await turn(page, 'nextch', 10);
  await page.waitForFunction(
    () => !document.querySelector('#panelflow-reader [data-act="nextch"]')?.hidden,
    null, { timeout: 10000 },
  );
  await turn(page, 'nextch', 8);
  assert.match(page.url(), /chapter-11/, `the third chapter was not reached: ${page.url()}`);
  assert.match(await chapterButton(page), /\b11\b/);
  await page.close();
});

test('closing the reader brings the pill back, and the pill opens it again', async (t) => {
  if (skip(t)) return;
  // QA, September 2026: after ✕ the page came back with nothing on it, and
  // Alt+R — which nobody knows — was the only way back into the reader.
  const page = await readerOn('/manga/blue-box/chapter-9/', 12);
  await page.locator('#panelflow-reader [data-act="close"]').dispatchEvent('click');
  await page.locator('#panelflow-reader').waitFor({ state: 'detached', timeout: 10000 });
  await page.locator('#panelflow-pill').waitFor({ state: 'visible', timeout: 5000 });
  const box = await page.locator('#panelflow-pill').boundingBox();
  assert.ok(box && box.height >= 44, `the pill is ${box?.height}px tall, less than a finger`);
  await page.locator('#panelflow-pill').click();
  await page.locator('#panelflow-reader').waitFor({ state: 'visible', timeout: 15000 });
  await page.close();
});

test('Escape over the library sheet closes the sheet and leaves the reader open', async (t) => {
  if (skip(t)) return;
  const page = await readerOn('/manga/blue-box/chapter-9/', 12);
  await page.locator('#panelflow-reader [data-act="library"]').dispatchEvent('click');
  await page.locator('#panelflow-libmodal').waitFor({ state: 'attached', timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.locator('#panelflow-libmodal').waitFor({ state: 'detached', timeout: 5000 });
  assert.ok(await page.locator('#panelflow-reader').isVisible(), 'Escape closed the reader with the sheet');
  await page.close();
});
