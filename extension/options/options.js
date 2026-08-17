'use strict';

const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const $ = (id) => document.getElementById(id);

// Before anything reaches for an element by id: two of the hints on this page
// carry a link and a <code> of their own, so they are placed as markup, and the
// #replay anchor below does not exist until this has run.
PanelFlowI18n.apply();
PanelFlowI18n.markLanguage();

async function load() {
  const data = await chrome.storage.local.get(['readerMode', 'authUser']);
  // Through the worker rather than off storage: `settings` holds only what has
  // been saved, so a second copy of the default would have to live here — and
  // it would be written into storage for real the first time Save is pressed,
  // pinning a stale URL over the one the core actually ships.
  const s = (await send({ type: 'getSettings' }))?.settings || {};
  $('backendUrl').value = s.backendUrl || '';
  $('whitelist').value = (s.whitelist || []).join('\n');
  $('readerMode').value = data.readerMode || 'vertical';
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

$('save').addEventListener('click', async () => {
  // Through the core rather than a direct storage write: `set({ settings })`
  // replaces the whole object, and this form knows only two of its keys — a raw
  // write silently drops checkIntervalMin and anything added to settings later.
  await send({
    type: 'setSettings',
    patch: {
      backendUrl: $('backendUrl').value.trim().replace(/\/$/, ''),
      whitelist: $('whitelist').value.split('\n').map((l) => l.trim()).filter(Boolean),
    },
  });
  await chrome.storage.local.set({ readerMode: $('readerMode').value });
  $('status').textContent = t('statusSaved');
  setTimeout(() => { $('status').textContent = ''; }, 1500);
});

const auth = (kind) => async () => {
  const resp = await send({ type: 'auth', kind, email: $('email').value, password: $('password').value });
  if (resp.error) { $('status').textContent = resp.error; return; }
  setAccount(resp.user);
  $('status').textContent = t('statusConnected');
};
$('login').addEventListener('click', auth('login'));
$('register').addEventListener('click', auth('register'));

// Resetting a password takes an email, a link and a form, and none of that
// belongs in an options page: the web app already has it, the backend serves the
// web app at its root, and one flow means one set of rate limits and one place
// where it can be got right.
$('forgot').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${backendBase()}/#forgot` });
});
// The setup page opens once, on install. This is the only way back to it, and
// it is worth having: it is where "why is there no button in my toolbar" is
// answered, which is a question people ask long after installing.
$('replay').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
});

$('logout').addEventListener('click', async () => {
  await send({ type: 'logout' });
  setAccount(null);
});

load();
