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

export type ClientMessage =
  | { type: "auth"; password: string }
  | { type: "start" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "setSpeed"; speed: number }
  | { type: "setTime"; virtualMs: number }
  | { type: "setHighlight"; highlight: { interval: number; offset: number } | null };

export type ServerMessage =
  | { type: "state"; state: TimerState }
  | { type: "authResult"; success: boolean }
  | { type: "error"; message: string };
