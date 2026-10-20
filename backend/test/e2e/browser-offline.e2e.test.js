// The E2E browser cannot reach the outside either (QA, P5, OPS-30).
//
// It runs outside the Node process, so the bench's socket guard does not hold
// it; its own resolver rules do: the listed hosts are this machine and every
// other name resolves to nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, chromium } from './browser.js';

test('a name outside the test hosts does not resolve in the E2E browser', async (t) => {
  if (!chromium) return t.skip('Playwright Chromium is not installed');
  const profile = mkdtempSync(join(tmpdir(), 'pf-offline-'));
  let ctx;
  try {
    ctx = await launch(profile, ['mangadex.org']);
  } catch (e) {
    rmSync(profile, { recursive: true, force: true });
    return t.skip(`Chromium could not start (${String(e.message).split('\n')[0]})`);
  }
  try {
    const page = await ctx.newPage();
    const err = await page.goto('http://example.com/', { timeout: 15000 }).then(() => null, (e) => e);
    assert.ok(err, 'example.com loaded');
    assert.match(String(err.message), /ERR_NAME_NOT_RESOLVED/);
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
