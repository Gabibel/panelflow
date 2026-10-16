// What the shared rules make of the official sites the QA campaign tried.
//
// webtoons.com and fmteam were opened for real in October 2026
// (qa-sim/runs/real-sites/) and neither was read the way a reader reads it:
//   - webtoons.com names its episodes "Ep. 12" and `episode_no=13`, words the
//     chapter rule did not know, so no episode was ever a chapter (NEW-15);
//     and every episode was a series of its own to the library.
//   - fmteam files every series under its language, /read/kingdom/fr/ch/888,
//     and "fr" became the series: every series on the site was one.
// And syosetu's novels, written in Japanese, were never prose (RS-2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterNumber, seriesSlug, proseLength } from '../src/site-rules.js';
import { seriesKey, sameSeries } from '../src/series-match.js';

const TOG = 'https://www.webtoons.com/en/fantasy/tower-of-god';

test('a webtoons.com episode is numbered by its place in the series, not in its season', () => {
  // season-3-ep-150 is the 568th episode: the number that keeps rising from
  // one season to the next is the one that orders a chapter list.
  const path = (u) => { const x = new URL(u); return x.pathname + x.search; };
  assert.equal(chapterNumber(path(`${TOG}/season-3-ep-150/viewer?title_no=95&episode_no=568`)), '568');
  assert.equal(chapterNumber(path(`${TOG}/season-1-ep-0/viewer?title_no=95&episode_no=1`)), '1');
});

test('"Ep." names a chapter, and only with a boundary in front of it', () => {
  assert.equal(chapterNumber('[Season 1] Ep. 12'), '12');
  assert.equal(chapterNumber('/anime/x/ep-7/'), '7');
  assert.equal(chapterNumber('step-3'), null);
  assert.equal(chapterNumber('keep-2'), null);
  // And the rules that worked keep working.
  assert.equal(chapterNumber('/manga/one-piece-chapter-1100/'), '1100');
  assert.equal(chapterNumber('Chapitre 109'), '109');
});

test('every episode of a webtoons.com series is that one series', () => {
  const ep1 = `${TOG}/season-1-ep-0/viewer?title_no=95&episode_no=1`;
  const ep568 = `${TOG}/season-3-ep-150/viewer?title_no=95&episode_no=568`;
  const list = `${TOG}/list?title_no=95`;
  assert.equal(seriesKey(ep1), 'webtoons.com|tower-of-god');
  assert.equal(seriesKey(ep568), 'webtoons.com|tower-of-god');
  assert.equal(seriesKey(list), 'webtoons.com|tower-of-god');
  assert.ok(sameSeries(ep1, list));
  assert.equal(seriesSlug(ep1), 'tower-of-god', '"viewer" is a word of the site, not a series');
  assert.equal(seriesSlug(list), 'tower-of-god', 'and so is "list"');
});

test('two fmteam series are two series, whatever language they are filed under', () => {
  const kingdom = 'https://fmteam.fr/read/kingdom/fr/ch/888';
  const blueBox = 'https://fmteam.fr/read/blue-box/fr/ch/109';
  assert.equal(seriesKey(kingdom), 'fmteam.fr|kingdom');
  assert.notEqual(seriesKey(kingdom), seriesKey(blueBox));
  assert.ok(!sameSeries(kingdom, blueBox));
  assert.ok(sameSeries(kingdom, 'https://fmteam.fr/read/kingdom/fr/ch/889'));
});

test('a line of Japanese is measured for what it says, not for its characters', () => {
  // Twenty characters of Japanese say what sixty of English do: the prose
  // floors are written in Latin characters, so a wide character counts three.
  const line = 'ある日、森の中で少女は小さな光を見つけた。';
  assert.equal(line.length, 21);
  assert.ok(proseLength(line) >= 60, `${proseLength(line)} is under the floor of 60`);
  assert.equal(proseLength('Hello there'), 11, 'Latin text is measured as it always was');
  assert.equal(proseLength(''), 0);
});
