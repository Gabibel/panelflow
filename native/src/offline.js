// Chapters kept in the app, for reading with no network. Inside the app's own
// documents directory: nothing here is shared with the phone's Files.
//
// The store itself is shared/offline-store.js: what a saved chapter is, how a
// save is committed (pages first, metadata last, so an interrupted one never
// exists), when it expires, how a page asks to save one. None of that is
// repeated here. What that file needs from a platform is a *backend* with five
// methods over two named stores (`meta`, `pages`), and on the two WebView
// shells that is IndexedDB. This client has no IndexedDB and a great deal of
// disk, so the backend below is the file system: one directory per store, one
// file per key.
//
// Two things a file system changes:
//
//   * a key is a chapter URL, which is not a file name. Keys are hashed to a
//     name and the key itself is kept inside `meta`, so `keys('pages')` can
//     still answer with the URL the store expects (`pageKey` puts the URL in
//     front, and `chapterOf` reads it back out).
//   * bytes are written as bytes, not as a Blob. `offlineMessages` builds a
//     Blob out of what the page sent; `BytesBlob` below is the smallest thing
//     that satisfies it and lets the backend write the array straight to disk.
//
// And one thing a phone changes: a cap. A desktop has a disk; a phone has
// whatever is left after the photos. `MAX_BYTES` is checked before every page
// is written, and a save that would cross it is refused with a sentence the
// reader shows, rather than filling the phone and being killed by the OS.
import { Directory, File, Paths } from 'expo-file-system';

// Not `./shared.js`: that file imports core.js, and core.js imports this one.
// The globals are read when a function runs, by which time core.js has loaded
// every shared script.

const { createOfflineStore, offlineMessages, pageKey } = globalThis.PanelFlowOffline;

/** Saved chapters may take this much of the phone. Half a gigabyte: ~150 chapters. */
export const MAX_BYTES = 512 * 1024 * 1024;

const ROOT = new Directory(Paths.document, 'offline');
const dirOf = (store) => new Directory(ROOT, store);

/**
 * A file name for a key. Hashed (FNV-1a, two rounds for 64 bits) because a
 * key holds a URL, and a URL holds every character a file name may not.
 * The key is stored beside the value, so this never has to be reversed.
 */
function nameOf(key) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

function ensure(dir) {
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Every entry in a store: `.json` sidecar per value, holding the key (and,
 * for `meta`, the record itself; for `pages`, the mime type). The bytes of a
 * page are the sibling `.bin`.
 */
function entries(store) {
  const dir = ensure(dirOf(store));
  const out = [];
  for (const f of dir.list()) {
    if (!(f instanceof File) || !f.name.endsWith('.json')) continue;
    try {
      out.push({ file: f, ...JSON.parse(f.textSync()) });
    } catch (e) {
      // A sidecar that does not parse is a save that died mid-write. Left in
      // place: `sweep()` in the shared store cannot see it, but nothing reads
      // it either, and the next save of the same key overwrites it.
      console.warn('[panelflow] unreadable offline entry', f.name, e);
    }
  }
  return out;
}

/** The five methods shared/offline-store.js asks of a platform. */
export const fileBackend = {
  async get(store, key) {
    const dir = ensure(dirOf(store));
    const side = new File(dir, `${nameOf(key)}.json`);
    if (!side.exists) return undefined;
    const record = JSON.parse(await side.text());
    if (store === 'meta') return record.value;
    const bin = new File(dir, `${nameOf(key)}.bin`);
    if (!bin.exists) return undefined;
    // What the reader screen wants is not the bytes but somewhere to point an
    // <Image>: the file's own URI, plus the type the page was saved with.
    return { uri: bin.uri, type: record.type, size: bin.size };
  },
  async put(store, key, value) {
    const dir = ensure(dirOf(store));
    const name = nameOf(key);
    if (store === 'meta') {
      new File(dir, `${name}.json`).write(JSON.stringify({ key, value }));
      return;
    }
    // `value` is a BytesBlob from offlineMessages: bytes and a mime type.
    new File(dir, `${name}.bin`).write(value.bytes);
    new File(dir, `${name}.json`).write(JSON.stringify({ key, type: value.type }));
  },
  async del(store, key) {
    const dir = ensure(dirOf(store));
    for (const ext of ['.json', '.bin']) {
      const f = new File(dir, `${nameOf(key)}${ext}`);
      if (f.exists) f.delete();
    }
  },
  async keys(store) {
    return entries(store).map((e) => e.key);
  },
  async values(store) {
    if (store !== 'meta') throw new Error('values() is only ever asked of meta');
    return entries(store).map((e) => e.value);
  },
};

/** What `offlineMessages` builds a page into; the backend reads it straight. */
export class BytesBlob {
  constructor(parts, { type } = {}) {
    this.bytes = parts[0];
    this.type = type || 'image/jpeg';
    this.size = this.bytes.length;
  }
}

export const store = createOfflineStore(fileBackend);

/** Bytes on disk right now: the pages directory, as the file system counts it. */
export async function bytesOnDisk() {
  return ensure(dirOf('pages')).size ?? 0;
}

/**
 * The hub messages, as the shared file defines them, with the cap in front of
 * the one that writes bytes. `MAX_BYTES` is a phone's concern and stays here.
 */
export function messages() {
  const shared = offlineMessages(store, { Blob: BytesBlob });
  return {
    ...shared,
    offlinePage: async (msg) => {
      const incoming = Math.floor((String(msg.b64 || '').length * 3) / 4);
      if ((await bytesOnDisk()) + incoming > MAX_BYTES) {
        // A code, not a sentence: the reader says it in the reader's language
        // (readerOfflineFull). The save stops and, never committed, does not exist.
        throw new Error('offline-full');
      }
      return shared.offlinePage(msg);
    },
    // A page the page could not read itself (see downloadPage).
    offlineFetchPage: async (msg) => downloadPage(msg),
    // The same key the reader screen uses to find a chapter's pages.
    offlineGet: async (msg) => store.get(msg.chapterUrl),
  };
}

// A browser's headers: an image host behind Cloudflare answers an app's own
// user agent with a challenge page rather than the panel.
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** What a file's first bytes say it is, or null when it is not a picture. */
export function imageMime(head) {
  const b = head || [];
  const ascii = (from, to) => String.fromCharCode(...Array.from(b.slice(from, to)));
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  if (ascii(4, 8) === 'ftyp') return 'image/avif';
  return null;
}

/**
 * One page of a chapter, fetched by the app straight into its files.
 *
 * For the pages the page itself cannot read: another host's CDN, which CORS
 * keeps from the document. The app downloads it natively, with the chapter as
 * its Referer (hotlink protection asks for that), and checks that what came
 * back is a picture and not a challenge page before it counts. The bytes never
 * cross the bridge, so a page of a megabyte costs a megabyte and not four.
 */
export async function downloadPage({ chapterUrl, index, url, siteUrl } = {}) {
  if (!chapterUrl || !Number.isInteger(index) || index < 0) throw new Error('downloadPage needs a chapter and an index');
  if ((await bytesOnDisk()) >= MAX_BYTES) throw new Error('offline-full');
  const dir = ensure(dirOf('pages'));
  const key = pageKey(chapterUrl, index);
  const bin = new File(dir, `${nameOf(key)}.bin`);
  await File.downloadFileAsync(url, bin, {
    idempotent: true,
    headers: {
      'User-Agent': UA,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      ...(siteUrl ? { Referer: siteUrl } : {}),
    },
  });
  let type = null;
  try {
    const handle = bin.open();
    type = imageMime(handle.readBytes(12));
    handle.close();
  } catch { /* unreadable: treated as not a picture below */ }
  if (!type) {
    if (bin.exists) bin.delete();
    throw new Error('not an image');
  }
  if ((await bytesOnDisk()) > MAX_BYTES) {
    bin.delete();
    throw new Error('offline-full');
  }
  new File(dir, `${nameOf(key)}.json`).write(JSON.stringify({ key, type }));
  return { ok: true, bytes: bin.size ?? 0 };
}

/** Everything saved for one series, gone: what removing it from the shelf implies. */
export const removeSeries = (sourceUrl) => store.removeSeries(sourceUrl);

/** The series a saved chapter belongs to, for the list screen's grouping. */
export const seriesOf = (meta) => globalThis.PanelFlowMatch.seriesKey(meta.sourceUrl || meta.chapterUrl || '');
