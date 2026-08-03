'use strict';

const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const $ = (id) => document.getElementById(id);

async function load() {
  const data = await chrome.storage.local.get(['settings', 'readerMode', 'authUser']);
  const s = data.settings || {};
  $('backendUrl').value = s.backendUrl || 'http://localhost:8787';
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
  const settings = {
    backendUrl: $('backendUrl').value.trim().replace(/\/$/, ''),
    whitelist: $('whitelist').value.split('\n').map((l) => l.trim()).filter(Boolean),
  };
  await chrome.storage.local.set({ settings, readerMode: $('readerMode').value });
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
