// Print a fresh VAPID key pair.
//
//   node scripts/vapid-keys.mjs
//
// Run it yourself and paste the two lines into your environment (Vercel project
// settings, or backend/.env locally). Nothing is written to disk and nothing is
// sent anywhere: the private key must never end up in the repo, in a chat, or
// anywhere but the server that sends the pushes.
//
// The pair identifies this deployment to every push service. Generating a new
// one invalidates every subscription your users have ever registered — they are
// tied to the public key that was current when they subscribed — so generate it
// once and keep it.
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });

const b64 = (s) => Buffer.from(s, 'base64url').toString('base64url');
// The public key travels as the raw uncompressed point, 0x04 || x || y: that is
// what the browser's `applicationServerKey` expects, and what the `k=` half of
// the Authorization header carries.
const point = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]);

process.stdout.write(`PANELFLOW_VAPID_PUBLIC_KEY=${point.toString('base64url')}
PANELFLOW_VAPID_PRIVATE_KEY=${b64(priv.d)}
PANELFLOW_VAPID_SUBJECT=mailto:you@example.com
`);
