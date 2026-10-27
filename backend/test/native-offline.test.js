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
    open() {
      const bytes = files.get(this.uri)?.bytes || new Uint8Array(0);
      return { readBytes: (n) => bytes.slice(0, n), close() {} };
    }
    // What the network answers, by address, and what each download asked for.
    static async downloadFileAsync(url, dest, options) {
      downloads.push({ url, options });
      const body = net.get(url);
      if (!body) throw new Error(`UnableToDownload: 404 ${url}`);
      dest.write(body);
      return dest;
    }
  }
  const net = new Map();
  const downloads = [];
  // What the phone says it has left. Plenty, unless a test says otherwise.
  const Paths = { document: new Directory('/doc'), availableDiskSpace: 64 * 1024 ** 3 };
  return { Directory, File, Paths, files, net, downloads };
}

/**
 * native/src/offline.js, with the file system swapped for the fake, and
 * whether this phone is Premium (./premium-kept.js) answered by the test.
 */
function load({ premium = false } = {}) {
  const fs = fakeFs();
  const body = src
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|class|function|async function) /gm, '$1 ')
    .replace(/^export \{[^}]*\};?$/gm, '');
  const state = { premium };
  const mod = new Function('Directory', 'File', 'Paths', 'premiumHere', `${body}
    return { fileBackend, BytesBlob, store, messages, FREE_BYTES, KEEP_FREE_BYTES, capFor, offlineSpace,
      bytesOnDisk, removeSeries, seriesOf, downloadPage, imageMime };`)(
    fs.Directory, fs.File, fs.Paths, async () => state.premium);
  return { ...mod, MAX_BYTES: mod.FREE_BYTES, fs, state };
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

test('the phone refuses a page that would cross the cap, with a code the reader translates', async () => {
  const { messages, MAX_BYTES, fs } = load();
  const msgs = messages();
  // Pretend the disk is nearly full: one big existing page.
  fs.files.set('/doc/offline/pages/ffffffffffffffff.bin', { bytes: new Uint8Array(MAX_BYTES - 10), text: null });
  await assert.rejects(
    () => msgs.offlinePage({ chapterUrl: 'https://scan.test/x/1/', index: 0, b64: b64('twelve bytes!'), mime: 'image/jpeg' }),
    // A code: the reader says it in the reader's language (readerOfflineFull).
    /offline-full/,
  );
  // And a page that fits still does.
  const ok = await msgs.offlinePage({ chapterUrl: 'https://scan.test/x/1/', index: 0, b64: b64('tiny'), mime: 'image/jpeg' });
  assert.ok(ok.ok);
});

// --- PanelFlow Premium: the phone's free space, not 512 MB --------------------

test('Premium keeps saving past the free cap, while the phone has room', async () => {
  const { messages, FREE_BYTES, fs } = load({ premium: true });
  const msgs = messages();
  fs.files.set('/doc/offline/pages/ffffffffffffffff.bin', { bytes: new Uint8Array(FREE_BYTES), text: null });
  const ok = await msgs.offlinePage({ chapterUrl: 'https://scan.test/x/1/', index: 0, b64: b64('twelve bytes!'), mime: 'image/jpeg' });
  assert.ok(ok.ok, 'a subscriber was held to the free cap');
});

test('Premium leaves the phone its last gigabyte', async () => {
  const { messages, FREE_BYTES, KEEP_FREE_BYTES, fs } = load({ premium: true });
  // Past the free cap, with five bytes left above the gigabyte kept free.
  fs.files.set('/doc/offline/pages/ffffffffffffffff.bin', { bytes: new Uint8Array(FREE_BYTES), text: null });
  fs.Paths.availableDiskSpace = KEEP_FREE_BYTES + 5;
  const msgs = messages();
  assert.ok((await msgs.offlinePage({ chapterUrl: 'https://scan.test/x/1/', index: 0, b64: b64('ok'), mime: 'image/jpeg' })).ok);
  await assert.rejects(
    () => msgs.offlinePage({ chapterUrl: 'https://scan.test/x/1/', index: 1, b64: b64('twelve bytes!'), mime: 'image/jpeg' }),
    /offline-full/,
  );
});

test('the cap is the free one without Premium, and never less than it with', () => {
  const { capFor, FREE_BYTES, KEEP_FREE_BYTES } = load();
  const GB = 1024 ** 3;
  assert.equal(capFor(false, 0, 100 * GB), FREE_BYTES, 'a full phone or an empty one: 512 MB without Premium');
  assert.equal(capFor(true, 2 * GB, 10 * GB), 2 * GB + 10 * GB - KEEP_FREE_BYTES);
  assert.equal(capFor(true, 0, 0), FREE_BYTES, 'a nearly full phone still has what everyone has');
  assert.equal(capFor(true, 0, NaN), FREE_BYTES, 'a phone that will not say how full it is');
});

test('when Premium ends nothing is deleted, and only new saves past the free cap stop', async () => {
  const { messages, FREE_BYTES, fs, state } = load({ premium: true });
  const msgs = messages();
  await saveChapter(msgs, 'https://scan.test/blue-box/ch-1/');
  fs.files.set('/doc/offline/pages/ffffffffffffffff.bin', { bytes: new Uint8Array(FREE_BYTES), text: null });
  state.premium = false;
  assert.equal((await msgs.offlineList()).chapters.length, 1, 'a chapter kept under Premium is still there');
  assert.equal((await msgs.offlineGet({ chapterUrl: 'https://scan.test/blue-box/ch-1/' })).pages.length, 3);
  await assert.rejects(
    () => msgs.offlinePage({ chapterUrl: 'https://scan.test/x/2/', index: 0, b64: b64('more'), mime: 'image/jpeg' }),
    /offline-full/,
  );
});

test('the screens show the cap that applies, and a full free cap offers more room', () => {
  const read = (...p) => readFileSync(join(root, ...p), 'utf8');
  const sheet = read('native', 'src', 'screens', 'OfflineChaptersScreen.js');
  assert.match(sheet, /offlineSpace\(\)/);
  assert.ok(!/MAX_BYTES/.test(sheet + read('native', 'src', 'screens', 'settings', 'SavedPage.js')));
  const shell = read('native', 'src', 'Shell.js');
  assert.match(shell, /premiumHere\(\)\.then\(\(premium\) => toast\(t\('mobileOfflineFull'\), premium \? null : \{/);
  assert.match(shell, /setSettingsPage\('premium'\)/);
  // The phone's answer is read without the SDK or the network: offline.js
  // must not import the buying side, which imports the core, which imports it.
  assert.match(src, /from '\.\/premium-kept\.js'/);
  assert.ok(!/from '\.\/premium\.js'/.test(src));
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

test('the reader says why a save stopped, in the reader\'s language', () => {
  // The store answers "offline-full"; the reader says that, rather than "page 1
  // was rejected", and says every reason in French or English. It used to show
  // "Non enregistré : page 1 could not be fetched" (owner's report, October 2026).
  const reader = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');
  assert.match(reader, /r\?\.error === 'offline-full' \? t\('readerOfflineFull'\)/);
  assert.match(reader, /t\('readerPageNotFetched', \[String\(i \+ 1\)\]\)/);
  assert.match(reader, /t\('readerSaveFailed'\)/);
  assert.doesNotMatch(reader, /could not be fetched`|was rejected`|'commit failed'/, 'an English reason is shown to a French reader again');
});

test('the store is wired: messages in the hub, removal on the core, the file on the phone\'s list', () => {
  const core = readFileSync(join(root, 'native', 'src', 'core.js'), 'utf8');
  assert.match(core, /\.\.\.offline\.messages\(\)/);
  assert.match(core, /onRemoved: \(entry\) => offline\.removeSeries\(entry\.sourceUrl\)/);
  assert.match(core, /generated\/shared\/offline-store\.js/);
  assert.match(readFileSync(join(root, 'scripts', 'sync-shared.mjs'), 'utf8'),
    /'compat\.js', 'offline-store\.js', 'search\.js',\s*'report\.js'\] \}/, 'offline-store.js is not copied to the phone');
  // On the account's menu, and the page messages it needs allowed.
  // A page of the account's menu since the dark redesign (October 2026).
  const menu = readFileSync(join(root, 'native', 'src', 'screens', 'SettingsScreen.js'), 'utf8');
  assert.match(menu, /\{ id: 'saved', title: 'navSaved', Page: SavedPage/);
  assert.match(core, /'offlineFetchPage'/);
});

// --- pages from another host -------------------------------------------------
// The reader on a phone cannot read a page another host's CDN serves (CORS),
// and the app had no answer for it: every such chapter failed with "page 1
// could not be fetched" (owner's report, October 2026, on asurascans). The app
// now downloads those pages itself, straight into its files.

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

test('a page another host serves is downloaded by the app, with the chapter as its Referer', async () => {
  const { messages, fs } = load();
  const msgs = messages();
  const url = 'https://scan.test/x/chapitre-245/';
  fs.net.set('https://cdn.test/245/01.jpg', JPEG);
  fs.net.set('https://cdn.test/245/02.jpg', JPEG);
  for (const [i, img] of ['https://cdn.test/245/01.jpg', 'https://cdn.test/245/02.jpg'].entries()) {
    const r = await msgs.offlineFetchPage({ chapterUrl: url, index: i, url: img, siteUrl: url });
    assert.equal(r.ok, true);
    assert.equal(r.bytes, JPEG.length);
  }
  assert.equal(fs.downloads[0].options.headers.Referer, url);
  assert.match(fs.downloads[0].options.headers['User-Agent'], /Safari/);
  const done = await msgs.offlineCommit({ meta: { chapterUrl: url, title: 'Villain To Kill', chapterLabel: 'Ch. 245', sourceUrl: 'https://scan.test/x/', kind: 'images', bytes: 28 } });
  assert.equal(done.chapter.pageCount, 2);
  const opened = await msgs.offlineGet({ chapterUrl: url });
  assert.equal(opened.pages.length, 2);
  assert.equal(opened.pages[0].type, 'image/jpeg');
});

test('what is not a picture (a challenge page) is refused and leaves nothing behind', async () => {
  const { messages, fs } = load();
  const msgs = messages();
  fs.net.set('https://cdn.test/1.jpg', new TextEncoder().encode('<!doctype html><title>Just a moment</title>'));
  await assert.rejects(() => msgs.offlineFetchPage({ chapterUrl: 'https://scan.test/x/1/', index: 0, url: 'https://cdn.test/1.jpg' }), /not an image/);
  assert.deepEqual([...fs.files.keys()].filter((k) => k.includes('/pages/')), []);
  // And a host that answers with an error is a refusal, not an empty page.
  await assert.rejects(() => msgs.offlineFetchPage({ chapterUrl: 'https://scan.test/x/1/', index: 0, url: 'https://cdn.test/404.jpg' }));
});

test('the app downloads nothing more once saved chapters are full', async () => {
  const { messages, MAX_BYTES, fs } = load();
  fs.files.set('/doc/offline/pages/ffffffffffffffff.bin', { bytes: new Uint8Array(MAX_BYTES), text: null });
  fs.net.set('https://cdn.test/1.jpg', JPEG);
  await assert.rejects(() => messages().offlineFetchPage({ chapterUrl: 'https://scan.test/x/1/', index: 0, url: 'https://cdn.test/1.jpg' }), /offline-full/);
  assert.equal(fs.downloads.length, 0, 'it downloaded first and asked after');
});

test('a picture is known by its first bytes', () => {
  const { imageMime } = load();
  assert.equal(imageMime([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'image/png');
  assert.equal(imageMime([0xff, 0xd8, 0xff]), 'image/jpeg');
  assert.equal(imageMime([...Buffer.from('RIFF')], 0), null);
  assert.equal(imageMime([...Buffer.from('RIFF\x00\x00\x00\x00WEBP')]), 'image/webp');
  assert.equal(imageMime([...Buffer.from('<html>')]), null);
});

test('a page may only have the app fetch a picture of its own chapter, from the public web', () => {
  const core = readFileSync(join(root, 'native', 'src', 'core.js'), 'utf8');
  const fn = core.slice(core.indexOf('export function publicWebAddress'), core.indexOf('\n}\n', core.indexOf('export function publicWebAddress')) + 2);
  const publicWebAddress = new Function(`${fn.replace('export function', 'function')}; return publicWebAddress;`)();
  for (const ok of ['https://gg.asuracomic.net/storage/media/1/01.webp', 'http://cdn.scan.test/a.jpg']) {
    assert.equal(publicWebAddress(ok), true, ok);
  }
  for (const no of ['http://192.168.1.1/admin.png', 'http://10.0.0.5/x.jpg', 'http://127.0.0.1:8080/a.png',
    'http://localhost/a.png', 'http://printer.local/a.png', 'http://router/a.png', 'file:///etc/passwd',
    'http://[::1]/a.png', 'http://169.254.169.254/latest', 'http://172.16.0.1/a.png', 'javascript:alert(1)',
    // QA, P5: the spellings that went past the ranges. The root's dot, a name
    // and password, IPv6 forms carrying a private IPv4, and the numeric
    // IPv4 forms a resolver accepts (Node normalises some of these itself;
    // React Native's URL may hand them over as written).
    'http://localhost./a.png', 'http://printer.local./a.png', 'https://user:pass@cdn.test/a.png',
    'http://[::7f00:1]/a.png', 'http://[64:ff9b::7f00:1]/a.png', 'http://[2002:c0a8:101::]/a.png',
    'http://[fd12:3456::1]/a.png', 'http://[::ffff:127.0.0.1]/a.png',
    'http://0x7f.1/a.png', 'http://0177.0.0.1/a.png', 'http://0xc0.0xa8.1.1/a.png', 'http://2130706433/a.png']) {
    assert.equal(publicWebAddress(no), false, no);
  }
  assert.match(core, /case 'offlineFetchPage':\s*if \(!onSite\(msg\.chapterUrl, site\) \|\| !publicWebAddress\(msg\.url\)\) return REFUSED;/);
});
