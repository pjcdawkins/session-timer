import type { TimerRoom } from "./timer-room";

export interface Env {
  TIMER_ROOM: DurableObjectNamespace<TimerRoom>;
  ASSETS: Fetcher;
  LEAD_PASSWORD: string;
}

export interface TimerState {
  running: boolean;
  speed: number;
  accumulatedVirtualMs: number;
  startRealTimestamp: number | null;
  serverNow: number;
  highlight: { interval: number; offset: number } | null;
}

export type ClientRole = "viewer" | "lead";

export interface ClientInfo {
  id: string;
  name: string;
  role: ClientRole;
  rtt: number | null;
  lastSeenAgoMs: number;
}

export type ClientMessage =
  | { type: "hello"; id: string; name: string; role: ClientRole }
  | { type: "ping"; t: number; rtt: number | null }
  | { type: "auth"; password: string }
  | { type: "start" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "setSpeed"; speed: number }
  | { type: "setTime"; virtualMs: number }
  | { type: "setHighlight"; highlight: { interval: number; offset: number } | null };

export type ServerMessage =
  | { type: "state"; state: TimerState }
  | { type: "pong"; t: number; serverNow: number }
  | { type: "clients"; clients: ClientInfo[]; serverNow: number }
  | { type: "authResult"; success: boolean; reason?: "rateLimited" }
  | { type: "error"; message: string };
