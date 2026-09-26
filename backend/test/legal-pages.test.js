// The legal pages, held to the code they describe.
//
// A privacy policy is a list of claims about what a program does, and it goes
// wrong the way any other duplicated fact goes wrong: the program changes and
// the page does not. So the page is read here the way a stylesheet is read by
// theme.test.js — as text, checked against the source of the thing it is
// about. Every retention figure on the page is the constant in the code; every
// table in the schema has a row on the page; every "PanelFlow does not …" is a
// grep that comes back empty.
//
// The other half is what the checklist that prompted these pages was about:
// that the pages exist, that every surface links to them, that a person can
// read them before creating an account, and that no page of ours loads
// anything from a third party — which is what makes the "no trackers, no
// cookies" sentence true rather than hopeful.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const LEGAL = ['web/mentions-legales.html', 'web/confidentialite.html', 'web/conditions.html'];
// The same three in English, each a translation of the French one, which
// prevails. Same order as LEGAL.
const LEGAL_EN = ['web/legal-notice.html', 'web/privacy.html', 'web/terms.html'];
const privacy = read('web/confidentialite.html');
const mentions = read('web/mentions-legales.html');
const terms = read('web/conditions.html');
const privacyEn = read('web/privacy.html');
const mentionsEn = read('web/legal-notice.html');

// --- they exist, and every surface can reach them --------------------------

test('the three pages exist and link to each other', () => {
  for (const page of LEGAL) {
    assert.ok(existsSync(join(root, page)), `${page} is missing`);
    const html = read(page);
    for (const other of LEGAL) {
      assert.ok(html.includes(`href="${other.replace('web/', '')}"`), `${page} does not link to ${other}`);
    }
    assert.match(html, /<html lang="fr">/, `${page}: the legal pages are French and say so`);
    assert.ok(html.includes('legal.js'), `${page} does not load legal.js, so the operator's details never fill in`);
  }
});

test('each page has its English version, and each version links back', () => {
  LEGAL_EN.forEach((page, i) => {
    assert.ok(existsSync(join(root, page)), `${page} is missing`);
    const html = read(page);
    for (const other of LEGAL_EN) {
      assert.ok(html.includes(`href="${other.replace('web/', '')}"`), `${page} does not link to ${other}`);
    }
    assert.match(html, /<html lang="en">/, `${page} does not say it is English`);
    assert.ok(html.includes('legal.js'), `${page} does not load legal.js`);
    const french = LEGAL[i].replace('web/', '');
    assert.ok(html.includes(`href="${french}" hreflang="fr"`), `${page} does not link to ${french}`);
    assert.match(html, /which prevail/, `${page} does not say the French version prevails`);
    assert.ok(read(LEGAL[i]).includes(`href="${page.replace('web/', '')}" hreflang="en"`),
      `${LEGAL[i]} does not link to its English version`);
  });
  for (const page of ['web/legal-notice.html', 'web/privacy.html']) {
    assert.match(read(page), /data-legal="contact" class="todo"/, `${page} has no contact mark`);
    assert.match(read(page), /contact address to be provided/);
  }
  // legal.js fills the English pages in English.
  const js = read('web/legal.js');
  assert.match(js, /en: '26 September 2026'/);
  assert.match(js, /document\.documentElement\.lang === 'en'/);
});

test('every surface opens the page in the language it is showing', () => {
  // The page is named by the locale file, so there is one place that says
  // which file is the French policy and which is the English one.
  const pages = { legalNoticePage: 0, legalPrivacyPage: 1, legalTermsPage: 2 };
  for (const [lang, list] of [['fr', LEGAL], ['en', LEGAL_EN]]) {
    const messages = JSON.parse(read(`shared/_locales/${lang}/messages.json`));
    for (const [key, i] of Object.entries(pages)) {
      assert.equal(`web/${messages[key]?.message}`, list[i], `${key} in ${lang} is not ${list[i]}`);
      assert.match(read(list[i]), new RegExp(`<html lang="${lang}">`));
    }
  }
  const options = read('extension/options/options.js');
  const phone = read('native/src/screens/settings/LegalPage.js');
  for (const key of Object.keys(pages)) {
    assert.ok(options.includes(`'${key}'`), `options.js does not open ${key}`);
    assert.ok(phone.includes(`'${key}'`), `LegalPage.js does not open ${key}`);
  }
  assert.ok(options.includes('a.href = `${base}/${t(page)}`'));
  assert.ok(phone.includes('onOpen(`${base}/${t(page)}`)'));
  const account = read('native/src/screens/AccountScreen.js');
  assert.ok(account.includes("t('legalTermsPage')"));
  assert.ok(account.includes("t('legalPrivacyPage')"));
  // And the web app: every legal link carries the key that re-points it.
  const html = read('web/index.html');
  for (const [file, key] of [['mentions-legales', 'legalNoticePage'], ['confidentialite', 'legalPrivacyPage'],
    ['conditions', 'legalTermsPage']]) {
    const links = [...html.matchAll(new RegExp(`<a href="${file}\\.html"[^>]*>`, 'g'))].map((m) => m[0]);
    assert.ok(links.length >= 2);
    for (const a of links) assert.ok(a.includes(`data-i18n-href="${key}"`), `${a} is French whatever the language`);
  }
  assert.ok(read('shared/i18n.js').includes("['data-i18n-href', 'i18nHref', 'href']"));
});

test('the web app links them from the sign-in screen and from the settings', () => {
  const html = read('web/index.html');
  const links = [...html.matchAll(/href="(mentions-legales|confidentialite|conditions)\.html"/g)].map((m) => m[1]);
  // Twice each: once where an account is created, once where it is managed. A
  // policy only reachable after signing in is a policy nobody read before
  // agreeing to it.
  for (const page of ['mentions-legales', 'confidentialite', 'conditions']) {
    assert.ok(links.filter((l) => l === page).length >= 2, `${page}.html is linked ${links.filter((l) => l === page).length} time(s) in index.html; the sign-in screen and the settings both need it`);
  }
  const authView = html.slice(html.indexOf('id="auth-view"'), html.indexOf('id="app-view"'));
  assert.match(authView, /class="legal-links"/, 'the sign-in screen has no legal links');
});

test('the extension and the phone link the same pages, on the account\'s own server', () => {
  const options = read('extension/options/options.js');
  const phone = read('native/src/screens/settings/LegalPage.js');
  // Which file each one opens is the locale file's to say (see "every surface
  // opens the page in the language it is showing" above).
  // Built from the backend URL, not hard-coded: someone running their own
  // server is sent to their own server's pages.
  assert.match(options, /backendBase\(\)/);
  assert.match(phone, /store\.settings\?\.backendUrl/);
  assert.match(read('native/src/screens/SettingsScreen.js'), /Page: LegalPage/, 'the legal page is not in the settings menu');
});

// --- the operator's details: one place, visibly missing until filled --------

test('the operator is named in one file, and an empty contact shows as such', () => {
  const js = read('web/legal.js');
  assert.match(js, /contact:\s*'[^']*'/, 'legal.js has no contact field');
  // Every page carries the mark that legal.js fills — and the visible
  // "à renseigner" text that stays if it cannot.
  for (const page of LEGAL) {
    const html = read(page);
    if (page.endsWith('conditions.html')) continue; // the terms defer to the mentions for contact
    assert.match(html, /data-legal="contact" class="todo"/, `${page} has no contact mark`);
    assert.match(html, /adresse de contact à renseigner/, `${page} does not say the contact is missing when it is`);
  }
  assert.match(mentions, /data-legal="host\.name"/, 'the host is not filled from legal.js');
  assert.match(js, /name: 'Vercel Inc\.'/);
});

// --- every claim on the privacy page is the code -----------------------------

test('every table in the schema has a row on the privacy page', () => {
  // A table added to db.js without a sentence here is data the policy does
  // not admit to. The map is table → the row's first cell.
  const ROW = {
    users: 'Adresse e-mail',
    library: 'Bibliothèque',
    categories: 'Étagères',
    progress: 'Progression',
    history: 'Historique de lecture',
    news: 'Nouveaux chapitres trouvés',
    push_subs: 'Abonnement aux notifications',
    trackers: 'Jetons AniList / MyAnimeList',
    tracker_links: 'Liens vers les trackers',
    password_resets: 'Demandes de réinitialisation',
    email_changes: "Demandes de changement d'adresse",
    prefs: 'Préférences',
    rate_limits: 'Adresse IP',
  };
  const ROW_EN = {
    users: 'E-mail address',
    library: 'Library',
    categories: 'Shelves',
    progress: 'Progress',
    history: 'Reading history',
    news: 'New chapters found',
    push_subs: 'Notification subscription',
    trackers: 'AniList / MyAnimeList tokens',
    tracker_links: 'Tracker links',
    password_resets: 'Reset requests',
    email_changes: 'Address change requests',
    prefs: 'Preferences',
    rate_limits: 'IP address',
  };
  const schema = read('backend/src/db.js');
  const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.ok(tables.length >= 12, 'the schema did not list its tables');
  for (const table of tables) {
    assert.ok(ROW[table], `table "${table}" is in db.js and has no row in the privacy policy — add both`);
    assert.ok(privacy.includes(`<td>${ROW[table]}</td>`), `the privacy page has no "${ROW[table]}" row for table ${table}`);
    assert.ok(privacyEn.includes(`<td>${ROW_EN[table]}</td>`), `privacy.html has no "${ROW_EN[table]}" row for table ${table}`);
  }
});

test('the security log and the counters are what the page says: no address in clear', () => {
  // QA, September 2026: the page said PanelFlow keeps no log of the IP
  // address, and the log held every e-mail and IP address in clear.
  assert.ok(privacy.includes('<td>Journal de sécurité</td>'));
  assert.ok(privacyEn.includes('<td>Security log</td>'));
  assert.ok(privacy.includes("jamais l'adresse elle-même, et rien du tout pour une adresse sans compte"));
  assert.ok(privacy.includes('adresse IP tronquée'));
  const log = read('backend/src/security-log.js');
  assert.ok(log.includes("import { pseudonym, coarseIp } from './pseudonym.js';"));
  assert.ok(log.includes('...pseudonymous(fields)'));
  // The counters are stored under a keyed hash, never the name.
  assert.ok(privacy.includes('empreinte chiffrée (HMAC)'));
  assert.ok(read('backend/src/rate-limit.js').includes('get(bucketKey(bucket)'));
  // Thirty days: the longest runtime-log retention the host offers without a
  // log drain. A drain added later is a change to this page.
  assert.ok(privacy.includes('30 jours au plus'));
  assert.ok(privacyEn.includes('30 days at most'));
});

test('every retention figure on the page is the constant in the code', () => {
  // Reset links: RESET_TTL_MIN in auth.js.
  const ttl = Number(read('backend/src/auth.js').match(/const RESET_TTL_MIN = (\d+);/)[1]);
  assert.ok(privacy.includes(`${ttl} minutes, ou jusqu'à utilisation`), `the page says something other than ${ttl} minutes for reset links`);
  assert.ok(privacyEn.includes(`Valid for ${ttl} minutes, or until used`));
  // ...and the rows go 7 days after they expire (prunePasswordResets).
  assert.ok(read('backend/src/auth.js').includes("expires_at <= datetime('now', '-7 days')"));
  assert.ok(privacy.includes('effacée 7 jours après'));
  // The counters: the rate-limit prune in rate-limit.js keeps a row two days
  // after its window opened, and the nightly cron can take one more day to
  // come round — three days, not the two the page used to say.
  assert.match(read('backend/src/rate-limit.js'), /window_start <= datetime\('now', '-2 days'\)/);
  assert.match(read('vercel.json'), /"schedule": "\d+ \d+ \* \* \*"/, 'the sweep is no longer daily');
  assert.ok(privacy.includes('72 heures au plus'));
  assert.ok(privacyEn.includes('72 hours at most'));
  // Covers: COVER_TTL_MS in meta.js, an in-memory cache and nothing on disk.
  assert.match(read('backend/src/routes/meta.js'), /const COVER_TTL_MS = 24 \* 3600 \* 1000;/);
  assert.ok(mentions.includes('vingt-quatre heures'));
  assert.ok(!/writeFile|createWriteStream/.test(read('backend/src/routes/meta.js')), 'the cover proxy writes to disk, and the page says it does not');
});

test('"no cookies" is true of the code, not only of the page', () => {
  assert.ok(privacy.includes("PanelFlow n'utilise aucun cookie"));
  const web = read('web/app.js') + read('web/sw.js');
  assert.ok(!/document\.cookie/.test(web), 'the web app touches document.cookie');
  const backend = ['backend/src/index.js', 'backend/src/auth.js']
    .map(read).join('\n');
  assert.ok(!/set-cookie|cookie-parser|res\.cookie\(/i.test(backend), 'the server sets a cookie');
  // The session is a bearer token in localStorage, as the page says.
  assert.match(web, /localStorage\.(getItem|setItem)\('pf\.token'/);
});

test('"the password is never stored in clear" is bcrypt in the code', () => {
  assert.ok(privacy.includes('empreinte bcrypt'));
  assert.match(read('backend/src/auth.js'), /bcrypt\.hashSync\(password, 10\)/);
});

test('the deletion the page promises is the button and the route that exist', () => {
  assert.ok(privacy.includes('« Supprimer mon compte »'));
  assert.match(read('web/index.html'), /id="set-delete"/);
  assert.match(read('web/index.html'), /id="delete-dialog"/);
  assert.match(read('backend/src/auth.js'), /authRouter\.delete\('\/me', requireAuth/);
  assert.match(read('shared/panelflow-core.js'), /case 'deleteAccount':/);
  assert.match(read('native/src/screens/AccountScreen.js'), /type: 'deleteAccount'/);
});

test('the sub-processors named are the ones the code talks to', () => {
  for (const name of ['Vercel Inc.', 'Turso Inc.', 'Resend Inc.', 'Expo (650 Industries, Inc.)']) {
    assert.ok(privacy.includes(name), `the privacy page does not name ${name}`);
    assert.ok(privacyEn.includes(name), `privacy.html does not name ${name}`);
  }
  // The app asks Expo for updates at every launch.
  const app = JSON.parse(read('native/app.json')).expo;
  assert.match(app.updates?.url || '', /u\.expo\.dev/);
  assert.equal(app.updates?.checkAutomatically, 'ON_LOAD');
  // The search engines the words go to.
  assert.match(read('shared/search.js'), /html\.duckduckgo\.com/);
  assert.match(read('backend/src/routes/search.js'), /api\.search\.brave\.com/);
  for (const name of ['DuckDuckGo', 'Brave Search']) {
    assert.ok(privacy.includes(name) && privacyEn.includes(name), `the privacy pages do not name ${name}`);
  }
  assert.match(read('backend/src/mail.js'), /api\.resend\.com/);
  assert.match(read('vercel.json'), /"regions": \["dub1"\]/);
  assert.ok(privacy.includes('région de Dublin'));
});

test('the terms say what the checklist asks: free, no purchase, no refund', () => {
  assert.ok(terms.includes('aucune politique de remboursement ne\n    s\'applique') || /aucune politique de remboursement ne\s+s'applique/.test(terms));
  assert.ok(terms.includes('sans achat intégré'));
  // And the code has nothing to sell: no payment provider anywhere.
  const pkg = read('backend/package.json') + read('native/package.json');
  assert.ok(!/stripe|paddle|revenuecat|react-native-iap|expo-in-app-purchases/i.test(pkg), 'a payment library is installed; the terms say there is nothing to buy');
});

test('the export the page describes is the export the code builds', () => {
  // QA, September 2026: "a complete backup" was the shelf alone.
  assert.ok(privacy.includes('une section « compte »'));
  assert.ok(privacyEn.includes('an "account" section'));
  const exporter = read('backend/src/routes/export.js');
  assert.ok(exporter.includes('accountSection(userId)'));
  for (const key of ['prefs:', 'trackers:', 'trackerLinks:', 'newChapters:', 'pushSubscriptions:', 'removedSeries:']) {
    assert.ok(exporter.includes(key), `the export has no ${key}`);
  }
});

test('the ad blocking is where the page says it is', () => {
  for (const page of [privacy, terms]) assert.match(page, /sur ces sites seulement|nulle part ailleurs/);
  assert.match(privacyEn, /and nowhere\s+else/);
  assert.ok(read('extension/background.js').includes('toDnr(remote, { sites })'));
  assert.ok(read('extension/rules/adblock.json').includes('"initiatorDomains"'));
});

test('the covers are described as they are loaded', () => {
  // The legal notice used to say covers are relayed by the server, and two
  // paragraphs later that the browser loads them from their source; both were
  // true, of different surfaces.
  assert.match(mentions, /l'extension et l'application les\s+chargent directement depuis leur source/);
  assert.match(mentionsEn, /the extension and the app load them directly from their source/);
  assert.ok(privacy.includes('qui voit alors votre adresse IP'));
});

// --- nothing from a third party ---------------------------------------------

test('no page of ours loads a script, style, font or image from a third party', () => {
  // This is what makes "no trackers" a fact: an analytics snippet is a
  // <script src="https://…">, a tracking pixel is an <img src="https://…">,
  // a font from Google is a <link href="https://fonts…">. The only external
  // addresses allowed in markup are hyperlinks a person clicks.
  const pages = [
    'web/index.html', ...LEGAL, ...LEGAL_EN, 'extension/popup/popup.html', 'extension/options/options.html',
  ];
  for (const page of pages) {
    const html = read(page);
    for (const m of html.matchAll(/<(script|link|img|iframe|video|audio|source|object|embed)\b[^>]*\b(?:src|href)="(https?:)?\/\/[^"]*"/gi)) {
      assert.fail(`${page} loads a third-party resource: ${m[0].slice(0, 120)}`);
    }
  }
  for (const css of ['web/styles.css', 'web/legal.css', 'shared/theme.css', 'extension/popup/popup.css']) {
    const text = read(css);
    assert.ok(!/@import\s+(url\()?["']?https?:/i.test(text), `${css} imports from a third party`);
    assert.ok(!/url\(\s*["']?https?:\/\//i.test(text), `${css} loads from a third party`);
  }
});

test('the web app talks to one server, and no analytics vendor is anywhere', () => {
  const js = read('web/app.js');
  // Every fetch goes through api()/apiPostRaw(), which prefix the backend.
  for (const m of js.matchAll(/fetch\(([^)]*)\)/g)) {
    assert.match(m[1], /^API \+/, `app.js fetches something that is not the API: ${m[0].slice(0, 80)}`);
  }
  const everything = ['web/app.js', 'web/sw.js', 'web/index.html', 'extension/popup/popup.js',
    'extension/options/options.js', 'extension/background.js'].map(read).join('\n');
  assert.ok(!/gtag|google-analytics|googletagmanager|hotjar|plausible|matomo|segment\.com|mixpanel|amplitude|sentry\.io|facebook\.net|doubleclick/i.test(everything),
    'an analytics or advertising vendor is referenced');
});

test('the report screens write to the operator, and nothing leaves the device on its own', () => {
  // "Report a problem", on the phone, in the extension and on the web, is
  // addressed to the same contact the legal pages name; two addresses would
  // mean reports lost in one of them. And the file that gathers the events
  // has no transport: the privacy page says nothing is sent that the reader
  // did not send.
  const contact = read('web/legal.js').match(/contact: '([^']+)'/)[1];
  assert.match(read('shared/report.js'), new RegExp(`REPORT_TO = '${contact.replace('.', '\.')}'`));
  for (const file of ['shared/report.js', 'native/src/diagnostics.js']) {
    assert.ok(!/fetch\(|XMLHttpRequest|send\(/.test(read(file)), `${file} sends something`);
  }
});
