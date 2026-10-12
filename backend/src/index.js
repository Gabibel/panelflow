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
import { withErrorCodes } from './error-codes.js';

const app = express();
// Which framework answers is nobody's business, and it is the first line an
// automated scan reads.
app.disable('x-powered-by');
// First, so that every refusal below it — the routes' own and the error
// middleware's — leaves with a `code` a client can translate (error-codes.js).
app.use(withErrorCodes);

/**
 * What the web app is allowed to load, as a policy the browser enforces.
 *
 * The web app keeps the account's token in localStorage, so a script that runs
 * on this origin owns the account — and until September 2026 nothing stopped
 * one: no Content-Security-Policy, no frame-ancestors, no nosniff. The app
 * loads only its own files (web/, one origin, no inline script, no CDN), which
 * is what makes a strict policy possible: 'self' for everything that runs.
 * Pictures are the exception: a cover is fetched from its site when the
 * proxy cannot get it, so images may come from any https host — an image
 * cannot run anything.
 *
 * On a loopback host the API may be another local port (a developer pointing
 * the page at their own server), and only there.
 */
const isLoopback = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(req.headers.host || ''));

function webPolicy(req) {
  const local = isLoopback(req);
  const connect = local ? "'self' http://localhost:* http://127.0.0.1:*" : "'self'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Whether the request reached us over HTTPS. Behind Vercel's edge the socket is
 * plain and the edge says what the reader used in x-forwarded-proto.
 */
const overHttps = (req) => req.secure
  || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// For every answer: no sniffing a type into something else, no referrer
// handed to the sites a reader opens from here, no framing. The page policy
// only on pages — the API answers JSON, and the cover proxy sets its own.
//
// And HTTPS for two years once a browser has seen it once (HSTS): the token in
// localStorage is the account, and a page served over plain HTTP on a café's
// network is a page someone else can rewrite. Vercel sends the same header on
// its own domains; it is set here as well so the promise travels with the
// code to any host. Never on a loopback address, where there is no HTTPS to
// keep to and a header would stick to `localhost` for every other project.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (overHttps(req) && !isLoopback(req)) res.set('Strict-Transport-Security', 'max-age=63072000');
  if (!req.path.startsWith('/api/')) res.set('Content-Security-Policy', webPolicy(req));
  next();
});

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

// An address under /api that no route answers is a refusal like the others,
// with a code — not the static server's HTML page.
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Web frontend (monorepo /web): served same-origin so it needs no CORS or config.
// Overridable by env because a serverless bundle does not keep this file at a
// predictable depth relative to the repo root.
const webDir = process.env.PANELFLOW_WEB_DIR
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/**
 * The address the public pages live at, for the two files a search engine
 * reads: PANELFLOW_PUBLIC_URL when set (the same value the e-mails use), the
 * address the request came in on otherwise.
 */
function siteBase(req) {
  const set = process.env.PANELFLOW_PUBLIC_URL;
  if (set) return set.replace(/\/+$/, '');
  // The Host header is the caller's to write, and it ends up inside XML: only
  // a plain host name (and port) is repeated back.
  const host = String(req.headers.host || '');
  return `${overHttps(req) ? 'https' : 'http'}://${/^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? host : 'localhost'}`;
}

// The pages anyone may land on without an account: the front door, the help
// and the legal pages, each in both languages. The library itself is behind a
// sign-in and has nothing to index.
export const PUBLIC_PAGES = [
  '', 'aide.html', 'support.html',
  'mentions-legales.html', 'legal-notice.html',
  'confidentialite.html', 'privacy.html',
  'conditions.html', 'terms.html',
];

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    // Answers to a program, never pages: nothing under it is worth a crawl,
    // and the cover relay would be a crawler fetching other people's sites.
    'Disallow: /api/',
    `Sitemap: ${siteBase(req)}/sitemap.xml`,
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  const base = siteBase(req);
  res.type('application/xml').send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...PUBLIC_PAGES.map((page) => `  <url><loc>${base}/${page}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n'));
});

// Asked for by every browser and crawler that never read the page's <link>.
app.get('/favicon.ico', (_req, res) => {
  res.type('image/png').sendFile(path.join(webDir, 'icons', 'favicon-32.png'));
});

app.use(express.static(webDir));

// An address no page answers: a page that says so and leads back, in place of
// Express's bare "Cannot GET /x". Only for a browser asking for a page; the API
// has its own JSON 404 above.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.status(404).sendFile(path.join(webDir, '404.html'));
});

app.use((err, req, res, _next) => {
  const status = Number(err?.status ?? err?.statusCode);
  // The body parser's refusals quote the body they could not read — "Unexpected
  // token 'o', "too many…" is not valid JSON" — so the words are the caller's,
  // and naming the refusal by them gave a malformed sign-up the code for "too
  // many attempts" (QA re-test, September 2026). A sentence of our own instead.
  // A compressed body that does not inflate is the same refusal: zlib's own
  // words ("incorrect header check") are not ours to hand back (re-test It.4).
  const unreadable = (typeof err?.type === 'string' && /^(entity|charset|encoding|request)\./.test(err.type))
    || (typeof err?.code === 'string' && err.code.startsWith('Z_'));
  if (unreadable) {
    const tooLarge = status === 413;
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'the request body is too large' : 'the request body could not be read',
      code: tooLarge ? 'too_large' : 'bad_request',
    });
  }
  // A handler that threw a deliberate refusal — a bad URL, a list that is not
  // an export, a site that timed out — says so with a status, and the caller
  // needs to be told which of those it was. Only an unlabelled error is a bug
  // here, and only that one is logged and reduced to 500.
  if (status >= 400 && status < 600) {
    return res.status(status).json({ error: err.message || 'request refused' });
  }
  // An unlabelled error is a bug, and "internal error" is the same six words
  // whichever of the ~100 routes produced it. So the log line names the route
  // and the reply carries a short reference to the same line: a bug report that
  // quotes `ref` is one grep of the runtime log away from the stack, instead of
  // a read of every handler that can 500. Deliberately not the request id of
  // any platform — this has to work the same on Vercel and on `npm start`.
  const ref = Math.random().toString(36).slice(2, 8);
  console.error(`[500 ${ref}] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: 'internal error', ref });
});

export { app };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => console.log(`panelflow-backend listening on :${port}`));
}
