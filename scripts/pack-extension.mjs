#!/usr/bin/env node
// The zip you actually send someone.
//
// There was no command for this: "give it to a friend" meant zipping the folder
// by hand, which quietly ships whatever else is lying in it — a stale ruleset
// Chrome refuses to load over, an icon script, a half-finished edit that was
// never committed and exists on one machine.
//
// So the zip is not built from the folder. It is built from `git ls-files`,
// over a tree git says is clean, with the tests green. That makes it exactly the
// commit it came from: the SHA-256 printed at the end means something, because
// anyone with that commit can produce the same bytes and get the same number.
//
//   npm run pack
//
// Refuses rather than warns. A zip produced from a dirty tree is the one thing
// this script exists to prevent, and a flag to allow it would be the flag
// everybody uses.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8' });

/**
 * Tracked files that are not part of the extension.
 *
 * `_metadata/` is Chrome's own: it compiles the declarativeNetRequest rules into
 * it on load. Shipping the copy from this machine makes Chrome refuse the folder
 * outright — "Could not load the indexed ruleset" — and it is the single most
 * likely way this zip fails on someone else's computer.
 */
const EXCLUDE = [
  /^extension\/_metadata\//,
  /^extension\/icons\/make-icons\.cjs$/,   // draws the icons; not one of them
];

/** Everything the zip ships, in a fixed order so the bytes are reproducible. */
export function shippedFiles() {
  return run('git', ['ls-files', '-z', 'extension'])
    .split('\0').filter(Boolean)
    .filter((f) => !EXCLUDE.some((re) => re.test(f)))
    .sort();
}

// --- refusing ----------------------------------------------------------------

function insist() {
  process.stdout.write('sync:shared… ');
  run('node', ['scripts/sync-shared.mjs']);
  console.log('ok');

  // After the sync, not before: if generating the manifest's host list moved
  // something, the tree is dirty now and that is the interesting failure.
  process.stdout.write('git clean… ');
  const dirty = run('git', ['status', '--porcelain']).trim();
  if (dirty) {
    console.log('no');
    console.error('\nUncommitted changes. The zip has to be a commit somebody can go back to:\n');
    console.error(dirty.split('\n').map((l) => `  ${l}`).join('\n'));
    process.exit(1);
  }
  console.log('ok');

  // `node --test` in the workspace, which is what `npm test` runs — not npm
  // itself. Node refuses to spawn a .cmd shim without a shell, so calling npm
  // here fails on Windows with an empty error, and an empty error from the step
  // whose whole job is to say "your tests are broken" is worse than no step.
  process.stdout.write('tests… ');
  try {
    run(process.execPath, ['--test'], join(root, 'backend'));
  } catch (e) {
    console.log('no');
    console.error(`\n${e.stdout || e.stderr || e.message}`);
    console.error('\nTests are red. Nothing to send.');
    process.exit(1);
  }
  console.log('ok');
}

// --- writing the zip ---------------------------------------------------------
//
// By hand rather than through a dependency: this repo has none outside the
// backend, and a build tool for the artefact people install is a strange place
// to acquire the first one. It is also the only way to pin the timestamps, and
// pinned timestamps are what make the SHA-256 worth printing.

const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

// 1980-01-01 00:00, the earliest a zip can express. Every file gets it, so the
// same commit produces the same bytes on any machine, on any day.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const deflated = deflateRawSync(data, { level: 9 });
    // Small and already-compressed files (png, woff2) come out bigger deflated.
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const method = store ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');
    const sum = crc32(data);

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);              // version needed
    head.writeUInt16LE(0, 6);               // flags — names are ascii
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(sum, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);              // no extra field
    locals.push(head, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);               // version made by
    dir.writeUInt16LE(20, 6);               // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 30);               // extra + comment lengths
    dir.writeUInt16LE(0, 34);               // disk number
    dir.writeUInt16LE(0, 36);               // internal attributes
    dir.writeUInt32LE(0, 38);               // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += head.length + nameBuf.length + body.length;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, dirBuf, end]);
}

// --- the command -------------------------------------------------------------

function main() {
  insist();

  const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
  const files = shippedFiles();

  // Paths inside the zip are relative to `extension/`, so Chrome is handed a
  // folder with manifest.json at the top and not a folder containing one.
  const entries = files.map((f) => ({
    name: relative('extension', f).replace(/\\/g, '/'),
    data: readFileSync(join(root, f)),
  }));

  const out = join(root, 'dist', `panelflow-${manifest.version}.zip`);
  mkdirSync(dirname(out), { recursive: true });
  const buf = zip(entries);
  writeFileSync(out, buf);

  const sha = createHash('sha256').update(buf).digest('hex');
  const kb = Math.round(statSync(out).size / 1024);
  const commit = run('git', ['rev-parse', '--short', 'HEAD']).trim();

  console.log(`\n${relative(root, out).replace(/\\/g, '/')}`);
  console.log(`  ${entries.length} files, ${kb} kB, from ${commit}`);
  console.log(`  sha256 ${sha}`);
  console.log('\nSend both. docs/installation.md is what goes with the link.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
