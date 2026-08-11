import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db, uid } from './db.js';
import { wrap } from './wrap.js';

// A known signing key lets anyone mint a token for any account, so the shared
// dev value only survives on a developer's machine. Deployed, it is fatal at
// boot rather than silently insecure.
function jwtSecret() {
  const set = process.env.PANELFLOW_JWT_SECRET;
  if (set) return set;
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    throw new Error('PANELFLOW_JWT_SECRET must be set in production');
  }
  return 'dev-secret-change-me';
}

const JWT_SECRET = jwtSecret();
const TOKEN_TTL = '30d';

export const authRouter = Router();

// Both of these are wrapped, like every other async handler in the API: Express
// 4 does not catch a rejected promise returned by a handler, so a database that
// is unreachable here would leave the request open until the client gave up —
// on the two routes a signed-out user meets first.
authRouter.post('/register', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'email and password (min 8 chars) required' });
  }
  const exists = await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'email already registered' });

  const id = uid();
  try {
    await db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
      .run(id, email, bcrypt.hashSync(password, 10));
  } catch (err) {
    // The check above and this insert are two round trips, and two sign-ups
    // with the same address can both pass the check. The UNIQUE index is what
    // actually decides, so the loser is told what the check would have told it
    // rather than being handed a 500.
    if (/UNIQUE|constraint/i.test(String(err?.message ?? ''))) {
      return res.status(409).json({ error: 'email already registered' });
    }
    throw err;
  }
  res.status(201).json({ token: sign(id), user: { id, email, tier: 'free' } });
}));

authRouter.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email ?? '');
  if (!user || !bcrypt.compareSync(password ?? '', user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  res.json({ token: sign(user.id), user: { id: user.id, email: user.email, tier: user.tier } });
}));

function sign(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// An OAuth `state` has to survive a round trip through the tracker and come
// back on a plain browser redirect with no Authorization header, so it is the
// only thing identifying the user at the callback. Signed and short-lived
// rather than a bare user id: otherwise anyone could hand the callback someone
// else's id and hang their tracker account off it.
// `extra` is for a flow that has something of its own to carry across the round
// trip — MAL's PKCE verifier is the only one so far. It rides inside the signed
// payload rather than in a table, because a lambda has nowhere to keep a secret
// between two requests.
export const signOAuthState = (userId, service, extra = {}) =>
  jwt.sign({ ...extra, sub: userId, svc: service }, JWT_SECRET, { expiresIn: '15m' });

/**
 * The user id the state stands for, or null. With `{ full: true }`, the whole
 * verified payload instead — for the caller that needs what `extra` carried.
 */
export function readOAuthState(state, service, { full = false } = {}) {
  try {
    const payload = jwt.verify(String(state ?? ''), JWT_SECRET);
    if (payload.svc !== service) return null;
    return full ? payload : payload.sub;
  } catch {
    return null;
  }
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  let payload;
  // Only the signature check may answer 401 — the lookup below now touches the
  // network, and a database outage must not read as "your token is bad".
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
  try {
    const user = await db.prepare('SELECT id, email, tier FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'unknown user' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
