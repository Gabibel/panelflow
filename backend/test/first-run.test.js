// The first five minutes, with no account.
//
// Every other test in this suite starts from somewhere: a registered user, a
// token, a storage object with a library already in it. The one journey nobody
// had ever walked is the one everybody actually walks first — install the
// extension, open a chapter, read it, close the browser. No account, and on the
// only path where the backend is a stranger that has never heard of you.
//
// Three things have to hold for that to work, and each one fails silently:
//
//   1. The two lists a browser needs before it can do anything — the detection
//      rules and the ad-block list — have to answer without a token. They are
//      mounted outside `requireAuth` today; one line moved in index.js turns a
//      fresh install into an extension that detects nothing, with a 401 nobody
//      sees in a console nobody has open.
//   2. The library, the bookmark and the statistics have to live on the device.
//      Not "degrade gracefully" — work.
//   3. It has to survive the browser closing, which is where a bookmark held in
//      a service worker's memory rather than in storage would be lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, base, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { bootWorker } from '../test-support/worker.js';
import { bootCore } from '../test-support/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test.after(shutdown);

// --- 1. what answers before anyone signs in ---------------------------------

test('the rules and the ad-block list answer with no account', async () => {
  const rules = await api('GET', '/api/rules', undefined, null);
  assert.equal(rules.status, 200, `/api/rules answered ${rules.status} with no token`);
  assert.ok(rules.body?.sites || rules.body?.domains,
    'the rules came back without the per-domain rules a client is asking for');

  const adblock = await api('GET', '/api/adblock', undefined, null);
  assert.equal(adblock.status, 200, `/api/adblock answered ${adblock.status} with no token`);
  assert.ok(Array.isArray(adblock.body?.entries) && adblock.body.entries.length,
    'the filter list came back empty, which a client cannot tell from "block nothing"');
});

test('and everything that is somebody else\'s data still needs the account', async () => {
  // The other half of the same rule. A test that only checked the two public
  // routes would pass just as well on a server that had lost `requireAuth`
  // altogether.
  for (const path of ['/api/me', '/api/library', '/api/progress', '/api/prefs',
    '/api/history', '/api/history/stats', '/api/categories']) {
    const r = await api('GET', path, undefined, null);
    assert.equal(r.status, 401, `${path} answered ${r.status} to a request with no token`);
  }
});

test('and nothing has quietly moved them behind requireAuth', () => {
  // Belt and braces, and cheap: the runtime tests above would catch this too,
  // but this one names the line to put back.
  const src = readFileSync(join(root, 'backend', 'src', 'index.js'), 'utf8');
  for (const mount of ['/api/rules', '/api/adblock']) {
    const line = src.split('\n').find((l) => l.includes(`app.use('${mount}'`));
    assert.ok(line, `${mount} is not mounted where this test looks for it`);
    assert.ok(!line.includes('requireAuth'),
      `${mount} is behind requireAuth; a fresh install cannot reach it`);
  }
});

// --- 2. the journey ---------------------------------------------------------

const CHAPTER = {
  title: 'Ao no Hako',
  sourceDomain: 'sushiscan.fr',
  sourceUrl: 'https://sushiscan.fr/manga/ao-no-hako/',
  chapterUrl: 'https://sushiscan.fr/ao-no-hako-chapitre-109/',
  chapterLabel: 'Chapitre 109',
};

/** A profile that has just installed the extension and pointed at this server. */
const freshProfile = (storage = {}) => bootWorker({
  storage: { settings: { backendUrl: base }, ...storage },
  fetch: (url, init) => fetch(url, init),
});

test('a fresh profile reads a chapter, closes the browser, and comes back to it', async () => {
  const install = freshProfile();

  // The detector reports the page. Nothing here has ever seen a token.
  await install.send({ type: 'pageDetected', meta: CHAPTER });
  const { entry } = await install.send({ type: 'addToLibrary', entry: CHAPTER });
  assert.ok(entry?.id, 'the entry was not added');
  assert.ok(!entry.remoteId, 'a signed-out entry claims a server id');

  // Page nine of twenty, and the reader banks the time on the way out.
  await install.send({
    type: 'saveProgress',
    progress: {
      sourceUrl: CHAPTER.sourceUrl,
      chapterUrl: CHAPTER.chapterUrl,
      chapterLabel: CHAPTER.chapterLabel,
      page: 9,
      pageCount: 20,
      scrollPos: 9 / 19,
    },
  });
  await install.send({
    type: 'recordRead',
    read: { ...CHAPTER, day: '2025-03-01', seconds: 420, pages: 9 },
  });

  // Chrome closes. The service worker is gone; chrome.storage.local is not.
  const relaunch = freshProfile(install.storage());

  const { progress } = await relaunch.send({
    type: 'getProgressFor', chapterUrl: CHAPTER.chapterUrl,
  });
  assert.ok(progress, 'the bookmark did not survive the browser closing');
  assert.equal(progress.page, 9, 'it came back on the wrong page');
  assert.equal(progress.pageCount, 20);

  // And the shelf offers the way back in, which is what the reader actually
  // clicks — a bookmark nothing links to is a bookmark nobody reaches.
  const { library } = await relaunch.send({ type: 'getLibrary' });
  assert.equal(library.length, 1);
  const { targets } = await relaunch.send({ type: 'continueTargets' });
  assert.equal(targets[library[0].id]?.url, CHAPTER.chapterUrl);

  // The whole of it, without ever having sent an Authorization header.
  for (const call of [...install.calls, ...relaunch.calls]) {
    assert.ok(!call.init?.headers?.Authorization,
      `${call.url} was called with a bearer token on a profile that has no account`);
  }
});

test('and the statistics panel has something to say', async () => {
  const w = freshProfile();
  await w.send({ type: 'addToLibrary', entry: CHAPTER });
  for (const [day, label] of [['2025-03-01', 'Ch. 108'], ['2025-03-02', 'Ch. 109']]) {
    await w.send({
      type: 'recordRead',
      read: {
        ...CHAPTER,
        chapterUrl: `${CHAPTER.sourceUrl}${label}`,
        chapterLabel: label,
        day,
        seconds: 300,
        pages: 18,
      },
    });
  }
  const { stats } = await w.send({ type: 'getStats' });
  assert.ok(stats, 'signed out, the panel is told there are no statistics at all');
  assert.equal(stats.local, true, 'the panel cannot tell the reader where these came from');
  assert.equal(stats.chapters, 2);
  assert.equal(stats.seconds, 600);
  assert.equal(stats.series, 1);
  assert.equal(stats.longest, 2, 'two days running is a two-day streak');
  assert.equal(stats.entries, 1);
  assert.equal(stats.days.length, 2);
});

// --- 3. the two answers agree ------------------------------------------------

test('signing in does not change what was read', async () => {
  // The reason the local figures are computed at all, and the reason they are a
  // risk: two implementations of "chapters read" that disagree turn signing in
  // into an event that appears to lose reading. So the same days go through the
  // account and through the device, and the numbers are compared.
  const DAYS = [
    ['2025-03-01', 'Ch. 106', 300],
    ['2025-03-02', 'Ch. 107', 600],
    ['2025-03-05', 'Ch. 108', 120],
  ];

  const { token } = await newUser();
  const remote = await addEntry(token, {
    title: CHAPTER.title,
    sourceDomain: CHAPTER.sourceDomain,
    sourceUrl: CHAPTER.sourceUrl,
    score: 9,
    rereads: 2,
    folder: 'reading',
  });
  for (const [day, label, seconds] of DAYS) {
    const r = await api('POST', '/api/history', {
      libraryId: remote.id,
      chapterUrl: `${CHAPTER.sourceUrl}${label}`,
      chapterLabel: label,
      pages: 18,
      seconds,
      day,
    }, token);
    assert.equal(r.status, 201, `history POST answered ${r.status}`);
  }
  const server = (await api('GET', '/api/history/stats', undefined, token)).body;

  const { core } = bootCore({
    storage: {
      library: [{
        id: 'local-1',
        title: CHAPTER.title,
        sourceDomain: CHAPTER.sourceDomain,
        sourceUrl: CHAPTER.sourceUrl,
        score: 9,
        rereads: 2,
        folder: 'reading',
      }],
    },
  });
  for (const [day, label, seconds] of DAYS) {
    await core.recordRead({
      sourceUrl: CHAPTER.sourceUrl,
      chapterUrl: `${CHAPTER.sourceUrl}${label}`,
      chapterLabel: label,
      day,
      seconds,
      pages: 18,
    });
  }
  const local = await core.getStats();

  for (const key of ['chapters', 'seconds', 'series', 'firstDay', 'secondsPerDay',
    'current', 'longest', 'entries', 'scored', 'avgScore', 'rereads']) {
    assert.deepEqual(local[key], server[key],
      `${key}: the device says ${local[key]}, the account says ${server[key]}`);
  }
  assert.deepEqual(local.days, server.days, 'the two charts are not the same chart');
  // Not the ids — those are this device's and that account's — but the shape
  // the panel draws from.
  assert.deepEqual(
    local.topSeries.map((s) => [s.title, s.chapters, s.seconds]),
    server.topSeries.map((s) => [s.title, s.chapters, s.seconds]));
});

// --- 4. the three lines the popup opens with ---------------------------------

const popupSrc = readFileSync(join(root, 'extension', 'popup', 'popup.js'), 'utf8');

/** `showIntroOnce` lifted out of the shipping popup, which has no exports. */
function liftIntro() {
  const from = popupSrc.indexOf('async function showIntroOnce()');
  const to = popupSrc.indexOf('\n}', from) + 2;
  assert.ok(from !== -1 && to > from, 'showIntroOnce is not where this test expects it');
  return new Function('$', 'chrome', `${popupSrc.slice(from, to)}\nreturn showIntroOnce;`);
}

const introDom = () => {
  const listener = () => ({ on: {}, addEventListener(e, f) { this.on[e] = f; } });
  const els = {
    '#intro': { hidden: true },
    '#intro-dismiss': listener(),
    '#intro-account': listener(),
  };
  return { els, $: (sel) => els[sel] };
};

const stubChrome = (local) => ({
  storage: {
    local: {
      get: async (k) => (k in local ? { [k]: local[k] } : {}),
      set: async (o) => Object.assign(local, o),
    },
  },
  runtime: { openOptionsPage() { local.optionsOpened = true; } },
});

test('the popup explains itself the first time it is opened', async () => {
  const dom = introDom();
  const stored = {};
  await liftIntro()(dom.$, stubChrome(stored))();
  assert.equal(dom.els['#intro'].hidden, false, 'a fresh profile is shown the bare menu');

  // Dismissed by hand, and only then written down: a popup closes the moment
  // focus leaves it, which happens by accident often enough that "shown" and
  // "read" are not the same thing.
  assert.equal(stored.introDismissed, undefined, 'opening the popup counted as reading it');
  await dom.els['#intro-dismiss'].on.click();
  assert.equal(dom.els['#intro'].hidden, true);
  assert.equal(stored.introDismissed, true);

  const again = introDom();
  await liftIntro()(again.$, stubChrome(stored))();
  assert.equal(again.els['#intro'].hidden, true, 'it came back after being dismissed');
});

test('and the three lines say the three things', () => {
  const locale = (lang) => JSON.parse(
    readFileSync(join(root, 'extension', '_locales', lang, 'messages.json'), 'utf8'));
  for (const messages of [locale('en'), locale('fr')]) {
    for (const key of ['popupIntroWhat', 'popupIntroWhere', 'popupIntroAccount',
      'popupIntroDismiss']) {
      assert.ok(messages[key]?.message, `${key} is missing`);
    }
    // Where the button is, and how to get an account — the two things a reader
    // cannot work out alone. The shortcut and the link are the parts that have
    // to survive translation.
    assert.match(messages.popupIntroWhere.message, /<kbd>Alt\+R<\/kbd>/);
    assert.match(messages.popupIntroAccount.message, /id="intro-account"/);
  }
  const html = readFileSync(join(root, 'extension', 'popup', 'popup.html'), 'utf8');
  // Above the menu, so it is read before the rows it explains.
  assert.ok(html.indexOf('<section id="intro"') < html.indexOf('<nav class="menu">'));
  const start = html.indexOf('<section id="intro"');
  const intro = html.slice(start, html.indexOf('</section>', start));
  for (const key of ['popupIntroWhat', 'popupIntroWhere', 'popupIntroAccount']) {
    assert.ok(intro.includes(key), `${key} is in the locale files but on no line of the card`);
  }
});

// --- 5. the banner that stays until there is an account -----------------------
//
// A different thing from the card above, and the difference is the whole
// design. The card explains what PanelFlow is, is read once and dismissed. The
// banner reports a state — signed out — and there is nothing to dismiss while
// that is still true. The setup tour will not let anyone past the account step
// any more, but the tour is a tab, and a tab opened by an extension is a tab a
// lot of people close before it has said anything. This is what they see
// instead, every time, until they act on it.

test('the popup says so, permanently, while there is no account', () => {
  const html = readFileSync(join(root, 'extension', 'popup', 'popup.html'), 'utf8');
  const start = html.indexOf('<section id="no-account"');
  assert.ok(start !== -1, 'the popup never mentions the missing account');
  // Above the menu and above the intro card: it is the one thing on this
  // window that is unfinished.
  assert.ok(start < html.indexOf('<nav class="menu">'));
  assert.ok(start < html.indexOf('<section id="intro"'));
  const banner = html.slice(start, html.indexOf('</section>', start));
  assert.match(banner, /data-i18n="popupNoAccountBody"/);
  assert.match(banner, /id="no-account-go"/);
  // No dismiss button, on purpose. There is nothing to agree to.
  assert.ok(!/no-account-dismiss/.test(banner));

  for (const lang of ['en', 'fr']) {
    const messages = JSON.parse(
      readFileSync(join(root, 'extension', '_locales', lang, 'messages.json'), 'utf8'));
    for (const key of ['popupNoAccountBody', 'popupNoAccountAction']) {
      assert.ok(messages[key]?.message, `${key} is missing from ${lang}`);
    }
  }
});

test('the banner is drawn from the account, and hidden by having one', () => {
  // Lifted rather than restated: the line that hides it sits in the middle of
  // the library render, and a copy of it here would go on passing the day the
  // real one was deleted.
  const from = popupSrc.indexOf("const account = $('#account');");
  const to = popupSrc.indexOf("$('#no-account').hidden", from);
  assert.ok(from !== -1 && to > from, 'the banner is no longer painted with the account line');
  const paint = new Function('$', 'acct', 't',
    `${popupSrc.slice(from, popupSrc.indexOf('\n', to) + 1)}`);

  const els = { '#account': {}, '#no-account': {} };
  els['#account'].classList = { toggle() {} };
  const $ = (sel) => els[sel];

  paint($, { authUser: null }, () => 'no account');
  assert.equal(els['#no-account'].hidden, false);

  paint($, { authUser: { email: 'reader@example.com' } }, () => '');
  assert.equal(els['#no-account'].hidden, true);
});

test('the banner sends the reader to the tour, which is where the step is', () => {
  // Not the options page. The options page has an email box; the tour has the
  // paragraph saying what an account is for, which is the part someone who has
  // not made one yet is missing.
  const wiring = popupSrc.slice(
    popupSrc.indexOf("$('#no-account-go')"),
    popupSrc.indexOf("$('#open-offline')"));
  assert.ok(wiring, 'the button on the banner does nothing');
  assert.match(wiring, /welcome\/welcome\.html/);
});
