import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db, uid } from './db.js';

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

authRouter.post('/register', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'email and password (min 8 chars) required' });
  }
  const exists = await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'email already registered' });

  const id = uid();
  await db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(id, email, bcrypt.hashSync(password, 10));
  res.status(201).json({ token: sign(id), user: { id, email, tier: 'free' } });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email ?? '');
  if (!user || !bcrypt.compareSync(password ?? '', user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  res.json({ token: sign(user.id), user: { id: user.id, email: user.email, tier: user.tier } });
});

function sign(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// An OAuth `state` has to survive a round trip through the tracker and come
// back on a plain browser redirect with no Authorization header, so it is the
// only thing identifying the user at the callback. Signed and short-lived
// rather than a bare user id: otherwise anyone could hand the callback someone
// else's id and hang their tracker account off it.
export const signOAuthState = (userId, service) =>
  jwt.sign({ sub: userId, svc: service }, JWT_SECRET, { expiresIn: '15m' });

export function readOAuthState(state, service) {
  try {
    const payload = jwt.verify(String(state ?? ''), JWT_SECRET);
    return payload.svc === service ? payload.sub : null;
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
