import { DurableObject } from "cloudflare:workers";
import type { Env, ClientMessage, ClientInfo, ClientRole, TimerState } from "./types";

interface InternalState {
  running: boolean;
  speed: number;
  accumulatedVirtualMs: number;
  startRealTimestamp: number | null;
  highlight: { interval: number; offset: number } | null;
  locked: boolean;
  // Where Start was pressed, so a count-in can be cancelled back to it
  startedFromMs: number | null;
}

interface Attachment {
  authenticated: boolean;
  // Bumped by logout, so an auth check that was in flight (throttled, or
  // awaiting crypto) can't sign the socket back in when it finishes
  logouts: number;
  ip: string;
  id: string;
  name: string;
  role: ClientRole;
  rtt: number | null;
  lastSeen: number;
}

// Default start time is -5s so there's a count-in
const DEFAULT_START_MS = -5000;

const DEFAULT_STATE: InternalState = {
  running: false,
  speed: 1.0,
  accumulatedVirtualMs: DEFAULT_START_MS,
  startRealTimestamp: null,
  highlight: { interval: 10, offset: 0 },
  locked: false,
  startedFromMs: null,
};

// Auth throttle: each IP gets one password check per AUTH_INTERVAL_MS. Extra
// attempts are queued (held, then checked); if the queue wait would exceed
// AUTH_MAX_WAIT_MS the attempt is rejected immediately.
const AUTH_INTERVAL_MS = 2_000;
const AUTH_MAX_WAIT_MS = 5_000;

// Reconnect token: issued after a successful password check and accepted
// without throttling, so a client sharing the lead's IP can't starve
// reconnects. It is "<expiresAt>.<HMAC of expiresAt>", signed with a 256-bit
// random secret (never derived from the password, or password guesses could
// be submitted as tokens to dodge the throttle). Every successful auth issues
// a fresh token, so a login lasts LEAD_TOKEN_TTL_MS after it was last used;
// the lead page re-auths hourly while open. The secret is persisted in DO
// storage alongside an HMAC of the password keyed by the secret. If
// LEAD_PASSWORD changes the HMAC no longer matches, so a new secret is made
// and every token is revoked.
const LEAD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const LEAD_TOKEN = /^(\d{1,15})\.([0-9a-f]{64})$/;

interface StoredTokenSecret {
  secret: string;
  passwordCheck: string;
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
}

async function hmacHex(key: CryptoKey, message: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Commands refused while the show lock is on (it applies to every lead screen)
const LOCKED_COMMANDS = new Set(["stop", "reset", "setSpeed", "setTime", "setHighlight"]);

export class TimerRoom extends DurableObject<Env> {
  private state: InternalState = { ...DEFAULT_STATE };
  // In-memory only: lost on hibernation, which only happens after the DO
  // has been idle, by which point any reserved slots have expired anyway.
  private authNextSlot = new Map<string, number>();
  private tokenKey: Promise<CryptoKey> | null = null;

  private getTokenKey(): Promise<CryptoKey> {
    this.tokenKey ??= this.loadOrCreateTokenKey().catch((err) => {
      this.tokenKey = null; // Don't cache a failure
      throw err;
    });
    return this.tokenKey;
  }

  private async loadOrCreateTokenKey(): Promise<CryptoKey> {
    const password = this.env.LEAD_PASSWORD;
    const stored = await this.ctx.storage.get<StoredTokenSecret>("leadTokenSecret");
    if (stored && constantTimeEqual(stored.passwordCheck, await hmacHex(await hmacKey(stored.secret), password))) {
      return hmacKey(stored.secret);
    }
    const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const key = await hmacKey(secret);
    await this.ctx.storage.put("leadTokenSecret", { secret, passwordCheck: await hmacHex(key, password) });
    await this.ctx.storage.delete("leadToken"); // From before tokens expired; no longer accepted
    return key;
  }

  private async issueLeadToken(): Promise<string> {
    const expires = String(Date.now() + LEAD_TOKEN_TTL_MS);
    return `${expires}.${await hmacHex(await this.getTokenKey(), expires)}`;
  }

  private async isLeadToken(token: string): Promise<boolean> {
    const match = LEAD_TOKEN.exec(token);
    if (!match || Number(match[1]) <= Date.now()) return false;
    return constantTimeEqual(match[2], await hmacHex(await this.getTokenKey(), match[1]));
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<InternalState>("timerState");
      if (stored) {
        this.state = stored;
        this.state.highlight = this.state.highlight ?? null;
        this.state.locked = this.state.locked ?? false;
        this.state.startedFromMs = this.state.startedFromMs ?? null;
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
      logouts: 0,
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
      const logouts = attachment.logouts ?? 0;
      const success = await this.isLeadToken(msg.token);
      const token = success ? await this.issueLeadToken() : undefined;
      try {
        const current = ws.deserializeAttachment() as Attachment;
        if ((current.logouts ?? 0) !== logouts) return; // Signed out meanwhile
        current.authenticated = success;
        ws.serializeAttachment(current);
        ws.send(JSON.stringify({ type: "authResult", success, token }));
      } catch {
        // Socket closed
      }
      return;
    }

    // Sign out this socket. The token itself stays valid until it expires
    // (the client forgets it); changing LEAD_PASSWORD revokes every token.
    if (msg.type === "logout") {
      attachment.authenticated = false;
      attachment.logouts = (attachment.logouts ?? 0) + 1;
      ws.serializeAttachment(attachment);
      return;
    }

    if (msg.type === "auth") {
      const wait = this.reserveAuthSlot(attachment.ip);
      if (wait === null) {
        ws.send(JSON.stringify({ type: "authResult", success: false, reason: "rateLimited" }));
        return;
      }
      const logouts = attachment.logouts ?? 0;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const success = msg.password === this.env.LEAD_PASSWORD;
      const token = success ? await this.issueLeadToken() : undefined;
      try {
        // Re-read after the last await: hello/ping may have updated the
        // attachment, or logout cancelled this check, while we waited
        const current = ws.deserializeAttachment() as Attachment;
        if ((current.logouts ?? 0) !== logouts) return; // Signed out meanwhile
        current.authenticated = success;
        ws.serializeAttachment(current);
        ws.send(JSON.stringify({ type: "authResult", success, token }));
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

    if (this.state.locked && LOCKED_COMMANDS.has(msg.type)) {
      ws.send(JSON.stringify({ type: "error", message: "Show lock is on" }));
      return;
    }

    switch (msg.type) {
      case "start":
        if (!this.state.running) {
          this.state.running = true;
          this.state.startRealTimestamp = Date.now();
          this.state.startedFromMs = this.state.accumulatedVirtualMs;
          await this.persist();
          this.broadcast();
        }
        break;

      // Undo Start during the count-in (allowed under Show lock): back to
      // where Start was pressed. Refused once the timer has reached zero.
      case "cancel":
        if (this.state.running && this.state.startedFromMs !== null) {
          if (this.currentVirtualMs() >= 0) {
            ws.send(JSON.stringify({ type: "error", message: "Count-in is over" }));
            return;
          }
          this.state.running = false;
          this.state.accumulatedVirtualMs = this.state.startedFromMs;
          this.state.startRealTimestamp = null;
          this.state.startedFromMs = null;
          await this.persist();
          this.broadcast();
        }
        break;

      case "stop":
        if (this.state.running && this.state.startRealTimestamp !== null) {
          this.accumulate();
          this.state.running = false;
          this.state.startRealTimestamp = null;
          this.state.startedFromMs = null;
          await this.persist();
          this.broadcast();
        }
        break;

      case "reset":
        this.state.running = false;
        this.state.accumulatedVirtualMs = DEFAULT_START_MS;
        this.state.startRealTimestamp = null;
        this.state.startedFromMs = null;
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

      case "setLock":
        this.state.locked = msg.locked === true;
        await this.persist();
        this.broadcast();
        break;
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

  private currentVirtualMs(): number {
    if (this.state.startRealTimestamp === null) return this.state.accumulatedVirtualMs;
    return this.state.accumulatedVirtualMs + (Date.now() - this.state.startRealTimestamp) * this.state.speed;
  }

  private buildTimerState(): TimerState {
    return {
      running: this.state.running,
      speed: this.state.speed,
      accumulatedVirtualMs: this.state.accumulatedVirtualMs,
      startRealTimestamp: this.state.startRealTimestamp,
      serverNow: Date.now(),
      highlight: this.state.highlight,
      locked: this.state.locked,
      startedFromMs: this.state.startedFromMs,
    };
  }

  private listClients(): ClientInfo[] {
    const now = Date.now();
    const clients: ClientInfo[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.id) continue;
      clients.push({ id: a.id, name: a.name, role: a.role, authenticated: a.authenticated, rtt: a.rtt, lastSeenAgoMs: now - a.lastSeen });
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
