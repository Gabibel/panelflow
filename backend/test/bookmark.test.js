// The bookmark and the last position — arbitrage e of the QA report
// (September 2026).
//
// Rereading chapter 9 of a series read to chapter 11 used to put the bookmark
// back to 9: "Continue" then opened chapter 10, the shelf counted chapters 10
// and 11 as unread again, and the trackers were told the reader had gone
// backwards. Two answers are kept now. The last position is where the reader
// *is* — the reread — and the latest one wins between devices. The bookmark is
// the furthest chapter reached: it never goes back, whichever device is late,
// unless the reader moves it by hand, and then every older bookmark is void.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, addEntry, newUser, shutdown } from '../test-support/harness.js';
import { bootCore, json, entryFixture } from '../test-support/core.js';
import { buildBackup, restoreBackup, toCsv, toMalXml } from '../src/routes/export.js';

after(shutdown);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const chapter = (n) => `https://example-manga-site.test/manga/x/ch-${n}`;
const put = (u, e, body) => api('PUT', `/api/progress/${e.id}`, body, u.token);
const at = (day, time = '10:00:00') => `2026-09-${String(day).padStart(2, '0')}T${time}.000Z`;

// --- the server --------------------------------------------------------------

test('a reread moves the position and leaves the bookmark', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  await put(u, e, { chapterUrl: chapter(11), chapterLabel: 'Ch. 11', page: 19, pageCount: 20, updatedAt: at(20) });
  const r = await put(u, e, { chapterUrl: chapter(9), chapterLabel: 'Ch. 9', page: 2, pageCount: 18, updatedAt: at(21) });
  assert.equal(r.status, 200);
  assert.equal(r.body.chapterLabel, 'Ch. 9', 'the position is the reread');
  assert.equal(r.body.furthest.chapterLabel, 'Ch. 11', 'the bookmark stays where the reading got to');
  assert.equal(r.body.furthest.page, 19);
  assert.equal(r.body.furthest.movedAt, null);
});

test('a client from before the bookmark cannot rewind it either', async () => {
  // Builds already installed send no `furthest`: their chapter is their
  // bookmark, merged by the same rule.
  const u = await newUser();
  const e = await addEntry(u.token);
  await put(u, e, { chapterUrl: chapter(12), chapterLabel: 'Ch. 12' });
  const r = await put(u, e, { chapterUrl: chapter(9), chapterLabel: 'Ch. 9' });
  assert.equal(r.body.chapterLabel, 'Ch. 9');
  assert.equal(r.body.furthest.chapterLabel, 'Ch. 12');
});

test('an older position that went further keeps the bookmark, not the position', async () => {
  // The PC rereads chapter 9 today; the phone's chapter 12, read last week and
  // never sent, arrives afterwards. Older as a position, further as a bookmark.
  const u = await newUser();
  const e = await addEntry(u.token);
  await put(u, e, { chapterUrl: chapter(9), chapterLabel: 'Ch. 9', updatedAt: at(24) });
  const r = await put(u, e, {
    chapterUrl: chapter(12), chapterLabel: 'Ch. 12', updatedAt: at(17),
    furthest: { chapterUrl: chapter(12), chapterLabel: 'Ch. 12', page: 4, pageCount: 30, at: at(17) },
  });
  assert.equal(r.body.stale, true, 'the position lost, and the device is told');
  assert.equal(r.body.chapterLabel, 'Ch. 9');
  assert.equal(r.body.furthest.chapterLabel, 'Ch. 12');
  assert.equal(r.body.furthest.page, 4);
  const [row] = (await api('GET', '/api/progress', undefined, u.token)).body;
  assert.equal(row.chapterLabel, 'Ch. 9');
  assert.equal(row.furthest.chapterLabel, 'Ch. 12');
});

test('a bookmark moved by hand outlives a further one set before the move', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  await put(u, e, { chapterUrl: chapter(12), chapterLabel: 'Ch. 12', updatedAt: at(10) });
  const moved = await put(u, e, {
    chapterUrl: chapter(5), chapterLabel: 'Ch. 5', updatedAt: at(20),
    furthest: { chapterUrl: chapter(5), chapterLabel: 'Ch. 5', at: at(20), movedAt: at(20) },
  });
  assert.equal(moved.body.furthest.chapterLabel, 'Ch. 5', 'moved back by hand');
  assert.equal(moved.body.furthest.movedAt, '2026-09-20 10:00:00');

  // A device that read chapter 11 before the move, and sends it only now.
  const late = await put(u, e, {
    chapterUrl: chapter(11), chapterLabel: 'Ch. 11', updatedAt: at(15),
    furthest: { chapterUrl: chapter(11), chapterLabel: 'Ch. 11', at: at(15) },
  });
  assert.equal(late.body.furthest.chapterLabel, 'Ch. 5', 'set before the move, so void');
});

test('the move stays a fence once reading goes on from it', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  await put(u, e, { chapterUrl: chapter(12), chapterLabel: 'Ch. 12', updatedAt: at(10) });
  await put(u, e, {
    chapterUrl: chapter(5), chapterLabel: 'Ch. 5', updatedAt: at(20),
    furthest: { chapterUrl: chapter(5), chapterLabel: 'Ch. 5', at: at(20), movedAt: at(20) },
  });
  // Chapter 6, read after the move: the bookmark goes on, the fence stays.
  const on = await put(u, e, {
    chapterUrl: chapter(6), chapterLabel: 'Ch. 6', updatedAt: at(21),
    furthest: { chapterUrl: chapter(6), chapterLabel: 'Ch. 6', at: at(21), movedAt: at(20) },
  });
  assert.equal(on.body.furthest.chapterLabel, 'Ch. 6');
  assert.equal(on.body.furthest.movedAt, '2026-09-20 10:00:00');
  // Chapter 11 from before the move still does not come back...
  const old = await put(u, e, {
    chapterUrl: chapter(11), chapterLabel: 'Ch. 11', updatedAt: at(15),
    furthest: { chapterUrl: chapter(11), chapterLabel: 'Ch. 11', at: at(15) },
  });
  assert.equal(old.body.furthest.chapterLabel, 'Ch. 6');
  // ...and chapter 8, read on the phone after it, goes further.
  const after_ = await put(u, e, {
    chapterUrl: chapter(8), chapterLabel: 'Ch. 8', updatedAt: at(22),
    furthest: { chapterUrl: chapter(8), chapterLabel: 'Ch. 8', at: at(22) },
  });
  assert.equal(after_.body.furthest.chapterLabel, 'Ch. 8');
});

test('chapters with no number: the later bookmark is kept', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  await put(u, e, { chapterUrl: 'https://example-manga-site.test/manga/x/prologue', chapterLabel: 'Prologue', updatedAt: at(10) });
  const r = await put(u, e, { chapterUrl: 'https://example-manga-site.test/manga/x/extra', chapterLabel: 'Extra', updatedAt: at(11) });
  assert.equal(r.body.furthest.chapterLabel, 'Extra');
});

test('a bookmark that is not an http(s) address is refused, and named', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  const r = await put(u, e, {
    chapterUrl: chapter(1), furthest: { chapterUrl: 'javascript:alert(1)', chapterLabel: 'Ch. 1' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /furthest\.chapterUrl/);
});

test('the trackers are told the bookmark, not a reread', () => {
  // Both of the places the server reads a series' chapter for a tracker.
  const src = read('backend', 'src', 'tracker-push.js');
  assert.equal(src.match(/COALESCE\(p\.furthest_label, p\.chapter_label\) AS chapter_label/g)?.length, 2);
  assert.match(read('backend', 'src', 'routes', 'progress.js'),
    /pushProgress\(req\.user\.id, row\.library_id, row\.furthest_label \?\? chapterLabel\)/);
});

test('a backup carries the bookmark, and restores it', async () => {
  const source = await newUser();
  const e = await addEntry(source.token);
  await put(source, e, { chapterUrl: chapter(11), chapterLabel: 'Ch. 11', page: 3, pageCount: 20, updatedAt: at(20) });
  await put(source, e, { chapterUrl: chapter(9), chapterLabel: 'Ch. 9', updatedAt: at(21) });
  const file = await buildBackup(source.id);
  const [s] = file.library;
  assert.equal(s.progress.chapterLabel, 'Ch. 9');
  assert.equal(s.progress.furthest.chapterLabel, 'Ch. 11');
  assert.equal(s.progress.furthest.page, 3);
  // What the other services and the spreadsheet are told is how far it went.
  assert.match(toMalXml(file), /<my_read_chapters>11<\/my_read_chapters>/);
  assert.match(toCsv(file), /"Ch\. 11"/);

  const target = await newUser();
  await restoreBackup(target.id, file, { dryRun: false });
  const [b] = (await buildBackup(target.id)).library;
  assert.equal(b.progress.chapterLabel, 'Ch. 9');
  assert.equal(b.progress.furthest.chapterLabel, 'Ch. 11');
  assert.equal(b.progress.furthest.page, 3);
});

// --- the merge, on the client --------------------------------------------------

const { mergeMarks, bookmarkOf, continueTarget } = await (async () => {
  await import('../src/panelflow-core.js');
  return globalThis.PanelFlowCore;
})();

const mark = (n, when, movedAt = null) => ({
  chapterUrl: chapter(n), chapterLabel: `Ch. ${n}`, page: 0, pageCount: null, at: when, movedAt,
});

test('mergeMarks: the further chapter, whichever is newer', () => {
  assert.equal(mergeMarks(mark(12, at(1)), mark(9, at(2))).chapterLabel, 'Ch. 12');
  assert.equal(mergeMarks(mark(9, at(2)), mark(12, at(1))).chapterLabel, 'Ch. 12');
});

test('mergeMarks: a move voids what was set before it, and is carried on', () => {
  const moved = mark(5, at(20), at(20));
  assert.equal(mergeMarks(mark(12, at(10)), moved).chapterLabel, 'Ch. 5');
  assert.equal(mergeMarks(moved, mark(12, at(10))).chapterLabel, 'Ch. 5');
  // Read on from the move: further, and still fenced.
  const on = mergeMarks(moved, mark(6, at(21)));
  assert.equal(on.chapterLabel, 'Ch. 6');
  assert.equal(on.movedAt, at(20));
  assert.equal(mergeMarks(on, mark(11, at(15))).chapterLabel, 'Ch. 6');
  // In the server's spelling, to the second: the same fence.
  assert.equal(mergeMarks({ ...on, movedAt: '2026-09-20 10:00:00' }, mark(11, at(15))).chapterLabel, 'Ch. 6');
});

test('mergeMarks: the same chapter, or no number, is the later one', () => {
  const early = { ...mark(7, at(1)), page: 3 };
  const late = { ...mark(7, at(2)), page: 9 };
  assert.equal(mergeMarks(early, late).page, 9);
  assert.equal(mergeMarks(late, early).page, 9);
  const a = { chapterUrl: 'https://s.test/x/prologue', chapterLabel: 'Prologue', at: at(1) };
  const b = { chapterUrl: 'https://s.test/x/extra', chapterLabel: 'Extra', at: at(2) };
  assert.equal(mergeMarks(a, b).chapterLabel, 'Extra');
  assert.equal(mergeMarks(b, a).chapterLabel, 'Extra');
  // A number in the address counts where the label has none.
  const byUrl = { chapterUrl: 'https://s.test/x/chapter-30', chapterLabel: 'Final battle', at: at(1) };
  assert.equal(mergeMarks(byUrl, mark(12, at(2))).chapterUrl, 'https://s.test/x/chapter-30');
});

test('bookmarkOf: a record from before the two were kept apart is its own bookmark', () => {
  const old = { chapterUrl: chapter(4), chapterLabel: 'Ch. 4', page: 2, pageCount: 9, updatedAt: at(3) };
  assert.deepEqual(bookmarkOf(old), {
    chapterUrl: chapter(4), chapterLabel: 'Ch. 4', page: 2, pageCount: 9, at: at(3), movedAt: null,
  });
  assert.equal(bookmarkOf(null), null);
});

test('continueTarget: Continue goes on from the bookmark, and the reread rides along', () => {
  const entry = { sourceUrl: 'https://example-manga-site.test/manga/x', lastKnownChapter: '14' };
  const t = continueTarget(entry, {
    chapterUrl: chapter(9), chapterLabel: 'Ch. 9', page: 4, pageCount: 20,
    furthest: { ...mark(11, at(1)), page: 19, pageCount: 20 },
  });
  assert.equal(t.url, chapter(12), 'the chapter after the bookmark, not after the reread');
  assert.equal(t.isNew, true);
  assert.deepEqual(t.reread, { url: chapter(9), label: 'Ch. 9' });
  // On the bookmark's own chapter there is nothing to resume.
  const same = continueTarget(entry, { ...mark(11, at(1)), updatedAt: at(1), furthest: mark(11, at(1)) });
  assert.equal(same.reread, null);
});

// --- the client, end to end ------------------------------------------------------

const SRC = 'https://old-scan.test/manga/ao-no-hako';
const ch = (n) => `https://old-scan.test/manga/ao-no-hako/chapitre-${n}`;
const saving = (n, over = {}) => ({
  type: 'saveProgress',
  progress: { sourceUrl: SRC, chapterUrl: ch(n), chapterLabel: `Chapitre ${n}`, page: 0, pageCount: 20, scrollPos: 0, ...over },
});

test('the reader rereading chapter 9 leaves the bookmark at chapter 11', async () => {
  const entry = entryFixture({ lastKnownChapter: '14' });
  const { hub, storage } = bootCore({ storage: { library: [entry] } });
  await hub(saving(11, { page: 19 }));
  await hub(saving(9, { page: 2 }));
  const p = storage().progress[SRC];
  assert.equal(p.chapterLabel, 'Chapitre 9');
  assert.equal(p.furthest.chapterLabel, 'Chapitre 11');
  assert.equal(p.furthest.page, 19);

  // The covers and the badges read the bookmark.
  const { targets } = await hub({ type: 'continueTargets' });
  assert.equal(targets[entry.id].url, ch(12));
  assert.equal(targets[entry.id].reread.url, ch(9));
});

test('reading on in the bookmark\'s chapter carries its page; a further one takes over', async () => {
  const { hub, storage } = bootCore({ storage: { library: [entryFixture()] } });
  await hub(saving(11, { page: 3 }));
  await hub(saving(11, { page: 12 }));
  assert.equal(storage().progress[SRC].furthest.page, 12);
  await hub(saving(12, { page: 1 }));
  assert.equal(storage().progress[SRC].furthest.chapterLabel, 'Chapitre 12');
});

test('"move the bookmark here" moves it back, as a fence', async () => {
  const { hub, storage } = bootCore({ storage: { library: [entryFixture()] } });
  await hub(saving(11, { page: 19 }));
  await hub(saving(9, { page: 2 }));
  await hub(saving(9, { page: 2, moveBookmark: true }));
  const p = storage().progress[SRC];
  assert.equal(p.furthest.chapterLabel, 'Chapitre 9');
  assert.ok(p.furthest.movedAt, 'the move is dated');
  assert.equal(p.moveBookmark, undefined, 'the request is not stored as a field');
});

test('opening a chapter behind the bookmark is answered with the bookmark', async () => {
  const { hub } = bootCore({ storage: { library: [entryFixture()] } });
  await hub(saving(11, { page: 19 }));
  await hub(saving(9, { page: 2 }));
  const behind = await hub({ type: 'getProgressFor', chapterUrl: ch(8), sourceUrl: SRC, chapterLabel: 'Chapitre 8' });
  assert.equal(behind.bookmark.chapterUrl, ch(11));
  const onIt = await hub({ type: 'getProgressFor', chapterUrl: ch(11), sourceUrl: SRC, chapterLabel: 'Chapitre 11' });
  assert.equal(onIt.bookmark, null, 'the bookmark\'s own chapter is no reread');
  assert.equal(onIt.progress.page, 19, 'and opens where the bookmark stopped in it');
  const ahead = await hub({ type: 'getProgressFor', chapterUrl: ch(13), sourceUrl: SRC, chapterLabel: 'Chapitre 13' });
  assert.equal(ahead.bookmark, null);
  const unnumbered = await hub({ type: 'getProgressFor', chapterUrl: `${SRC}/extra`, sourceUrl: SRC, chapterLabel: 'Extra' });
  assert.equal(unnumbered.bookmark, null, 'no number, no "behind"');
  const without = await hub({ type: 'getProgressFor', chapterUrl: ch(8) });
  assert.equal(without.bookmark, null, 'asked without the series, nothing is guessed');
});

test('a pull takes a further bookmark from the account and keeps the reread here', async () => {
  const entry = entryFixture({ remoteId: 'r1' });
  const { core, storage } = bootCore({
    storage: {
      library: [entry], authToken: 't',
      progress: {
        [SRC]: {
          sourceUrl: SRC, chapterUrl: ch(9), chapterLabel: 'Chapitre 9', page: 2, pageCount: 20,
          updatedAt: at(25), syncedAt: at(25),
          furthest: { chapterUrl: ch(9), chapterLabel: 'Chapitre 9', page: 2, pageCount: 20, at: at(25), movedAt: null },
        },
      },
    },
    fetch: async (url) => {
      const path = String(url).replace('https://api.test', '');
      if (path === '/api/library') return json([{ ...entry, id: 'r1' }]);
      if (path === '/api/progress') {
        return json([{
          libraryId: 'r1', chapterUrl: ch(12), chapterLabel: 'Chapitre 12', page: 0, pageCount: 20,
          updatedAt: '2026-09-17 10:00:00',
          furthest: { chapterUrl: ch(12), chapterLabel: 'Chapitre 12', page: 0, pageCount: 20, at: '2026-09-17 10:00:00', movedAt: null },
        }]);
      }
      return json({});
    },
  });
  await core.pullLibrary();
  const p = storage().progress[SRC];
  assert.equal(p.chapterLabel, 'Chapitre 9', 'the later position stays');
  assert.equal(p.furthest.chapterLabel, 'Chapitre 12', 'the further bookmark comes in');
});

test('a further bookmark the account has not had goes back with the next sync', async () => {
  const entry = entryFixture({ remoteId: 'r1' });
  const puts = [];
  const { core, storage } = bootCore({
    storage: {
      library: [entry], authToken: 't',
      progress: {
        // Read offline last week, never sent.
        [SRC]: {
          sourceUrl: SRC, chapterUrl: ch(12), chapterLabel: 'Chapitre 12', page: 5, pageCount: 20,
          updatedAt: at(17),
          furthest: { chapterUrl: ch(12), chapterLabel: 'Chapitre 12', page: 5, pageCount: 20, at: at(17), movedAt: null },
        },
      },
    },
    fetch: async (url, init) => {
      const path = String(url).replace('https://api.test', '');
      if (path === '/api/library') return json([{ ...entry, id: 'r1' }]);
      if (path === '/api/progress') {
        // A reread of chapter 9 elsewhere, today.
        return json([{
          libraryId: 'r1', chapterUrl: ch(9), chapterLabel: 'Chapitre 9', page: 2, pageCount: 20,
          updatedAt: '2026-09-25 10:00:00',
          furthest: { chapterUrl: ch(11), chapterLabel: 'Chapitre 11', page: 0, pageCount: 20, at: '2026-09-20 10:00:00', movedAt: null },
        }]);
      }
      if (path === '/api/progress/r1' && init?.method === 'PUT') {
        const body = JSON.parse(init.body);
        puts.push(body);
        return json({
          libraryId: 'r1', chapterUrl: ch(9), chapterLabel: 'Chapitre 9', page: 2, pageCount: 20,
          updatedAt: '2026-09-25 10:00:00',
          furthest: { ...body.furthest, at: '2026-09-17 10:00:00' },
        });
      }
      return json({});
    },
  });
  const report = await core.syncAll();
  assert.equal(report.ok, true, JSON.stringify(report));
  const p = storage().progress[SRC];
  assert.equal(p.chapterLabel, 'Chapitre 9', 'the other device\'s later position');
  assert.equal(p.furthest.chapterLabel, 'Chapitre 12', 'this device\'s further bookmark');
  assert.equal(puts.length, 1, 'sent once');
  assert.equal(puts[0].furthest.chapterLabel, 'Chapitre 12');
  assert.equal(puts[0].chapterLabel, 'Chapitre 9', 'with the account\'s position, not an older one');
});

// --- the screens --------------------------------------------------------------

test('the shelf counts unread chapters from the bookmark', async () => {
  new Function(read('shared', 'library-view.js'))();
  const V = globalThis.PanelFlowView;
  const entry = { lastKnownChapter: '14', folder: 'reading' };
  const rereading = { chapterUrl: chapter(9), chapterLabel: 'Ch. 9', furthest: mark(11, at(1)) };
  assert.equal(V.chaptersBehind(entry, rereading), 3, 'from chapter 11, not chapter 9');
  assert.equal(V.bookmarkOf(rereading).chapterLabel, 'Ch. 11');
  assert.equal(V.chaptersBehind(entry, { chapterUrl: chapter(9), chapterLabel: 'Ch. 9' }), 5, 'an old row as before');
});

test('every screen that says how far a series got reads the bookmark', () => {
  for (const [file, pattern] of [
    ['extension/popup/popup.js', /PanelFlowView\.bookmarkOf\(progressOf\(entry\)\)/],
    ['extension/popup/popup.js', /t\('actionResumeReread'/],
    ['web/app.js', /PanelFlowView\.bookmarkOf\(progressMap\[entry\.id\]\)/],
    ['web/app.js', /t\('actionResumeReread'/],
    ['native/src/EntrySheet.js', /Shelf\.bookmarkOf\(record\)/],
    ['native/src/EntrySheet.js', /t\('actionResumeReread'/],
    ['native/src/screens/LibraryScreen.js', /Shelf\.bookmarkOf\(p\)/],
    ['mobile/www/app.js', /PanelFlowView\.bookmarkOf\(state\.progress\[entry\.sourceUrl\]\)/],
  ]) {
    assert.match(read(...file.split('/')), pattern, `${file}: ${pattern}`);
  }
});

test('the reader asks with the series, and offers to move the bookmark back', () => {
  const src = read('extension', 'content', 'reader.js');
  assert.match(src, /type: 'getProgressFor', chapterUrl: state\.meta\.chapterUrl,\s*sourceUrl: state\.meta\.sourceUrl/);
  assert.match(src, /if \(resp\.bookmark\?\.chapterUrl\) offerBookmarkMove\(resp\.bookmark\);/);
  assert.match(src, /progress: \{ \.\.\.progressNow\(\), moveBookmark: true \}/);
});

test('the in-app browser answers a page with this site\'s bookmark or none', () => {
  const src = read('native', 'src', 'core.js');
  assert.match(src, /bookmark: mark && onSite\(mark\.chapterUrl, site\) && onSite\(msg\.sourceUrl, site\) \? mark : null/);
});

// --- the re-test of It.4 (tester B) -------------------------------------------

test('a move in the very second of the bookmark it replaces still takes', async () => {
  // Moments are kept to the second. "At or after the fence" let a move lose to
  // the page turn that preceded it within the second.
  const u = await newUser();
  const e = await addEntry(u.token);
  const when = at(20, '10:00:00');
  await put(u, e, { chapterUrl: chapter(12), chapterLabel: 'Ch. 12', updatedAt: when });
  const moved = await put(u, e, {
    chapterUrl: chapter(9), chapterLabel: 'Ch. 9', updatedAt: at(20, '10:00:00').replace('.000Z', '.600Z'),
    furthest: { chapterUrl: chapter(9), chapterLabel: 'Ch. 9', at: at(20, '10:00:00').replace('.000Z', '.600Z'), movedAt: at(20, '10:00:00').replace('.000Z', '.600Z') },
  });
  assert.equal(moved.body.furthest.chapterLabel, 'Ch. 9');
  // And the client agrees.
  const merged = mergeMarks(mark(12, at(20, '10:00:00')), { ...mark(9, at(20, '10:00:00')), movedAt: at(20, '10:00:00') });
  assert.equal(merged.chapterLabel, 'Ch. 9');
  // While a bookmark of that same second that does not carry the move is
  // from before it.
  assert.equal(mergeMarks({ ...mark(9, at(20, '10:00:00')), movedAt: at(20, '10:00:00') }, mark(12, at(20, '10:00:00'))).chapterLabel, 'Ch. 9');
});

test('a series moved to another site is a fence: a late device cannot pull it back', async () => {
  // QA re-test It.4, N-B2: the move to scan-vf wrote the bookmark and cleared
  // the fence, and a tablet coming back with chapter 12 of the old site put
  // the series back there.
  const u = await newUser();
  const e = await addEntry(u.token);
  await put(u, e, { chapterUrl: chapter(10), chapterLabel: 'Ch. 10', updatedAt: at(22) });
  const moved = await api('POST', `/api/library/${e.id}/migrate`, {
    sourceUrl: 'https://scan-vf.test/manga/x', sourceDomain: 'scan-vf.test', title: 'X',
  }, u.token);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const late = await put(u, e, {
    chapterUrl: chapter(12), chapterLabel: 'Ch. 12', updatedAt: at(21),
    furthest: { chapterUrl: chapter(12), chapterLabel: 'Ch. 12', at: at(21) },
  });
  assert.equal(late.body.furthest.chapterLabel, 'Ch. 10', 'the old site came back');
  assert.match(late.body.furthest.chapterUrl, /^https:\/\/scan-vf\.test\//);
});

test('an unreadable compressed body is refused in our words, not zlib\'s', async () => {
  const { gzipSync } = await import('node:zlib');
  const u = await newUser();
  const e = await addEntry(u.token);
  const { base } = await import('../test-support/harness.js');
  const r = await fetch(`${base}/api/progress/${e.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${u.token}` },
    body: Buffer.concat([Buffer.from('not gzip at all'), gzipSync(Buffer.from('{}')).subarray(10)]),
  });
  const body = await r.json();
  assert.equal(r.status, 400);
  assert.equal(body.code, 'bad_request');
  assert.doesNotMatch(body.error, /header check|zlib|invalid/i);
});

test('only a real click moves the bookmark, and an episode keeps its clean names', () => {
  const reader = read('extension', 'content', 'reader.js');
  const choices = reader.slice(reader.indexOf('function flashChoices'), reader.indexOf('function tapTurnWidth'));
  assert.match(choices, /if \(!e\.isTrusted\) return;/);
  const modal = read('extension', 'content', 'library-modal.js');
  assert.match(modal, /state\.meta\.medium === 'anime' \? \{ \.\.\.better, \.\.\.state\.meta \}/);
});

test('turning a streaming site on asks for its player in the same question', () => {
  const popup = read('extension', 'popup', 'popup.js');
  assert.match(popup, /origins: \[`\$\{state\.origin\}\/\*`, \.\.\.players\]/);
  assert.match(popup, /videoDomains/);
  const manifest = JSON.parse(read('extension', 'manifest.json'));
  assert.ok(manifest.permissions.includes('activeTab'), 'the popup cannot read the page\'s frames without activeTab');
});
