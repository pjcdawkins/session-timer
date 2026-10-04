// WebSocket protocol tests shared by both backends: the local Node server
// (server.js) and the Cloudflare Durable Object (src/timer-room.ts). They are
// meant to behave identically, so the same suite runs against each.

import { describe, expect } from "vitest";
import { sleep } from "./client.js";

const DEFAULT_START_MS = -3000;

/**
 * @param it  A Vitest `test` extended with a `backend` fixture, fresh per test:
 *   - `connect(): Promise<client>` opens a socket (see client.js); resolves once open
 *   - `restart(): Promise<void>` simulates the server going away and coming back
 *     (process restart / DO eviction)
 *   - `password` is the lead password the server was started with
 */
export function defineProtocolTests(it) {
  async function connectLead({ connect, password }) {
    const c = await connect();
    await c.next("state");
    c.send({ type: "auth", password });
    expect(await c.next("authResult")).toEqual({ type: "authResult", success: true });
    return c;
  }

  describe("on connect", () => {
    it("sends the default state immediately", async ({ backend }) => {
      const before = Date.now();
      const c = await backend.connect();
      const { state } = await c.next("state");
      expect(state).toMatchObject({
        running: false,
        speed: 1,
        accumulatedVirtualMs: DEFAULT_START_MS,
        startRealTimestamp: null,
        highlight: { interval: 10, offset: 0 },
        locked: false,
      });
      expect(state.serverNow).toBeGreaterThanOrEqual(before - 1000);
      c.close();
    });

    it("answers pings with the echoed timestamp and server time", async ({ backend }) => {
      const c = await backend.connect();
      c.send({ type: "ping", t: 12345, rtt: null });
      const pong = await c.next("pong");
      expect(pong.t).toBe(12345);
      expect(typeof pong.serverNow).toBe("number");
      c.close();
    });

    it("rejects invalid JSON", async ({ backend }) => {
      const c = await backend.connect();
      c.send("{not json");
      expect(await c.next("error")).toEqual({ type: "error", message: "Invalid JSON" });
      c.close();
    });
  });

  describe("auth", () => {
    it("rejects the wrong password", async ({ backend }) => {
      const c = await backend.connect();
      c.send({ type: "auth", password: "nope" });
      expect(await c.next("authResult")).toEqual({ type: "authResult", success: false });
      c.close();
    });

    it("refuses every command from an unauthenticated socket", async ({ backend }) => {
      const c = await backend.connect();
      await c.next("state");
      for (const cmd of [
        { type: "start" },
        { type: "stop" },
        { type: "reset" },
        { type: "setSpeed", speed: 2 },
        { type: "setTime", virtualMs: 0 },
        { type: "setHighlight", highlight: null },
        { type: "setLock", locked: true },
      ]) {
        c.send(cmd);
        expect(await c.next("error")).toEqual({ type: "error", message: "Not authenticated" });
      }
      await c.flush();
      expect(c.pending("state")).toEqual([]);
      c.close();
    });

    it("a failed re-auth revokes a previously authenticated socket", async ({ backend }) => {
      const c = await connectLead(backend);
      c.send({ type: "auth", password: "wrong" });
      await c.next("authResult");
      c.send({ type: "start" });
      expect(await c.next("error")).toMatchObject({ message: "Not authenticated" });
      c.close();
    });
  });

  describe("transport", () => {
    it("start broadcasts a running state to every client", async ({ backend }) => {
      const lead = await connectLead(backend);
      const viewer = await backend.connect();
      await viewer.next("state");

      const before = Date.now();
      lead.send({ type: "start" });
      const [a, b] = await Promise.all([lead.next("state"), viewer.next("state")]);
      expect(a.state.running).toBe(true);
      expect(a.state.startRealTimestamp).toBeGreaterThanOrEqual(before - 1000);
      expect(b.state).toEqual(a.state);
      lead.close();
      viewer.close();
    });

    it("start while running is a no-op", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "start" });
      await lead.next("state");
      lead.send({ type: "start" });
      await lead.flush();
      expect(lead.pending("state")).toEqual([]);
      lead.close();
    });

    it("stop accumulates the elapsed time", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "start" });
      await lead.next("state");
      await sleep(100);
      lead.send({ type: "stop" });
      const { state } = await lead.next("state");
      expect(state.running).toBe(false);
      expect(state.startRealTimestamp).toBeNull();
      expect(state.accumulatedVirtualMs).toBeGreaterThanOrEqual(DEFAULT_START_MS + 90);
      expect(state.accumulatedVirtualMs).toBeLessThan(DEFAULT_START_MS + 1500);
      lead.close();
    });

    it("stop while paused is a no-op", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "stop" });
      await lead.flush();
      expect(lead.pending("state")).toEqual([]);
      lead.close();
    });

    it("reset returns to the -3s count-in but keeps speed and highlight", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "setSpeed", speed: 2 });
      await lead.next("state");
      lead.send({ type: "setHighlight", highlight: { interval: 5, offset: 1 } });
      await lead.next("state");
      lead.send({ type: "start" });
      await lead.next("state");
      await sleep(10);
      lead.send({ type: "reset" });
      const { state } = await lead.next("state");
      expect(state).toMatchObject({
        running: false,
        accumulatedVirtualMs: DEFAULT_START_MS,
        startRealTimestamp: null,
        speed: 2,
        highlight: { interval: 5, offset: 1 },
      });
      lead.close();
    });
  });

  describe("setSpeed", () => {
    it("changes speed while paused", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "setSpeed", speed: 1.5 });
      const { state } = await lead.next("state");
      expect(state.speed).toBe(1.5);
      expect(state.accumulatedVirtualMs).toBe(DEFAULT_START_MS);
      lead.close();
    });

    it("keeps elapsed virtual time when changed while running", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "setSpeed", speed: 4 });
      await lead.next("state");
      lead.send({ type: "start" });
      const started = (await lead.next("state")).state;
      await sleep(100);
      lead.send({ type: "setSpeed", speed: 1 });
      const { state } = await lead.next("state");

      expect(state.running).toBe(true);
      expect(state.speed).toBe(1);
      // ~100ms at 4x was banked before the switch
      expect(state.accumulatedVirtualMs).toBeGreaterThanOrEqual(DEFAULT_START_MS + 4 * 90);
      expect(state.accumulatedVirtualMs).toBeLessThan(DEFAULT_START_MS + 4 * 1500);
      // ...and the clock restarted from the switch
      expect(state.startRealTimestamp).toBeGreaterThan(started.startRealTimestamp);
      lead.close();
    });

    it.for([0.05, 10.5, "2", null])("rejects %s", async (speed, { backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "setSpeed", speed });
      expect(await lead.next("error")).toEqual({ type: "error", message: "Speed must be between 0.1 and 10.0" });
      lead.close();
    });

    it("accepts the 0.1 and 10 bounds", async ({ backend }) => {
      const lead = await connectLead(backend);
      for (const speed of [0.1, 10]) {
        lead.send({ type: "setSpeed", speed });
        expect((await lead.next("state")).state.speed).toBe(speed);
      }
      lead.close();
    });
  });

  describe("setTime", () => {
    it("sets the time while paused, including negative countdowns", async ({ backend }) => {
      const lead = await connectLead(backend);
      for (const virtualMs of [90_000, -10_000]) {
        lead.send({ type: "setTime", virtualMs });
        expect((await lead.next("state")).state.accumulatedVirtualMs).toBe(virtualMs);
      }
      lead.close();
    });

    it("refuses while running", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "start" });
      await lead.next("state");
      lead.send({ type: "setTime", virtualMs: 0 });
      expect(await lead.next("error")).toEqual({ type: "error", message: "Stop the timer before setting time" });
      lead.close();
    });

    it.for(["10", null, undefined])("rejects non-numeric %s", async (virtualMs, { backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "setTime", virtualMs });
      expect(await lead.next("error")).toEqual({ type: "error", message: "Time must be a finite number" });
      lead.close();
    });
  });

  describe("setHighlight", () => {
    it("sets and clears the highlight", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "setHighlight", highlight: { interval: 15, offset: 5 } });
      expect((await lead.next("state")).state.highlight).toEqual({ interval: 15, offset: 5 });
      lead.send({ type: "setHighlight", highlight: null });
      expect((await lead.next("state")).state.highlight).toBeNull();
      lead.close();
    });

    it.for([
      [{ interval: 0, offset: 0 }, "Interval must be between 1 and 60"],
      [{ interval: 61, offset: 0 }, "Interval must be between 1 and 60"],
      [{ interval: 10, offset: -1 }, "Offset must be between 0 and 59"],
      [{ interval: 10, offset: 60 }, "Offset must be between 0 and 59"],
      [{ interval: 10 }, "Offset must be between 0 and 59"],
    ])("rejects %j", async ([highlight, message], { backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "setHighlight", highlight });
      expect(await lead.next("error")).toEqual({ type: "error", message });
      lead.close();
    });
  });

  describe("show lock", () => {
    async function lockedLead(backend) {
      const lead = await connectLead(backend);
      lead.send({ type: "setLock", locked: true });
      expect((await lead.next("state")).state.locked).toBe(true);
      return lead;
    }

    it.for([
      { type: "reset" },
      { type: "setSpeed", speed: 2 },
      { type: "setTime", virtualMs: 0 },
      { type: "setHighlight", highlight: null },
    ])("refuses $type while locked", async (cmd, { backend }) => {
      const lead = await lockedLead(backend);
      lead.send(cmd);
      expect(await lead.next("error")).toEqual({ type: "error", message: "Show lock is on" });
      await lead.flush();
      expect(lead.pending("state")).toEqual([]);
      lead.close();
    });

    it("still allows start and pause while locked", async ({ backend }) => {
      const lead = await lockedLead(backend);
      lead.send({ type: "start" });
      expect((await lead.next("state")).state.running).toBe(true);
      lead.send({ type: "stop" });
      expect((await lead.next("state")).state.running).toBe(false);
      lead.close();
    });

    it("applies to every lead, and any lead can unlock", async ({ backend }) => {
      const a = await lockedLead(backend);
      const b = await connectLead(backend);
      b.send({ type: "reset" });
      expect(await b.next("error")).toMatchObject({ message: "Show lock is on" });
      b.send({ type: "setLock", locked: false });
      expect((await b.next("state")).state.locked).toBe(false);
      b.send({ type: "setSpeed", speed: 2 });
      expect((await b.next("state")).state.speed).toBe(2);
      a.close();
      b.close();
    });

    it("only locks for an explicit true", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "setLock", locked: "yes" });
      expect((await lead.next("state")).state.locked).toBe(false);
      lead.close();
    });
  });

  describe("screens list", () => {
    it("is sent to authenticated leads with each pong", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "hello", id: "lead-1", name: "Lead laptop", role: "lead" });
      const viewer = await backend.connect();
      viewer.send({ type: "hello", id: "viewer-1", name: "x".repeat(100), role: "admin" });
      viewer.send({ type: "ping", t: 1, rtt: 42 });
      await viewer.next("pong");

      lead.send({ type: "ping", t: 2, rtt: 7 });
      await lead.next("pong");
      const { clients } = await lead.next("clients");
      const byId = Object.fromEntries(clients.map((c) => [c.id, c]));
      expect(byId["lead-1"]).toMatchObject({ name: "Lead laptop", role: "lead", authenticated: true, rtt: 7 });
      // Name truncated to 40 chars, unknown roles become viewer
      expect(byId["viewer-1"]).toMatchObject({ name: "x".repeat(40), role: "viewer", authenticated: false, rtt: 42 });
      expect(byId["viewer-1"].lastSeenAgoMs).toBeGreaterThanOrEqual(0);

      // Viewers never receive the list
      await viewer.flush();
      expect(viewer.pending("clients")).toEqual([]);
      lead.close();
      viewer.close();
    });
  });

  describe("persistence", () => {
    it("restores paused state after a restart", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "setSpeed", speed: 2.5 });
      await lead.next("state");
      lead.send({ type: "setTime", virtualMs: 42_000 });
      await lead.next("state");
      lead.send({ type: "setHighlight", highlight: null });
      await lead.next("state");
      lead.send({ type: "setLock", locked: true });
      await lead.next("state");
      lead.close();

      await backend.restart();

      const c = await backend.connect();
      const { state } = await c.next("state");
      expect(state).toMatchObject({
        running: false,
        speed: 2.5,
        accumulatedVirtualMs: 42_000,
        highlight: null,
        locked: true,
      });
      c.close();
    });

    it("a running timer keeps its place across a restart", async ({ backend }) => {
      const lead = await connectLead(backend);
      lead.send({ type: "start" });
      const started = (await lead.next("state")).state;
      lead.close();

      await backend.restart();

      const c = await backend.connect();
      const { state } = await c.next("state");
      expect(state.running).toBe(true);
      expect(state.startRealTimestamp).toBe(started.startRealTimestamp);
      c.close();
    });
  });
}
