// No em dash in anything PanelFlow shows a reader.
//
// The product's text joins two thoughts with a colon, a comma, parentheses, a
// middle dot between the parts of a status line, or a second sentence. The em
// dash is the mark that creeps back in when nobody is looking, so the places
// those sentences live are held to it: the catalogue every surface draws from,
// the pages (minus their comments, scripts and styles, which nobody opening the
// page reads), and the account mails with the answers of the reset flow, read
// from the outbox and the responses rather than from auth.js, so that a comment
// in that file is never taken for a sentence sent to someone.
//
// A dash that is the whole of a value (an empty <option>, the placeholder of a
// score nobody gave) means "nothing here" rather than joining anything, and is
// left alone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, newUser, shutdown } from '../test-support/harness.js';
import { outbox } from '../src/mail.js';

after(shutdown);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(p, 'utf8');
// An escape rather than the character, so a search for the dash never lands here.
const DASH = '\u2014';

test('no message in the catalogue carries one', () => {
  const dir = join(root, 'shared', '_locales');
  const langs = readdirSync(dir);
  assert.ok(langs.length >= 2, 'the catalogue moved, so this test is checking nothing');
  const found = langs.flatMap((lang) => {
    const messages = JSON.parse(read(join(dir, lang, 'messages.json')));
    return Object.entries(messages)
      .filter(([, entry]) => entry.message.includes(DASH))
      .map(([key, entry]) => `${lang}/${key}: ${entry.message}`);
  });
  assert.deepEqual(found, [],
    'rewrite these with a colon, a comma, parentheses or two sentences');
});

// The folders whose pages are opened by a person. `shared` holds generated
// copies, `_locales` is not pages, and `_metadata` is Chrome's: it writes and
// deletes it while the end-to-end tests run, which is why a name that vanishes
// between the listing and the look is skipped rather than thrown on. The
// website's and the phone's pages sit at the top of their folders.
const SKIP = new Set(['shared', '_locales', '_metadata', 'node_modules']);
function pages(dir, deep, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let stat;
    try { stat = statSync(p); } catch { continue; }
    if (stat.isDirectory()) {
      if (deep) pages(p, deep, out);
    } else if (name.endsWith('.html')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every em dash a page would draw, as `line: text`. What is blanked out keeps
 * its line breaks, so the line numbers are the ones an editor shows.
 */
function strayDashes(html) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const shown = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, blank);
  const out = [];
  for (const m of shown.matchAll(new RegExp(DASH, 'g'))) {
    const before = shown.slice(0, m.index);
    const after = shown.slice(m.index + 1);
    if (/[>"']\s*$/.test(before) && /^\s*[<"']/.test(after)) continue;
    const line = before.split('\n').length;
    out.push(`${line}: ${shown.split('\n')[line - 1].trim()}`);
  }
  return out;
}

test('no page draws one', () => {
  const all = [
    ...pages(join(root, 'extension'), true),
    ...pages(join(root, 'web'), false),
    ...pages(join(root, 'mobile', 'www'), false),
  ];
  assert.ok(all.length >= 8, `only ${all.length} pages found, so the walk is broken`);
  const found = all.flatMap((p) => strayDashes(read(p))
    .map((hit) => `${relative(root, p).replace(/\\/g, '/')}:${hit}`));
  assert.deepEqual(found, []);
});

test('the walk tells a sentence from a value', () => {
  // Both halves of the rule above, so a change to it cannot quietly turn it
  // into a check that passes everything.
  assert.equal(strayDashes(`<title>PanelFlow ${DASH} Saved chapters</title>`).length, 1);
  assert.equal(strayDashes(`<p>Lost?${DASH}run it again</p>`).length, 1);
  assert.deepEqual(strayDashes(`<option value="">${DASH}</option><input placeholder="${DASH}">`), []);
  assert.deepEqual(strayDashes(`<!-- an aside ${DASH} for whoever edits this -->`), []);
});

test('the account mails and the reset answers are written without one', async () => {
  const u = await newUser();
  const next = `moved${Date.now()}@test.dev`;
  assert.equal((await api('POST', '/api/auth/forgot', { email: u.email })).status, 200);
  assert.equal((await api('POST', '/api/auth/email',
    { password: 'password123', email: next }, u.token)).status, 200);

  const sent = outbox.filter((m) => m.to === u.email || m.to === next);
  assert.equal(sent.length, 2, 'the reset and the address change should both be in the outbox');
  for (const mail of sent) {
    for (const part of ['subject', 'text', 'html']) {
      assert.equal(typeof mail[part], 'string', `the outbox lost the ${part} of "${mail.subject}"`);
      assert.ok(!mail[part].includes(DASH), `"${mail.subject}" has one in its ${part}`);
    }
  }

  // Then the link from that mail, spent, spent again, and the session it retired.
  const token = sent.find((m) => m.to === u.email).text.match(/#reset=([\w-]+)/)[1];
  const answers = [
    await api('POST', '/api/auth/reset', { token, password: 'brand-new-password' }),
    await api('POST', '/api/auth/reset', { token, password: 'another-password' }),
    await api('GET', '/api/me', undefined, u.token),
  ];
  assert.deepEqual(answers.map((r) => r.status), [200, 400, 401]);
  for (const { body } of answers) {
    const said = body.message ?? body.error;
    assert.equal(typeof said, 'string', `nothing was said: ${JSON.stringify(body)}`);
    assert.ok(!said.includes(DASH), said);
  }
});
