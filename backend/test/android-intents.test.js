// What Android is told PanelFlow can open.
//
// The in-app browser used to advertise itself with two bare `<data
// android:scheme>` lines and nothing else, which in Android's vocabulary means
// "this app opens the web". Every http and https link on the phone — a bank, a
// work intranet, a password reset — put PanelFlow in the "Open with" list. It
// was never needed: everything inside the app reaches BrowserActivity through
// an explicit Intent, which ignores filters entirely, and sharing a link in
// from another app goes through the SEND filter.
//
// So the filter now names hosts. The list is allowed to lag the rules file (a
// manifest cannot be updated server-side, a rule can), but it may not contain
// anything that is not a site PanelFlow claims to read, and it may never go
// back to being schemes alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = readFileSync(join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
const rules = JSON.parse(readFileSync(join(root, 'shared/detection-rules.json'), 'utf8'));

/** Every `<intent-filter>` in the manifest, as raw text. */
const filters = [...manifest.matchAll(/<intent-filter>([\s\S]*?)<\/intent-filter>/g)].map((m) => m[1]);

const webFilters = filters.filter((f) => /android:scheme="https?"/.test(f));
const hostsOf = (f) => [...f.matchAll(/android:host="([^"]+)"/g)].map((m) => m[1]);

test('the app does not declare itself a browser', () => {
  assert.ok(webFilters.length > 0, 'the web filter is gone entirely — links can no longer be opened');
  for (const f of webFilters) {
    assert.ok(hostsOf(f).length > 0,
      'an http/https filter with no host puts PanelFlow in the Open with list of every link on the phone');
  }
});

test('every host it does claim is a site the rules file knows', () => {
  const known = new Set(Object.keys(rules.domains).map((d) => d.replace(/^\*\./, '')));
  const unknown = webFilters
    .flatMap(hostsOf)
    .map((h) => h.replace(/^\*\./, ''))
    .filter((h) => !known.has(h));
  assert.deepEqual([...new Set(unknown)], [],
    'the manifest offers to open sites shared/detection-rules.json has never heard of');
});

test('a bare domain and its subdomains both count', () => {
  // Android matches `*.example.com` as a suffix, so it does NOT cover
  // `example.com` — and chapter URLs are as often on the bare domain as on www.
  // Listing one without the other is the kind of half-working nobody notices.
  for (const f of webFilters) {
    const hosts = hostsOf(f);
    for (const h of hosts.filter((x) => !x.startsWith('*.'))) {
      assert.ok(hosts.includes(`*.${h}`), `${h} is listed without its subdomains`);
    }
    for (const h of hosts.filter((x) => x.startsWith('*.'))) {
      assert.ok(hosts.includes(h.slice(2)), `${h} is listed without the bare domain`);
    }
  }
});

test('both schemes, because half these sites are still on http somewhere', () => {
  for (const f of webFilters) {
    assert.match(f, /android:scheme="https"/);
    assert.match(f, /android:scheme="http"/);
  }
});

test('sharing a link into the app still works for any site at all', () => {
  // This is the path that does not depend on the list above, and the reason
  // trimming the list costs a user nothing on a site added last week.
  const send = filters.find((f) => /action.SEND/.test(f));
  assert.ok(send, 'the SEND filter is gone');
  assert.match(send, /android:mimeType="text\/plain"/);
});
