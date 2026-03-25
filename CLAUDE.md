# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Local dev server (Miniflare) at http://localhost:8787
npm run deploy       # Deploy to Cloudflare Workers
npm run typecheck    # TypeScript type check (no emit)
```

Secrets: `wrangler secret put LEAD_PASSWORD` sets the lead auth password. For local dev, use `.dev.vars`.

## Architecture

Shared timer web app for music sessions. One "lead" controls the timer; all other viewers see a synced read-only display. The timer runs at a configurable speed multiplier (default 1.15x) — the main display shows sped-up "virtual" time, a corner display shows real elapsed time.

### Backend: Cloudflare Workers + Durable Objects

- **`src/index.ts`** — Hono app with a single `/ws` route that upgrades to WebSocket and forwards to the TimerRoom Durable Object. Static assets are served by Cloudflare's asset binding from `public/`.
- **`src/timer-room.ts`** — The core. A single Durable Object instance (`"default-room"`) holds all timer state and manages WebSocket connections. Uses the Hibernation API with auto ping/pong. Persists state to DO storage (SQLite-backed). Broadcasts state on every mutation + 30s heartbeat alarm.
- **`src/types.ts`** — Shared types for Env bindings, TimerState, and the client/server WebSocket message protocol.

### Timer State & Sync Protocol

State is **not** continuously pushed. The server broadcasts a state snapshot on changes and periodically; clients compute display locally at 60fps.

Timer state: `{ running, speed, accumulatedVirtualMs, accumulatedRealMs, startRealTimestamp }`. When running, clients compute:
```
virtualElapsed = accumulatedVirtualMs + (now - startRealTimestamp) * speed
realElapsed    = accumulatedRealMs    + (now - startRealTimestamp)
```

Each broadcast includes `serverNow` so clients calculate `clockOffset = serverNow - Date.now()` for cross-device alignment.

Speed changes while running: the server accumulates elapsed time at the old speed, then restarts with the new speed — no time is lost.

### Frontend: Vanilla JS (ES modules, no build step)

Two pages share common modules:
- **`/`** (`index.html` + `viewer.js`) — Read-only timer display
- **`/lead`** (`lead.html` + `lead.js`) — Password gate, then transport controls + speed presets

Shared modules:
- **`websocket-client.js`** — Connect, auto-reconnect with exponential backoff, clock offset calculation
- **`timer-display.js`** — SVG analog clock (minute + second hands), digital HH:MM:SS.t display, real-time corner display, 60fps render loop via requestAnimationFrame

### Auth

Password sent over WebSocket, validated by the Durable Object against `LEAD_PASSWORD` env var. The DO marks the socket attachment as authenticated. All commands (start/stop/reset/setSpeed) require an authenticated socket. Stored in localStorage for auto-re-auth on reconnect.

## Deployment

Custom domain `timer.ligetiquartet.com` configured in `wrangler.toml`. GitHub Actions workflow (`.github/workflows/deploy.yml`) auto-deploys on push to main using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.
