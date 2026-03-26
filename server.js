#!/usr/bin/env node
// Local-network server — no internet required.
// Run with: node server.js (or: npm run local)
// Then open http://<your-ip>:8787 on any device in the room.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT) || 8787;
const LEAD_PASSWORD = process.env.LEAD_PASSWORD || "session";
const PUBLIC_DIR = path.resolve(__dirname, "public");

// ---------------------------------------------------------------------------
// Timer state (mirrors timer-room.ts InternalState)
// ---------------------------------------------------------------------------

let state = {
  running: false,
  speed: 1.15,
  accumulatedVirtualMs: 0,
  accumulatedRealMs: 0,
  startRealTimestamp: null,
};

function accumulate() {
  if (state.startRealTimestamp === null) return;
  const now = Date.now();
  const realElapsed = now - state.startRealTimestamp;
  state.accumulatedRealMs += realElapsed;
  state.accumulatedVirtualMs += realElapsed * state.speed;
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
};

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split("?")[0]; // strip query string

  // Route /lead → lead.html
  if (urlPath === "/lead" || urlPath === "/lead/") urlPath = "/lead.html";
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

  // Safety: prevent path traversal
  const resolved = path.resolve(PUBLIC_DIR, "." + urlPath);
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
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket server (mirrors timer-room.ts logic)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: "/ws", perMessageDeflate: false });

/** @type {Map<import('ws').WebSocket, { authenticated: boolean }>} */
const clients = new Map();

function broadcast() {
  const msg = JSON.stringify({ type: "state", state: buildTimerState() });
  for (const [ws] of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(msg); } catch { /* ignore closed sockets */ }
    }
  }
}

// 30-second heartbeat (keeps clients in sync even with no activity)
setInterval(broadcast, 30_000);

wss.on("connection", (ws) => {
  clients.set(ws, { authenticated: false });

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

    // Application-level ping (Cloudflare WS hibernation compat)
    if (msg === "ping" || msg.type === "ping") {
      ws.send("pong");
      return;
    }

    if (msg.type === "auth") {
      const success = msg.password === LEAD_PASSWORD;
      clients.set(ws, { authenticated: success });
      ws.send(JSON.stringify({ type: "authResult", success }));
      return;
    }

    if (!clients.get(ws)?.authenticated) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }

    switch (msg.type) {
      case "start":
        if (!state.running) {
          state.running = true;
          state.startRealTimestamp = Date.now();
          broadcast();
        }
        break;

      case "stop":
        if (state.running && state.startRealTimestamp !== null) {
          accumulate();
          state.running = false;
          state.startRealTimestamp = null;
          broadcast();
        }
        break;

      case "reset":
        state.running = false;
        state.accumulatedVirtualMs = 0;
        state.accumulatedRealMs = 0;
        state.startRealTimestamp = null;
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
        state.accumulatedRealMs = virtualMs / state.speed;
        broadcast();
        break;
      }
    }
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => ws.terminate());
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, "0.0.0.0", async () => {
  const { networkInterfaces } = require("os");
  const nets = networkInterfaces();

  // Collect non-loopback IPv4 addresses
  const networkUrls = [];
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
  console.log("  (set a different password via LEAD_PASSWORD env var)");

  // Print a QR code for the first network address so phones can scan it
  const viewerUrl = networkUrls[0];
  if (viewerUrl) {
    console.log(`\n  Scan to open on phone (${viewerUrl}):\n`);
    const qr = await QRCode.toString(viewerUrl, { type: "terminal", small: true });
    console.log(qr);
  }
});
