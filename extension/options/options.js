'use strict';

// The settings a reader has reasons to change, and one <details> for the one
// they do not.
//
// Nothing here has a Save button except the two text fields, and they save when
// they lose focus: a settings page whose answers only take effect if you
// remember to press something is a settings page that silently throws answers
// away. That is the same rule the setup tour follows — it writes each choice as
// it is made — and the toast in the corner is what says so.

const { send } = PanelFlowSend;
const $ = (id) => document.getElementById(id);

let saveTimer = 0;
// Long enough to read: a sentence that explains a failure is not a tick.
function saved(message, ms = 1800) {
  $('status').textContent = message || t('statusSaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { $('status').textContent = ''; }, ms);
}

/** What a sync report means, in a sentence. */
const syncVerdict = (r) => {
  if (r?.ok) return t('statusSynced');
  if (!r || r.offline) return t('syncOffline');
  return t('syncIncomplete');
};

// Through the worker rather than off storage, all of it: the same `getPrefs`
// the Settings tab in the web app calls, so the two faces of this page cannot
// drift apart on where a setting lives or what its default is. It also keeps a
// second copy of the shipped API URL out of this file — one that would be
// written into storage for real the first time anything was saved, pinning a
// stale address over the one the core actually ships.
async function load() {
  // `refresh` — this is the page where a setting is read to be changed, so it
  // is worth one round trip to the account before drawing it. Everywhere else
  // takes the cached answer.
  const p = await send({ type: 'getPrefs', refresh: true });
  if (!p) return;                       // worker asleep; nothing to paint from

  // The account's theme, if it has one, applied to a page that has already been
  // painted in this browser's. `adopt` returns false and touches nothing when
  // they agree, which is every load after the first on a given device.
  window.panelflowTheme.adopt(p.theme);
  $('theme').value = window.panelflowTheme.get();
  $('backendUrl').value = p.backendUrl || '';
  pointLegalLinks();
  $('whitelist').value = p.whitelist.join('\n');
  $('checkInterval').value = String(p.checkIntervalMin);

  $('uiLang').value = p.uiLang;
  $('readerMode').value = p.readerMode;
  $('autoShow').checked = p.autoShow;
  $('autoNext').checked = !!p.prefs.autoNext;
  $('hideRead').checked = !!p.prefs.hideRead;
  $('tapZones').value = p.prefs.tapZones;
  // Default true, so a stored prefs object written before this existed still
  // reads as "keep it dark" rather than as "off".
  $('readerDark').checked = p.prefs.readerDark !== false;

  // Only when it has been moved off the default, or when it is asked for by
  // name. Someone self-hosting knows the hash; a reader never sees the field.
  $('advanced').hidden = location.hash !== '#advanced'
    && p.backendUrl === $('backendUrl').placeholder;

  await loadAllSites();

  setAccount(p.user);
  // Why nobody is signed in, when it was the server that ended the session
  // rather than the reader: the account was closed elsewhere, or a password
  // reset retired every token. A page that just showed the sign-in form again
  // left people wondering where their account had gone.
  const { sessionEnded } = (await send({ type: 'getAccount' })) || {};
  if (!p.user && sessionEnded) {
    $('auth-msg').hidden = false;
    $('auth-msg').textContent = sessionEnded.reason === 'deleted' ? t('sessionDeleted') : t('sessionExpired');
  }
  askAboutReset();
}

// The link is worth nothing pointing at a deployment that cannot send mail: the
// reader would type their address, wait, and be told the server is not
// configured. Unawaited, because the rest of this page has no business waiting
// on a network call, and absent is the right answer while it is in flight — and
// the right answer for good if it never comes back.
async function askAboutReset() {
  try {
    const r = await fetch(`${backendBase()}/api/auth/capabilities`);
    $('forgot-line').hidden = !(await r.json()).passwordReset;
  } catch {
    $('forgot-line').hidden = true;
  }
}

// The field wins over the saved setting, so a URL typed but not yet saved still
// leads somewhere; the placeholder is the shipped default, kept in step with
// the core by backend-url.test.js.
const backendBase = () =>
  ($('backendUrl').value.trim() || $('backendUrl').placeholder).replace(/\/$/, '');

// Where the legal pages are: on the server the account is on, in the language
// the page is showing (the locale file names the page, see legalPrivacyPage).
// Re-pointed whenever the backend field or the language changes, so someone
// running their own server is sent to their own server's pages and not to ours.
function pointLegalLinks() {
  const base = backendBase();
  for (const [id, page] of [
    ['legal-notice', 'legalNoticePage'],
    ['legal-privacy', 'legalPrivacyPage'],
    ['legal-terms', 'legalTermsPage'],
    // The two inside the consent line under the sign-in form. They arrive
    // with the translation (optionsConsentLine is -html), so they are looked
    // up rather than assumed.
    ['consent-privacy', 'legalPrivacyPage'],
    ['consent-terms', 'legalTermsPage'],
  ]) {
    const a = $(id);
    if (!a) continue;
    a.href = `${base}/${t(page)}`;
    a.target = '_blank';
    a.rel = 'noopener';
  }
}

function setAccount(user) {
  $('signed-out').hidden = !!user;
  $('signed-in').hidden = !user;
  if (user) $('who').textContent = user.email;
}

// --- writing ----------------------------------------------------------------

// One message for every setting on this page. The worker owns where each one
// lands — three loose keys, the reader's prefs object, the core's settings —
// and re-creates the chapter alarm when the period changes, which is the kind
// of consequence a page should not have to remember.
const patch = (p) => send({ type: 'setPrefs', patch: p });

/** Saves as soon as the control is answered, and says so. */
function onChange(id, write) {
  $(id).addEventListener('change', async () => {
    await write($(id));
    saved();
  });
}

// The theme goes two ways at once, and has to.
//
// Sideways first: shared/theme.js writes it to this origin's localStorage and
// applies it here, which is what makes the popup, the welcome page and the
// saved-chapters list agree with no message passing — and what lets any of
// them be painted in the right theme before a service worker has even woken.
//
// Then out to the account, so the site and the phone hear about it. That is
// the half this page did not do until now: the hint under this control used to
// say "applies to the extension's pages", and a reader who set it here found
// panelflow's website still light. `load()` above is the other end of the same
// wire — it adopts whatever the account says on the way in.
$('theme').value = window.panelflowTheme.get();
$('theme').addEventListener('change', () => {
  window.panelflowTheme.set($('theme').value);
  patch({ theme: $('theme').value });
  saved();
});

onChange('readerMode', (el) => patch({ readerMode: el.value }));
onChange('autoShow', (el) => patch({ autoShow: el.checked }));
onChange('autoNext', (el) => patch({ prefs: { autoNext: el.checked } }));
onChange('hideRead', (el) => patch({ prefs: { hideRead: el.checked } }));
onChange('tapZones', (el) => patch({ prefs: { tapZones: el.value } }));
onChange('readerDark', (el) => patch({ prefs: { readerDark: el.checked } }));
onChange('checkInterval', (el) => patch({ checkIntervalMin: Number(el.value) }));
// `change` on a text field fires on blur or Enter — late enough not to write a
// half-typed hostname, early enough that leaving the page saves what was typed.
onChange('whitelist', (el) => patch({
  whitelist: el.value.split('\n').map((l) => l.trim()).filter(Boolean),
}));
onChange('backendUrl', async (el) => {
  await patch({ backendUrl: el.value.trim().replace(/\/$/, '') });
  pointLegalLinks();
  // A different server is a different answer to "can this send mail".
  askAboutReset();
});

// Changing the language rewrites the whole page, including the toast that says
// it was saved — so the toast is raised last, in the language just chosen.
//
// Wired directly rather than through onChange() for the same reason: this is the
// one control here that can be refused — the map is fetched by the worker, and a
// worker that never woke saves nothing. A blanket "Saved ✓" over the top of that
// would leave the page in the old language insisting it was in the new one.
$('uiLang').addEventListener('change', async () => {
  const resp = await send({ type: 'setLanguage', lang: $('uiLang').value });
  if (!resp || resp.error) { saved(resp?.error || t('authNoAnswer')); return; }
  await PanelFlowI18n.reload();
  PanelFlowI18n.apply();
  PanelFlowI18n.markLanguage();
  pointLegalLinks();
  saved();
});

// --- where PanelFlow may run -------------------------------------------------
//
// Not a preference: a Chrome permission, so it is read and written through
// chrome.permissions rather than through patch(), and it can be refused.
//
// The extension installs with the sites shared/detection-rules.json named the
// day it was built and nothing else, and asks for anything beyond that one
// origin at a time, from the toolbar, on the site in question. This is that
// same request made once and for all. Two reasons to say yes, and the hint
// beside it gives both: a site nobody has added yet, and covers or chapter
// downloads on a site that otherwise works — those images are usually served
// from a domain of their own that no site list mentions.

const ALL_SITES = { origins: ['<all_urls>'] };

async function loadAllSites() {
  $('allSites').checked = await chrome.permissions.contains(ALL_SITES).catch(() => false);
}

// Not onChange(): that one says "saved" whatever happened, and a refused
// prompt saved nothing.
$('allSites').addEventListener('change', async () => {
  const want = $('allSites').checked;
  // Chrome only shows the prompt for a real click, so this is awaited straight
  // off the event with nothing in between.
  const done = want
    ? await chrome.permissions.request(ALL_SITES).catch(() => false)
    : await chrome.permissions.remove(ALL_SITES).catch(() => false);
  // A box left ticked over a refused prompt is a page lying about what the
  // extension may do.
  $('allSites').checked = done ? want : !want;
  if (!done) return;
  // Granting does not inject, and revoking does not stop injecting: the worker
  // registers and unregisters the manifest's own content scripts for whatever
  // is granted beyond what it declares.
  await send({ type: 'syncSites' });
  saved();
});

// --- account ----------------------------------------------------------------

const auth = (kind) => async () => {
  const resp = await send({ type: 'auth', kind, email: $('email').value, password: $('password').value });
  const failed = !resp || resp.error;
  $('auth-msg').hidden = !failed;
  // "No answer at all" is a different problem from "wrong password", and
  // telling someone their password was refused when the server never replied
  // sends them to change a password that was fine.
  if (failed) { $('auth-msg').textContent = resp?.error || t('authNoAnswer'); return; }
  $('password').value = '';
  setAccount(resp.user);
  saved(t('statusConnected'));
};
$('login').addEventListener('click', auth('login'));
$('register').addEventListener('click', auth('register'));

$('sync').addEventListener('click', async () => {
  // Held until the verdict replaces it: a sync can take several seconds, and a
  // "Synchronising…" gone after 1.8 s left the page saying nothing at all
  // while it ran (QA, September 2026). The button is off meanwhile, so a
  // second click is not a second sync.
  $('sync').disabled = true;
  saved(t('statusSyncing'), 60000);
  const resp = await send({ type: 'syncNow' }).finally(() => { $('sync').disabled = false; });
  // The server ended the session while we asked: redraw signed out, with why.
  if (resp?.signedOut) { load(); return; }
  saved(syncVerdict(resp), resp?.ok ? 1800 : 7000);
});

$('logout').addEventListener('click', async () => {
  const r = await send({ type: 'logout' });
  setAccount(null);
  // Signing out erases this device's copy once the server has it; when the
  // server could not be reached, the copy stays — and the reader is told.
  if (r && r.synced === false) saved(t('logoutKept'), 7000);
});

// The account as a file — the same `/api/export` the website links and the
// phone shares. Fetched by the worker, saved by this page as a download: the
// options page is the one surface of the extension that can offer a file.
$('export').addEventListener('click', async () => {
  const resp = await send({ type: 'exportAccount' });
  if (!resp?.data) return saved(resp?.error || t('authNoAnswer'));
  const blob = new Blob([JSON.stringify(resp.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `panelflow-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return saved(t('statusSaved'));
});

// Another address. The hub asks the server, which mails the new inbox a
// link; this page only reports what the server said.
$('email-run').addEventListener('click', async () => {
  const msg = $('email-msg');
  const resp = await send({
    type: 'changeEmail', email: $('new-email').value.trim(), password: $('email-password').value,
  });
  msg.hidden = false;
  msg.textContent = resp?.error || resp?.message || t('authNoAnswer');
  if (resp?.ok) $('email-password').value = '';
});

// Closing the account. The hub deletes on the server and forgets the account
// here (shared/panelflow-core.js, `deleteAccount`); a wrong password comes
// back as an error and nothing changes.
$('delete-run').addEventListener('click', async () => {
  const msg = $('delete-msg');
  const resp = await send({ type: 'deleteAccount', password: $('delete-password').value });
  msg.hidden = false;
  if (!resp || resp.error) {
    msg.textContent = resp?.error || t('authNoAnswer');
    return;
  }
  msg.hidden = true;
  $('delete-password').value = '';
  $('delete-account').open = false;
  setAccount(null);
});

// Resetting a password takes an email, a link and a form, and none of that
// belongs in an options page: the web app already has it, the backend serves the
// web app at its root, and one flow means one set of rate limits and one place
// where it can be got right.
$('forgot').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${backendBase()}/#forgot` });
});
// Last, and in this order for two reasons. The language map is read from
// storage, so nothing may be drawn before it lands or the page paints in one
// language and corrects itself in another. And two of the hints here carry a
// link of their own, placed by apply() from the locale file — so #replay is not
// an element on this page until apply() has run, which is why the one listener
// below is wired here and not with the others.
PanelFlowI18n.ready.then(() => {
  PanelFlowI18n.apply();
  PanelFlowI18n.markLanguage();
  pointLegalLinks();
  // The setup page opens once, on install. This is the only way back to it, and
  // it is worth having: it is where "why is there no button in my toolbar" is
  // answered, which is a question people ask long after installing.
  $('replay').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  });
  // The same settings, in the app people actually have open — which is where
  // the account ones belong, and where someone will look for them first.
  $('site-settings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: `${backendBase()}/#settings` });
  });
  load();
});

// --- report a problem -------------------------------------------------------
//
// The same mail the phone's report screen writes, from what this side knows:
// the extension's version, the browser, the last page a content script found
// a chapter on and what the worker noted (its `diagnostics` message). Read
// when the section is looked at, never sent by anything but the mail client.
const { REPORT_TO, reportLines, mailto } = window.PanelFlowReport;

async function reportBody() {
  const seen = await send({ type: 'diagnostics' }).catch(() => ({}));
  return reportLines({
    description: $('report-what').value.trim(),
    url: seen.lastPage || '',
    events: seen.events || [],
    app: { version: chrome.runtime.getManifest().version, build: 'extension' },
    platform: { os: 'browser', version: navigator.userAgent },
    now: new Date().toISOString(),
  });
}

async function showReport() {
  const lines = await reportBody();
  $('report-included').textContent = lines.filter((l) => l !== '(what happened?)').join('\n');
}

$('report-mail').addEventListener('click', async () => {
  const lines = await reportBody();
  const version = chrome.runtime.getManifest().version;
  // A new tab, not this one: a mailto in the options tab replaces the page
  // in some browsers and leaves the reader wondering where their text went.
  chrome.tabs.create({ url: mailto(REPORT_TO, `PanelFlow ${version} (extension)`, lines) });
});

$('report-copy').addEventListener('click', async () => {
  const lines = await reportBody();
  await navigator.clipboard.writeText(lines.join('\n'));
  saved(t('reportCopied'));
});

showReport();
