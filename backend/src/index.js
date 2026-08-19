import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authRouter, requireAuth } from './auth.js';
import { libraryRouter } from './routes/library.js';
import { categoriesRouter } from './routes/categories.js';
import { progressRouter } from './routes/progress.js';
import { historyRouter } from './routes/history.js';
import { importRouter } from './routes/import.js';
import { metaRouter, coverProxy } from './routes/meta.js';
import { rulesRouter, adblockRouter } from './routes/rules.js';
import { searchRouter } from './routes/search.js';
import { trackersRouter, trackerCallback } from './routes/trackers.js';
import { watchRouter, newsRouter } from './routes/watch.js';
import { pushRouter } from './routes/push.js';
import { exportRouter, restoreRoute } from './routes/export.js';
import { prefsRouter } from './routes/prefs.js';
import { wrap } from './wrap.js';

const app = express();

// CORS: the Chrome extension and mobile WebViews call this API cross-origin.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Ahead of the shared parser, with a parser of its own: a full backup — shelf,
// bookmarks and every read ever recorded — is the one body this API accepts
// that is genuinely large, and 1 MB would refuse it before the route ran.
app.post('/api/import/panelflow', requireAuth, ...restoreRoute);

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'panelflow-backend' }));
app.use('/api/auth', authRouter);
app.use('/api/rules', rulesRouter);
// Public like /api/rules, and for the same reason: blocking has to work before
// anyone signs in, and the list says nothing about who is asking.
app.use('/api/adblock', adblockRouter);
app.get('/api/me', requireAuth, (req, res) => res.json(req.user));
app.use('/api/library', requireAuth, libraryRouter);
app.use('/api/categories', requireAuth, categoriesRouter);
app.use('/api/prefs', requireAuth, prefsRouter);
app.use('/api/progress', requireAuth, progressRouter);
app.use('/api/history', requireAuth, historyRouter);
app.use('/api/import', requireAuth, importRouter);
app.use('/api/export', requireAuth, exportRouter);
// Before the guarded mount: the tracker redirects a browser here, so this one
// route cannot require a bearer token. It authenticates on the signed `state`
// it handed out at /connect instead.
app.get('/api/trackers/:service/callback', wrap(trackerCallback));
app.use('/api/trackers', requireAuth, trackersRouter);
// The cron runner authenticates on a shared secret, not on a user token, so it
// mounts outside requireAuth and does its own check.
app.use('/api/watch', watchRouter);
app.use('/api/news', requireAuth, newsRouter);
// Behind auth including /key: a subscription belongs to an account, so there is
// no point handing the public key to someone who cannot then register one.
app.use('/api/push', requireAuth, pushRouter);
app.use('/api/meta', requireAuth, metaRouter);
// Behind auth like /api/meta: both spend a server-side page fetch per call.
app.use('/api/search', requireAuth, searchRouter);
// Public: <img> tags cannot send Authorization; the proxy is SSRF-guarded.
app.get('/api/cover', wrap(coverProxy));

// Web frontend (monorepo /web): served same-origin so it needs no CORS or config.
// Overridable by env because a serverless bundle does not keep this file at a
// predictable depth relative to the repo root.
const webDir = process.env.PANELFLOW_WEB_DIR
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
app.use(express.static(webDir));

app.use((err, _req, res, _next) => {
  // A handler that threw a deliberate refusal — a bad URL, a list that is not
  // an export, a site that timed out — says so with a status, and the caller
  // needs to be told which of those it was. Only an unlabelled error is a bug
  // here, and only that one is logged and reduced to 500.
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 600) {
    return res.status(status).json({ error: err.message || 'request refused' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

export { app };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => console.log(`panelflow-backend listening on :${port}`));
}
