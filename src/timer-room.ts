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
  id: string;
  name: string;
  role: ClientRole;
  rtt: number | null;
  lastSeen: number;
}

const DEFAULT_STATE: InternalState = {
  running: false,
  speed: 1.15,
  accumulatedVirtualMs: 0,
  startRealTimestamp: null,
  highlight: null,
};

export class TimerRoom extends DurableObject<Env> {
  private state: InternalState = { ...DEFAULT_STATE };

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

    if (msg.type === "auth") {
      attachment.authenticated = msg.password === this.env.LEAD_PASSWORD;
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify({ type: "authResult", success: attachment.authenticated }));
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
        this.state.accumulatedVirtualMs = 0;
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
