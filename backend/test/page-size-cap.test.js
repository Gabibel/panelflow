// How much of a page the server reads.
//
// The callers only ever use the first 1.5 million characters of a page, but
// the body used to be read whole (`resp.text()`) before that cut, so a page
// that kept sending was buffered until the function ran out of memory: the
// ten-second abort does not stop a fast server (QA, P5). The stream is now
// read up to a byte cap and let go there. Checked against a stand-in fetch
// whose body never ends, counting what was actually pulled from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPage } from '../src/routes/meta.js';

const MB = 1024 * 1024;

/** A fetch whose page is `pages` megabytes of "a", handed out a megabyte at a time. */
function endless(pages) {
  const real = globalThis.fetch;
  let pulled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      if (pulled >= pages) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(MB).fill(0x61));
    },
  }), { status: 200, headers: { 'content-type': 'text/html' } });
  return { pulled: () => pulled, restore: () => { globalThis.fetch = real; } };
}

test('a page that does not end is read only as far as the cut', async () => {
  const f = endless(200);
  try {
    const html = await fetchPage('http://1.1.1.1/huge');
    assert.equal(html.length, 1_500_000, 'the callers still get their 1.5 million characters');
    assert.ok(f.pulled() <= 8, `${f.pulled()} MB were read for a 1.5 MB answer`);
  } finally { f.restore(); }
});

test('a page under the cap comes back whole', async () => {
  const f = endless(1);
  try {
    assert.equal((await fetchPage('http://1.1.1.1/small')).length, MB);
  } finally { f.restore(); }
});
