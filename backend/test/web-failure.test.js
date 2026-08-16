// What the web app does when the server does not answer.
//
// Every dialog on that page reports its own failures. The shelf did not, and
// the shelf is the screen you cannot avoid: `boot()` called `enterApp()`
// without awaiting it, so once `refresh()` rejected — a cold Vercel start, a
// dropped wifi, any one of its four calls — the rejection went nowhere. The
// sign-in view was already hidden and the app view already shown, so what was
// left on screen was an empty library, no message, and nothing to click. That
// reads as "PanelFlow lost my library", which is the wrong thing to make
// someone else's first impression.
//
// Same shape on three card actions, which awaited the network inside a click
// handler with no catch: removing a series, moving it to another shelf, and
// clearing the history all did nothing at all, silently, when the request
// failed. The user's next move is to click again.
//
// The rule is lifted out of web/app.js the way every other rule here is —
// `new Function` over the shipping source, never a second copy written to pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const src = read('web', 'app.js');

/**
 * The trouble line and its guard, with a stub for the three elements they
 * touch. Returns the pieces plus the elements, so a test can read what is on
 * screen rather than what the code says it put there.
 */
function buildGuard() {
  const from = src.indexOf('// What failed, so the button can do it again.');
  const to = src.indexOf('/* ---------- Auth ---------- */');
  assert.ok(from !== -1 && to > from, 'the trouble line is not where this test expects it');

  const els = {
    'app-error': { hidden: true },
    'app-error-text': { textContent: '' },
    'app-error-retry': { clicks: [], addEventListener(_, fn) { this.clicks.push(fn); } },
  };
  const $ = (id) => els[id];

  const built = new Function('$', `${src.slice(from, to)}
    return { guard, showTrouble, hideTrouble };`)($);
  return { ...built, els, retry: () => els['app-error-retry'].clicks[0]() };
}

const boom = (message) => async () => { throw new Error(message); };

test('a request that fails says so, instead of leaving a blank shelf', async () => {
  const g = buildGuard();
  const ok = await g.guard('Could not load your library', boom('Failed to fetch'));

  assert.equal(ok, false);
  assert.equal(g.els['app-error'].hidden, false);
  // Both halves matter: what was being done, and what went wrong. Either one
  // alone leaves the reader guessing which of the two it is.
  assert.match(g.els['app-error-text'].textContent, /Could not load your library/);
  assert.match(g.els['app-error-text'].textContent, /Failed to fetch/);
});

test('the button does the thing that failed, not a page reload', async () => {
  // A reload would also throw away everything else on screen, and on this page
  // that includes a half-filled import dialog.
  const g = buildGuard();
  let attempts = 0;
  const flaky = async () => { attempts += 1; if (attempts < 2) throw new Error('offline'); };

  await g.guard('Could not remove Blue Box', flaky);
  assert.equal(attempts, 1);

  await g.retry();
  assert.equal(attempts, 2, 'the retry button did not re-run the action');
  assert.equal(g.els['app-error'].hidden, true, 'the line stayed up after it worked');
});

test('a second failure does not print the first one inside it', async () => {
  // The message on screen already has the error appended to it. Feeding that
  // back in as the description is how these lines grow a tail.
  const g = buildGuard();
  await g.guard('Could not clear your history', boom('500'));
  await g.retry();

  const shown = g.els['app-error-text'].textContent;
  assert.equal(shown.match(/Could not clear your history/g).length, 1);
  assert.equal(shown.match(/500/g).length, 1);
});

test('success clears a line left over from a previous failure', async () => {
  const g = buildGuard();
  await g.guard('Could not move Vagabond', boom('offline'));
  assert.equal(g.els['app-error'].hidden, false);

  await g.guard('Could not move Vagabond', async () => {});
  assert.equal(g.els['app-error'].hidden, true);
});

// --- the wiring -------------------------------------------------------------

test('a valid session is not thrown away because the shelf would not load', () => {
  // The old boot() signed out on any failure, which for a network error meant
  // losing a good token and landing on the sign-in screen — a blank page either
  // way, with the user's place gone as a bonus.
  const boot = src.slice(src.indexOf('(async function boot()'));
  const meAt = boot.indexOf("api('/me')");
  const signOutAt = boot.indexOf('signOut()');
  const guardAt = boot.indexOf('guard(');
  assert.ok(meAt !== -1 && signOutAt !== -1 && guardAt !== -1);
  // signOut belongs to the /me failure only, so it has to come before the
  // guarded load, not after it.
  assert.ok(signOutAt < guardAt, 'boot() still signs out when the library fails to load');
  assert.match(boot, /await guard\(/, 'the library load is still not awaited');
});

test('nothing on this page awaits the network in a handler without a net', () => {
  // The failure this whole file is about is not one bug, it is a shape: an
  // async click handler that awaits a request and has nowhere to put a
  // rejection. Guarding the four that existed is worth little if the fifth
  // gets written next week.
  const lines = src.split(/\r?\n/);
  const loose = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/addEventListener\(.*async/.test(lines[i])) continue;
    const body = lines.slice(i, i + 30).join('\n');
    const end = body.indexOf('});');
    const chunk = end > 0 ? body.slice(0, end) : body;
    if (/await (api|apiPostRaw|fetch)\(/.test(chunk) && !/try\s*\{|guard\(/.test(chunk)) {
      loose.push(`web/app.js:${i + 1}`);
    }
  }
  assert.deepEqual(loose, [], 'these handlers can fail with nothing on screen to show it');
});

test('the trouble line exists, starts hidden, and can be hidden at all', () => {
  const html = read('web', 'index.html');
  assert.match(html, /id="app-error"[^>]*hidden/, 'the line is missing or starts visible');
  assert.match(html, /id="app-error-text"/);
  assert.match(html, /id="app-error-retry"/);
  // It is a `display: flex` element toggled with the `hidden` attribute, which
  // only works because of the global guard rule — the trap ui-hidden.test.js
  // exists for. Named here too, so removing the rule fails both.
  const css = read('web', 'styles.css');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});
