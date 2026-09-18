// The hand-written site samples, kept honest.
//
// docs/sites-samples.json is what a person found by opening sites in a
// browser: a chapter address the registry script fetches instead of guessing,
// or a word saying why there is none (parked, moved, an app, an account).
// The registry treats that word as a verdict, so the file has to be one the
// script can read without surprises: every entry has an address or a note,
// every note starts with one of the words the registry legend explains, and
// every domain with an address is one the rules actually cover, because a
// sample for a site the extension never runs on proves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const samples = JSON.parse(readFileSync(join(root, 'docs', 'sites-samples.json'), 'utf8'));
const rules = JSON.parse(readFileSync(join(root, 'shared', 'detection-rules.json'), 'utf8'));
const script = readFileSync(join(root, 'scripts', 'check-sites.mjs'), 'utf8');

const entries = Object.entries(samples).filter(([k]) => !k.startsWith('_'));
const known = new Set(Object.keys(rules.domains).filter((k) => !k.startsWith('_')).map((d) => d.replace(/^\*\./, '')));

/** The words the registry's legend explains, and no other. */
const CATEGORIES = ['dead', 'moved', 'blocked', 'account', 'app'];

test('every sample is an address or a reason, never neither', () => {
  assert.ok(entries.length > 0);
  for (const [domain, entry] of entries) {
    assert.ok(entry.url || entry.note, `${domain}: neither url nor note`);
    if (entry.url) assert.match(entry.url, /^https?:\/\//, `${domain}: url is not an address`);
  }
});

test('a reason for having no address starts with a word the registry legend explains', () => {
  // With an address, the note is a remark and the verdict comes from the
  // page; without one, the note *is* the verdict and has to be a known word.
  const legend = script.slice(script.indexOf('`hand:…`'), script.indexOf('Un échantillon marqué'));
  for (const [domain, entry] of entries) {
    if (!entry.note || entry.url) continue;
    const word = entry.note.split(':')[0].trim();
    assert.ok(CATEGORIES.includes(word), `${domain}: note starts with "${word}", which the legend does not explain`);
    assert.ok(legend.includes(`\`${word}\``), `the legend in check-sites.mjs no longer explains "${word}"`);
  }
});

test('a chapter address belongs to a domain the rules cover', () => {
  // The address may sit on a subdomain or a sister host of the entry's
  // domain (v7.kiryuu.to for kiryuu.to, ncode.syosetu.com for syosetu.com):
  // the site's registered name has to match, not the full host.
  const siteOf = (host) => host.replace(/^www\./, '').split('.').slice(-2).join('.');
  for (const [domain, entry] of entries) {
    if (!entry.url) continue;
    assert.ok(known.has(domain), `${domain} has a sample but is not in the rules`);
    assert.equal(siteOf(new URL(entry.url).hostname), siteOf(domain), `${domain}: the sample is on another site`);
  }
});

test('a domain the rules dropped keeps its reason here, so the pruning can be read back', () => {
  // The rules file's own note says it was pruned on this file's evidence.
  // A dropped domain without an entry here is a removal nobody can explain.
  const pruned = entries.filter(([domain, e]) => !known.has(domain));
  assert.ok(pruned.length > 0, 'the record of the September pruning is gone');
  for (const [domain, entry] of pruned) {
    assert.ok(entry.note && !entry.url, `${domain} is not in the rules but has no reason recorded`);
  }
});

test('the registry script reads this file, and tries a hand sample even when the home page refuses it', () => {
  assert.ok(script.includes("'sites-samples.json'"), 'check-sites.mjs no longer reads the samples');
  assert.match(script, /samples\[domain\]\?\.url/, 'a hand-written address is not preferred over guessing');
  assert.match(script, /row\.status !== 'ok' && !samples\[domain\]\?\.url/,
    'a home page that walls the script must not hide a chapter a person already opened');
});
