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
  locked: boolean;
  /** Where Start was pressed while running (null when paused): Cancel returns here */
  startedFromMs: number | null;
}

export type ClientRole = "viewer" | "lead";

export interface ClientInfo {
  id: string;
  name: string;
  role: ClientRole;
  authenticated: boolean;
  rtt: number | null;
  lastSeenAgoMs: number;
}

export type ClientMessage =
  | { type: "hello"; id: string; name: string; role: ClientRole }
  | { type: "ping"; t: number; rtt: number | null }
  | { type: "auth"; password?: string; token?: string }
  | { type: "logout" }
  | { type: "start" }
  | { type: "cancel" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "setSpeed"; speed: number }
  | { type: "setTime"; virtualMs: number }
  | { type: "setHighlight"; highlight: { interval: number; offset: number } | null }
  | { type: "setLock"; locked: boolean };

export type ServerMessage =
  | { type: "state"; state: TimerState }
  | { type: "pong"; t: number; serverNow: number }
  | { type: "clients"; clients: ClientInfo[]; serverNow: number }
  | { type: "authResult"; success: boolean; reason?: "rateLimited"; token?: string }
  | { type: "error"; message: string };
