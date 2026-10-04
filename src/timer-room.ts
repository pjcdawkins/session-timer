import { DurableObject } from "cloudflare:workers";
import type { Env, ClientMessage, ClientInfo, ClientRole, TimerState } from "./types";

interface InternalState {
  running: boolean;
  speed: number;
  accumulatedVirtualMs: number;
  startRealTimestamp: number | null;
  highlight: { interval: number; offset: number } | null;
}

interface Attachment {
  authenticated: boolean;
  ip: string;
  id: string;
  name: string;
  role: ClientRole;
  rtt: number | null;
  lastSeen: number;
}

// Default start time is -3s so there's a count-in
const DEFAULT_START_MS = -3000;

const DEFAULT_STATE: InternalState = {
  running: false,
  speed: 1.0,
  accumulatedVirtualMs: DEFAULT_START_MS,
  startRealTimestamp: null,
  highlight: { interval: 10, offset: 0 },
};

// Auth throttle: each IP gets one password check per AUTH_INTERVAL_MS. Extra
// attempts are queued (held, then checked); if the queue wait would exceed
// AUTH_MAX_WAIT_MS the attempt is rejected immediately.
const AUTH_INTERVAL_MS = 2_000;
const AUTH_MAX_WAIT_MS = 5_000;

// Reconnect token: issued after a successful password check and accepted
// without throttling (it's 256 bits, so not guessable). Derived from the
// password, so it needs no storage and changing LEAD_PASSWORD revokes it.
// This stops a client sharing the lead's IP from starving reconnects.
const TOKEN_CONTEXT = "session-timer lead reconnect v1";

async function deriveLeadToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(TOKEN_CONTEXT));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class TimerRoom extends DurableObject<Env> {
  private state: InternalState = { ...DEFAULT_STATE };
  // In-memory only: lost on hibernation, which only happens after the DO
  // has been idle, by which point any reserved slots have expired anyway.
  private authNextSlot = new Map<string, number>();
  private leadToken: Promise<string> | null = null;

  private getLeadToken(): Promise<string> {
    this.leadToken ??= deriveLeadToken(this.env.LEAD_PASSWORD);
    return this.leadToken;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<InternalState>("timerState");
      if (stored) {
        this.state = stored;
        this.state.highlight = this.state.highlight ?? null;
      }
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong")
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = {
      authenticated: false,
      ip: request.headers.get("CF-Connecting-IP") ?? "unknown",
      id: "",
      name: "",
      role: "viewer",
      rtt: null,
      lastSeen: Date.now(),
    };
    server.serializeAttachment(attachment);

    server.send(JSON.stringify({
      type: "state",
      state: this.buildTimerState(),
    }));

    this.ensureHeartbeat();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const attachment = ws.deserializeAttachment() as Attachment;
    attachment.lastSeen = Date.now();

    if (msg.type === "hello") {
      attachment.id = String(msg.id).slice(0, 32);
      attachment.name = String(msg.name).slice(0, 40);
      attachment.role = msg.role === "lead" ? "lead" : "viewer";
      ws.serializeAttachment(attachment);
      return;
    }

    if (msg.type === "ping") {
      attachment.rtt = typeof msg.rtt === "number" ? msg.rtt : null;
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify({ type: "pong", t: msg.t, serverNow: Date.now() }));
      if (attachment.authenticated) {
        ws.send(JSON.stringify({ type: "clients", clients: this.listClients(), serverNow: Date.now() }));
      }
      return;
    }

    if (msg.type === "auth" && typeof msg.token === "string") {
      const token = await this.getLeadToken();
      const success = constantTimeEqual(msg.token, token);
      try {
        const current = ws.deserializeAttachment() as Attachment;
        current.authenticated = success;
        ws.serializeAttachment(current);
        ws.send(JSON.stringify({ type: "authResult", success, ...(success && { token }) }));
      } catch {
        // Socket closed
      }
      return;
    }

    if (msg.type === "auth") {
      const wait = this.reserveAuthSlot(attachment.ip);
      if (wait === null) {
        ws.send(JSON.stringify({ type: "authResult", success: false, reason: "rateLimited" }));
        return;
      }
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        // Re-read: hello/ping may have updated the attachment while we waited
        const current = ws.deserializeAttachment() as Attachment;
        current.authenticated = msg.password === this.env.LEAD_PASSWORD;
        ws.serializeAttachment(current);
        const token = current.authenticated ? await this.getLeadToken() : undefined;
        ws.send(JSON.stringify({ type: "authResult", success: current.authenticated, token }));
      } catch {
        // Socket closed while waiting
      }
      return;
    }

    // All other commands require authentication
    if (!attachment.authenticated) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }

    switch (msg.type) {
      case "start":
        if (!this.state.running) {
          this.state.running = true;
          this.state.startRealTimestamp = Date.now();
          await this.persist();
          this.broadcast();
        }
        break;

      case "stop":
        if (this.state.running && this.state.startRealTimestamp !== null) {
          this.accumulate();
          this.state.running = false;
          this.state.startRealTimestamp = null;
          await this.persist();
          this.broadcast();
        }
        break;

      case "reset":
        this.state.running = false;
        this.state.accumulatedVirtualMs = DEFAULT_START_MS;
        this.state.startRealTimestamp = null;
        await this.persist();
        this.broadcast();
        break;

      case "setSpeed": {
        const speed = msg.speed;
        if (typeof speed !== "number" || speed < 0.1 || speed > 10.0) {
          ws.send(JSON.stringify({ type: "error", message: "Speed must be between 0.1 and 10.0" }));
          return;
        }
        // If running, accumulate at old speed before changing
        if (this.state.running && this.state.startRealTimestamp !== null) {
          this.accumulate();
          this.state.startRealTimestamp = Date.now();
        }
        this.state.speed = speed;
        await this.persist();
        this.broadcast();
        break;
      }

      case "setTime": {
        if (this.state.running) {
          ws.send(JSON.stringify({ type: "error", message: "Stop the timer before setting time" }));
          return;
        }
        const virtualMs = msg.virtualMs;
        if (typeof virtualMs !== "number" || !Number.isFinite(virtualMs)) {
          ws.send(JSON.stringify({ type: "error", message: "Time must be a finite number" }));
          return;
        }
        this.state.accumulatedVirtualMs = virtualMs;
        await this.persist();
        this.broadcast();
        break;
      }

      case "setHighlight": {
        const hl = msg.highlight;
        if (hl !== null) {
          if (typeof hl.interval !== "number" || hl.interval < 1 || hl.interval > 60) {
            ws.send(JSON.stringify({ type: "error", message: "Interval must be between 1 and 60" }));
            return;
          }
          if (typeof hl.offset !== "number" || hl.offset < 0 || hl.offset > 59) {
            ws.send(JSON.stringify({ type: "error", message: "Offset must be between 0 and 59" }));
            return;
          }
        }
        this.state.highlight = hl;
        await this.persist();
        this.broadcast();
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close();
  }

  async alarm(): Promise<void> {
    this.broadcast();
    this.ensureHeartbeat();
  }

  /** Returns ms to wait before checking, or null if the wait would be too long. */
  private reserveAuthSlot(ip: string): number | null {
    const now = Date.now();
    // Entries are re-inserted on every reservation, so the map is roughly
    // ordered by expiry: drop expired entries from the front and stop at the
    // first live one (O(1) amortized). Any expired entry left behind is
    // harmless, and is removed once the entries ahead of it expire.
    for (const [key, slot] of this.authNextSlot) {
      if (slot > now) break;
      this.authNextSlot.delete(key);
    }
    const slot = Math.max(now, this.authNextSlot.get(ip) ?? 0);
    const wait = slot - now;
    if (wait > AUTH_MAX_WAIT_MS) return null;
    this.authNextSlot.delete(ip);
    this.authNextSlot.set(ip, slot + AUTH_INTERVAL_MS);
    return wait;
  }

  private accumulate(): void {
    if (this.state.startRealTimestamp === null) return;
    const now = Date.now();
    const realElapsed = now - this.state.startRealTimestamp;
    this.state.accumulatedVirtualMs += realElapsed * this.state.speed;
  }

  private buildTimerState(): TimerState {
    return {
      running: this.state.running,
      speed: this.state.speed,
      accumulatedVirtualMs: this.state.accumulatedVirtualMs,
      startRealTimestamp: this.state.startRealTimestamp,
      serverNow: Date.now(),
      highlight: this.state.highlight,
    };
  }

  private listClients(): ClientInfo[] {
    const now = Date.now();
    const clients: ClientInfo[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.id) continue;
      clients.push({ id: a.id, name: a.name, role: a.role, rtt: a.rtt, lastSeenAgoMs: now - a.lastSeen });
    }
    return clients;
  }

  private broadcast(): void {
    const message = JSON.stringify({
      type: "state",
      state: this.buildTimerState(),
    });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Socket already closed
      }
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("timerState", this.state);
  }

  private ensureHeartbeat(): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }
}
