// Where the server is allowed to send a request.
//
// This API fetches URLs the client hands it — a series page to scrape, a cover
// to proxy — so "which hosts will it talk to" is the whole security story of
// those routes. The guard used to be a regex over the hostname *string*, and
// two things walked straight past it:
//
//   A public name whose A record is private. `localtest.me` resolves to the
//   loopback and is spelled like any other domain; anyone can publish another.
//   No redirect needed — the name simply is not what the regex was reading.
//
//   A public host that answers 302. `redirect: 'follow'` re-issues the request
//   at the new address without asking anyone, so the second hop was never
//   checked at all.
//
// Both were reachable on /api/meta/scrape, which hands the fetched page back to
// the caller — so the answer came back too. So the check moved off the name and
// onto the address, and it runs again on every hop.
//
// What it still does not close: DNS may answer differently between this lookup
// and the connection undici actually makes (rebinding). Pinning the checked
// address into the socket needs a custom dispatcher; the window is small and
// every hop is re-checked, so it is documented rather than papered over.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Ranges that are not on the public internet, so nothing here should ever be
 * reachable through a URL a user typed. Loopback and link-local are the ones
 * that matter — 169.254.169.254 is the cloud metadata endpoint — but the
 * private and carrier ranges are just as much "inside" from where this runs.
 */
function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;              // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true; // 192.0.0/24, 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;    // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                            // multicast, reserved, broadcast
  return false;
}

function privateV6(raw) {
  const s = raw.toLowerCase().split('%')[0]; // drop any zone id
  if (s === '::' || s === '::1') return true;

  // An IPv4 address wearing an IPv6 hat. Both spellings have to be understood:
  // ::ffff:127.0.0.1 and ::ffff:7f00:1 are the same 32 bits and only one of
  // them looks private to a reader.
  const mapped = s.match(/^::ffff:(.+)$/);
  if (mapped) {
    const v = mapped[1];
    if (v.includes('.')) return privateV4(v);
    const [hi, lo] = v.split(':').map((g) => parseInt(g, 16));
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
  }

  const head = parseInt(s.split(':')[0], 16);
  if (!Number.isFinite(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7  unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8  multicast
  return false;
}

/** True for an address this server must not open a connection to. */
export const isPrivateAddress = (ip) =>
  isIP(ip) === 6 ? privateV6(ip) : isIP(ip) === 4 ? privateV4(ip) : true;

/**
 * The URL, parsed, once it is established that it points somewhere public.
 * Throws a 400 otherwise — the same refusal the old regex gave, so callers and
 * their tests read the same.
 *
 * @param {string|URL} raw
 * @returns {Promise<URL>}
 */
export async function publicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw httpError(400, 'invalid url'); }
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'url not allowed');

  // Strip the brackets an IPv6 literal wears inside a URL.
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');

  // A literal address is checked as written and never looked up: dns.lookup
  // resolves an IP to itself, so sending it through the resolver would only add
  // a way for the answer to differ from what was asked about.
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw httpError(400, 'url not allowed');
    return u;
  }

  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    // A name nobody can resolve is not a way in: with no address there is no
    // connection to make, and the fetch below fails on its own lookup a moment
    // later. Refusing here instead would only mean this guard decides which
    // *unreachable* sites are unreachable — and would make every test that
    // stubs the network need a real DNS server to say so.
    return u;
  }
  // `some`, not `every`: a name that answers with one public and one private
  // address is not half-safe, it is a rebinding attempt with a fallback.
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw httpError(400, 'url not allowed');
  }
  return u;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch`, with every hop of the redirect chain validated instead of only the
 * URL the caller passed in.
 *
 * Every caller here is a GET, so the method is carried across unchanged rather
 * than implementing the 303-turns-POST-into-GET rewrite that would never run.
 *
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {{maxRedirects?: number}} [opts]
 */
export async function safeFetch(url, init = {}, { maxRedirects = 5 } = {}) {
  let current = await publicUrl(url);
  for (let hop = 0; ; hop++) {
    const resp = await fetch(current, { ...init, redirect: 'manual' });
    if (!REDIRECT.has(resp.status)) return resp;
    const location = resp.headers.get('location');
    // A redirect that names nowhere is the answer, such as it is.
    if (!location) return resp;
    if (hop >= maxRedirects) throw httpError(502, 'too many redirects');
    let next;
    try { next = new URL(location, current).href; } catch { throw httpError(502, 'bad redirect'); }
    current = await publicUrl(next);
  }
}
