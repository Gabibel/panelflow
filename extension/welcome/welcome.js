// The first two minutes.
//
// A fresh install of PanelFlow does nothing visible: it has no catalogue, its
// button is hidden behind Chrome's puzzle piece, and on any page that is not a
// chapter it is correctly silent. Someone handed the folder by a friend has no
// way to tell that apart from a broken extension, and the reviews of the
// nearest competitor say exactly that about their first day.
//
// So this page answers the four questions that install cannot: where the button
// went, whether the reader opens on its own, whether an account is needed, and
// what to open. Each step writes the real setting as it is answered — the tour
// is the settings screen, not a slideshow shown before one.
//
// It opens once, on install only. `welcomeSeen` is what stops it coming back,
// and the options page can send the user here again on purpose.
'use strict';

const $ = (sel) => document.querySelector(sel);
const { send } = PanelFlowSend;

const STEPS = 4;
let step = 0;

/**
 * A rules key as a hostname you can actually open. The detection rules are
 * keyed by pattern — `*.mangadex.org` covers the site and its subdomains — and
 * a pattern is not a URL: `https://*.mangadex.org/` is a search query, not a
 * page, and Chrome's favicon service returns nothing for it.
 */
function bareHost(pattern) {
  return String(pattern || '').replace(/^\*\./, '').trim();
}

/** The domains shipping tuned extraction rules, sorted, as bare hostnames. */
function tunedHosts(rules) {
  const seen = new Set();
  for (const key of Object.keys((rules && rules.domains) || {})) {
    const host = bareHost(key);
    if (host && !host.includes('*')) seen.add(host);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// --- navigation --------------------------------------------------------------

function show(next) {
  step = Math.max(0, Math.min(STEPS - 1, next));
  for (const section of document.querySelectorAll('.step')) {
    section.hidden = Number(section.dataset.step) !== step;
  }
  for (const dot of document.querySelectorAll('.dots li')) {
    const n = Number(dot.dataset.step);
    dot.classList.toggle('on', n === step);
    dot.classList.toggle('done', n < step);
  }
  window.scrollTo(0, 0);
  if (step === STEPS - 1) loadSites();
}

for (const btn of document.querySelectorAll('[data-go]')) {
  btn.addEventListener('click', () => show(Number(btn.dataset.go)));
}

// --- step 2: when the reader opens ------------------------------------------
// Written on click rather than on "Next", so backing out of the tour halfway
// still leaves the answers the user gave behind.

function paintAuto(on) {
  for (const btn of document.querySelectorAll('.choice')) {
    btn.classList.toggle('on', (btn.dataset.auto === 'on') === on);
  }
}

for (const btn of document.querySelectorAll('.choice')) {
  btn.addEventListener('click', async () => {
    const on = btn.dataset.auto === 'on';
    paintAuto(on);
    await chrome.storage.local.set({ autoShowDefault: on });
  });
}

$('#readerMode').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ readerMode: e.target.value });
});

// --- step 3: the account -----------------------------------------------------

function signedIn(user) {
  $('#auth-form').hidden = !!user;
  $('#auth-done').hidden = !user;
  if (user) {
    $('#who').textContent = user.email;
    // The skip button on this step stops being a skip once there is an account.
    $('#account-next').textContent = t('actionNext');
  }
}

const auth = (kind) => async () => {
  const msg = $('#auth-msg');
  msg.className = 'hint';
  msg.textContent = t('authContacting');
  const resp = await send({
    type: 'auth', kind, email: $('#email').value.trim(), password: $('#password').value,
  });
  if (!resp || resp.error) {
    msg.className = 'hint err';
    // A backend that is down and a password that is wrong are different
    // problems, and only the server knows which one this was.
    msg.textContent = (resp && resp.error) || t('authNoAnswer');
    return;
  }
  msg.textContent = '';
  signedIn(resp.user);
};

$('#register').addEventListener('click', auth('register'));
$('#login').addEventListener('click', auth('login'));

// --- step 4: somewhere to go -------------------------------------------------

let sitesLoaded = false;

async function loadSites() {
  if (sitesLoaded) return;
  sitesLoaded = true;
  const list = $('#sites');
  const msg = $('#sites-msg');
  msg.hidden = true;

  const rules = (await send({ type: 'getRules' }))?.rules;
  const hosts = tunedHosts(rules);

  if (!hosts.length) {
    // Not a failure worth hiding: detection is heuristic first, and the tuned
    // list is an optimisation on top of it. Say what still works.
    msg.hidden = false;
    msg.textContent = t('welcomeSitesUnavailable');
    sitesLoaded = false; // let a later visit try again
    return;
  }

  for (const host of hosts) {
    const row = document.createElement('button');
    row.className = 'site';
    row.type = 'button';
    const icon = document.createElement('img');
    icon.alt = '';
    const fav = faviconUrl(host);
    if (fav) icon.src = fav;
    const label = document.createElement('span');
    label.textContent = host;
    row.append(icon, label);
    // This tab, not a new one: the tour is over, and leaving its tab open
    // behind the site would be one more thing to close.
    row.addEventListener('click', () => finish(`https://${host}/`));
    list.appendChild(row);
  }
}

function faviconUrl(host) {
  try {
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', `https://${host}/`);
    url.searchParams.set('size', '32');
    return url.toString();
  } catch {
    return null;
  }
}

// --- leaving -----------------------------------------------------------------

/** Mark the tour done, then go — to a site if one was picked, else close. */
async function finish(url) {
  await chrome.storage.local.set({ welcomeSeen: true });
  if (url) { location.href = url; return; }
  // `window.close()` is only allowed on windows a script opened, and this tab
  // was opened by the service worker. Asking chrome.tabs to remove the tab we
  // are in is the version that works — and `getCurrent` needs no permission.
  const tab = await new Promise((r) => chrome.tabs.getCurrent(r));
  if (tab && tab.id !== undefined) chrome.tabs.remove(tab.id);
  else window.close();
}

$('#finish').addEventListener('click', () => finish(null));
$('#skip').addEventListener('click', () => finish(null));

// --- boot --------------------------------------------------------------------
// Replaying the tour from the options page has to show what is already set,
// not the defaults — otherwise looking at it would quietly change it.

(async function boot() {
  // The chosen language, if there is one, is read out of storage — so awaiting
  // it is what stands between this page and painting itself in the browser's
  // language first and correcting itself a moment later.
  await PanelFlowI18n.ready;
  PanelFlowI18n.apply();
  PanelFlowI18n.markLanguage();
  const v = await chrome.storage.local.get([
    'autoShowDefault', 'readerMode', 'authUser', 'settings',
  ]);
  // The same expression the popup and detect.js resolve this from. A tour that
  // computed the default its own way would show one thing and the reader do
  // another, which is the exact confusion this page exists to remove.
  //
  // Except on the very first run, where nothing has been chosen yet: the stored
  // default resolves to off, so painting it would show a decision the user has
  // not made, on the one card the page calls the usual choice. There it is
  // written for real instead — clicking through without touching anything then
  // leaves the reader doing what this step said it would.
  if (v.autoShowDefault === undefined && v.settings?.autoOpenReader === undefined) {
    await chrome.storage.local.set({ autoShowDefault: true });
    paintAuto(true);
  } else {
    paintAuto(v.autoShowDefault ?? !!v.settings?.autoOpenReader);
  }
  $('#readerMode').value = v.readerMode || 'vertical';
  signedIn(v.authUser);
  show(0);
})();
