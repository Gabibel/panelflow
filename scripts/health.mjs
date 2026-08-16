// Is production answering?
//
// This exists as a file, rather than as a curl line in the shipping skill,
// for two reasons. The first is that the production URL should be written
// down once: `panelflow-backend.vercel.app` is the deployment, and the shorter
// `panelflow.vercel.app` belongs to an unrelated project that answers 200 to
// anything — a trap that only springs when someone retypes the host from
// memory, which is exactly what a checklist invites. The second is local: this
// machine's antivirus deletes a file under `.claude/` that holds a command
// fetching a remote host, so the skill points here instead of carrying the URL.
//
// Exits non-zero unless the service names itself, so `npm run health` can be
// read by a person or by a script.
const URL = 'https://panelflow-backend.vercel.app/api/health';
const TIMEOUT_MS = 20000;

/** One attempt. Resolves to `{ ok, status, body }`; never throws. */
async function probe() {
  const stop = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(URL, { signal: stop, headers: { accept: 'application/json' } });
    const body = (await res.text()).slice(0, 300);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String((err && err.message) || err) };
  }
}

// A deploy takes a moment and a single timeout is not a failed deployment, so
// one retry — and no more, because a third attempt only delays the bad news.
let result = await probe();
if (!result.ok) {
  await new Promise((r) => setTimeout(r, 5000));
  result = await probe();
}

const named = result.ok && result.body.includes('panelflow-backend');
console.log(`${URL} -> ${result.status || 'no answer'} ${result.body}`);
if (!named) {
  console.log(result.ok
    ? 'Answered, but did not name itself — check which project that host resolves to.'
    : 'Production did not answer.');
  process.exit(1);
}
