// The title, minus what the site put around it.
//
// A scan site titles its pages for a search engine, not for a shelf: "Blue Box
// Scan VF / FR Gratuit (Webtoon)" is one string, and most of those words are
// the site talking about itself. Stored as it arrives, it overflows every card,
// follows the entry into all three exports, and is what a tracker gets asked to
// match against — so it is cleaned once, on the way in.
//
// Two things are tested here, and they pull in opposite directions:
//
//   - that the furniture comes off, and
//   - that a real title is never renamed to something its reader would not
//     recognise. A card that says a little too much is a blemish; a card that
//     has lost the name of the book is a bug the reader cannot undo.
//
// The vocabulary is data (shared/detection-rules.json), not code, because sites
// rename their tails and an extension release is the wrong unit of work for one
// word. That is what most of these tests are actually about.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import '../../shared/site-rules.js';
import { displayTitle } from '../src/series-match.js';
import { cleanTitle } from '../src/panelflow-core.js';
import { bootCore } from '../test-support/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const RULES = JSON.parse(read('shared/detection-rules.json'));

// --- what the sites actually write -----------------------------------------

test('the SEO tail comes off the titles these sites really ship', () => {
  const cases = [
    // The one the roadmap names, from sushiscan.fr.
    ['Blue Box Scan VF / FR Gratuit (Webtoon)', 'Blue Box'],
    // MangaNato puts the furniture at the head as well as the tail.
    ['Read One Piece Manga Chapter 1140', 'One Piece'],
    // A chapter page, separators and all.
    ['Ao no Hako VF — Chapitre 109 | Lecture en ligne', 'Ao no Hako'],
    // Chevrons are what a "next chapter" heading leaves behind.
    ['» Kagurabachi Scan VF', 'Kagurabachi'],
  ];
  for (const [raw, want] of cases) {
    assert.equal(cleanTitle(raw), want, `${raw} did not clean to ${want}`);
  }
});

test('a title that is already a title is handed back untouched', () => {
  // Every one of these is a real work whose name is built out of listed words.
  // The two-cut rule is what saves them, and it is the whole reason the word
  // list is allowed to be as long as it is.
  for (const title of ['Blue Box', 'Sword Art Online', 'Manga Dogs', 'Free!',
    'One Piece', 'Solo Leveling', 'Read or Die']) {
    assert.equal(cleanTitle(title), title);
  }
});

test('a title that cleaning would empty is kept exactly as it came in', () => {
  // A page titled nothing but furniture. Handing back "" would put a nameless
  // row on the shelf, and a title is the one field on a library card that
  // cannot be worked out again from anything else.
  for (const raw of ['Scan VF Manga Gratuit', 'Lecture en ligne', 'Manga']) {
    const out = cleanTitle(raw);
    assert.ok(out, `${raw} cleaned away to nothing`);
    assert.equal(out, raw);
  }
  // Nothing in means nothing out — a different case, and every caller already
  // guards it with `|| entry.title`.
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle(null), '');
  assert.equal(cleanTitle(undefined), '');
});

// --- the list is data, and that is the point --------------------------------

test('the rules file can add a word the code has never heard of', () => {
  const raw = 'Solo Leveling Mangas Streaming';
  // "mangas" and "streaming" are in detection-rules.json, not in the code.
  assert.equal(displayTitle(raw), raw, 'the built-in list already knew these');
  assert.equal(displayTitle(raw, { rules: RULES }), 'Solo Leveling');
});

test('a site whose own name is the tail says so in its own entry', () => {
  const opts = (host) => ({ host, rules: RULES });
  // "sushiscan" is listed under *.sushiscan.fr and nowhere else.
  assert.equal(displayTitle('SushiScan Blue Box Scan', opts('sushiscan.fr')), 'Blue Box');
  // The wildcard covers the apex, the subdomains, and the www. nobody means.
  assert.equal(displayTitle('Blue Box Sushi Scan', opts('www.sushiscan.fr')), 'Blue Box');
  assert.equal(displayTitle('Blue Box Sushi Scan', opts('ww6.sushiscan.fr')), 'Blue Box');
  // And it is that site's word, not everyone's: on another host the same
  // string keeps a name that might genuinely be part of the work.
  assert.equal(displayTitle('SushiScan Blue Box Scan', opts('autre.test')),
    'SushiScan Blue Box Scan');
});

test('a site can take a word back off the list for itself alone', () => {
  const rules = {
    titleNoise: { words: [] },
    domains: { '*.online.test': { titleNoise: { keep: ['online', 'read'] } } },
  };
  // Everywhere else, "Read … Online" is furniture and comes off.
  assert.equal(displayTitle('Read Sword Art Online', { host: 'a.test', rules }), 'Sword Art');
  // On the site that asked, it is left alone — without weakening the rule for
  // any of the other forty-nine.
  assert.equal(displayTitle('Read Sword Art Online', { host: 'x.online.test', rules }),
    'Read Sword Art Online');
});

test('a rules file somebody mistyped costs that site its words and nothing else', () => {
  const rules = {
    titleNoise: { words: ['streaming'] },
    domains: {
      // The one that is written properly, for comparison.
      '*.good.test': { titleNoise: { words: ['toonhub'] } },
      // Every wrong shape the same thing can be written in.
      '*.broken.test': { titleNoise: 'toonhub, streaming' },
      '*.worse.test': { titleNoise: { words: 'toonhub', keep: 42 } },
      '*.empty.test': { titleNoise: { words: [null, 7, '', '   '] } },
      '*.notanobject.test': ['titleNoise'],
    },
  };
  // "toonhub" is a word only a domain section can supply, so it is what shows
  // whether that section was read.
  assert.equal(displayTitle('Solo Leveling ToonHub Streaming', { host: 'good.test', rules }),
    'Solo Leveling');

  for (const host of ['broken.test', 'worse.test', 'empty.test', 'notanobject.test']) {
    // Nothing thrown, and exactly one thing lost: the word that entry meant to
    // add. "ToonHub" stops the run after one cut, so the title comes back whole
    // rather than half-eaten.
    assert.equal(displayTitle('Solo Leveling ToonHub Streaming', { host, rules }),
      'Solo Leveling ToonHub Streaming', `${host} did not fall back cleanly`);
    // And the global section is still in force on that same site: "Streaming"
    // is the file's word, "Scan" is the code's, and both still come off. A bad
    // domain entry subtracts nothing — it only fails to add.
    assert.equal(displayTitle('Solo Leveling Scan Streaming', { host, rules }),
      'Solo Leveling', `${host} lost the global word list too`);
  }
  // The site next door is untouched by its neighbour's typo.
  assert.equal(displayTitle('Solo Leveling Scan VF', { host: 'fine.test', rules }),
    'Solo Leveling');
});

test('no rules file at all is the list that shipped, not an empty one', () => {
  for (const opts of [undefined, {}, { host: 'a.test' }, { host: 'a.test', rules: null },
    { rules: {} }, { host: '', rules: { domains: null } }]) {
    assert.equal(displayTitle('Blue Box Scan VF / FR Gratuit (Webtoon)', opts), 'Blue Box');
  }
});

test('the file that ships really carries the section the code reads', () => {
  // The mechanism above is worth nothing if the shipped file has no section:
  // this is the test that fails when someone tidies it away.
  assert.ok(RULES.titleNoise, 'detection-rules.json has no titleNoise section');
  assert.ok(Array.isArray(RULES.titleNoise.words) && RULES.titleNoise.words.length);
  for (const w of RULES.titleNoise.words) {
    assert.equal(typeof w, 'string');
    assert.equal(w, w.toLowerCase().trim(), `"${w}" is not written the way it is matched`);
  }
  // At least one domain shows the per-domain half is real and reachable.
  const own = Object.entries(RULES.domains).filter(([, v]) => v && v.titleNoise);
  assert.ok(own.length, 'no domain in the file uses its own word list');
});

// --- where it is applied ----------------------------------------------------

test('a series is cleaned as it enters the library, not by whoever draws it', async () => {
  const { core, calls } = bootCore({
    storage: { rulesCache: { rules: RULES, fetchedAt: Date.now() } },
  });
  const entry = await core.addToLibrary({
    title: 'SushiScan Blue Box Scan VF',
    sourceDomain: 'sushiscan.fr',
    sourceUrl: 'https://sushiscan.fr/manga/blue-box',
  });
  assert.equal(entry.title, 'Blue Box');
  // Signed out, and it stayed that way: the word list is read off the cache the
  // detector already filled, never fetched. "Nothing is sent anywhere" is a
  // property of adding a series, and cleaning a string must not cost it.
  assert.deepEqual(calls, []);
});

test('with no rules ever fetched the built-in list still cleans', async () => {
  const { core } = bootCore();
  const entry = await core.addToLibrary({
    title: 'Blue Box Scan VF / FR Gratuit (Webtoon)',
    sourceDomain: 'sushiscan.fr',
    sourceUrl: 'https://sushiscan.fr/manga/blue-box',
  });
  assert.equal(entry.title, 'Blue Box');
});

test('a title the reader typed is never taken off them again', async () => {
  const { core } = bootCore({
    storage: { rulesCache: { rules: RULES, fetchedAt: Date.now() } },
  });
  const url = 'https://sushiscan.fr/manga/manga-dogs';
  await core.addToLibrary({
    title: 'Manga Dogs Scan VF', sourceDomain: 'sushiscan.fr', sourceUrl: url,
  });
  // Re-adding is how the edit modal saves. The reader looked at our guess,
  // disagreed, and typed the name of the book — which happens to be built out
  // of listed words. Cleaning it again would be the app arguing back.
  const edited = await core.addToLibrary({
    title: 'Manga Dogs Scan', sourceDomain: 'sushiscan.fr', sourceUrl: url,
  });
  assert.equal(edited.title, 'Manga Dogs Scan');
});

test('nobody keeps a private copy of the word list any more', () => {
  // detect.js used to carry `read online|free|manga|scan` as a regex frozen
  // into a file that only changes when the extension is republished. That is
  // what A1 was about: the list has to be able to change without one.
  const detect = read('extension/content/detect.js');
  assert.ok(!/read online\|free\|manga\|scan/.test(detect),
    'detect.js still has its own SEO word list');
  assert.match(detect, /displayTitle\(cut, opts\)/, 'detect.js cleans without the rules');
  assert.match(detect, /host: location\.hostname, rules/,
    'detect.js does not tell the cleaner which site it is on');

  // The server scrapes the same pages and must spell the result the same way,
  // or one series turns into two entries that no longer look alike.
  const meta = read('backend/src/routes/meta.js');
  assert.match(meta, /displayTitle\(rawTitle, \{ host, rules: loadRules\(\) \}\)/);
  const search = read('backend/src/routes/search.js');
  assert.match(search, /displayTitle\(raw, \{ host: hostOf\(url\), rules \}\)/);
});
