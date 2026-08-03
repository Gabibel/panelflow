// Express 4 does not catch a rejected promise returned by a handler: the
// request simply hangs until the client gives up. Every route now awaits the
// database, so each one goes through here and a driver error reaches the error
// middleware — a 500 — instead of a timeout.
export const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
