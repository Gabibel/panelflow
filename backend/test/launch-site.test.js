// What a website is expected to have on the day it is announced (launch
// review, October 2026): a tab icon, a picture for a shared link, a page that
// answers for an address that does not exist, the two files search engines
// read, a help page the App Store listing can point at, HTTPS kept to once a
// browser has seen it, and no link that leads nowhere.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base, shutdown } from '../test-support/harness.js';
import { PUBLIC_PAGES } from '../src/index.js';
import { INK, ACCENT } from '../../scripts/build-icons.mjs';

after(shutdown);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const web = (...p) => join(root, 'web', ...p);
const PAGES = readdirSync(join(root, 'web')).filter((f) => f.endsWith('.html'));
const legalJs = read('web', 'legal.js');
// The top-level `site`, not `host.site` (the host's own address).
const SITE = /^ {4}site: '([^']+)'/m.exec(legalJs)[1];
const CONTACT = /contact: '([^']+)'/.exec(legalJs)[1];

/** A raw request, with the Host and headers a test chooses. */
function raw(path, headers = {}) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('latin1');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('robots.txt keeps crawlers off the API and names the sitemap', async () => {
  const r = await raw('/robots.txt', { host: 'panelflow.example', 'x-forwarded-proto': 'https' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/plain/);
  assert.match(r.body, /^User-agent: \*$/m);
  assert.match(r.body, /^Disallow: \/api\/$/m);
  assert.match(r.body, /^Sitemap: https:\/\/panelflow\.example\/sitemap\.xml$/m);
});

test('the sitemap lists the public pages, and every one of them exists', async () => {
  const r = await raw('/sitemap.xml', { host: 'panelflow.example', 'x-forwarded-proto': 'https' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/xml/);
  for (const page of PUBLIC_PAGES) {
    assert.ok(r.body.includes(`<loc>https://panelflow.example/${page}</loc>`), `${page || '/'} is not in the sitemap`);
    if (page) assert.ok(existsSync(web(page)), `the sitemap lists ${page}, which does not exist`);
  }
  // A Host header is the caller's to write; anything but a host name is not
  // repeated back inside the XML.
  const odd = await raw('/sitemap.xml', { host: 'evil.example"><x' });
  assert.ok(!odd.body.includes('evil.example'), 'the sitemap echoed a Host header that is not a host name');
  // The address mail links use wins over the request's, when it is set.
  process.env.PANELFLOW_PUBLIC_URL = 'https://panelflow.app/';
  try {
    const set = await raw('/sitemap.xml', { host: 'whatever.example' });
    assert.ok(set.body.includes('<loc>https://panelflow.app/aide.html</loc>'));
  } finally {
    delete process.env.PANELFLOW_PUBLIC_URL;
  }
});

test('an address no page answers gets a page that says so; the API keeps its JSON', async () => {
  for (const path of ['/nope.html', '/a/b/c']) {
    const r = await raw(path);
    assert.equal(r.status, 404, path);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.body, /Cette page n'existe pas/);
    assert.match(r.body, /This page does not exist/);
    assert.match(r.headers['content-security-policy'], /script-src 'self'/, 'the 404 page left without the page policy');
  }
  const api = await raw('/api/nope');
  assert.equal(api.status, 404);
  assert.match(api.headers['content-type'], /application\/json/);
  // Served at any depth, so every address in it starts from the root.
  const page = read('web', '404.html');
  for (const [, url] of page.matchAll(/(?:href|src)="([^"#]+)"/g)) {
    assert.ok(url.startsWith('/') || /^https?:/.test(url), `404.html points at ${url}, which is relative`);
  }
  assert.match(page, /<meta name="robots" content="noindex">/);
});

test('HTTPS is kept to once seen, except on a loopback address', async () => {
  const https = await raw('/', { host: 'panelflow.example', 'x-forwarded-proto': 'https' });
  assert.equal(https.headers['strict-transport-security'], 'max-age=63072000');
  const api = await raw('/api/health', { host: 'panelflow.example', 'x-forwarded-proto': 'https' });
  assert.equal(api.headers['strict-transport-security'], 'max-age=63072000', 'the API answered without HSTS');
  const local = await raw('/', { host: 'localhost:8787', 'x-forwarded-proto': 'https' });
  assert.equal(local.headers['strict-transport-security'], undefined, 'HSTS sent to localhost sticks to every local project');
  const plain = await raw('/', { host: 'panelflow.example' });
  assert.equal(plain.headers['strict-transport-security'], undefined, 'HSTS means nothing over plain HTTP');
});

test('the tab icon is served, under both names browsers ask for', async () => {
  const ico = await raw('/favicon.ico');
  assert.equal(ico.status, 200);
  assert.match(ico.headers['content-type'], /^image\/png/);
  assert.equal(ico.body.slice(1, 4), 'PNG');
  const svg = read('web', 'icons', 'favicon.svg');
  const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  assert.ok(svg.includes(`fill="${hex(INK)}"`) && svg.includes(`stroke="${hex(ACCENT)}"`), 'favicon.svg is not in the palette');
  assert.ok(svg.includes('M3 4h18v16H3zM10 4v16M10 12h11'), 'favicon.svg is not the mark');
});

test('every page has the tab icon, a title and a description', () => {
  for (const page of PAGES) {
    const html = read('web', page);
    assert.match(html, /<link rel="icon" href="\/?icons\/favicon\.svg" type="image\/svg\+xml">/, `${page} has no tab icon`);
    assert.match(html, /<link rel="apple-touch-icon" href="\/?icons\/apple-touch-icon\.png">/, `${page} has no home-screen icon`);
    assert.match(html, /<title>[^<]+<\/title>/, `${page} has no title`);
    if (page !== '404.html') assert.match(html, /<meta name="description" content="[^"]{40,}">/, `${page} has no description`);
  }
});

test('a shared link shows a picture and a sentence, from the production server', () => {
  const html = read('web', 'index.html');
  const og = (p) => new RegExp(`<meta property="og:${p}" content="([^"]+)">`).exec(html)?.[1];
  assert.ok(og('title') && og('description') && og('type'));
  assert.equal(og('url'), `${SITE}/`, 'og:url and legal.js name two different servers');
  assert.equal(og('image'), `${SITE}/og-image.png`, 'og:image and legal.js name two different servers');
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  const png = readFileSync(web('og-image.png'));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], 'the picture is not the 1200×630 platforms ask for');
  assert.equal(Number(og('image:width')), 1200);
  assert.equal(Number(og('image:height')), 630);
});

test('the web manifest names icons that exist, at the sizes it claims', () => {
  assert.match(read('web', 'index.html'), /<link rel="manifest" href="manifest\.webmanifest">/);
  const manifest = JSON.parse(read('web', 'manifest.webmanifest'));
  assert.equal(manifest.name, 'PanelFlow');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'no maskable icon for Android');
  for (const icon of manifest.icons) {
    assert.ok(existsSync(web(icon.src)), `${icon.src} is in the manifest and not on disk`);
    if (icon.type === 'image/png') {
      const b = readFileSync(web(icon.src));
      assert.equal(`${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`, icon.sizes, `${icon.src} is not ${icon.sizes}`);
    }
  }
});

test('the manifest is served as a manifest', async () => {
  const r = await raw('/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/manifest\+json/);
});

test('the help page exists in both languages, and every surface links it in its own', () => {
  const fr = read('web', 'aide.html');
  const en = read('web', 'support.html');
  assert.match(fr, /<html lang="fr">/);
  assert.match(en, /<html lang="en">/);
  assert.ok(fr.includes('href="support.html" hreflang="en"') && en.includes('href="aide.html" hreflang="fr"'));
  // The contact is the operator's, in the markup too, for a reviewer without JavaScript.
  for (const page of [fr, en]) {
    assert.ok(page.includes(`<a data-legal="contact" href="mailto:${CONTACT}">${CONTACT}</a>`), 'the help page has another contact');
    assert.ok(page.includes('legal.js'));
  }
  for (const page of ['mentions-legales.html', 'confidentialite.html', 'conditions.html']) {
    assert.ok(read('web', page).includes('<a href="aide.html">Aide</a>'), `${page} does not link the help page`);
  }
  for (const page of ['legal-notice.html', 'privacy.html', 'terms.html']) {
    assert.ok(read('web', page).includes('<a href="support.html">Help</a>'), `${page} does not link the help page`);
  }
  for (const [lang, file] of [['fr', 'aide.html'], ['en', 'support.html']]) {
    assert.equal(JSON.parse(read('shared', '_locales', lang, 'messages.json')).legalHelpPage.message, file);
  }
  const index = read('web', 'index.html');
  assert.equal([...index.matchAll(/<a href="aide\.html" data-i18n-href="legalHelpPage" data-i18n="webHelp"><\/a>/g)].length, 2,
    'the sign-in screen and the settings both need the help link');
  assert.ok(read('native', 'src', 'screens', 'settings', 'LegalPage.js').includes("{ page: 'legalHelpPage', label: 'webHelp' }"));
  // On the phone, the menu row that leads there says it is help, not only law.
  assert.match(read('native', 'src', 'screens', 'SettingsScreen.js'), /\{ id: 'legal', title: 'mobileHelpLegal', Page: LegalPage/);
  assert.ok(read('extension', 'options', 'options.js').includes("['legal-help', 'legalHelpPage']"));
  assert.ok(read('extension', 'options', 'options.html').includes('<a id="legal-help" href="#" data-i18n="webHelp"></a>'));
});

test('what the help page promises is what the code does', () => {
  const fr = read('web', 'aide.html');
  const en = read('web', 'support.html');
  const auth = read('backend', 'src', 'auth.js');
  const minutes = /const RESET_TTL_MIN = (\d+);/.exec(auth)[1];
  assert.ok(fr.includes(`pendant ${minutes} minutes`) && en.includes(`for ${minutes} minutes`), 'the reset link lifetime moved');
  assert.match(auth, /token_epoch = token_epoch \+ 1/, 'a reset no longer signs every device out, as the help page says');
  const days = /const RETENTION_DAYS = (\d+);/.exec(read('shared', 'offline-store.js'))[1];
  assert.ok(fr.includes(`au bout de\n    ${days} jours`) || fr.includes(`au bout de ${days} jours`), 'the offline retention moved');
  assert.ok(en.includes(`after ${days} days`), 'the offline retention moved');
  // Said under the sign-up buttons since the age box left (owner, October 2026).
  assert.match(read('shared', '_locales', 'fr', 'messages.json'), /vous déclarez avoir 15 ans ou plus/);
  assert.match(auth, /bcrypt/);
  assert.match(read('backend', 'src', 'tracker-oauth.js'), /seal\(tok\.access_token\)/, 'the tracker tokens are no longer sealed');
  assert.match(read('native', 'src', 'storage.js'), /SecureStore/, 'the session is no longer in the Keychain');
});

test('no link on the site leads nowhere', () => {
  // Every relative href and src in every page, and every #anchor they name,
  // resolved against the files on disk. The links a script fills in (the
  // data-legal contact, the data-i18n-href pages) are checked as written.
  const ids = new Map(PAGES.map((p) => [p, new Set([...read('web', p).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))]));
  const problems = [];
  for (const page of PAGES) {
    const html = read('web', page);
    // A real attribute, so preceded by a space: data-i18n-href names a key, not a link.
    for (const [, url] of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      if (/^(https?:|mailto:|data:|javascript:)/.test(url) || url === '#' || url === '') continue;
      const [path, anchor] = url.split('#');
      const file = path === '' ? page : path.replace(/^\.?\//, '') || 'index.html';
      if (path !== '' && path !== './' && path !== '/' && !existsSync(web(file))) {
        problems.push(`${page}: ${url} (no such file)`);
        continue;
      }
      const target = path === '' ? page : (path === './' || path === '/' ? 'index.html' : file);
      if (anchor && target.endsWith('.html') && !ids.get(target)?.has(anchor)) {
        problems.push(`${page}: ${url} (no element with that id)`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
