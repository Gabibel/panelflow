// The phone's saved-chapter store: the shared store's contract, over files.
//
// shared/offline-store.js is tested on its own with a fake backend. What is
// new on the phone is the backend itself (native/src/offline.js): keys that are
// URLs turned into file names, bytes written as bytes, a size cap. So this
// runs the *shared* store through the *phone's* backend, with the file system
// replaced by an in-memory stand-in that offers exactly the members the
// backend uses (expo-file-system's File and Directory), and asks the questions
// a reader would: save a chapter, list it, open it, remove it, fill the disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../shared/series-match.js';
import '../../shared/offline-store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'native', 'src', 'offline.js'), 'utf8').replace(/\r\n/g, '\n');

/** An in-memory file system with the surface native/src/offline.js touches. */
function fakeFs() {
  const files = new Map(); // uri -> { bytes: Uint8Array | null, text: string | null }
  class Directory {
    constructor(...parts) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    get exists() { return [...files.keys()].some((k) => k.startsWith(this.uri + '/')) || dirs.has(this.uri); }
    create() { dirs.add(this.uri); }
    list() {
      return [...files.keys()].filter((k) => k.startsWith(this.uri + '/') && !k.slice(this.uri.length + 1).includes('/'))
        .map((k) => new File(k));
    }
    get size() {
      let n = 0;
      for (const [k, v] of files) if (k.startsWith(this.uri + '/')) n += v.bytes ? v.bytes.length : (v.text || '').length;
      return n;
    }
  }
  const dirs = new Set();
  class File {
    constructor(...parts) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    get name() { return this.uri.slice(this.uri.lastIndexOf('/') + 1); }
    get exists() { return files.has(this.uri); }
    get size() { const v = files.get(this.uri); return v ? (v.bytes ? v.bytes.length : (v.text || '').length) : 0; }
    write(content) {
      files.set(this.uri, typeof content === 'string' ? { text: content, bytes: null } : { bytes: content, text: null });
    }
    textSync() { return files.get(this.uri).text; }
    async text() { return files.get(this.uri).text; }
    delete() { files.delete(this.uri); }
  }
  const Paths = { document: new Directory('/doc') };
  return { Directory, File, Paths, files };
}

/** native/src/offline.js, with the file system swapped for the fake. */
function load() {
  const fs = fakeFs();
  const body = src
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|class|function|async function) /gm, '$1 ')
    .replace(/^export \{[^}]*\};?$/gm, '');
  const mod = new Function('Directory', 'File', 'Paths', `${body}
    return { fileBackend, BytesBlob, store, messages, MAX_BYTES, bytesOnDisk, removeSeries, seriesOf };`)(
    fs.Directory, fs.File, fs.Paths);
  return { ...mod, fs };
}

const b64 = (s) => Buffer.from(s).toString('base64');

/** Save a three-page chapter the way reader.js does: pages, then commit. */
async function saveChapter(msgs, url, { title = 'Blue Box', label = 'Ch. 9', sourceUrl = 'https://scan.test/blue-box/' } = {}) {
  for (let i = 0; i < 3; i++) {
    const r = await msgs.offlinePage({ chapterUrl: url, index: i, b64: b64(`page-${i}-bytes`), mime: 'image/png' });
    assert.ok(r.ok, `page ${i} refused`);
  }
  return msgs.offlineCommit({ meta: { chapterUrl: url, title, chapterLabel: label, sourceUrl, kind: 'images', bytes: 42 } });
}

test('a chapter saved page by page can be listed and opened, with no network', async () => {
  const { messages, fs } = load();
  const msgs = messages();
  const url = 'https://scan.test/blue-box/ch-9/';
  const done = await saveChapter(msgs, url);
  assert.ok(done.ok);
  assert.equal(done.chapter.pageCount, 3);

  assert.deepEqual((await msgs.offlineHas({ chapterUrl: url })), { saved: true });
  const { chapters } = await msgs.offlineList();
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].chapterLabel, 'Ch. 9');

  // Opening hands back file URIs in page order, not bytes: an <Image> reads
  // a file: URI straight from disk.
  const opened = await msgs.offlineGet({ chapterUrl: url });
  assert.equal(opened.pages.length, 3);
  for (const p of opened.pages) {
    assert.match(p.uri, /^\/doc\/offline\/pages\/[0-9a-f]{16}\.bin$/);
    assert.equal(p.type, 'image/png');
    assert.ok(fs.files.has(p.uri), 'the URI points at nothing on disk');
  }
  assert.equal(Buffer.from(fs.files.get(opened.pages[1].uri).bytes).toString(), 'page-1-bytes', 'pages are out of order');
});

test('the key is the URL, whatever characters it holds, and file names are not', async () => {
  const { messages, fs } = load();
  const msgs = messages();
  // As a browser hands it over: percent-encoded (the store keys on the URL
  // and splits on a space, so a literal one is not a URL it ever sees).
  const url = 'https://scan.test/s%C3%A9rie/chapitre%209?x=1&y=2#top';
  await saveChapter(msgs, url);
  assert.equal((await msgs.offlineHas({ chapterUrl: url })).saved, true);
  for (const name of fs.files.keys()) assert.match(name, /^\/doc\/offline\/(meta|pages)\/[0-9a-f]{16}\.(json|bin)$/);
});

test('an interrupted save does not exist, and is swept', async () => {
  const { messages } = load();
  const msgs = messages();
  const url = 'https://scan.test/blue-box/ch-10/';
  await msgs.offlinePage({ chapterUrl: url, index: 0, b64: b64('x'), mime: 'image/jpeg' });
  // No commit. Not listed, not "has", and the orphan page is dropped.
  assert.equal((await msgs.offlineHas({ chapterUrl: url })).saved, false);
  assert.equal((await msgs.offlineList()).chapters.length, 0);
  assert.equal((await msgs.offlineSweep()).dropped, 1);
});

test('removing a chapter removes its files, and removing a series its chapters', async () => {
  const { messages, removeSeries, fs } = load();
  const msgs = messages();
  await saveChapter(msgs, 'https://scan.test/blue-box/ch-9/');
  await saveChapter(msgs, 'https://scan.test/blue-box/ch-10/', { label: 'Ch. 10' });
  await saveChapter(msgs, 'https://scan.test/other/ch-1/', { title: 'Other', sourceUrl: 'https://scan.test/other/' });
  assert.equal(fs.files.size, 3 * (1 + 3 * 2));

  await msgs.offlineRemove({ chapterUrl: 'https://scan.test/blue-box/ch-9/' });
  assert.equal((await msgs.offlineList()).chapters.length, 2);

  // What "remove from library" implies, wired through core's onRemoved.
  const r = await removeSeries('https://scan.test/blue-box/');
  assert.equal(r.removed, 1);
  assert.equal((await msgs.offlineList()).chapters.length, 1);
  assert.equal(fs.files.size, 1 + 3 * 2, 'files of removed chapters are still on disk');
});

test('the phone refuses a page that would cross the cap, with a sentence the reader shows', async () => {
  const { messages, MAX_BYTES, fs } = load();
  const msgs = messages();
  // Pretend the disk is nearly full: one big existing page.
  fs.files.set('/doc/offline/pages/ffffffffffffffff.bin', { bytes: new Uint8Array(MAX_BYTES - 10), text: null });
  await assert.rejects(
    () => msgs.offlinePage({ chapterUrl: 'https://scan.test/x/1/', index: 0, b64: b64('twelve bytes!'), mime: 'image/jpeg' }),
    /saved chapters are full \(512 MB\)/,
  );
  // And a page that fits still does.
  const ok = await msgs.offlinePage({ chapterUrl: 'https://scan.test/x/1/', index: 0, b64: b64('tiny'), mime: 'image/jpeg' });
  assert.ok(ok.ok);
});

test('a text chapter travels in its metadata and needs no files', async () => {
  const { messages } = load();
  const msgs = messages();
  const url = 'https://novel.test/ch-1/';
  const r = await msgs.offlineCommit({
    meta: { chapterUrl: url, title: 'Novel', chapterLabel: 'Ch. 1', kind: 'text', paragraphs: ['A.', 'B.'], bytes: 0 },
  });
  assert.equal(r.chapter.pageCount, 2);
  const opened = await msgs.offlineGet({ chapterUrl: url });
  assert.deepEqual(opened.meta.paragraphs, ['A.', 'B.']);
  assert.deepEqual(opened.pages, []);
});

test('the reader says the store\'s sentence when a save is refused', () => {
  // The store throws "saved chapters are full"; the hub turns that into
  // { error }, and the reader has to say it rather than "page 1 was rejected".
  const reader = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');
  assert.match(reader, /throw new Error\(r\?\.error \|\| `page \$\{i \+ 1\} was rejected`\)/);
});

test('the store is wired: messages in the hub, removal on the core, the file on the phone\'s list', () => {
  const core = readFileSync(join(root, 'native', 'src', 'core.js'), 'utf8');
  assert.match(core, /\.\.\.offline\.messages\(\)/);
  assert.match(core, /onRemoved: \(entry\) => offline\.removeSeries\(entry\.sourceUrl\)/);
  assert.match(core, /generated\/shared\/offline-store\.js/);
  assert.match(readFileSync(join(root, 'scripts', 'sync-shared.mjs'), 'utf8'),
    /'compat\.js', 'offline-store\.js'\] \}/, 'offline-store.js is not copied to the phone');
  assert.match(readFileSync(join(root, 'native', 'src', 'screens', 'SettingsScreen.js'), 'utf8'), /Page: SavedPage/);
});
