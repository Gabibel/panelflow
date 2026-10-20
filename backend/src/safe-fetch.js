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
// And since QA P5 the address is checked where the connection is made, not
// only before: a name may answer differently between a lookup made here and
// the one the connection makes on its own (DNS rebinding), so `safeFetch`
// hands undici a `lookup` that refuses a private address at the moment of
// connecting. `publicUrl` stays the routes' early refusal; the check that
// decides is the one on the socket.
import { lookup } from 'node:dns/promises';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

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

  // The other spellings that carry an IPv4 address inside (QA, P5): the old
  // IPv4-compatible form (::127.0.0.1, ::7f00:1), the NAT64 prefix
  // (64:ff9b::/96), which a NAT64 gateway turns back into the IPv4 address,
  // and 6to4 (2002:WWXX:YYZZ::), which embeds it in the second and third
  // groups. Each is judged by the IPv4 address it stands for.
  const groups = expandV6(s);
  if (groups) {
    const v4 = (hi, lo) => privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    if (groups.slice(0, 6).every((g) => g === 0) && (groups[6] || groups[7] > 1)) return v4(groups[6], groups[7]);
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
      return v4(groups[6], groups[7]);
    }
    if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  }

  const head = parseInt(s.split(':')[0], 16);
  if (!Number.isFinite(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7  unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8  multicast
  return false;
}

/**
 * The eight 16-bit groups of an IPv6 address, `::` expanded and a trailing
 * dotted IPv4 part turned into its two groups; null for anything else.
 */
function expandV6(s) {
  let text = s;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const parts = dotted[2].split('.').map(Number);
    if (parts.some((n) => n > 255)) return null;
    text = `${dotted[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const read = (part) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
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

/**
 * The URL and every address its name resolves to, once each of them is known
 * to be public: for a caller that opens its own connection, and can be told
 * which address to use (curl's `--resolve`). The connection then goes where the
 * check looked, not wherever the name points a moment later (QA, P5: the
 * rebinding window `publicUrl` documents). A name that does not resolve is
 * refused here rather than waved through: with nothing to pin, the caller
 * would resolve it on its own, which is the window this closes.
 *
 * @param {string|URL} raw
 * @param {{lookupAll?: (host: string) => Promise<{address: string}[]>}} [opts]
 * @returns {Promise<{url: URL, addresses: string[]}>} no addresses for a literal
 */
export async function publicTarget(raw, { lookupAll = (host) => lookup(host, { all: true }) } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw httpError(400, 'invalid url'); }
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'url not allowed');
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw httpError(400, 'url not allowed');
    return { url: u, addresses: [] };
  }
  let addrs;
  try { addrs = await lookupAll(host); } catch { throw httpError(502, 'site unreachable'); }
  if (!addrs?.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw httpError(400, 'url not allowed');
  }
  return { url: u, addresses: addrs.map((a) => a.address) };
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

const PRIVATE_AT_CONNECT = 'PANELFLOW_PRIVATE_ADDRESS';

/**
 * The lookup the connection itself uses: every address the name resolves to,
 * judged right there, and the connection refused if one is not public. Read
 * through `dns.lookup` at call time, so a test's fake DNS is the one asked.
 */
function checkedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses?.length || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to an address that is not public`),
        { code: PRIVATE_AT_CONNECT }));
    }
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const pinned = new Agent({ connect: { lookup: checkedLookup } });

/**
 * The URL, parsed, if it is http(s) and not a literal private address. No
 * lookup: a name is judged on the socket (checkedLookup), and a literal never
 * reaches a lookup at all, so this is where a literal is judged.
 */
function checkedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw httpError(400, 'invalid url'); }
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'url not allowed');
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(host) && isPrivateAddress(host)) throw httpError(400, 'url not allowed');
  return u;
}

// The fetch this module was loaded with. A test that swaps `globalThis.fetch`
// for a stand-in is answered by it, as before; otherwise the request goes
// through undici with the checked lookup.
const BUILTIN_FETCH = globalThis.fetch;

async function send(url, init) {
  if (globalThis.fetch !== BUILTIN_FETCH) return globalThis.fetch(url, init);
  try {
    return await undiciFetch(url, { ...init, dispatcher: pinned });
  } catch (e) {
    if (e?.cause?.code === PRIVATE_AT_CONNECT || e?.code === PRIVATE_AT_CONNECT) {
      throw httpError(400, 'url not allowed');
    }
    throw e;
  }
}

/**
 * `fetch`, with every hop of the redirect chain validated instead of only the
 * URL the caller passed in, and every connection checked on the address it is
 * actually made to.
 *
 * Every caller here is a GET, so the method is carried across unchanged rather
 * than implementing the 303-turns-POST-into-GET rewrite that would never run.
 *
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {{maxRedirects?: number}} [opts]
 */
export async function safeFetch(url, init = {}, { maxRedirects = 5 } = {}) {
  let current = checkedUrl(url);
  for (let hop = 0; ; hop++) {
    const resp = await send(current, { ...init, redirect: 'manual' });
    if (!REDIRECT.has(resp.status)) return resp;
    const location = resp.headers.get('location');
    // A redirect that names nowhere is the answer, such as it is.
    if (!location) return resp;
    if (hop >= maxRedirects) throw httpError(502, 'too many redirects');
    let next;
    try { next = new URL(location, current).href; } catch { throw httpError(502, 'bad redirect'); }
    current = checkedUrl(next);
  }
}
