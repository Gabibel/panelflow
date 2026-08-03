// The Vercel entry point is the one file that is never exercised locally, so
// it is also the one most likely to be wrong in production only. It boots the
// same Express app but has to locate `web/` and `shared/` from its own
// position — this suite proves those two paths resolve.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const dataDir = mkdtempSync(join(tmpdir(), 'panelflow-vercel-'));
process.env.PANELFLOW_DATA_DIR = dataDir;
process.env.PANELFLOW_JWT_SECRET = 'test-secret';
delete process.env.PANELFLOW_WEB_DIR;
delete process.env.PANELFLOW_RULES_PATH;

const app = (await import('../../api/index.js')).default;

let server, base;

before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server?.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test('the entry point exports something Express-shaped', () => {
  assert.equal(typeof app, 'function', 'Vercel calls it as (req, res)');
  assert.equal(typeof app.listen, 'function');
});

test('it sets the two path env vars from its own location', () => {
  assert.ok(process.env.PANELFLOW_WEB_DIR?.endsWith('web'));
  assert.ok(process.env.PANELFLOW_RULES_PATH?.endsWith('detection-rules.json'));
});

test('the API answers through the serverless entry point', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

test('shared/detection-rules.json is reachable from the bundle layout', async () => {
  const r = await fetch(`${base}/api/rules`);
  assert.equal(r.status, 200, 'a wrong PANELFLOW_RULES_PATH answers 500');
  const rules = await r.json();
  assert.ok(rules.heuristics.scoreThreshold >= 0);
});

test('web/ is reachable from the bundle layout', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200, 'a wrong PANELFLOW_WEB_DIR answers 404');
  assert.match(await index.text(), /<html/i);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
});

test('a full round-trip works through the entry point', async () => {
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'vercel@test.dev', password: 'password123' }),
  });
  assert.equal(reg.status, 201);
  const { token } = await reg.json();

  const add = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: 'Serverless Series',
      sourceDomain: 'example-manga-site.test',
      sourceUrl: 'https://example-manga-site.test/manga/serverless',
    }),
  });
  assert.equal(add.status, 201);
  const entry = await add.json();

  const prog = await fetch(`${base}/api/progress/${entry.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ chapterUrl: 'https://example-manga-site.test/manga/serverless/1', chapterLabel: 'Ch. 1' }),
  });
  assert.equal(prog.status, 200);

  const cont = await fetch(`${base}/api/progress/continue`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = await cont.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Serverless Series');
});
