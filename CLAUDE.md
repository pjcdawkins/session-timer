# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run local        # Local Node.js server (no internet) at http://localhost:8787
npm run show         # Local server for performances: auto-restart loop + caffeinate
npm run dev          # Cloudflare dev server (Miniflare) at http://localhost:8787
npm run deploy       # Deploy to Cloudflare Workers
npm run typecheck    # TypeScript type check (no emit)
```

Secrets: `wrangler secret put LEAD_PASSWORD` sets the lead auth password. For Cloudflare dev, use `.dev.vars`. For local mode, set `LEAD_PASSWORD` env var (default: `"session"`).

## Architecture

Shared timer web app for music sessions. One "lead" controls the timer; all other viewers see a synced read-only display. The timer runs at a configurable speed multiplier (default 1x) — the main display shows sped-up "virtual" time, a corner display shows real elapsed time.

### Backend: Two modes

#### Cloudflare Workers + Durable Objects (production)

- **`src/index.ts`** — Hono app with a single `/ws` route that upgrades to WebSocket and forwards to the TimerRoom Durable Object. Static assets are served by Cloudflare's asset binding from `public/`.
- **`src/timer-room.ts`** — The core. A single Durable Object instance (`"default-room"`) holds all timer state and manages WebSocket connections. Uses the Hibernation API with auto ping/pong. Persists state to DO storage (SQLite-backed). Broadcasts state on every mutation + 30s heartbeat alarm.
- **`src/types.ts`** — Shared types for Env bindings, TimerState, and the client/server WebSocket message protocol.

#### Local Node.js server (offline / LAN use)

- **`server.js`** — Standalone Node.js HTTP + WebSocket server. Mirrors the timer logic from `timer-room.ts`. Serves the same `public/` frontend. No internet required — works on a local network. Prints a QR code on startup for easy phone access. State is saved to `.timer-state.json` (override with `STATE_FILE`) on every change and restored on startup, so a crash/restart mid-performance resumes in place. Drops sockets silent for 15s. Requires the `ws` npm package.

### Timer State & Sync Protocol

State is **not** continuously pushed. The server broadcasts a state snapshot on changes and periodically; clients compute display locally at 60fps.

Timer state: `{ running, speed, accumulatedVirtualMs, startRealTimestamp }`. When running, clients compute:
```
virtualElapsed = accumulatedVirtualMs + (now - startRealTimestamp) * speed
realElapsed    = virtualElapsed / speed
```

Clock sync (`clock.js`): clients send `{type:"ping", t}` every 2s; the server replies `{type:"pong", t, serverNow}`. The client estimates `offset = serverNow + rtt/2 - now` and uses the min-RTT sample of the last 10. Until the first pong it falls back to `serverNow - Date.now()` from state broadcasts.

Liveness: if a client receives nothing for 6s it treats the socket as dead and reconnects (500ms → 2s backoff, 4s connect timeout), and reconnects immediately on visibilitychange/online/pageshow. The last state is saved to localStorage and restored on page load, so a reloaded screen resumes counting before it reconnects.

Screens list: clients send `{type:"hello", id, name, role}` on connect (id is per-tab via sessionStorage; viewer name from `?name=` or tapping the name in the status bar). Authenticated leads receive `{type:"clients", ...}` with each ping reply.

Speed changes while running: the server accumulates elapsed time at the old speed, then restarts with the new speed — no time is lost.

### Frontend: Vanilla JS (ES modules, no build step)

Two pages share common modules:
- **`/`** (`index.html` + `viewer.js`) — Read-only timer display
- **`/lead`** (`lead.html` + `lead.js`) — Password gate, then transport controls + speed presets

Shared modules:
- **`websocket-client.js`** — Connect, auto-reconnect with exponential backoff, clock offset calculation. Reports connection status as `"connected"`, `"reconnecting"`, or `"disconnected"` (after 3+ failed attempts)
- **`timer-display.js`** — SVG analog clock (minute + second hands), digital HH:MM:SS.t display, real-time corner display, 60fps render loop via requestAnimationFrame

### Auth

Password sent over WebSocket, validated by the Durable Object (or local server) against `LEAD_PASSWORD` env var. The DO marks the socket attachment as authenticated. All commands (start/pause/reset/setSpeed/setTime) require an authenticated socket. Password stored in localStorage for auto-re-auth on reconnect and page reload. The lead can set a start time (including negative for countdown) while the timer is paused. The default start time (initial state and after Reset) is -3s, giving a count-in. Highlighting is on by default, every 10 seconds with offset 0.

Lead page safeguards: Space = Start (never toggles), Esc = Pause, Reset needs a second click within 3s, "Show lock" disables reset/set-time/speed/highlight, and a red banner shows if a command is attempted while disconnected.

### Offline caveats

`public/sw.js` (network-first offline cache) and the Wake Lock API only work in a secure context (HTTPS or localhost), so neither is active for LAN devices on plain `http://192.168…`. Fonts are vendored in `public/fonts/` so nothing is fetched from the internet.

See `PERFORMANCE.md` for the show-day setup checklist.

## Deployment

Custom domain `timer.ligetiquartet.com` configured in `wrangler.toml`. GitHub Actions workflow (`.github/workflows/deploy.yml`) auto-deploys on push to main using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.
