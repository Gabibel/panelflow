import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { db, uid } from './db.js';
import { wrap } from './wrap.js';
import { enforce, forget, callerIp, callerNetwork, LIMITS } from './rate-limit.js';
import { sendMail, mailConfigured, publicBase } from './mail.js';
import { securityLog } from './security-log.js';

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

const httpError = (status, message) => Object.assign(new Error(message), { status });

// A real bcrypt hash of a string nobody will ever type, compared against when
// the account does not exist. See /login: without it, the endpoint answers a
// missing address in a millisecond and an existing one in seventy, which
// distinguishes them as reliably as a different status code would. Written out
// rather than computed at import time, because computing it costs that same
// seventy milliseconds on every cold start, forever, for a constant.
const DECOY_HASH = '$2a$10$jX9GM1KfEx6frVWFTU7.1.3Ihlv54U7F2KF9jpkir9Ag.pVFWsTZ.';

// Reset links live for an hour. Long enough to walk away from the computer and
// come back, short enough that a link sitting in a mailbox that is later
// compromised is usually already dead.
const RESET_TTL_MIN = 60;

/**
 * An e-mail address as an account keeps it — trimmed, lower-case — or null
 * when it is not one.
 *
 * The QA pass of September 2026 signed up with " reader@x.test" and
 * "reader@x.test" and got two accounts, sent an object and got a 500, and sent
 * "not-an-email" and got an account. Every route that takes an address reads
 * it through here.
 */
export function normaliseEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/**
 * Why a password cannot be used, or null.
 *
 * bcrypt reads the first 72 bytes and silently ignores the rest, so a longer
 * password is a password whose end does nothing — refused rather than
 * truncated behind the reader's back.
 */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'password (min 8 chars) required';
  if (Buffer.byteLength(password, 'utf8') > 72) return 'password is longer than 72 bytes';
  return null;
}

// Both of these are wrapped, like every other async handler in the API: Express
// 4 does not catch a rejected promise returned by a handler, so a database that
// is unreachable here would leave the request open until the client gave up —
// on the two routes a signed-out user meets first.
authRouter.post('/register', wrap(async (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const password = req.body?.password;
  // Checked before anything is counted: a form sent with a typo is not an
  // account being made, and it used to spend the allowance of everyone behind
  // the same address (QA, September 2026).
  if (!email) return res.status(400).json({ error: 'a valid e-mail address is required' });
  const weak = passwordProblem(password);
  if (weak) return res.status(400).json({ error: weak });

  // Per network, because a network is what an account costs. Not so tight that
  // a family, an office or a mobile carrier's shared address cannot sign up in
  // the same afternoon — the point is to make ten thousand accounts expensive,
  // not thirty.
  await enforce(res, `register:${callerNetwork(req)}`, LIMITS.register);

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

// Two counters, because there are two different attacks and one limit cannot
// answer both.
//
// Per address caps how fast anyone can work at all, and it is what stops the
// bcrypt cost — ~70 ms of blocked event loop per attempt — from being a way to
// take the function down with a loop. It counts every attempt, right or wrong.
//
// Per account caps guessing at one specific person, which a botnet spread over
// a thousand addresses would otherwise do under the first limit's radar. It
// counts only *failures*, and a correct password clears it: someone who
// mistypes twice a day for a month must never find themselves locked out by the
// sum of it.
//
// Neither one locks the account, and that is deliberate. Locking after N
// failures hands anyone who knows your address a button that takes your account
// away from you — the denial of service is the feature. Slowing the guessing
// down costs the attacker everything and the owner a wait.
authRouter.post('/login', wrap(async (req, res) => {
  const ip = callerIp(req);
  // Read the way /register wrote it. Anything that is not text is no account
  // and no password — it used to reach the database and bcrypt as an object,
  // and come back as a 500.
  const account = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  await enforce(res, `login-ip:${callerNetwork(req)}`, {
    ...LIMITS.loginIp,
    message: 'too many sign-in attempts, try again later',
  }).catch((err) => {
    securityLog('login_rate_limited', { by: 'ip', ip });
    throw err;
  });

  const user = account ? await db.prepare('SELECT * FROM users WHERE email = ?').get(account) : undefined;
  // Before bcrypt runs, so that a spent allowance costs nothing to refuse.
  if (user) {
    await enforce(res, `login-account:${account}`, {
      ...LIMITS.loginAccount,
      cost: 0, // reading the counter, not charging it: only failures below do
      message: 'too many sign-in attempts, try again later',
    }).catch((err) => {
      securityLog('login_rate_limited', { by: 'account', email: account, ip });
      throw err;
    });
  }

  // Always a bcrypt comparison, even with nothing to compare against: see
  // DECOY_HASH. The result of the decoy one is discarded — it can only be
  // false — but the seventy milliseconds it spends are the point.
  const ok = bcrypt.compareSync(password, user?.password_hash ?? DECOY_HASH) && !!user;
  if (!ok) {
    if (user) {
      await enforce(res, `login-account:${account}`, LIMITS.loginAccount).catch(() => {});
    }
    // An address with no account behind it is somebody else's, or nobody's:
    // it is counted by where it came from, and not written down in any form.
    securityLog('login_failed', { ...(user ? { email: account } : {}), ip, known: !!user });
    return res.status(401).json({ error: 'invalid credentials' });
  }

  await forget(`login-account:${account}`);
  res.json({
    token: sign(user.id, user.token_epoch),
    user: { id: user.id, email: user.email, tier: user.tier },
  });
}));

// --- forgotten passwords ---------------------------------------------------

// Read before the sign-in screen is drawn, and unauthenticated because that is
// exactly who needs it. A deployment with no mail provider cannot send a reset
// link, and offering the door anyway means a reader types their address, waits,
// and is told 503 — the same dead end, reached slower and with more hope spent.
// So the client asks first and simply does not draw it.
//
// It leaks nothing: whether this server can send mail is visible from the
// outside the moment anyone tries.
authRouter.get('/capabilities', (_req, res) => {
  res.json({ passwordReset: mailConfigured() });
});

// The answer is the same whatever happened: address known, address unknown,
// address known but the mail bounced. Anything else turns this endpoint into
// the account-list oracle that /register at least makes people work for, and
// this one needs no password at all to ask.
const FORGOT_ANSWER = { ok: true, message: 'if that address has an account, a reset link is on its way' };

authRouter.post('/forgot', wrap(async (req, res) => {
  const ip = callerIp(req);
  const email = normaliseEmail(req.body?.email) ?? '';

  // Per address of the *caller* and per address being asked about. The second
  // one is what stops this endpoint being used to bury someone else's inbox:
  // whoever they are, three mails an hour is the most that can be aimed at them
  // from here, from any number of machines.
  await enforce(res, `forgot-ip:${callerNetwork(req)}`, LIMITS.forgotIp);
  if (email) await enforce(res, `forgot-email:${email}`, LIMITS.forgotEmail);

  if (!email) return res.json(FORGOT_ANSWER);
  // Checked before the lookup so that a server which cannot send says so,
  // rather than cheerfully claiming a mail is on its way to a queue that does
  // not exist.
  if (!mailConfigured()) throw httpError(503, 'password reset is not configured on this server');

  const user = await db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) {
    securityLog('password_reset_unknown_email', { ip });
    return res.json(FORGOT_ANSWER);
  }

  // 32 bytes from the CSPRNG, which is the whole of the secret: this link is a
  // password for one minute's worth of one account, so it is generated the way
  // a password never can be. base64url because it has to survive being pasted
  // out of a mail client.
  const token = randomBytes(32).toString('base64url');

  // Previous unused links for this account die here. Otherwise "I clicked
  // forgot five times because nothing arrived" leaves five working keys, and
  // the four the user never sees are the ones nobody would notice being used.
  await db.batch([
    { sql: 'DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', args: [user.id] },
    {
      sql: `INSERT INTO password_resets (token_hash, user_id, expires_at)
            VALUES (?, ?, datetime('now', ?))`,
      args: [hashToken(token), user.id, `+${RESET_TTL_MIN} minutes`],
    },
  ]);

  const link = `${publicBase()}/#reset=${token}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your PanelFlow password',
    text: [
      'Someone asked to reset the password on your PanelFlow account.',
      '',
      `Open this link to choose a new one — it works once, and expires in ${RESET_TTL_MIN} minutes:`,
      link,
      '',
      'If it was not you, nothing has happened to your account and you can ignore this.',
    ].join('\n'),
    html: [
      '<p>Someone asked to reset the password on your PanelFlow account.</p>',
      `<p><a href="${escapeHtml(link)}">Choose a new password</a> — the link works once, `,
      `and expires in ${RESET_TTL_MIN} minutes.</p>`,
      '<p>If it was not you, nothing has happened to your account and you can ignore this.</p>',
    ].join(''),
  });

  securityLog('password_reset_requested', { email, ip });
  res.json(FORGOT_ANSWER);
}));

// Spending the link. One statement claims it — see the WHERE — so two clicks
// arriving together cannot both win: the second matches nothing because
// used_at is no longer NULL, and is told the link is dead, which by then it is.
const CLAIM_RESET = `
  UPDATE password_resets SET used_at = datetime('now')
  WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
  RETURNING user_id
`;

authRouter.post('/reset', wrap(async (req, res) => {
  const ip = callerIp(req);
  const { token, password } = req.body ?? {};
  // Guessing a 256-bit token is not a thing anyone will do, but the endpoint
  // still writes to the database once per call, so it is not left open either.
  await enforce(res, `reset:${callerNetwork(req)}`, LIMITS.reset);

  const weak = passwordProblem(password);
  if (weak) return res.status(400).json({ error: weak });
  const claimed = token
    ? await db.prepare(CLAIM_RESET).get(hashToken(String(token)))
    : null;
  if (!claimed) {
    securityLog('password_reset_invalid', { ip });
    // Expired, already used, and never issued are one answer on purpose: the
    // three of them differ only in what they would tell someone holding a token
    // they should not have.
    return res.status(400).json({ error: 'this reset link is no longer valid — ask for a new one' });
  }

  // The epoch bump is the second half of the reset, and the half that is easy
  // to leave out: a password changed because someone else might know it has
  // changed nothing at all while the session that someone else is already
  // holding keeps working for another thirty days. Incrementing here retires
  // every token issued before this moment, on every device, on their next
  // request (see requireAuth).
  await db.batch([
    {
      sql: `UPDATE users SET password_hash = ?, token_epoch = token_epoch + 1 WHERE id = ?`,
      args: [bcrypt.hashSync(String(password), 10), claimed.user_id],
    },
    { sql: 'DELETE FROM password_resets WHERE user_id = ?', args: [claimed.user_id] },
  ]);

  // The failure counter for this account goes with it: whoever just proved they
  // hold the mailbox should not walk into a lockout left behind by whoever was
  // guessing at them.
  const owner = await db.prepare('SELECT email FROM users WHERE id = ?').get(claimed.user_id);
  if (owner) await forget(`login-account:${String(owner.email).toLowerCase()}`);

  securityLog('password_reset_used', { userId: claimed.user_id, ip });
  // No token in the answer, deliberately: signing in with the new password is
  // one more step and it is the step that proves the new password is the one
  // the user meant to set.
  res.json({ ok: true, message: 'password changed — sign in with your new password' });
}));

// --- leaving --------------------------------------------------------------

/**
 * Delete the account, and everything that was ever attached to it.
 *
 * The one route this API had no equivalent of, and the one the law does not
 * make optional: the right to erasure (RGPD art. 17), which the privacy page
 * promises as "Réglages → Compte → Supprimer mon compte", and which Apple
 * requires of any app that lets people create an account in the first place.
 *
 * It asks for the password again even though the caller is already signed in.
 * A session is a token on a device, and a device is a thing that gets left on
 * a train; deleting an account is the one action a stranger holding one must
 * not be able to take. The same decoy comparison as sign-in, for the same
 * reason — there is no timing difference to learn from.
 *
 * One statement. Every table that belongs to an account references users(id)
 * with ON DELETE CASCADE (see db.js), and foreign keys are on, so the library,
 * the progress, the history, the preferences, the push subscriptions, the
 * tracker tokens and the reset links go with the row. Nothing is soft-deleted
 * and nothing is kept back "in case": the promise on the privacy page is
 * immediate and definitive, and this is what makes it true. Every session then
 * dies on its next request — requireAuth looks the user up and finds nobody.
 *
 * What is not deleted, and why: the rate-limit buckets keyed on this address
 * and this e-mail. They hold no reference to the account and no address in
 * clear — a bucket is stored under a keyed hash of its name (rate-limit.js) —
 * they expire on their own within three days, and clearing them on deletion
 * would turn "delete and re-register" into a way past the sign-in limits. The
 * privacy page says so, in those words.
 */
authRouter.delete('/me', requireAuth, wrap(async (req, res) => {
  const ip = callerIp(req);
  const { password } = req.body ?? {};
  // Charged like a sign-in attempt, against the account: a stolen session
  // guessing at the password here is the same attack as guessing it there.
  const account = String(req.user.email).toLowerCase();
  await enforce(res, `login-account:${account}`, {
    ...LIMITS.loginAccount,
    cost: 0,
    message: 'too many attempts, try again later',
  });

  const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const ok = bcrypt.compareSync(String(password ?? ''), user?.password_hash ?? DECOY_HASH) && !!user;
  if (!ok) {
    await enforce(res, `login-account:${account}`, LIMITS.loginAccount).catch(() => {});
    securityLog('account_delete_refused', { userId: req.user.id, ip });
    // 403 and not 401: the session is fine, the password is not. Every client
    // treats a 401 while signed in as "your session expired" and signs out —
    // which would turn a mistyped password into a trip back to the front door.
    return res.status(403).json({ error: 'wrong password' });
  }

  await db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  // The one line in the log that says an account was closed: the id, which now
  // points at nothing, and the address it came from. Not the e-mail — the
  // point of the request was that it stops being kept.
  securityLog('account_deleted', { userId: req.user.id, ip });
  res.status(204).end();
}));

// --- changing the address ---------------------------------------------------

/**
 * Ask to move the account to another address.
 *
 * Two proofs, because two things can go wrong. The password, again, for the
 * same reason deletion asks for it: a session is a token on a device, and
 * the address is how the account is recovered, so a stranger with the device
 * must not be able to point recovery at themselves. And a link sent to the
 * *new* address, because the only way to know that the person asking can read
 * that inbox is to make them prove it: nothing is applied until it is clicked.
 * Until then the old address stays, and a typo changes nothing.
 *
 * Refused up front when the address is taken: unlike /forgot there is no
 * enumeration to protect here, since the caller is signed in and rate-limited
 * on their own account, and "already registered" is the one answer that lets
 * them fix a typo rather than wait for a mail that will never come.
 */
authRouter.post('/email', requireAuth, wrap(async (req, res) => {
  const ip = callerIp(req);
  const { password, email } = req.body ?? {};
  const next = normaliseEmail(email);
  const account = String(req.user.email).toLowerCase();

  await enforce(res, `login-account:${account}`, { ...LIMITS.loginAccount, cost: 0 });
  if (!next) return res.status(400).json({ error: 'a valid e-mail address is required' });
  // Three mails an hour to any one new address, from any account: the same
  // ceiling /forgot puts on an inbox, so this route is not a second way to
  // bury one.
  await enforce(res, `forgot-email:${next}`, LIMITS.forgotEmail);
  if (next === account) return res.status(400).json({ error: 'that is already your address' });
  if (!mailConfigured()) throw httpError(503, 'changing the address is not configured on this server');

  const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const ok = bcrypt.compareSync(String(password ?? ''), user?.password_hash ?? DECOY_HASH) && !!user;
  if (!ok) {
    await enforce(res, `login-account:${account}`, LIMITS.loginAccount).catch(() => {});
    securityLog('email_change_refused', { userId: req.user.id, ip });
    // 403, as deletion: the session is fine, the password is not.
    return res.status(403).json({ error: 'wrong password' });
  }
  const taken = await db.prepare('SELECT 1 FROM users WHERE email = ?').get(next);
  if (taken) return res.status(409).json({ error: 'email already registered' });

  const token = randomBytes(32).toString('base64url');
  // One pending change per account: asking again replaces the last link.
  await db.batch([
    { sql: 'DELETE FROM email_changes WHERE user_id = ? AND used_at IS NULL', args: [req.user.id] },
    {
      sql: `INSERT INTO email_changes (token_hash, user_id, new_email, expires_at)
            VALUES (?, ?, ?, datetime('now', ?))`,
      args: [hashToken(token), req.user.id, next, `+${RESET_TTL_MIN} minutes`],
    },
  ]);

  const link = `${publicBase()}/#confirm-email=${token}`;
  await sendMail({
    to: next,
    subject: 'Confirm your new PanelFlow address',
    text: [
      `Someone asked to move a PanelFlow account (${account}) to this address.`,
      '',
      `Open this link to confirm. It works once, and expires in ${RESET_TTL_MIN} minutes:`,
      link,
      '',
      'If it was not you, nothing changes and you can ignore this.',
    ].join('\n'),
    html: [
      `<p>Someone asked to move a PanelFlow account (${escapeHtml(account)}) to this address.</p>`,
      `<p><a href="${escapeHtml(link)}">Confirm the new address</a>. The link works once, `,
      `and expires in ${RESET_TTL_MIN} minutes.</p>`,
      '<p>If it was not you, nothing changes and you can ignore this.</p>',
    ].join(''),
  });

  securityLog('email_change_requested', { userId: req.user.id, ip });
  res.json({ ok: true, message: 'a confirmation link is on its way to the new address' });
}));

const CLAIM_EMAIL_CHANGE = `
  UPDATE email_changes SET used_at = datetime('now')
  WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
  RETURNING user_id, new_email
`;

/**
 * Spend the link. Unauthenticated, like /reset: the person clicking is in a
 * mail client, not necessarily in a signed-in tab, and the token is the
 * proof. Sessions are kept: the password did not change, and a reader who
 * moved their address on the phone should not be signed out at the desk.
 */
authRouter.post('/email/confirm', wrap(async (req, res) => {
  const ip = callerIp(req);
  await enforce(res, `reset:${ip}`, LIMITS.reset);
  const { token } = req.body ?? {};
  const claimed = token ? await db.prepare(CLAIM_EMAIL_CHANGE).get(hashToken(String(token))) : null;
  if (!claimed) {
    securityLog('email_change_invalid', { ip });
    return res.status(400).json({ error: 'this link is no longer valid, ask for a new one' });
  }
  // The address may have been taken in the hour between asking and clicking.
  const taken = await db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?')
    .get(claimed.new_email, claimed.user_id);
  if (taken) return res.status(409).json({ error: 'email already registered' });

  await db.prepare('UPDATE users SET email = ? WHERE id = ?').run(claimed.new_email, claimed.user_id);
  securityLog('email_changed', { userId: claimed.user_id, ip });
  res.json({ ok: true, email: claimed.new_email, message: 'your address has been changed' });
}));

/** Old rows, cleared out by the nightly run. Nothing reads them once spent. */
export const prunePasswordResets = () => db.batch([
  { sql: "DELETE FROM password_resets WHERE expires_at <= datetime('now', '-7 days')", args: [] },
  { sql: "DELETE FROM email_changes WHERE expires_at <= datetime('now', '-7 days')", args: [] },
]);

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// `ep` is the session generation the token belongs to (users.token_epoch). Left
// off, it reads as 0 on the way back in, which is what every token issued
// before this existed should mean.
function sign(userId, epoch = 0) {
  return jwt.sign({ sub: userId, ep: Number(epoch ?? 0) }, JWT_SECRET, { expiresIn: TOKEN_TTL });
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
    const user = await db.prepare(
      'SELECT id, email, tier, token_epoch FROM users WHERE id = ?',
    ).get(payload.sub);
    if (!user) return res.status(401).json({ error: 'unknown user' });
    // The revocation a stateless token cannot otherwise have. It costs no extra
    // query — this lookup was already happening — and it is what makes a
    // password reset mean anything: every token minted before the reset carries
    // the previous number and stops working here, on the next request, on every
    // device at once.
    if (Number(payload.ep ?? 0) !== Number(user.token_epoch ?? 0)) {
      securityLog('session_retired', { userId: user.id });
      return res.status(401).json({ error: 'password changed — sign in again' });
    }
    req.user = { id: user.id, email: user.email, tier: user.tier };
    next();
  } catch (err) {
    next(err);
  }
}
