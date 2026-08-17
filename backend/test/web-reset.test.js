// The signed-out screen, once it has three things to be instead of one.
//
// The rules are lifted out of web/app.js with `new Function` over the shipping
// source, the way web-failure.test.js does it — never a second copy written
// here to pass, because a copy passes forever after the real one changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const src = read('web', 'app.js');
const html = read('web', 'index.html');

function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a !== -1 && b > a, `web/app.js no longer contains ${JSON.stringify(from)}`);
  return src.slice(a, b);
}

/** showAuth and the fragment helpers, over stub globals. */
function build(hash = '') {
  const location = { hash, pathname: '/', search: '' };
  const history = { calls: [], replaceState(_s, _t, url) { this.calls.push(url); location.hash = ''; } };

  const els = {};
  for (const id of ['auth-view', 'app-view', 'auth-form', 'forgot-form', 'reset-form',
    'auth-error', 'forgot-error', 'forgot-sent', 'reset-error']) {
    els[id] = { hidden: false, textContent: '' };
  }
  const $ = (id) => els[id] ?? assert.fail(`web/app.js reaches for #${id}, which this test does not stub`);

  const built = new Function('$', 'location', 'history', `
    ${slice('// Three cards share the signed-out view', 'function signOut()')}
    ${slice('// The reset token rides in the fragment', '/* ---------- App ---------- */')}
    return { showAuth, readResetHash, clearResetHash, token: () => resetToken };
  `)($, location, history);
  return { ...built, els, location, history };
}

test('every element the sign-out screen reaches for is on the page', () => {
  for (const id of ['forgot-form', 'forgot-email', 'forgot-error', 'forgot-sent', 'forgot-submit',
    'forgot-back', 'auth-forgot', 'auth-forgot-line',
    'reset-form', 'reset-password', 'reset-error', 'reset-submit', 'reset-back']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from web/index.html`);
  }
});

test('exactly one card is on screen at a time', () => {
  const w = build();
  for (const [card, shown] of [['auth', 'auth-form'], ['forgot', 'forgot-form'], ['reset', 'reset-form']]) {
    w.showAuth(card);
    const visible = ['auth-form', 'forgot-form', 'reset-form'].filter((id) => !w.els[id].hidden);
    assert.deepEqual(visible, [shown], `showAuth('${card}')`);
  }
  // The default is the one someone arriving with no link should get.
  w.showAuth();
  assert.equal(w.els['auth-form'].hidden, false);
});

test('switching cards does not carry the last card\'s complaint along', () => {
  const w = build();
  w.els['auth-error'].hidden = false;
  w.els['forgot-sent'].hidden = false;
  w.showAuth('forgot');
  // "Wrong password" left standing over "check your inbox" reads as a rejection
  // of the address that was just typed.
  assert.equal(w.els['auth-error'].hidden, true);
  assert.equal(w.els['forgot-sent'].hidden, true);
});

test('the signed-out view is shown and the app hidden, whichever card it is', () => {
  const w = build();
  w.showAuth('reset');
  assert.equal(w.els['auth-view'].hidden, false);
  assert.equal(w.els['app-view'].hidden, true);
});

test('the token is read from the fragment, which no server ever sees', () => {
  assert.equal(build('#reset=abc123_-XYZ').readResetHash(), 'abc123_-XYZ');
  // A fragment is not sent with the request, so the token stays out of access
  // logs, out of proxies, and out of the Referer of everything the page loads.
  // Nothing may read it from anywhere else.
  for (const hash of ['', '#reset=', '#reset=abc def', '#other=abc123', '#reset=a&b']) {
    assert.equal(build(hash).readResetHash(), null, JSON.stringify(hash));
  }
});

test('the token leaves the address bar as soon as it is in hand', () => {
  const w = build('#reset=abc123');
  w.readResetHash();
  assert.equal(w.token(), 'abc123');

  w.clearResetHash();
  assert.equal(w.token(), null);
  assert.equal(w.location.hash, '', 'a reload must not replay a link that is already spent');
  assert.deepEqual(w.history.calls, ['/'], 'replaced, not pushed — Back is not a way to get it again');
});

test('clearing when there is nothing to clear touches nothing', () => {
  const w = build('#library');
  w.clearResetHash();
  assert.deepEqual(w.history.calls, [], 'an unrelated fragment is left where it was');
  assert.equal(w.location.hash, '#library');
});

test('a reset link wins over a session that is already signed in', () => {
  // Otherwise following the link on the machine you are still signed in on
  // drops you onto your shelf, with no way to reach the form the link was for —
  // and that machine is the likeliest one to be holding a session you came to
  // end.
  const boot = src.slice(src.indexOf('(async function boot()'));
  const hashCheck = boot.indexOf('readResetHash()');
  const tokenCheck = boot.indexOf('if (!token)');
  assert.ok(hashCheck !== -1 && tokenCheck !== -1, 'boot() no longer looks like this test expects');
  assert.ok(hashCheck < tokenCheck, 'boot() must look for a reset link before it consults the token');
});

test('neither client offers the door until the server says it opens', () => {
  // A deployment with no mail provider answers /auth/forgot with a 503. Drawing
  // the link anyway costs a reader their address, a wait, and the belief that
  // the mail is coming — so both clients start with the line hidden in the
  // markup and reveal it only on the capability.
  assert.match(html, /id="auth-forgot-line"[^>]*\shidden/,
    'web/index.html must not ship the line visible');
  assert.match(src, /askAboutReset[\s\S]*?\/auth\/capabilities/,
    'web/app.js no longer asks whether the mail can be sent');
  assert.match(src, /catch\s*\{\s*canReset = false/,
    'a backend that will not answer is not one that is about to send mail');

  const optionsHtml = read('extension', 'options', 'options.html');
  const optionsJs = read('extension', 'options', 'options.js');
  assert.match(optionsHtml, /id="forgot-line"[^>]*\shidden/,
    'the options page must not ship the line visible');
  assert.match(optionsJs, /auth\/capabilities/,
    'the options page no longer asks either');
});

test('the extension sends people here, and they land on the form', () => {
  // The options page has no reset screen of its own on purpose — one flow, one
  // set of rate limits. Its link is worth nothing if the page it opens shows
  // the sign-in form instead, so both halves are checked together.
  const options = read('extension', 'options', 'options.js');
  assert.match(options, /'forgot'\)\.addEventListener/, 'the options page no longer offers the link');
  assert.match(options, /\/#forgot/, 'the link must carry the fragment the web app answers to');
  assert.ok(read('extension', 'options', 'options.html').includes('id="forgot"'),
    '#forgot is missing from the options page');

  const boot = src.slice(src.indexOf('(async function boot()'));
  const forgotCheck = boot.indexOf("'#forgot'");
  const tokenCheck = boot.indexOf('if (!token)');
  assert.ok(forgotCheck !== -1, 'the web app no longer answers the fragment the extension links to');
  assert.ok(forgotCheck < tokenCheck,
    'someone still signed in on this browser came for the form, not for their shelf');
  assert.match(boot.slice(forgotCheck), /replaceState/,
    'the fragment goes once it is read, so Back and reload behave like the rest of the app');
});

test('the forgot link is offered for signing in, not for signing up', () => {
  const swap = slice("$('auth-switch').addEventListener", "$('auth-forgot').addEventListener");
  assert.match(swap, /auth-forgot-line.*hidden\s*=\s*toRegister/s,
    'nothing has been forgotten by someone who has not signed up yet');
});
