// Where the phone's browser may be sent, and by whom.
//
// The bug this exists for, as reported: on voiranime, pressing Play sends the
// reader to an advertiser. The OnClick networks the site runs spend the first
// tap on `window.open` — which popup-guard.js refuses — and then on pointing
// the window itself at the ad. The ad domains rotate weekly, so the decision
// cannot be a list; it has to be about who asked. These tests pin that rule,
// and especially its exceptions, because every one of them is a legitimate
// cross-site navigation that a stricter rule would break: the app's own
// requests, an OAuth handshake coming back to our server, a saved series
// whose site moved domains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, siteOf } from '../../native/src/navigation-policy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ctx = (over = {}) => ({
  here: 'https://voiranime.rip/tomb-raider-king/saison-1/episode-1/',
  asked: 'https://voiranime.rip/tomb-raider-king/',
  trusted: ['panelflow-backend.vercel.app'],
  blocked: ['acscdn.com', 'popads.net'],
  stores: ['apps.apple.com', 'play.google.com'],
  ...over,
});

const script = (url, over = {}) => decide({ url, navigationType: 'other', isTopFrame: true }, ctx(over));
const tap = (url, over = {}) => decide({ url, navigationType: 'click', isTopFrame: true }, ctx(over));

test('script may not leave the site', () => {
  // The hijack itself: the tap landed on Play, and the page answered by
  // pointing the window at a casino.
  const v = script('https://sdk-rotating-name-4471.com/land?z=11467010');
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'script left the site');
});

test('script may go anywhere on its own site', () => {
  assert.ok(script('https://voiranime.rip/tomb-raider-king/saison-1/episode-2/').allow);
  // Another host of the same site is the same site.
  assert.ok(script('https://cdn.voiranime.rip/next').allow);
  assert.ok(script('https://www.voiranime.rip/').allow);
});

test('a link the reader tapped may go anywhere that is not an ad', () => {
  assert.ok(tap('https://t.me/voiranime00').allow);
  assert.equal(tap('https://t.me/voiranime00').reason, 'tapped');
  // Form submissions are the reader's hand too — signing in on a site.
  assert.ok(decide({ url: 'https://other.example/login', navigationType: 'formsubmit', isTopFrame: true }, ctx()).allow);
});

test('an ad host is refused however it was reached', () => {
  assert.equal(tap('https://acscdn.com/script/aclib.js').allow, false);
  assert.equal(tap('https://x.popads.net/go').reason, 'ad host');
  // In a frame as well: the frame exemption comes after the list.
  assert.equal(decide({ url: 'https://acscdn.com/f', navigationType: 'other', isTopFrame: false }, ctx()).allow, false);
});

test('an app store is refused however it was reached', () => {
  // A universal link: https, and iOS answers it by leaving the app.
  assert.equal(tap('https://apps.apple.com/app/id123').reason, 'store');
  assert.equal(script('https://play.google.com/store/apps/details?id=x').allow, false);
});

test('a scheme that is not browsing is refused', () => {
  assert.equal(script('itms-apps://itunes.apple.com/app/id1').reason, 'scheme');
  assert.equal(script('intent://x#Intent;end').allow, false);
  assert.equal(script('javascript:void(0)').allow, false);
  assert.ok(script('about:blank').allow);
});

test('the page the app asked for is allowed, and its redirects with it', () => {
  // The app sent the WebView to a series page; the site answers with a 302 to
  // a different host of the same brand. Same site as `asked`, so allowed even
  // though `here` is somewhere else.
  assert.equal(script('https://voiranime.rip/anything', { here: 'https://elsewhere.example/' }).reason, 'asked for');
});

test('the first load may go anywhere: there is nothing yet to hijack', () => {
  // A series saved under a site's old domain. The app asks for voiranime.com,
  // which no longer exists as such and redirects to voiranime.rip — a
  // different site, by a server redirect, before any page has landed.
  const v = script('https://voiranime.rip/tomb-raider-king/', {
    here: '', asked: 'https://voiranime.com/tomb-raider-king/',
  });
  assert.ok(v.allow);
  assert.equal(v.reason, 'first load');
});

test('the app\'s own server is always reachable, because OAuth comes back to it', () => {
  // The reader pressed Authorize on anilist.co. AniList answers with a 302 to
  // our /callback — cross-site, script-shaped, nobody tapped it. Without this
  // exception no tracker could ever be connected from the phone.
  const v = script('https://panelflow-backend.vercel.app/api/trackers/anilist/callback?code=abc', {
    here: 'https://anilist.co/api/v2/oauth/authorize?client_id=1',
    asked: 'https://anilist.co/api/v2/oauth/authorize?client_id=1',
  });
  assert.ok(v.allow);
  assert.equal(v.reason, 'own server');
});

test('a frame may come from anywhere that is not an ad', () => {
  // The video player is an <iframe> from another site, and that is the whole
  // design of these sites. The window is what is guarded, not its frames.
  const v = decide({ url: 'https://vidmoly.to/embed-abc.html', navigationType: 'other', isTopFrame: false }, ctx());
  assert.ok(v.allow);
  assert.equal(v.reason, 'frame');
});

test('a request that does not say which frame it is for is taken as the window', () => {
  // Android reports no `isTopFrame`. Assuming "top" is the safe direction:
  // the worst case is a cross-site player frame refused, which the site's own
  // player list would have to be on an ad list to hit.
  const v = decide({ url: 'https://rotating-ad.example/', navigationType: 'other' }, ctx());
  assert.equal(v.allow, false);
});

test('a hijack reached by the ad\'s own redirect chain is still refused', () => {
  // The first hop was refused; had it not been, this is the second: the ad
  // network's tracker bouncing to the advertiser. `here` is still the episode
  // page, because a refused navigation never lands.
  assert.equal(script('https://advertiser.example/landing').allow, false);
});

test('siteOf agrees with popup-guard.js, which keeps its own copy', () => {
  // Two copies on purpose — the guard runs in the page's main world, where no
  // shared module is visible — so the only thing that keeps them one rule is
  // this: the guard's `site` is lifted from its source and asked the same
  // questions.
  const src = readFileSync(join(root, 'extension', 'content', 'popup-guard.js'), 'utf8');
  const a = src.indexOf('  const TWO_PART');
  const b = src.indexOf('  // A real click on the site');
  assert.ok(a !== -1 && b > a, 'site() is not where this test expects it in popup-guard.js');
  const guardSite = new Function(`${src.slice(a, b)}\n return site;`)();

  for (const host of [
    'voiranime.rip', 'www.voiranime.rip', 'cdn.img.voiranime.rip',
    'asuracomic.net', 'www.asuracomic.net',
    'bbc.co.uk', 'news.bbc.co.uk',
    'anime-sama.fr', 'localhost', '', 'A.B.EXAMPLE.COM',
  ]) {
    assert.equal(siteOf(host), guardSite(host), `the two site() rules disagree on ${host}`);
  }
});
