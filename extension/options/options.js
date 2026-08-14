'use strict';

const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const $ = (id) => document.getElementById(id);

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
}

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
  $('status').textContent = 'Saved ✓';
  setTimeout(() => { $('status').textContent = ''; }, 1500);
});

const auth = (kind) => async () => {
  const resp = await send({ type: 'auth', kind, email: $('email').value, password: $('password').value });
  if (resp.error) { $('status').textContent = resp.error; return; }
  setAccount(resp.user);
  $('status').textContent = 'Connected ✓';
};
$('login').addEventListener('click', auth('login'));
$('register').addEventListener('click', auth('register'));
$('logout').addEventListener('click', async () => {
  await send({ type: 'logout' });
  setAccount(null);
});

load();
