// The one thing this API sends by email: a link back into an account whose
// password is gone.
//
// Deliberately one function and one provider behind it. A reset flow needs mail
// that arrives at a stranger's inbox and is not filed as spam, which is a
// deliverability problem, not a code problem — it wants a domain with SPF and
// DKIM records, and no library fixes that. So the code here is the thin part:
// an HTTP POST to Resend, written against `fetch` rather than an SDK because
// the SDK would be a dependency to serialise one JSON object.
//
// Swapping provider means rewriting `deliver` and nothing else.
//
// Unconfigured, it does not pretend. In production a missing key is a 503 with
// a name — a reset endpoint that answers "check your inbox" while nothing was
// sent is the worst of the possible failures, because the user then waits.
// Locally there is no key and none is wanted, so the link goes to the console
// and to `outbox`, which is how the flow is exercised without an inbox.
import { securityLog } from './security-log.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

const key = () => process.env.PANELFLOW_RESEND_KEY;
const from = () => process.env.PANELFLOW_MAIL_FROM ?? 'PanelFlow <no-reply@panelflow.app>';

const isProduction = () => !!process.env.VERCEL || process.env.NODE_ENV === 'production';

/** Whether a reset mail would actually leave the building. */
export const mailConfigured = () => !!key() || !isProduction();

/**
 * Where the clients are served, for links that have to work in a mail client.
 *
 * Read from the environment and never from the request's Host header. That
 * header is the caller's to write: taking the link's origin from it lets
 * someone request a reset for your address and have the mail arrive with their
 * host in the URL, so that clicking it hands them the token. It is a known
 * enough trick to have a name — host header poisoning — and the fix is exactly
 * this: the server decides where it lives.
 */
export function publicBase() {
  const set = process.env.PANELFLOW_PUBLIC_URL;
  if (set) return set.replace(/\/+$/, '');
  if (isProduction()) throw httpError(503, 'password reset is not configured on this server');
  return `http://localhost:${process.env.PORT ?? 8787}`;
}

/**
 * Mail that was never handed to a provider, newest last. Only ever written when
 * no key is set, which outside a developer's machine is a 503 before this. It
 * is what the tests read instead of an inbox.
 */
export const outbox = [];
const OUTBOX_MAX = 50;

export async function sendMail({ to, subject, text, html }) {
  if (!key()) {
    if (isProduction()) throw httpError(503, 'password reset is not configured on this server');
    outbox.push({ to, subject, text, at: new Date().toISOString() });
    if (outbox.length > OUTBOX_MAX) outbox.shift();
    console.log(`[mail] no provider configured — would send to ${to}:\n${text}`);
    return { delivered: false };
  }
  await deliver({ to, subject, text, html });
  return { delivered: true };
}

async function deliver({ to, subject, text, html }) {
  let resp;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from(), to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // The provider being unreachable is our outage, not the caller's mistake,
    // and the caller can do nothing with the detail — so it is logged in full
    // here and reduced to one sentence on the way out.
    securityLog('mail_transport_failed', { reason: String(err?.message ?? err) });
    throw httpError(502, 'could not send the email, try again in a moment');
  }
  if (!resp.ok) {
    securityLog('mail_rejected', { status: resp.status, body: (await resp.text()).slice(0, 300) });
    throw httpError(502, 'could not send the email, try again in a moment');
  }
}
