// The extension worker's image fetch, and what it will hand back.
//
// `fetchImage` and `offlineFetchPage` fetch a page of a chapter for the reader
// when CORS keeps the page's own document from reading it. The fetch carries
// the reader's cookies for every site the extension may read, and the answer
// goes back to a content script, which Chrome's own security model treats as
// no more trusted than the page it runs in. Answered for any address, it read
// whatever that address served with the reader's session: an account page on
// another reading site, the JSON behind it. A chapter's page is a picture, so
// a picture is all it answers now (QA, P5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootWorker } from '../test-support/worker.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HTML = new TextEncoder().encode('<!doctype html><title>Account</title>email: someone@example.test');

const serving = (url) => {
  const body = String(url).endsWith('.png') ? PNG : HTML;
  return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(0) };
};

test('a picture comes back to the reader', async () => {
  const w = bootWorker({ fetch: async (url) => serving(url) });
  const r = await w.send({ type: 'fetchImage', url: 'https://cdn.scan.test/ch1/p1.png', siteUrl: 'https://scan.test/ch1' });
  assert.ok(r?.b64, JSON.stringify(r));
  assert.deepEqual([...Buffer.from(r.b64, 'base64')], [...PNG]);
});

test('anything that is not a picture does not, whoever asks', async () => {
  const w = bootWorker({ fetch: async (url) => serving(url) });
  for (const type of ['fetchImage', 'offlineFetchPage']) {
    const r = await w.send({ type, url: 'https://other-site.test/account', siteUrl: 'https://scan.test/ch1',
      chapterUrl: 'https://scan.test/ch1', index: 0 });
    assert.equal(r?.b64, undefined, `${type} handed back a page that is not a picture`);
    assert.ok(r?.error, `${type} answered ${JSON.stringify(r)}`);
  }
});

test('only an address on the web is fetched at all', async () => {
  const w = bootWorker({ fetch: async (url) => serving(url) });
  for (const url of ['chrome-extension://abc/options.html', 'file:///etc/passwd', 'data:image/png;base64,iVBORw0K', 'not a url']) {
    const r = await w.send({ type: 'fetchImage', url, siteUrl: 'https://scan.test/ch1' });
    assert.equal(r?.b64, undefined, url);
  }
  assert.equal(w.calls.filter((c) => !String(c.url ?? c).includes('/api/')).length, 0,
    'a refused address was requested anyway');
});
