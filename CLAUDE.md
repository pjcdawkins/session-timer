# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Requires Node 24 (`.nvmrc`; CI and deploy read it too).

```bash
npm run local        # Local Node.js server (no internet) at http://localhost:8787
npm run show         # Local server for performances: auto-restart loop + caffeinate
npm run dev          # Cloudflare dev server (Miniflare) at http://localhost:8787
npm run deploy       # Deploy to Cloudflare Workers
npm run build        # Bundle the Worker without deploying (wrangler deploy --dry-run)
npm run typecheck    # TypeScript type check (no emit), including worker tests
npm run lint         # Biome lint (warnings fail); `npm run lint:fix` applies safe fixes
npm test             # All tests (Vitest), ~6s
npm run test:watch   # Vitest watch mode
npx vitest run --project server    # One project: server | frontend | worker
npx vitest run -t "setSpeed"       # Tests whose name matches
```

Before committing, run `npm run lint && npm run typecheck && npm test`. CI runs these plus `npm run build`.

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

Screens list: clients send `{type:"hello", id, name, role}` on connect (id is per-tab via sessionStorage; viewer name from `?name=` or tapping the name in the status bar). Authenticated leads receive `{type:"clients", ...}` with each ping reply; the lead Screens panel lists viewers and other lead screens (tagged "lead", or "lead · signed out" if not authenticated).

Speed changes while running: the server accumulates elapsed time at the old speed, then restarts with the new speed — no time is lost.

### Frontend: Vanilla JS (ES modules, no build step)

Two pages share common modules:
- **`/`** (`index.html` + `viewer.js`) — Read-only timer display
- **`/lead`** (`lead.html` + `lead.js`) — Password gate, then transport controls + speed presets

Shared modules:
- **`websocket-client.js`** — Connect, auto-reconnect with exponential backoff, clock offset calculation. Reports connection status as `"connected"`, `"reconnecting"`, or `"disconnected"` (after 3+ failed attempts)
- **`timer-display.js`** — SVG analog clock (minute + second hands), digital HH:MM:SS display (with .t tenths below 1x), real-time corner display, 60fps render loop via requestAnimationFrame

### Auth

Password sent over WebSocket, validated by the Durable Object (or local server) against `LEAD_PASSWORD` env var. The DO marks the socket attachment as authenticated. All commands (start/pause/reset/setSpeed/setTime) require an authenticated socket. Password stored in localStorage for auto-re-auth on reconnect and page reload. The lead can set a start time (including negative for countdown) while the timer is paused. The default start time (initial state and after Reset) is -3s, giving a count-in. Highlighting is on by default, every 10 seconds with offset 0.

Lead page safeguards: Space = Start (never toggles), Esc = Pause, Reset needs a second click within 3s, "Show lock" disables pause/reset/set-time/speed/highlight, leaving only Start (it is part of the timer state, so it applies to every lead screen, and the server refuses those commands while it is on), and a red banner shows if a command is attempted while disconnected. Perform mode (per screen, remembered in localStorage) hides the controls except a Start button (no Pause, and Esc does nothing) and enlarges the clocks, side by side in landscape with Start and Exit under the digits; entering it turns on Show lock, exiting leaves the lock on, and the status bar shows a compact screens count.

### Offline caveats

`public/sw.js` (network-first offline cache) and the Wake Lock API only work in a secure context (HTTPS or localhost), so neither is active for LAN devices on plain `http://192.168…`. Fonts are vendored in `public/fonts/` so nothing is fetched from the internet.

See `PERFORMANCE.md` for the show-day setup checklist.

## Tests

Vitest with three projects (`vitest.config.mts`):

- **`server`** (`test/node/`) — each test spawns its own `server.js` child process (free port, temp `STATE_FILE`) via a Vitest fixture, so these tests run concurrently. Talks to it over real WebSockets and HTTP. Also covers static file serving, path traversal, and state-file recovery.
- **`worker`** (`test/worker/`) — runs `src/` inside workerd via `@cloudflare/vitest-pool-workers` (reads `wrangler.toml`; `LEAD_PASSWORD` is `test-password`). Also covers hibernation and the heartbeat alarm.
- **`frontend`** (`test/frontend/`) — unit tests for `public/js` modules under happy-dom: clock sync, display rendering/highlighting, and the reconnect/liveness logic in `websocket-client.js` (with a fake `WebSocket` and fake timers).

`test/shared/protocol-suite.js` is the WebSocket protocol spec. It takes a `test` extended with a per-test `backend` fixture (`connect`, `restart`, `password`) and runs against **both** backends, so `server.js` and `timer-room.ts` must behave identically — when changing the protocol, update both and add the test there. Password auth is throttled per IP (all test sockets share one), so the suite's `connectLead` uses the password once per test and the reconnect token after that; do the same in new tests rather than sending the password repeatedly.

The server and worker tests bind local ports; in a sandbox that blocks local binding they fail with `listen EPERM`.

## Linting

Biome (`biome.json`), linter only — the formatter is disabled. `public/js/vendor/` and fonts are excluded. Two rules are off because they flag intentional CSS: duplicate properties (`100vh` then `100svh` fallbacks) and `!important`.

## Deployment

Custom domain `timer.ligetiquartet.com` configured in `wrangler.toml`. GitHub Actions: `.github/workflows/ci.yml` runs lint, typecheck, tests and a dry-run Worker build on pull requests. `.github/workflows/deploy.yml` runs that same CI on push to main and only deploys if it passes, using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.
