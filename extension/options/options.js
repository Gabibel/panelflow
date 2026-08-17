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

async function load() {
  const data = await chrome.storage.local.get(
    ['readerMode', 'readerPrefs', 'authUser', 'autoShowDefault', 'uiLang']);
  // Through the worker rather than off storage: `settings` holds only what has
  // been saved, so a second copy of the default would have to live here — and
  // it would be written into storage for real the first time Save is pressed,
  // pinning a stale URL over the one the core actually ships.
  const s = (await send({ type: 'getSettings' }))?.settings || {};
  $('backendUrl').value = s.backendUrl || '';
  $('whitelist').value = (s.whitelist || []).join('\n');
  $('checkInterval').value = String(s.checkIntervalMin);

  $('uiLang').value = data.uiLang || 'auto';
  $('readerMode').value = data.readerMode || 'vertical';
  // The tour's answer, and before it existed the old single flag in settings —
  // the popup reads it the same way, and disagreeing with the popup about
  // whether the reader opens on its own is worse than either answer.
  $('autoShow').checked = data.autoShowDefault ?? !!s.autoOpenReader;

  const prefs = data.readerPrefs || {};
  $('autoNext').checked = !!prefs.autoNext;
  $('hideRead').checked = !!prefs.hideRead;
  $('tapZones').value = prefs.tapZones || 'sides';

  setAccount(data.authUser);
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

// Through the core rather than a direct storage write: `set({ settings })`
// replaces the whole object, and this form knows three of its keys — a raw
// write silently drops the rest, and anything added to settings later.
const patchSettings = (patch) => send({ type: 'setSettings', patch });

async function patchPrefs(patch) {
  const { readerPrefs } = await chrome.storage.local.get(['readerPrefs']);
  await chrome.storage.local.set({ readerPrefs: { ...readerPrefs, ...patch } });
}

/** Saves as soon as the control is answered, and says so. */
function onChange(id, write) {
  $(id).addEventListener('change', async () => {
    await write($(id));
    saved();
  });
}

onChange('readerMode', (el) => chrome.storage.local.set({ readerMode: el.value }));
onChange('autoShow', (el) => chrome.storage.local.set({ autoShowDefault: el.checked }));
onChange('autoNext', (el) => patchPrefs({ autoNext: el.checked }));
onChange('hideRead', (el) => patchPrefs({ hideRead: el.checked }));
onChange('tapZones', (el) => patchPrefs({ tapZones: el.value }));
// The alarm is created with this period on install and never touched again, so
// changing the number here has to re-create it or the choice is decoration.
onChange('checkInterval', async (el) => {
  const checkIntervalMin = Number(el.value);
  await patchSettings({ checkIntervalMin });
  chrome.alarms.create('pf-check-chapters', { periodInMinutes: checkIntervalMin });
});
// `change` on a text field fires on blur or Enter — late enough not to write a
// half-typed hostname, early enough that leaving the page saves what was typed.
onChange('whitelist', (el) => patchSettings({
  whitelist: el.value.split('\n').map((l) => l.trim()).filter(Boolean),
}));
onChange('backendUrl', async (el) => {
  await patchSettings({ backendUrl: el.value.trim().replace(/\/$/, '') });
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
  load();
});
