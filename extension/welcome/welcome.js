// The first two minutes.
//
// A fresh install of PanelFlow does nothing visible: it has no catalogue, its
// button is hidden behind Chrome's puzzle piece, and on any page that is not a
// chapter it is correctly silent. Someone handed the folder by a friend has no
// way to tell that apart from a broken extension, and the reviews of the
// nearest competitor say exactly that about their first day.
//
// So this page answers the questions that install cannot: where the button went
// and what PanelFlow should look like, whether the reader opens on its own,
// whether an account is needed, and what to open. Each step writes the real
// setting as it is answered — the tour is the settings screen, not a slideshow
// shown before one.
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

// --- step 1: how it looks ----------------------------------------------------
//
// The one question here whose answer is visible in the asking: the page
// repaints under the click, which says what these three words mean better than
// the swatches beside them do.
//
// It goes two ways at once, exactly as the options page sends it. Sideways into
// this origin's localStorage, where shared/theme.js read it once before any of
// this ran and where the popup and the saved-chapters list will read it next —
// no message passing, no service worker, nothing to wake. Then out through the
// worker to the account, which is the half that reaches the website and the
// phone. `setPrefs` is where those two halves are kept in step.

// Only ever read at sign-in, and only to tell "this reader wants the system's
// theme" apart from "this reader has not been asked yet". Both are 'system'.
let themeAnswered = false;

function paintTheme(value) {
  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    const on = btn.dataset.themeChoice === value;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

for (const btn of document.querySelectorAll('[data-theme-choice]')) {
  btn.addEventListener('click', async () => {
    const value = btn.dataset.themeChoice;
    themeAnswered = true;
    window.panelflowTheme.set(value);
    paintTheme(value);
    await send({ type: 'setPrefs', patch: { theme: value } });
  });
}

// --- step 2: when the reader opens ------------------------------------------
// Written on click rather than on "Next", so backing out of the tour halfway
// still leaves the answers the user gave behind.

function paintAuto(on) {
  for (const btn of document.querySelectorAll('[data-auto]')) {
    btn.classList.toggle('on', (btn.dataset.auto === 'on') === on);
  }
}

for (const btn of document.querySelectorAll('[data-auto]')) {
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
  // The wall. Everything before this step is about this browser and can be
  // answered by anyone; everything after it — the sites picked here, the
  // library, the place read to in a chapter — is kept on an account or is kept
  // nowhere. The tour used to offer to keep it nowhere. It no longer does, so
  // the way on is greyed out until there is somewhere to put it.
  $('#account-next').disabled = !user;
  if (user) $('#who').textContent = user.email;
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
    // And they need different exits. A rejected password is answerable — type
    // the right one. A server that never answered is not, and a required step
    // nobody can complete is a tab with no way out of it and an extension that
    // was never set up. So the door appears, but only then, and only after it
    // has been tried.
    if (!resp) $('#skip').hidden = false;
    return;
  }
  msg.textContent = '';
  await settleTheme(resp.prefs);
  signedIn(resp.user);
};

/**
 * The theme, now that there is an account to keep it on.
 *
 * Which side wins is not a matter of taste. An account that already says "dark"
 * is a reader who answered this question somewhere else — on the website, on
 * the phone, in another browser — and what this install has is a default it was
 * shipped with. So the account wins, and the page changes under them, which is
 * the visible half of what signing in was for.
 *
 * An account with nothing to say is the commoner case on this step, because
 * this step is mostly where an account is *created*. Then the answer just given
 * travels the other way and is waiting on the phone before the phone is
 * installed. Only a real answer travels: 'system' from someone who never
 * touched the control is not an opinion, and writing it onto a fresh account
 * would be this page inventing one.
 */
async function settleTheme(prefs) {
  const theirs = prefs && prefs.theme;
  if (theirs) {
    window.panelflowTheme.adopt(theirs);
    paintTheme(window.panelflowTheme.get());
    return;
  }
  const mine = window.panelflowTheme.get();
  if (!themeAnswered && mine === 'system') return;
  await send({ type: 'setPrefs', patch: { theme: mine } });
}

$('#register').addEventListener('click', auth('register'));
$('#login').addEventListener('click', auth('login'));

// --- step 4: the sites you read ----------------------------------------------
//
// This step used to be a door: click a site, the tour hands you over to it and
// ends. That answered "does this thing work" once, and threw away the only
// moment anyone will ever be asked which sites they actually read.
//
// So a click now does two separate things. It opens the site — in its own tab,
// behind this one, so the tour is still here to pick a second and a third. And
// it remembers the choice, which is the half that outlives the tour: these
// hosts come first in the popup's site list and get their own view on the
// website, on a phone they were never chosen on. Clicking again takes it back.

let sitesLoaded = false;
/** The chosen hosts, in the order they were chosen. */
let favourites = [];

/** Light the cards that are on the list. */
function paintFavourites() {
  for (const row of document.querySelectorAll('[data-host]')) {
    const on = favourites.includes(row.dataset.host);
    row.classList.toggle('on', on);
    row.setAttribute('aria-pressed', String(on));
  }
}

async function toggleFavourite(host) {
  const was = favourites.includes(host);
  favourites = was ? favourites.filter((h) => h !== host) : [...favourites, host];
  paintFavourites();
  // Opening happens on the way in only. Un-choosing a site by mistake and
  // choosing it again should not be punished with a second copy of it.
  if (!was) openSite(host);
  await send({ type: 'setPrefs', patch: { favouriteSites: favourites } });
}

/**
 * The site, in a tab of its own, left in the background.
 *
 * Behind this one on purpose: the reader is in the middle of a list and is
 * being invited to pick more than one thing off it, and a page that jumps away
 * on the first click makes that impossible to discover. The tabs are waiting
 * when the tour is closed.
 */
function openSite(host) {
  const url = 'https://' + host + '/';
  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url, active: false });
  else window.open(url, '_blank');
}

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
    row.dataset.host = host;
    row.setAttribute('aria-pressed', 'false');
    const icon = document.createElement('img');
    icon.alt = '';
    const fav = faviconUrl(host);
    if (fav) icon.src = fav;
    const label = document.createElement('span');
    label.textContent = host;
    row.append(icon, label);
    row.addEventListener('click', () => toggleFavourite(host));
    list.appendChild(row);
  }
  paintFavourites();
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

/** Mark the tour done and close the tab. The sites picked are already open. */
async function finish() {
  await chrome.storage.local.set({ welcomeSeen: true });
  // `window.close()` is only allowed on windows a script opened, and this tab
  // was opened by the service worker. Asking chrome.tabs to remove the tab we
  // are in is the version that works — and `getCurrent` needs no permission.
  const tab = await new Promise((r) => chrome.tabs.getCurrent(r));
  if (tab && tab.id !== undefined) chrome.tabs.remove(tab.id);
  else window.close();
}

$('#finish').addEventListener('click', () => finish());
$('#skip').addEventListener('click', () => finish());

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
    'autoShowDefault', 'readerMode', 'authUser', 'settings', 'accountPrefs',
  ]);
  // shared/theme.js painted this page from localStorage before this file was
  // fetched; this is where the account gets to disagree, on the same terms as
  // at sign-in. The cached copy of the account's answer and not a fresh one —
  // a tour that waits on the network to draw its first step draws nothing at
  // all on the morning the network is down.
  window.panelflowTheme.adopt(v.accountPrefs && v.accountPrefs.theme);
  paintTheme(window.panelflowTheme.get());
  // Same reason: replaying the tour has to show the sites already chosen, or
  // the second visit would look like the first and clicking through it would
  // quietly open four tabs that were already picked months ago.
  favourites = (v.accountPrefs && v.accountPrefs.favouriteSites) || [];
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
