// The routes of PanelFlow Premium. What they decide, and why, is in
// ../premium.js; these only answer.
import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from '../wrap.js';
import { enforce } from '../rate-limit.js';
import { securityLog } from '../security-log.js';
import {
  accountsInEvent, premiumConfigured, syncPremium, webhookAuthorized,
} from '../premium.js';

export const premiumRouter = Router();

/** Whether the account is Premium, and whether this server sells it at all. */
premiumRouter.get('/', wrap(async (req, res) => {
  res.json({ available: premiumConfigured(), ...req.user.premium });
}));

/**
 * Look again, after a purchase or a restore on the phone. The answer is
 * RevenueCat's, never the caller's: nothing in the body is read.
 *
 * Counted per account. Each call is a request to RevenueCat on our key, and
 * twenty an hour is far more than a person buying, restoring and changing
 * their mind will ever make.
 */
premiumRouter.post('/refresh', wrap(async (req, res) => {
  if (!premiumConfigured()) return res.status(503).json({ error: 'premium unavailable' });
  await enforce(res, `premium:${req.user.id}`, { max: 20, windowSec: 3600 });
  try {
    res.json({ available: true, ...(await syncPremium(req.user.id)) });
  } catch (err) {
    res.status(err.status === 400 ? 400 : 502).json({ error: 'premium check unavailable' });
  }
}));

/**
 * RevenueCat's call when something changed on Apple's side. Mounted outside
 * requireAuth (index.js): it authenticates on the shared Authorization value
 * instead, and refuses everything without it.
 *
 * Answered 200 once every account it names has been looked at again, and 500
 * when one of those looks failed, so that RevenueCat tries the whole event
 * again later (it does, five times over about an hour and a half). An event
 * about nobody we know is answered 200: there is nothing to retry.
 */
export const premiumWebhook = wrap(async (req, res) => {
  if (!premiumConfigured() || !process.env.REVENUECAT_WEBHOOK_AUTH) {
    return res.status(503).json({ error: 'premium unavailable' });
  }
  if (!webhookAuthorized(req.headers.authorization)) {
    securityLog('premium_webhook_refused', {});
    return res.status(401).json({ error: 'invalid token' });
  }
  const ids = accountsInEvent(req.body?.event);
  let failed = 0;
  for (const id of ids) {
    const known = await db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!known) continue;
    try { await syncPremium(id); } catch { failed++; }
  }
  if (failed) return res.status(500).json({ error: 'premium check unavailable' });
  res.json({ ok: true });
});
