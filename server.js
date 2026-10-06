#!/usr/bin/env node
// Local-network server — no internet required.
// Run with: node server.js (or: npm run local)
// Then open http://<your-ip>:8787 on any device in the room.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 8787;
const LEAD_PASSWORD = process.env.LEAD_PASSWORD || "session";
const PUBLIC_DIR = path.resolve(__dirname, "public");
const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, ".timer-state.json");
const TOKEN_SECRET_FILE = path.join(path.dirname(STATE_FILE), ".timer-lead-secret.json");
const LEGACY_TOKEN_FILE = path.join(path.dirname(STATE_FILE), ".timer-lead-token.json");
// How long a lead login lasts without being used. Overridable for tests.
const LEAD_TOKEN_TTL_MS = Number(process.env.LEAD_TOKEN_TTL_MS) || 24 * 60 * 60 * 1000;
// Sockets silent for longer than this are dropped (clients ping every 2s)
const CLIENT_TIMEOUT_MS = 15_000;

// Populated at startup — exposed via /api/info for the QR modal
const networkUrls = [];

// ---------------------------------------------------------------------------
// Timer state (mirrors timer-room.ts InternalState)
// ---------------------------------------------------------------------------

// Default start time is -5s so there's a count-in
const DEFAULT_START_MS = -5000;

let state = {
  running: false,
  speed: 1.0,
  accumulatedVirtualMs: DEFAULT_START_MS,
  startRealTimestamp: null,
  highlight: { interval: 10, offset: 0 },
  locked: false,
  // Where Start was pressed, so a count-in can be cancelled back to it
  startedFromMs: null,
  // Whether a QLab bridge talks to QLab
  qlab: true,
};

// Cancel is refused this close to zero (in real time), so that the QLab
// bridge hears about an accepted cancel before it would fire the cue
const CANCEL_CUTOFF_MS = 500;

// Commands refused while the show lock is on (it applies to every lead screen)
const LOCKED_COMMANDS = new Set(["stop", "reset", "setSpeed", "setTime", "setHighlight", "setQlab"]);

// Persist state to disk so a crash/restart mid-performance resumes where it was.
// startRealTimestamp is wall-clock time, so a running timer keeps its place.
function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state = { ...state, ...saved };
    console.log(`Restored timer state from ${STATE_FILE}${state.running ? " (running)" : ""}`);
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`Could not read ${STATE_FILE}:`, err.message);
  }
}

function saveState() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error(`Could not write ${STATE_FILE}:`, err.message);
  }
}

loadState();

function accumulate() {
  if (state.startRealTimestamp === null) return;
  const now = Date.now();
  const realElapsed = now - state.startRealTimestamp;
  state.accumulatedVirtualMs += realElapsed * state.speed;
}

function currentVirtualMs() {
  if (state.startRealTimestamp === null) return state.accumulatedVirtualMs;
  return state.accumulatedVirtualMs + (Date.now() - state.startRealTimestamp) * state.speed;
}

function buildTimerState() {
  return { ...state, serverNow: Date.now() };
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split("?")[0]; // strip query string

  // API: expose the LAN viewer URL for the QR code modal
  if (urlPath === "/api/info") {
    const viewerUrl = networkUrls[0];
    res.writeHead(viewerUrl ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(viewerUrl ? { viewerUrl } : { error: "No network address" }));
    return;
  }

  // Route /lead → lead.html
  if (urlPath === "/lead" || urlPath === "/lead/") urlPath = "/lead.html";
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

  // Safety: prevent path traversal
  const resolved = path.resolve(PUBLIC_DIR, `.${urlPath}`);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket server (mirrors timer-room.ts logic)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: "/ws", perMessageDeflate: false });
// Server-level errors (e.g. port in use) are re-emitted here; the httpServer handler below deals with them
wss.on("error", () => {});

/** @type {Map<import('ws').WebSocket, { authenticated: boolean, logouts: number, ip: string, id: string, name: string, role: string, rtt: number | null, lastSeen: number }>} */
const clients = new Map();

function listClients() {
  const now = Date.now();
  const list = [];
  for (const c of clients.values()) {
    if (!c.id) continue;
    list.push({ id: c.id, name: c.name, role: c.role, authenticated: c.authenticated, rtt: c.rtt, lastSeenAgoMs: now - c.lastSeen });
  }
  return list;
}

// Auth throttle (mirrors timer-room.ts): one password check per IP per
// AUTH_INTERVAL_MS; extra attempts are held, or rejected if the wait would
// exceed AUTH_MAX_WAIT_MS.
const AUTH_INTERVAL_MS = 2_000;
const AUTH_MAX_WAIT_MS = 5_000;
/** @type {Map<string, number>} */
const authNextSlot = new Map();

// Reconnect token (mirrors timer-room.ts): issued after a successful password
// check and accepted without throttling, so a client sharing the lead's IP
// can't starve reconnects. It is "<expiresAt>.<HMAC of expiresAt>", signed
// with a 256-bit random secret (never derived from the password, or password
// guesses could be submitted as tokens to dodge the throttle). Every
// successful auth issues a fresh token, so a login lasts LEAD_TOKEN_TTL_MS
// after it was last used; the lead page re-auths hourly while open.
// The secret is persisted next to the state file so tokens survive restarts,
// alongside an HMAC of the password keyed by the secret: if LEAD_PASSWORD
// changes, a new secret is made and every token is revoked.
const LEAD_TOKEN_SECRET = loadOrCreateTokenSecret();

function loadOrCreateTokenSecret() {
  const check = (secret) => crypto.createHmac("sha256", secret).update(LEAD_PASSWORD).digest("hex");
  // Tokens from before expiry was added are no longer accepted
  try { fs.rmSync(LEGACY_TOKEN_FILE, { force: true }); } catch { /* ignore */ }
  try {
    const stored = JSON.parse(fs.readFileSync(TOKEN_SECRET_FILE, "utf8"));
    if (typeof stored.secret === "string" && stored.passwordCheck === check(stored.secret)) return stored.secret;
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`Could not read ${TOKEN_SECRET_FILE}:`, err.message);
  }
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(TOKEN_SECRET_FILE, JSON.stringify({ secret, passwordCheck: check(secret) }), { mode: 0o600 });
  } catch (err) {
    console.error(`Could not write ${TOKEN_SECRET_FILE}:`, err.message);
  }
  return secret;
}

function signExpiry(expires) {
  return crypto.createHmac("sha256", LEAD_TOKEN_SECRET).update(expires).digest("hex");
}

function issueLeadToken() {
  const expires = String(Date.now() + LEAD_TOKEN_TTL_MS);
  return `${expires}.${signExpiry(expires)}`;
}

function isLeadToken(token) {
  // The pattern also rules out non-ASCII strings, which could have the right
  // length in characters but not in bytes (timingSafeEqual throws on that)
  const match = typeof token === "string" && /^(\d{1,15})\.([0-9a-f]{64})$/.exec(token);
  if (!match || Number(match[1]) <= Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(match[2]), Buffer.from(signExpiry(match[1])));
}

/** Returns ms to wait before checking, or null if the wait would be too long. */
function reserveAuthSlot(ip) {
  const now = Date.now();
  // Entries are re-inserted on every reservation, so the map is roughly
  // ordered by expiry: drop expired entries from the front and stop at the
  // first live one (O(1) amortized). Any expired entry left behind is
  // harmless, and is removed once the entries ahead of it expire.
  for (const [key, slot] of authNextSlot) {
    if (slot > now) break;
    authNextSlot.delete(key);
  }
  const slot = Math.max(now, authNextSlot.get(ip) ?? 0);
  const wait = slot - now;
  if (wait > AUTH_MAX_WAIT_MS) return null;
  authNextSlot.delete(ip);
  authNextSlot.set(ip, slot + AUTH_INTERVAL_MS);
  return wait;
}

function broadcast() {
  saveState();
  const msg = JSON.stringify({ type: "state", state: buildTimerState() });
  for (const [ws] of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(msg); } catch { /* ignore closed sockets */ }
    }
  }
}

// 30-second heartbeat (keeps clients in sync even with no activity)
setInterval(broadcast, 30_000);

// Drop sockets that have gone silent (e.g. a phone that walked out of Wi-Fi range)
setInterval(() => {
  const now = Date.now();
  for (const [ws, c] of clients) {
    if (now - c.lastSeen > CLIENT_TIMEOUT_MS) {
      clients.delete(ws);
      ws.terminate();
    }
  }
}, 5_000);

wss.on("connection", (ws, req) => {
  // logouts is bumped by logout, so a throttled password check still queued
  // can't sign the socket back in when it runs
  const client = { authenticated: false, logouts: 0, ip: req.socket.remoteAddress ?? "unknown", id: "", name: "", role: "viewer", rtt: null, lastSeen: Date.now() };
  clients.set(ws, client);

  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: "state", state: buildTimerState() }));

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    client.lastSeen = Date.now();

    if (msg?.type === "hello") {
      client.id = String(msg.id).slice(0, 32);
      client.name = String(msg.name).slice(0, 40);
      client.role = msg.role === "lead" || msg.role === "qlab" ? msg.role : "viewer";
      return;
    }

    if (msg?.type === "ping") {
      client.rtt = typeof msg.rtt === "number" ? msg.rtt : null;
      ws.send(JSON.stringify({ type: "pong", t: msg.t, serverNow: Date.now() }));
      if (client.authenticated) {
        ws.send(JSON.stringify({ type: "clients", clients: listClients(), serverNow: Date.now() }));
      }
      return;
    }

    if (msg?.type === "auth" && typeof msg.token === "string") {
      client.authenticated = isLeadToken(msg.token);
      ws.send(JSON.stringify({
        type: "authResult",
        success: client.authenticated,
        ...(client.authenticated && { token: issueLeadToken() }),
      }));
      return;
    }

    // Sign out this socket. The token itself stays valid until it expires
    // (the client forgets it); changing LEAD_PASSWORD revokes every token.
    if (msg?.type === "logout") {
      client.authenticated = false;
      client.logouts++;
      return;
    }

    if (msg?.type === "auth") {
      const wait = reserveAuthSlot(client.ip);
      if (wait === null) {
        ws.send(JSON.stringify({ type: "authResult", success: false, reason: "rateLimited" }));
        return;
      }
      const logouts = client.logouts;
      setTimeout(() => {
        if (ws.readyState !== ws.OPEN || client.logouts !== logouts) return;
        client.authenticated = msg.password === LEAD_PASSWORD;
        ws.send(JSON.stringify({
          type: "authResult",
          success: client.authenticated,
          ...(client.authenticated && { token: issueLeadToken() }),
        }));
      }, wait);
      return;
    }

    if (!client.authenticated) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }

    if (state.locked && LOCKED_COMMANDS.has(msg.type)) {
      ws.send(JSON.stringify({ type: "error", message: "Show lock is on" }));
      return;
    }

    switch (msg.type) {
      case "start":
        if (!state.running) {
          state.running = true;
          state.startRealTimestamp = Date.now();
          state.startedFromMs = state.accumulatedVirtualMs;
          broadcast();
        }
        break;

      // Undo Start during the count-in (allowed under Show lock): back to
      // where Start was pressed. Refused from CANCEL_CUTOFF_MS before zero.
      case "cancel":
        if (state.running && state.startedFromMs !== null) {
          if (-currentVirtualMs() / state.speed < CANCEL_CUTOFF_MS) {
            ws.send(JSON.stringify({ type: "error", message: "Too close to zero to cancel" }));
            return;
          }
          state.running = false;
          state.accumulatedVirtualMs = state.startedFromMs;
          state.startRealTimestamp = null;
          state.startedFromMs = null;
          broadcast();
        }
        break;

      case "stop":
        if (state.running && state.startRealTimestamp !== null) {
          accumulate();
          state.running = false;
          state.startRealTimestamp = null;
          state.startedFromMs = null;
          broadcast();
        }
        break;

      case "reset":
        state.running = false;
        state.accumulatedVirtualMs = DEFAULT_START_MS;
        state.startRealTimestamp = null;
        state.startedFromMs = null;
        broadcast();
        break;

      case "setSpeed": {
        const speed = msg.speed;
        if (typeof speed !== "number" || speed < 0.1 || speed > 10.0) {
          ws.send(JSON.stringify({ type: "error", message: "Speed must be between 0.1 and 10.0" }));
          return;
        }
        if (state.running && state.startRealTimestamp !== null) {
          accumulate();
          state.startRealTimestamp = Date.now();
        }
        state.speed = speed;
        broadcast();
        break;
      }

      case "setTime": {
        if (state.running) {
          ws.send(JSON.stringify({ type: "error", message: "Stop the timer before setting time" }));
          return;
        }
        const virtualMs = msg.virtualMs;
        if (typeof virtualMs !== "number" || !Number.isFinite(virtualMs)) {
          ws.send(JSON.stringify({ type: "error", message: "Time must be a finite number" }));
          return;
        }
        state.accumulatedVirtualMs = virtualMs;
        broadcast();
        break;
      }

      case "setHighlight": {
        const hl = msg.highlight;
        if (hl != null) {
          if (typeof hl.interval !== "number" || hl.interval < 1 || hl.interval > 60) {
            ws.send(JSON.stringify({ type: "error", message: "Interval must be between 1 and 60" }));
            return;
          }
          if (typeof hl.offset !== "number" || hl.offset < 0 || hl.offset > 59) {
            ws.send(JSON.stringify({ type: "error", message: "Offset must be between 0 and 59" }));
            return;
          }
        }
        state.highlight = hl ?? null;
        broadcast();
        break;
      }

      case "setLock":
        state.locked = msg.locked === true;
        broadcast();
        break;

      // Connect or disconnect the QLab bridge from QLab
      case "setQlab":
        state.qlab = msg.enabled === true;
        broadcast();
        break;
    }
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => ws.terminate());
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Exit on fatal errors so the `npm run show` loop restarts from the persisted state
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use — is another timer server running?`);
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  const { networkInterfaces } = require("node:os");
  const nets = networkInterfaces();

  // Collect non-loopback IPv4 addresses
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        networkUrls.push(`http://${iface.address}:${PORT}`);
      }
    }
  }

  console.log("\nSession Timer (local network mode)");
  console.log("===================================");
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Local:    http://localhost:${PORT}/lead  (lead controls)`);
  for (const url of networkUrls) {
    console.log(`  Network:  ${url}  ← viewer`);
    console.log(`  Network:  ${url}/lead  ← lead controls`);
  }
  console.log(`\n  Lead password: ${LEAD_PASSWORD}`);
  console.log("  (set a different password via LEAD_PASSWORD env var)\n");
});
