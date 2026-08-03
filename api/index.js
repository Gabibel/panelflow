// Vercel serverless entry point.
//
// vercel.json rewrites every path here, so this one function answers both the
// API and the web app — exactly as `node backend/src/index.js` does locally,
// and with the same Express instance, so the two cannot drift.
//
// The two env vars below are set from *this* file's location because it is the
// only module guaranteed to keep its position relative to the repo root once
// the bundler has rewritten paths. They are assigned before the app is imported
// because both are read at module load time.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.PANELFLOW_RULES_PATH ??= join(root, 'shared', 'detection-rules.json');
process.env.PANELFLOW_WEB_DIR ??= join(root, 'web');

const { app } = await import('../backend/src/index.js');

export default app;
