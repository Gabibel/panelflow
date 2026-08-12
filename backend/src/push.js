// Web Push: the last metre of the promise "we will tell you when a chapter is out".
//
// The watcher already finds chapters while every client is closed, and leaves
// them in `news`. But news only becomes a notification when something drains it,
// and nothing drains it while the browser is shut — which is exactly the stretch
// this was built for. A push goes the other way: the server hands an encrypted
// payload to the browser vendor's push service, and the service wakes the
// service worker whenever the browser next runs, with no page open.
//
// Written against RFC 8291 (message encryption) and RFC 8292 (VAPID) rather
// than pulled from a library, because the whole of it is three key derivations
// and one signature, and node:crypto has every piece. The test decrypts a real
// push body with a real browser-side key pair, which is the only way to know
// this file is right.
import {
  createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign,
} from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (str) => Buffer.from(String(str), 'base64url');

// Read at call time, not at import: a serverless function and a test process
// both set these late, and a module-level snapshot would freeze in whatever
// state the environment happened to be in when the file was first loaded.
export function vapidKeys() {
  const publicKey = process.env.PANELFLOW_VAPID_PUBLIC_KEY;
  const privateKey = process.env.PANELFLOW_VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    // A push service is allowed to refuse a token with no way to reach the
    // sender, and some do. mailto: is what the spec suggests when there is
    // nothing better; it is not a secret and it is never sent to the client.
    subject: process.env.PANELFLOW_VAPID_SUBJECT || 'mailto:push@panelflow.invalid',
  };
}

/** The EC key VAPID signs with, rebuilt from the two base64url halves. */
function signingKey(keys) {
  const pub = unb64(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('PANELFLOW_VAPID_PUBLIC_KEY is not an uncompressed P-256 point');
  }
  // JWK rather than DER: it is the one format where the raw numbers a VAPID
  // key pair is distributed as go in without hand-assembling ASN.1.
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url(unb64(keys.privateKey)),
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
  });
}

// The token proves the same sender is behind every push to a given origin, so
// the push service can rate-limit and contact whoever is misbehaving. It is
// scoped to the origin of the endpoint and nothing else — one token serves
// every subscription at that origin, which is why it is cached per run.
function vapidHeader(endpoint, keys, cache) {
  const aud = new URL(endpoint).origin;
  if (cache?.has(aud)) return cache.get(aud);

  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  // Twelve hours, well inside the 24 the spec allows: a clock a few minutes
  // off must not turn every push into a 401.
  const body = b64url(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: keys.subject,
  }));
  const input = `${header}.${body}`;
  // ieee-p1363 is r||s, 64 bytes. Node's default is DER, which JWS rejects.
  const sig = sign('sha256', Buffer.from(input), {
    key: signingKey(keys), dsaEncoding: 'ieee-p1363',
  });
  const value = `vapid t=${input}.${b64url(sig)}, k=${keys.publicKey}`;
  cache?.set(aud, value);
  return value;
}

// The record size in the aes128gcm header. One record is all PanelFlow ever
// sends — a push service refuses anything over ~4 kB anyway.
const RECORD_SIZE = 4096;

/**
 * Encrypt one payload for one subscription (RFC 8291, aes128gcm).
 * Exported for the test, which decrypts what this produces.
 * @returns {Buffer} the complete request body, header block included.
 */
export function encryptPush(plaintext, p256dh, authSecret, salt = randomBytes(16)) {
  const uaPublic = unb64(p256dh);
  const auth = unb64(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('bad p256dh');
  if (auth.length !== 16) throw new Error('bad auth secret');

  const as = createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);

  // Two HKDFs, and the order of the two public keys in the first one is the
  // part that has no second chance: get it backwards and the browser silently
  // drops every notification with no error anyone can see.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'), uaPublic, asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 is the "last record" delimiter; padding after it is allowed and
  // unnecessary here. A record with no delimiter decrypts and is then rejected.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RECORD_SIZE, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

/**
 * Hand one notification to one push service.
 * @returns {Promise<{ok:boolean, status:number, gone:boolean}>} `gone` means the
 *   subscription is dead for good and the row should go — not that this attempt
 *   failed. Everything else is worth keeping and retrying another day.
 */
export async function sendPush(sub, payload, keys = vapidKeys(), cache = null) {
  if (!keys) return { ok: false, status: 0, gone: false };
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(sub.endpoint, keys, cache),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        // How long the service holds it for a browser that is not running. A
        // day: a chapter alert that arrives a week late is noise, not news.
        TTL: '86400',
      },
      body: encryptPush(payload, sub.p256dh, sub.auth),
      signal: ctrl.signal,
    });
  } catch {
    // Unreachable service, or our own 10 s deadline. Not the subscription's
    // fault, so it stays.
    return { ok: false, status: 0, gone: false };
  } finally {
    clearTimeout(timer);
  }
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    // 404: the service never heard of it. 410: the browser dropped it — the
    // user cleared site data, or revoked permission. Either way it will never
    // work again, and keeping it means paying for a failing request forever.
    gone: res.status === 404 || res.status === 410,
  };
}
