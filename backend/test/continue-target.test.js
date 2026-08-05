// Where a series' cover leads.
//
// A cover that always opens the chapter you are already on is a dead end once
// you have caught up: the reason to open the series again is the chapter that
// came out since. The site never links that chapter from anywhere you have been
// — it did not exist when you were last there — so its URL is worked out from
// the one you did read, which every site agrees to number in the path.
//
// The rule is written twice: once in shared/panelflow-core.js, which the
// extension and both phone shells run, and once in web/app.js, which is served
// straight to a browser with no bridge to that core. Both copies are lifted out
// of their source here and run over the same table, so a change to one that the
// other does not follow fails a test rather than shipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, ...p.split('/')), 'utf8');

/** Lift a run of source between two markers and evaluate it on its own. */
function lift(file, from, to, deps, returns) {
  const src = read(file);
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  assert.ok(a !== -1 && b > a, `${file}: the rule is not where this test expects it`);
  return new Function(`${deps}\n${src.slice(a, b)}\nreturn { ${returns} };`)();
}

// The core's copy stops at the marker that follows it; the helpers it leans on
// come along, except labelNum, which lives further up the file.
const core = lift(
  'shared/panelflow-core.js',
  '  const URL_NUM_RE',
  '  // Titles scraped from a chapter page',
  `const labelNum = (label) => {
     const m = String(label ?? '').match(/(\\d+(?:\\.\\d+)?)/);
     return m ? parseFloat(m[1]) : NaN;
   };`,
  'nextChapterUrl, continueTarget',
);

const web = lift(
  'web/app.js',
  'const URL_NUM_RE',
  '// A new scan is out when',
  `const chapterNum = (label) => {
     const m = String(label ?? '').match(/(\\d+(?:\\.\\d+)?)/);
     return m ? parseFloat(m[1]) : null;
   };`,
  'nextChapterUrl, continueTarget',
);

const BOTH = [['the core', core], ['the web app', web]];
/** Run one assertion against both copies, naming whichever fails. */
const both = (fn) => { for (const [who, impl] of BOTH) fn(impl, who); };

// --- deriving one chapter's URL from another --------------------------------

test('the chapter number in the path is the one that moves', () => {
  both((impl, who) => {
    for (const [url, from, to, want] of [
      ['https://asuracomic.net/series/villain-to-kill/chapter/245', 245, 246,
        'https://asuracomic.net/series/villain-to-kill/chapter/246'],
      ['https://scan-manga.com/ao-no-hako/chapitre-109-vf', 109, 110,
        'https://scan-manga.com/ao-no-hako/chapitre-110-vf'],
      ['https://example.com/read/one-piece/1055', 1055, 1056,
        'https://example.com/read/one-piece/1056'],
      // A query string is part of the path as far as this is concerned.
      ['https://example.com/reader?ch=42', 42, 43, 'https://example.com/reader?ch=43'],
    ]) {
      assert.equal(impl.nextChapterUrl(url, from, to), want, `${who}: ${url}`);
    }
  });
});

test('a site that pads its numbers keeps being padded', () => {
  // "/chapter/246" 404s where "/chapter/0246" is the address, so the new number
  // is written the way the old one was.
  both((impl, who) => {
    assert.equal(impl.nextChapterUrl('https://x.com/c/0245', 245, 246),
      'https://x.com/c/0246', who);
    assert.equal(impl.nextChapterUrl('https://x.com/c/009', 9, 10),
      'https://x.com/c/010', who);
    // Not padded to begin with — do not invent it.
    assert.equal(impl.nextChapterUrl('https://x.com/c/9', 9, 10), 'https://x.com/c/10', who);
  });
});

test('the host is never touched', () => {
  // "ww6" is a mirror number, not a chapter, and rewriting it points the reader
  // at a server that may not exist.
  both((impl, who) => {
    assert.equal(impl.nextChapterUrl('https://ww6.mangasite.tv/manga/x/chapter-6', 6, 7),
      'https://ww6.mangasite.tv/manga/x/chapter-7', who);
  });
});

test('an ambiguous number is left alone rather than guessed at', () => {
  both((impl, who) => {
    // The series is named after its own number: only one of the two 3s is the
    // chapter, and the chapter word says which.
    assert.equal(impl.nextChapterUrl('https://x.com/tower-of-god-3/chapter/3', 3, 4),
      'https://x.com/tower-of-god-3/chapter/4', who);
    // Same number twice with nothing to tell them apart: no answer is better
    // than an answer that silently switches series.
    assert.equal(impl.nextChapterUrl('https://x.com/12/12', 12, 13), null, who);
  });
});

test('a URL with no chapter number in it yields nothing', () => {
  both((impl, who) => {
    // MangaDex-style: the chapter is a uuid, and there is nothing to increment.
    assert.equal(
      impl.nextChapterUrl('https://mangadex.org/chapter/8b8c1e02-1f4a-4a1a-9f3e-0d0c1b2a3f44', 42, 43),
      null, who);
    assert.equal(impl.nextChapterUrl('', 1, 2), null, who);
    assert.equal(impl.nextChapterUrl('not a url', 1, 2), null, who);
  });
});

test('"no number" is accepted however the caller spells it', () => {
  // The core's chapter parser returns NaN and the web app's returns null; the
  // shared rule has to refuse both without throwing.
  both((impl, who) => {
    assert.equal(impl.nextChapterUrl('https://x.com/c/1', NaN, 2), null, who);
    assert.equal(impl.nextChapterUrl('https://x.com/c/1', 1, null), null, who);
    assert.equal(impl.nextChapterUrl('https://x.com/c/1', undefined, undefined), null, who);
  });
});

test('the anchor of the chapter you are leaving does not come along', () => {
  // "#page-14" is a position in chapter 245; carrying it over would drop the
  // reader fourteen pages into 246.
  both((impl, who) => {
    assert.equal(impl.nextChapterUrl('https://x.com/chapter/245#page-14', 245, 246),
      'https://x.com/chapter/246', who);
  });
});

// --- what the cover opens ---------------------------------------------------

const entry = { sourceUrl: 'https://x.com/villain-to-kill', lastKnownChapter: '246' };
const progress = (over = {}) => ({
  chapterUrl: 'https://x.com/villain-to-kill/chapter/245',
  chapterLabel: 'Chapter 245',
  page: 0,
  pageCount: null,
  ...over,
});

test('caught up, and a new chapter is out: the cover opens the new one', () => {
  both((impl, who) => {
    const t = impl.continueTarget(entry, progress());
    assert.equal(t.url, 'https://x.com/villain-to-kill/chapter/246', who);
    assert.equal(t.label, 'Ch. 246', who);
    assert.equal(t.isNew, true, who);
  });
});

test('nothing new: the cover opens the chapter you are on', () => {
  both((impl, who) => {
    const t = impl.continueTarget({ ...entry, lastKnownChapter: '245' }, progress());
    assert.equal(t.url, 'https://x.com/villain-to-kill/chapter/245', who);
    assert.equal(t.isNew, false, who);
  });
});

test('five chapters behind: the next one, not the newest', () => {
  // "The one after the one you finished" — 250 would skip four chapters the
  // reader has not seen.
  both((impl, who) => {
    const t = impl.continueTarget({ ...entry, lastKnownChapter: '250' }, progress());
    assert.equal(t.url, 'https://x.com/villain-to-kill/chapter/246', who);
    assert.equal(t.label, 'Ch. 246', who);
  });
});

test('mid-chapter, the bookmark wins', () => {
  // Page 3 of 40 is not "finished with 245", whatever the site has published
  // since — the whole point of a bookmark is that it survives the news.
  both((impl, who) => {
    const t = impl.continueTarget(entry, progress({ page: 3, pageCount: 40 }));
    assert.equal(t.url, 'https://x.com/villain-to-kill/chapter/245', who);
    assert.equal(t.isNew, false, who);
  });
});

test('the last page of a counted chapter is finished', () => {
  both((impl, who) => {
    const t = impl.continueTarget(entry, progress({ page: 39, pageCount: 40 }));
    assert.equal(t.url, 'https://x.com/villain-to-kill/chapter/246', who);
  });
});

test('an uncounted bookmark does not block the jump', () => {
  // The bookmark the site's own next-chapter link writes has page 0 and no
  // count at all. Reading that as "unfinished" would pin every such reader to a
  // chapter they closed months ago — which is the bug this all started as.
  both((impl, who) => {
    const t = impl.continueTarget(entry, progress({ page: 0, pageCount: null }));
    assert.equal(t.isNew, true, who);
  });
});

test('no bookmark at all: the series page', () => {
  both((impl, who) => {
    const t = impl.continueTarget(entry, null);
    assert.equal(t.url, 'https://x.com/villain-to-kill', who);
    assert.equal(t.isNew, false, who);
  });
});

test('a chapter URL nothing can be derived from stays where it is', () => {
  both((impl, who) => {
    const t = impl.continueTarget(entry, progress({
      chapterUrl: 'https://mangadex.org/chapter/8b8c1e02-1f4a-4a1a-9f3e-0d0c1b2a3f44',
    }));
    assert.equal(t.url, 'https://mangadex.org/chapter/8b8c1e02-1f4a-4a1a-9f3e-0d0c1b2a3f44', who);
    assert.equal(t.isNew, false, who);
  });
});

test('a label with no number in it is not a chapter to count from', () => {
  both((impl, who) => {
    const t = impl.continueTarget(entry, progress({ chapterLabel: 'Prologue' }));
    assert.equal(t.isNew, false, who);
  });
});

// --- the clients ------------------------------------------------------------

test('every client asks the core where a cover leads', () => {
  // Three shells, one rule. A shell that goes back to reading progress.chapterUrl
  // directly is a shell whose covers stop keeping up with the site.
  for (const file of ['extension/popup/popup.js', 'mobile/www/app.js']) {
    assert.match(read(file), /continueTargets/, `${file} no longer asks for the targets`);
  }
  assert.match(read('shared/panelflow-core.js'), /case 'continueTargets':/,
    'the hub no longer answers continueTargets');
});

test('a new-chapter notification says where it goes', () => {
  // A notification you cannot tap is half the feature: the point is to land on
  // the chapter, not to be told it exists.
  const core_ = read('shared/panelflow-core.js');
  const notifyCall = core_.slice(core_.indexOf('notify({'), core_.indexOf('notify({') + 400);
  assert.match(notifyCall, /url:/, 'the notification carries no target');
  assert.match(read('extension/background.js'), /notifications\.onClicked/,
    'nothing opens the chapter when the notification is clicked');
});
