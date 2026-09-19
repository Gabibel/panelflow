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
const privacy = read('web/confidentialite.html');
const mentions = read('web/mentions-legales.html');
const terms = read('web/conditions.html');

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
  for (const file of ['mentions-legales.html', 'confidentialite.html', 'conditions.html']) {
    assert.ok(options.includes(file), `options.js does not point at ${file}`);
    assert.ok(phone.includes(file), `LegalPage.js does not point at ${file}`);
  }
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
  const schema = read('backend/src/db.js');
  const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.ok(tables.length >= 12, 'the schema did not list its tables');
  for (const table of tables) {
    assert.ok(ROW[table], `table "${table}" is in db.js and has no row in the privacy policy — add both`);
    assert.ok(privacy.includes(`<td>${ROW[table]}</td>`), `the privacy page has no "${ROW[table]}" row for table ${table}`);
  }
});

test('every retention figure on the page is the constant in the code', () => {
  // Reset links: RESET_TTL_MIN in auth.js.
  const ttl = Number(read('backend/src/auth.js').match(/const RESET_TTL_MIN = (\d+);/)[1]);
  assert.ok(privacy.includes(`${ttl} minutes, ou jusqu'à utilisation`), `the page says something other than ${ttl} minutes for reset links`);
  // The IP address: the rate-limit prune in rate-limit.js.
  assert.match(read('backend/src/rate-limit.js'), /window_start <= datetime\('now', '-2 days'\)/);
  assert.ok(privacy.includes('48 heures au plus'));
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
  for (const name of ['Vercel Inc.', 'Turso Inc.', 'Resend Inc.']) {
    assert.ok(privacy.includes(name), `the privacy page does not name ${name}`);
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

// --- nothing from a third party ---------------------------------------------

test('no page of ours loads a script, style, font or image from a third party', () => {
  // This is what makes "no trackers" a fact: an analytics snippet is a
  // <script src="https://…">, a tracking pixel is an <img src="https://…">,
  // a font from Google is a <link href="https://fonts…">. The only external
  // addresses allowed in markup are hyperlinks a person clicks.
  const pages = [
    'web/index.html', ...LEGAL, 'extension/popup/popup.html', 'extension/options/options.html',
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
