// The matcher decides whether a page the user is about to add is a work they
// already have. Getting it wrong is asymmetric: a missed match means a
// duplicate entry (annoying, fixable), a false match means offering to merge
// two unrelated series (destructive if accepted). These tests pin both sides,
// with the real titles scan sites actually print.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeTitle, displayTitle, similarity, seriesKey, sameSeries,
  classify, findMatches, bestMatch,
} from '../src/series-match.js';
import { copies, sourcePath } from '../../scripts/sync-shared.mjs';

test('shared sources are in sync', () => {
  // Chrome cannot load a content script from outside the extension directory
  // and a WebView cannot load one from outside the app bundle, so the shared
  // files exist several times over as generated copies. If one drifts, that
  // client starts disagreeing with the API about whether two pages are the same
  // work, or about what a chapter is — and nothing else would say so.
  const all = copies();
  assert.ok(all.length >= 5, 'every client should have its generated copies listed');
  for (const { name, path } of all) {
    assert.equal(
      readFileSync(path, 'utf8'),
      readFileSync(sourcePath(name), 'utf8'),
      `${path} is stale — run \`npm run sync:shared\``);
  }
});

test('normalizeTitle strips the furniture scan sites wrap around a title', () => {
  const cases = [
    ['Ao no Hako', 'ao no hako'],
    ['Ao no Hako VF', 'ao no hako'],
    ['Ao no Hako - Chapitre 109 VF', 'ao no hako'],
    ['Ao no Hako Scan VF — Lecture en ligne', 'ao no hako'],
    ['  AO NO HAKO  ', 'ao no hako'],
    ['Ao No Hako Chapter 109', 'ao no hako'],
    ['Blue Box Manga Scan FR', 'blue box fr'],
    ['One Piece (Scan VF) Tome 105', 'one piece'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeTitle(raw), expected, raw);
  }
});

test('normalizeTitle folds accents, apostrophes and punctuation', () => {
  assert.equal(normalizeTitle("L'Attaque des Titans"), 'lattaque des titans');
  assert.equal(normalizeTitle('L’Attaque des Titans'), 'lattaque des titans');
  assert.equal(normalizeTitle('Détective Conan'), 'detective conan');
  assert.equal(normalizeTitle('Detective  Conan!!'), 'detective conan');
  assert.equal(normalizeTitle('Fullmetal Alchemist: Brotherhood'), 'fullmetal alchemist brotherhood');
  assert.equal(normalizeTitle('Jujutsu Kaisen & Co.'), 'jujutsu kaisen and co');
});

test('normalizeTitle keeps titles that are made of noise words', () => {
  // "manga" and "free" are on the strip list, but stripping them here would
  // leave nothing — the title really is those words.
  assert.equal(normalizeTitle('Manga Dogs'), 'dogs');
  assert.equal(normalizeTitle('Manga'), 'manga');
  assert.equal(normalizeTitle('Free!'), 'free');
  assert.notEqual(normalizeTitle('Chapter'), '');
});

test('normalizeTitle survives empty and non-string input', () => {
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(undefined), '');
  assert.equal(normalizeTitle(42), '42');
});

test('similarity is 1 for identical and 0 for unrelated strings', () => {
  assert.equal(similarity('one piece', 'one piece'), 1);
  assert.equal(similarity('', ''), 0, 'two empty titles are not a match');
  assert.ok(similarity('one piece', 'berserk') < 0.2);
  assert.ok(similarity('naruto', 'bleach') < 0.2);
});

test('similarity tolerates word order and a missing subtitle', () => {
  assert.ok(similarity('blue box', 'box blue') > 0.6);
  assert.ok(similarity(normalizeTitle('Fullmetal Alchemist: Brotherhood'),
                       normalizeTitle('Fullmetal Alchemist Brotherhood')) === 1);
  assert.ok(similarity('jujutsu kaisen', 'jujutsu kaisen 0') > 0.9);
});

test('seriesKey collapses every url shape a single site uses', () => {
  const key = seriesKey('https://scan-site.test/manga/ao-no-hako');
  for (const url of [
    'https://scan-site.test/manga/ao-no-hako/',
    'https://www.scan-site.test/manga/ao-no-hako',
    'https://scan-site.test/lecture-en-ligne/ao-no-hako',
    'https://scan-site.test/manga/ao-no-hako/chapitre-109',
    'https://scan-site.test/manga/ao-no-hako-chapitre-109',
    'https://scan-site.test/manga/ao-no-hako.html',
  ]) {
    assert.equal(seriesKey(url), key, url);
  }
});

test('seriesKey keeps different works and different sites apart', () => {
  assert.notEqual(
    seriesKey('https://scan-site.test/manga/ao-no-hako'),
    seriesKey('https://scan-site.test/manga/one-piece'));
  assert.notEqual(
    seriesKey('https://scan-site.test/manga/ao-no-hako'),
    seriesKey('https://other-site.test/manga/ao-no-hako'),
    'the same slug on two sites is what the title matcher is for');
});

test('seriesKey degrades to the url when there is no slug to find', () => {
  assert.equal(seriesKey('not a url'), 'not a url');
  assert.equal(seriesKey(''), '');
  assert.equal(sameSeries('', 'https://a.test/x'), false);
  assert.equal(sameSeries(null, null), false);
});

test('classify reports the same page, the same site, then the same title', () => {
  const entry = { title: 'Ao no Hako', sourceUrl: 'https://scan-a.test/manga/ao-no-hako' };

  assert.equal(classify({ title: 'x', sourceUrl: 'https://scan-a.test/manga/ao-no-hako/' }, entry).confidence,
    'same-page');
  assert.equal(classify({ title: 'x', sourceUrl: 'https://scan-a.test/manga/ao-no-hako/chapitre-109' }, entry).confidence,
    'same-site');
  assert.equal(classify({ title: 'Ao no Hako VF', sourceUrl: 'https://scan-b.test/read/ao-no-hako' }, entry).confidence,
    'same-title');
  assert.equal(classify({ title: 'One Piece', sourceUrl: 'https://scan-b.test/read/one-piece' }, entry),
    null);
});

test('classify pairs a title against alternative titles too', () => {
  // Scan sites list the other romanisations; that is how "Blue Box" and
  // "Ao no Hako" ever get connected.
  const entry = { title: 'Ao no Hako', sourceUrl: 'https://scan-a.test/manga/ao-no-hako' };
  const candidate = {
    title: 'Blue Box',
    altTitles: ['Ao no Hako', '青の箱'],
    sourceUrl: 'https://scan-b.test/read/blue-box',
  };
  assert.equal(classify(candidate, entry).confidence, 'same-title');
  assert.equal(classify({ title: 'Blue Box', sourceUrl: 'https://scan-b.test/read/blue-box' }, entry),
    null, 'without the alt title there is nothing to go on');
});

test('a near-miss is offered as a question, not as a fact', () => {
  const entry = { title: 'Kaguya-sama wa Kokurasetai', sourceUrl: 'https://a.test/m/kaguya' };
  const m = classify({ title: 'Kaguya-sama wa Kokurasetai?', sourceUrl: 'https://b.test/m/kaguya' }, entry);
  assert.equal(m.confidence, 'same-title', 'trailing punctuation is not a different work');

  const near = classify({ title: 'Kaguya-sama wa Kokurasenai', sourceUrl: 'https://b.test/m/x' }, entry);
  assert.ok(near && ['same-title', 'likely'].includes(near.confidence));
});

test('short titles must match exactly — bigrams say nothing at that length', () => {
  const entry = { title: 'Gantz', sourceUrl: 'https://a.test/m/gantz' };
  assert.equal(classify({ title: 'Gantz', sourceUrl: 'https://b.test/m/gantz' }, entry).confidence, 'same-title');
  assert.equal(classify({ title: 'Gantz:O', sourceUrl: 'https://b.test/m/gantz-o' }, entry), null);
  assert.equal(classify({ title: 'Naruto', sourceUrl: 'https://b.test/m/naruto' },
    { title: 'Narumi', sourceUrl: 'https://a.test/m/narumi' }), null);
});

test('sequels and spin-offs are not silently merged into the parent', () => {
  const parent = { title: 'Boku no Hero Academia', sourceUrl: 'https://a.test/m/bnha' };
  for (const title of [
    'Boku no Hero Academia: Vigilantes',
    'Boku no Hero Academia Smash!!',
  ]) {
    const m = classify({ title, sourceUrl: 'https://b.test/m/x' }, parent);
    assert.notEqual(m?.confidence, 'same-title', `${title} must not auto-merge`);
  }
});

test('findMatches ranks the strongest evidence first', () => {
  const library = [
    { id: 'weak', title: 'Ao no Hakobune', sourceUrl: 'https://c.test/m/hakobune' },
    { id: 'title', title: 'Ao no Hako', sourceUrl: 'https://b.test/m/ao-no-hako' },
    { id: 'site', title: 'Something Else', sourceUrl: 'https://a.test/m/ao-no-hako' },
    { id: 'nope', title: 'Berserk', sourceUrl: 'https://a.test/m/berserk' },
  ];
  const matches = findMatches(
    { title: 'Ao no Hako VF', sourceUrl: 'https://a.test/m/ao-no-hako/chapitre-1' }, library);

  assert.equal(matches[0].entry.id, 'site', 'the same site wins over a title guess');
  assert.equal(matches[0].confidence, 'same-site');
  assert.equal(matches[1].entry.id, 'title');
  assert.ok(!matches.some((m) => m.entry.id === 'nope'));
  assert.equal(bestMatch({ title: 'Ao no Hako VF', sourceUrl: 'https://a.test/m/ao-no-hako/chapitre-1' }, library)
    .entry.id, 'site');
});

test('findMatches copes with an empty or absent library', () => {
  const c = { title: 'Ao no Hako', sourceUrl: 'https://a.test/m/x' };
  assert.deepEqual(findMatches(c, []), []);
  assert.deepEqual(findMatches(c, null), []);
  assert.deepEqual(findMatches(c, undefined), []);
  assert.equal(bestMatch(c, []), null);
});

test('an entry with no title cannot match everything', () => {
  const library = [{ id: 'blank', title: '', sourceUrl: 'https://a.test/m/x' }];
  assert.deepEqual(findMatches({ title: '', sourceUrl: 'https://b.test/m/y' }, library), []);
  assert.deepEqual(findMatches({ title: 'Ao no Hako', sourceUrl: 'https://b.test/m/y' }, library), []);
});

test('the whole library is scanned in reasonable time', () => {
  const library = Array.from({ length: 2000 }, (_, i) => ({
    id: String(i),
    title: `Some Long Series Title Number ${i}`,
    sourceUrl: `https://a.test/m/series-${i}`,
  }));
  const started = Date.now();
  const matches = findMatches(
    { title: 'Some Long Series Title Number 1999', sourceUrl: 'https://b.test/m/x' }, library);
  assert.equal(matches[0].entry.id, '1999');
  assert.ok(Date.now() - started < 2000, 'this runs synchronously while a modal is opening');
});

// --- what the shelf shows ---------------------------------------------------
//
// normalizeTitle answers "are these two pages the same work" and is allowed to
// throw away anything. displayTitle answers "what goes on the card", where the
// answer is read by a human and stored in the library, so it has to stop
// somewhere. These two jobs pull in opposite directions, which is why they are
// separate functions over the same vocabulary.

test('an SEO title comes back as the name of the series', () => {
  for (const [raw, want] of [
    ['Blue Box Scan VF / FR Gratuit (Webtoon)', 'Blue Box'],
    ['Ao no Hako VF — Chapitre 109 | Lecture en ligne', 'Ao no Hako'],
    ['One Piece Chapitre 1120 - Scan VF', 'One Piece'],
    ['Kagurabachi - Scan manga VF lecture en ligne', 'Kagurabachi'],
    ['Solo Leveling « Chapter 179 » Read Online Free', 'Solo Leveling'],
  ]) {
    assert.equal(displayTitle(raw), want, `${raw} should read as ${want}`);
  }
});

test('a title that only looks like furniture is left alone', () => {
  // The cost of being wrong here is a series stored under a truncated name, in
  // the library and in all three exports. One trailing noise word is not
  // evidence — these are the real names of real works.
  for (const title of [
    'Sword Art Online',
    'Manga Dogs',
    'Free!',
    'Mob Psycho 100',
    "JoJo's Bizarre Adventure Part 4",
    // Two words, but the second is the whole distinguishing half of the name.
    'Naruto Scan',
  ]) {
    assert.equal(displayTitle(title), title);
  }
});

test('furniture at the front of a title comes off too', () => {
  // MangaNato titles its pages "Read <series> Manga" — the trailing half came
  // off already and the leading "Read" stayed, so One Piece went into the
  // library as "Read One Piece". English and French both put the word first.
  assert.equal(displayTitle('Read One Piece Manga'), 'One Piece');
  assert.equal(displayTitle('Lire One Piece Scan en ligne'), 'One Piece');
  assert.equal(displayTitle('Read Solo Leveling Manga Online'), 'Solo Leveling');
});

test('the head is trimmed on the same evidence as the tail', () => {
  // One cut is not evidence, at either end: a title that opens on a listed word
  // and has nothing else wrong with it is a title that means it. Same rule that
  // keeps "Naruto Scan" whole, applied to the other side.
  for (const title of [
    'Read or Die',
    'Read Blue Lock',
    'Chapitres Kagurabachi',
    // Nothing would be left, so nothing goes: "Scan" is not a title, but it is
    // what the caller has, and the caller would rather have it back than "".
    'Scan',
    'Read Manga',
  ]) {
    assert.equal(displayTitle(title), title);
  }
  // And the head is never eaten down to nothing even with cuts to spare.
  assert.equal(displayTitle('Read Manga Scan VF'), 'Read Manga Scan VF');
});

test('a bracket that still has its partner is part of the title', () => {
  // Straight out of the library: MANGA Plus prints "[#002] Shunrai Table
  // Tennis", and trimming the ends took the "[" while leaving the "]" — a
  // worse title than the one the site gave us, which is the one thing this
  // function is not allowed to produce.
  assert.equal(displayTitle('[#002] Shunrai Table Tennis'), '[#002] Shunrai Table Tennis');
  assert.equal(displayTitle('(Oneshot) Kaiju No. 8'), '(Oneshot) Kaiju No. 8');
  // An orphan is still furniture: nothing it was wrapping is left.
  assert.equal(displayTitle('Ao no Hako »'), 'Ao no Hako');
  assert.equal(displayTitle('Blue Lock :'), 'Blue Lock');
  assert.equal(displayTitle('One Piece)'), 'One Piece');
});

test('displayTitle never returns nothing when it was given something', () => {
  // A title made entirely of noise would otherwise strip to the empty string,
  // and an entry with no name at all is worse than one with a bad name.
  assert.equal(displayTitle('Scan VF Manga Gratuit'), 'Scan VF Manga Gratuit');
  assert.equal(displayTitle('  One Piece  '), 'One Piece');
  assert.equal(displayTitle(''), '');
  assert.equal(displayTitle(null), '');
  assert.equal(displayTitle(undefined), '');
});

test('a title cleaned for display still matches the raw ones', () => {
  // The cleaned title is what gets *stored*, so every later match is made
  // against it: if cleaning cost the matcher anything, adding the same series
  // from a second site would stop recognising the entry already on the shelf.
  const entry = {
    title: displayTitle('Ao no Hako VF — Chapitre 109 | Lecture en ligne'),
    sourceUrl: 'https://a.test/m/ao-no-hako',
  };
  assert.equal(entry.title, 'Ao no Hako');
  for (const raw of ['Ao no Hako VF', 'Ao no Hako Scan VF — Lecture en ligne', 'Ao No Hako Chapter 109']) {
    assert.equal(classify({ title: raw, sourceUrl: 'https://b.test/read/ao-no-hako' }, entry)?.confidence,
      'same-title', raw);
  }
});
