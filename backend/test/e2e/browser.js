// The Chromium the end-to-end tests run the extension in.
//
// One place for the three things every e2e file needs and none should have
// to get right twice: finding a Chromium that runs extensions, launching it
// with the extension loaded and the fixture hosts pointed at this machine,
// and reaching the extension's own pages to read what it stored.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const EXTENSION = join(root, 'extension');

export let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}

/**
 * A Chromium to run, when Playwright's own download did not land.
 *
 * `npx playwright install chromium` fetches one build per Playwright version
 * and looks for exactly that one; on a machine where the download is blocked
 * (an antivirus in front of the CDN, this one) an earlier build is often
 * there from another project. Any Chromium runs an unpacked extension, so
 * the newest one found is used. PANELFLOW_E2E_CHROMIUM names one outright.
 */
export function findChromium() {
  if (process.env.PANELFLOW_E2E_CHROMIUM) return process.env.PANELFLOW_E2E_CHROMIUM;
  const cache = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const b of builds) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome',
      'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(cache, b, exe);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * Launch the full Chromium, headless, with the extension loaded and every
 * host in `hosts` resolved to this machine.
 *
 * Two things hide here. Playwright's `headless: true` picks its "headless
 * shell" since 1.49, a trimmed build that does not run extensions: the
 * content scripts never inject and every wait times out, while a test that
 * only asserts absence passes. `channel: 'chromium'` asks for the full build
 * in its new headless mode, which does. That build is the one matching the
 * installed Playwright; where its download did not land (this machine), the
 * newest build in the cache is used by path instead, see findChromium().
 *
 * The hosts are real sites the manifest names: content scripts only run on
 * listed sites, and a test that added a test domain to the rules would ship
 * it to every user. Match patterns ignore the port, so the fixture server's
 * random port is fine.
 */
export async function launch(profile, hosts) {
  const common = {
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`,
    ],
  };
  if (process.env.PANELFLOW_E2E_CHROMIUM) {
    return chromium.launchPersistentContext(profile, { ...common, executablePath: process.env.PANELFLOW_E2E_CHROMIUM });
  }
  try {
    return await chromium.launchPersistentContext(profile, { ...common, channel: 'chromium' });
  } catch (e) {
    const found = findChromium();
    if (!found) throw e;
    return chromium.launchPersistentContext(profile, { ...common, executablePath: found });
  }
}

/** The extension's id in this context, from its service worker's address. */
export async function extensionId(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return new URL(worker.url()).host;
}

/**
 * What the extension holds, asked the way its own popup asks: a message to
 * the core, sent from one of the extension's pages. The page is the popup,
 * opened in a tab of its own and closed after each question.
 */
export async function ask(context, id, message) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${id}/popup/popup.html`, { waitUntil: 'load' });
    return await page.evaluate((msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve)), message);
  } finally {
    await page.close();
  }
}
