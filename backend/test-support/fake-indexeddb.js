// Just enough IndexedDB for `shared/offline-store.js` to run under node.
//
// Not a general implementation and not trying to be: it exists so the offline
// messages can be exercised through the real service worker rather than a
// hand-made backend, which is where the wiring bugs live — a store opened
// twice, a transaction whose result is read before it commits, keys coming back
// in the wrong order. Everything the store actually calls is here; anything
// else throws rather than pretending.
//
// Two behaviours are deliberate, because the store depends on both:
//   * keys come back sorted, as a real object store's do — page 10 after page 9
//     only works because of that ordering;
//   * every callback fires on a later turn, so a handler assigned after the
//     request is created still runs. Synchronous "events" would make this a
//     different API than the one the browser has.

const later = (fn) => setTimeout(fn, 0);

function request(run) {
  const req = { result: undefined, error: null, onsuccess: null, onerror: null };
  later(() => {
    try {
      req.result = run();
      req.onsuccess?.({ target: req });
    } catch (e) {
      req.error = e;
      req.onerror?.({ target: req });
    }
  });
  return req;
}

class FakeStore {
  constructor(map) { this.map = map; }
  get(key) { return request(() => this.map.get(key)); }
  put(value, key) { return request(() => { this.map.set(key, value); return key; }); }
  delete(key) { return request(() => { this.map.delete(key); }); }
  getAll() { return request(() => this.sorted().map((k) => this.map.get(k))); }
  getAllKeys() { return request(() => this.sorted()); }
  sorted() { return [...this.map.keys()].sort(); }
}

class FakeDB {
  constructor(name) {
    this.name = name;
    this.stores = new Map();
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
  }

  createObjectStore(name) {
    this.stores.set(name, new Map());
    return new FakeStore(this.stores.get(name));
  }

  transaction(name) {
    if (!this.stores.has(name)) throw new Error(`no object store ${name}`);
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
    // The commit is one turn behind the request's own callback, which is the
    // order a browser gives them and the order `run()` in the store relies on.
    later(() => later(() => tx.oncomplete?.()));
    tx.objectStore = () => new FakeStore(this.stores.get(name));
    return tx;
  }
}

/** An `indexedDB` global backed by memory. One database per name, as usual. */
export function fakeIndexedDB() {
  const dbs = new Map();
  return {
    open(name, version) {
      const fresh = !dbs.has(name);
      if (fresh) dbs.set(name, new FakeDB(name));
      const db = dbs.get(name);
      const req = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        if (fresh) req.onupgradeneeded?.({ target: req, oldVersion: 0, newVersion: version });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
    /** Test-only: throw away everything, so one test cannot see another's. */
    _reset() { dbs.clear(); },
  };
}
