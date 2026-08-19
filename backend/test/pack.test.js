// What ends up in the zip somebody installs.
//
// The failure this guards against has no error message worth the name: Chrome
// says "Could not load extension" or, worse, loads it and one page comes up
// blank. Both come from the same cause — a file the extension references was
// not in the folder — and neither shows up in any other test, because every
// other test reads the repository, where all the files exist.
//
// So: the shipped set is walked from what the extension actually asks for, the
// manifest and then every HTML page it names, and the zip is read back with a
// reader that follows the same offsets Chrome will.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { shippedFiles, zip } from '../../scripts/pack-extension.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ext = (p) => join(root, 'extension', p);
const manifest = JSON.parse(readFileSync(ext('manifest.json'), 'utf8'));

/** The zip's own names: paths relative to extension/, which is what Chrome sees. */
const shipped = new Set(shippedFiles().map((f) => f.replace(/^extension\//, '')));

// --- everything it asks for is in there --------------------------------------

/** Every local file the manifest names, in the manifest's own spelling. */
function fromManifest() {
  const out = [manifest.background.service_worker, manifest.options_page,
    manifest.action.default_popup, ...Object.values(manifest.icons)];
  for (const c of manifest.content_scripts) out.push(...(c.js || []), ...(c.css || []));
  for (const r of manifest.declarative_net_request.rule_resources) out.push(r.path);
  // The locale files are named by convention rather than by path, and a missing
  // default one is the only manifest error Chrome refuses to start over.
  for (const locale of ['en', 'fr']) out.push(`_locales/${locale}/messages.json`);
  return out;
}

/** And every local file those pages pull in, resolved from where the page is. */
function fromPages() {
  const out = [];
  for (const page of [...shipped].filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(ext(page), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      // Only what travels in the zip: no http(s), no data:, no #anchor.
      if (/^(?:[a-z]+:|\/\/|#)/i.test(ref)) continue;
      out.push(posix.normalize(posix.join(posix.dirname(page), ref)));
    }
  }
  return out;
}

test('the zip has every file the extension asks for', () => {
  for (const ref of [...fromManifest(), ...fromPages()]) {
    assert.ok(shipped.has(ref), `${ref} is referenced but not shipped`);
    // Referenced, shipped, and actually on disk — a path that only ever gets
    // read through git would pass the line above while being a typo.
    assert.ok(existsSync(ext(ref)), `${ref} is in the file list but not on disk`);
  }
});

test('and nothing Chrome will choke on', () => {
  // Chrome compiles the declarativeNetRequest rules into _metadata/ itself when
  // it loads the folder. Handed a copy from someone else's machine it refuses
  // the whole extension — the likeliest single way this zip fails on a computer
  // that is not this one.
  assert.ok(!/_metadata/.test([...shipped].join('\n')),
    'the generated ruleset is in the zip; Chrome will refuse to load it');
  // Nothing that only makes sense in a checkout.
  for (const f of shipped) {
    assert.ok(!/\.test\.js$|\.map$|(^|\/)node_modules\//.test(f), `${f} has no business shipping`);
  }
  assert.ok(!shipped.has('icons/make-icons.cjs'), 'the icon generator is not an icon');
  // And the manifest at the top, so "choose the folder" means the folder they
  // just unzipped and not one inside it.
  assert.ok(shipped.has('manifest.json'));
});

test('the shipped set is what git tracks, so a dirty tree cannot leak in', () => {
  // The whole point of building from `git ls-files` rather than from the
  // directory: a scratch file, a stale build, an edit nobody committed.
  assert.ok(shipped.size > 30 && shipped.size < 100, `${shipped.size} files is not a plausible zip`);
  for (const f of shipped) assert.ok(existsSync(ext(f)), `${f} is tracked but gone`);
});

// --- and it is a zip ----------------------------------------------------------

/**
 * A reader that goes the way Chrome does: end record, then central directory,
 * then each entry by the offset the directory gives. A writer that got an
 * offset wrong produces a file that looks fine until something opens it.
 */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, 'no end-of-central-directory record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);

  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, `central header ${i} is not one`);
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);

    assert.equal(buf.readUInt32LE(local), 0x04034b50, `${name} does not start where it says`);
    const body = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(body, body + csize);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));

    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

const build = () => zip([...shipped].sort().map((name) => ({ name, data: readFileSync(ext(name)) })));

test('what comes back out is byte for byte what went in', () => {
  const read = unzip(build());
  assert.deepEqual([...read.keys()].sort(), [...shipped].sort());
  // Every one, not a sample: the compressed path and the stored path are
  // different code, and which file takes which is decided by size.
  for (const [name, data] of read) {
    assert.deepEqual(data, readFileSync(ext(name)), `${name} came back different`);
  }
  // The fonts and the pngs are already compressed and are stored as-is; if
  // everything is deflating, the store branch has stopped being reachable and
  // stopped being tested.
  assert.ok([...read.keys()].some((n) => n.endsWith('.woff2')));
});

test('the same commit makes the same bytes, so the sha256 means something', () => {
  // Printed next to the download link for people to check. A zip that embeds
  // the time it was built gives a different answer every run and the number is
  // worth nothing.
  assert.deepEqual(build(), build());
});

test('the version in the filename is the one Chrome will show', () => {
  // `panelflow-<version>.zip` comes from the manifest, and the manifest is what
  // the extensions page displays. Two versions in one repo is how someone ends
  // up unable to say which zip they have.
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version,
    'extension/manifest.json and package.json disagree on the version');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('`npm run pack` is the command, and it is written down', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.pack, 'node scripts/pack-extension.mjs');
  // The zip is fully described by its commit and its hash; committing the
  // artefact would be the repository stored twice.
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^dist\/$/m);
  // The link goes out with this, or the reader is left on chrome://extensions
  // guessing which of three buttons to press.
  const doc = readFileSync(join(root, 'docs', 'installation.md'), 'utf8');
  assert.match(doc, /chrome:\/\/extensions/);
  assert.match(doc, /manifest\.json/);
});
