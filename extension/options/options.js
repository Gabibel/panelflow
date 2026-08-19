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
function saved(message) {
  $('status').textContent = message || t('statusSaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { $('status').textContent = ''; }, 1800);
}

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

  setAccount(p.user);
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
  saved(t('statusSyncing'));
  const resp = await send({ type: 'syncNow' });
  saved(resp?.ok ? t('statusSynced') : t('authNoAnswer'));
});

$('logout').addEventListener('click', async () => {
  await send({ type: 'logout' });
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
