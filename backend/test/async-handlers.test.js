// Every async request handler goes through wrap().
//
// Express 4 does not catch a rejected promise returned by a handler: the
// request simply hangs until the client gives up, and no error middleware ever
// hears about it. `src/wrap.js` exists for exactly that, and the rule only
// works if it has no exceptions — the two routes that were missing it were
// /api/auth/register and /api/auth/login, which is to say the two a signed-out
// user meets first.
//
// Read as text, like the other drift guards here: this is about the shape of
// every route file, including ones written after this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const jsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? jsFiles(join(dir, e.name)) : (e.name.endsWith('.js') ? [join(dir, e.name)] : []));

const read = (file) => readFileSync(file, 'utf8');

// A handler written inline at the point of registration: router.get('/x', async
// (req, res) => …). The only thing that may sit immediately in front of it is
// the wrapper.
const INLINE = /(.{0,6})async \((?:_?req)\b/g;

test('every inline async handler is registered through wrap()', () => {
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    const text = read(file);
    for (const m of text.matchAll(INLINE)) {
      if (m[1].endsWith('wrap(')) continue;
      // `const foo = async (req, res) => …` is a handler with a name, mounted
      // somewhere else — the test below is the one that checks how.
      if (/=\s*$/.test(m[1])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`${file.slice(SRC.length + 1)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], 'unwrapped async handler — a rejection here hangs the request');
});

// Middleware, not a route: it answers 401 itself and hands anything else to
// next(err) from its own catch, which is what a wrapper would have done.
const MIDDLEWARE = ['requireAuth'];

test('handlers exported for index.js to mount are mounted through wrap()', () => {
  const index = read(join(SRC, 'index.js'));
  const named = [];
  for (const file of jsFiles(SRC)) {
    if (file.endsWith('index.js')) continue;
    const text = read(file);
    // export async function foo(req, res) / export const foo = async (req, res)
    for (const m of text.matchAll(/export (?:async function|const) (\w+)(?:\s*=\s*async)?\s*\(\s*_?req\b/g)) {
      named.push(m[1]);
    }
  }
  // The list is not empty, or this test passes by finding nothing to check.
  assert.ok(named.length >= 2, `expected exported handlers, found ${named.join(', ') || 'none'}`);

  for (const name of named) {
    if (MIDDLEWARE.includes(name)) continue;
    assert.ok(index.includes(`wrap(${name})`), `${name} is mounted in index.js without wrap()`);
  }
});

test('wrap forwards a rejection instead of swallowing it', async () => {
  const { wrap } = await import('../src/wrap.js');
  const boom = new Error('boom');
  const seen = await new Promise((resolve) => {
    wrap(async () => { throw boom; })({}, {}, resolve);
  });
  assert.equal(seen, boom);
});
