// No test leaves this machine.
//
// Loaded into every test process (`node --test --import`, see package.json).
// Routes that read other people's sites (meta, search, migrate-plan, the
// watcher) really went out when a test did not stub them: verifying one
// test on the old code sent a search to DuckDuckGo (QA, P5, OPS-30). So every
// TCP connection is checked where it is made, under fetch, undici, http and
// tls alike: the loopback is allowed, anything else is refused, and the
// refusal is printed so the test that tried it can be found.
//
// A name is judged by the address it resolves to, at the moment of connecting
// (the lookup is wrapped), so a test that fakes DNS is held to it too.
import net from 'node:net';
import dns from 'node:dns';

const loopback = (address) => {
  const a = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  return a === '::1' || a === 'localhost' || /^127\./.test(a) || /^::ffff:127\./.test(a);
};

const blocked = (host) => Object.assign(
  new Error(`network blocked in tests: ${host} is not this machine (test-support/no-network.js)`),
  { code: 'ENETUNREACH' },
);

const said = new Set();
function refuse(host) {
  if (!said.has(host)) {
    said.add(host);
    process.stderr.write(`[no-network] refused a connection to ${host}\n`);
  }
  return blocked(host);
}

/** The options object a connect call carries, or null for a local socket path. */
function optionsOf(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // net.connect hands over [options, cb]
  if (first && typeof first === 'object') return first.path ? null : first;
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null; // a pipe or a unix socket
  return { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost', fromArgs: true };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const options = optionsOf(args);
  if (!options) return connect.apply(this, args);
  const host = options.host ?? 'localhost';
  if (net.isIP(String(host).replace(/^\[|\]$/g, ''))) {
    if (!loopback(host)) {
      const err = refuse(host);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return connect.apply(this, args);
  }
  // A name: allowed only if every address it resolves to is this machine.
  const resolve = options.lookup || ((name, opts, cb) => dns.lookup(name, opts, cb));
  const lookup = (name, opts, cb) => resolve(name, opts, (err, address, family) => {
    if (err) return cb(err);
    const all = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (!all.every(loopback)) return cb(refuse(`${name} (${all.join(', ')})`));
    return cb(null, address, family);
  });
  if (options.fromArgs) {
    const cb = args.find((a) => typeof a === 'function');
    return connect.call(this, { port: options.port, host, lookup }, cb);
  }
  options.lookup = lookup;
  return connect.apply(this, args);
};
