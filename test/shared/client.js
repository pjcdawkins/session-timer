// Small test wrapper around a WebSocket (browser-style API: works with Node's
// global WebSocket and with workerd's WebSocket).

// Generous: only reached when something is wrong, and CI machines can be slow
const DEFAULT_TIMEOUT = 5000;

/**
 * Wrap an open-or-opening WebSocket so tests can await specific messages.
 * Messages are buffered, so nothing is lost between awaits.
 */
export function wrapSocket(ws) {
  const buffer = [];
  const waiters = [];

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      buffer.push(msg);
    }
  });

  const toMatcher = (m) => (typeof m === "function" ? m : (msg) => msg.type === m);

  return {
    send(msg) {
      ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    },

    /** Resolve with the first (buffered or future) message matching `type` or predicate. */
    next(typeOrPredicate, timeout = DEFAULT_TIMEOUT) {
      const match = toMatcher(typeOrPredicate);
      const i = buffer.findIndex(match);
      if (i >= 0) return Promise.resolve(buffer.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`Timed out waiting for message: ${typeOrPredicate}`));
        }, timeout);
        waiters.push(w);
      });
    },

    /** Messages received but not yet consumed by next(). */
    pending(type) {
      return type ? buffer.filter((m) => m.type === type) : [...buffer];
    },

    /** Round-trip a ping so that every message the server sent before it has arrived. */
    async flush() {
      const t = Math.random();
      this.send({ type: "ping", t, rtt: null });
      await this.next((m) => m.type === "pong" && m.t === t);
    },

    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
