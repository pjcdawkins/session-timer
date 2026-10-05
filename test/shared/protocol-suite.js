// WebSocket protocol tests shared by both backends: the local Node server
// (server.js) and the Cloudflare Durable Object (src/timer-room.ts). They are
// meant to behave identically, so the same suite runs against each.

import { describe, expect } from "vitest";
import { sleep } from "./client.js";

const DEFAULT_START_MS = -5000;

/**
 * @param it  A Vitest `test` extended with a `backend` fixture, fresh per test:
 *   - `connect(): Promise<client>` opens a socket (see client.js); resolves once open
 *   - `restart(): Promise<void>` simulates the server going away and coming back
 *     (process restart / DO eviction)
 *   - `password` is the lead password the server was started with
 */
export function defineProtocolTests(it) {
  // Password checks are throttled per IP, so like the lead page, log in with
  // the password once per test and use the reconnect token after that.
  const tokens = new WeakMap();

  async function connectLead(backend) {
    const c = await backend.connect();
    await c.next("state");
    const token = tokens.get(backend);
    c.send(token ? { type: "auth", token } : { type: "auth", password: backend.password });
    const result = await c.next("authResult");
    expect(result).toMatchObject({ type: "authResult", success: true, token: expect.any(String) });
    tokens.set(backend, result.token);
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
      c.send({ type: "auth", token: "wrong" });
      await c.next("authResult");
      c.send({ type: "start" });
      expect(await c.next("error")).toMatchObject({ message: "Not authenticated" });
      c.close();
    });
  });

  describe("auth throttle and reconnect token", () => {
    const TOKEN = /^[0-9a-f]{64}$/;

    it("issues a random 256-bit token on password login, and accepts it", async ({ backend }) => {
      const a = await backend.connect();
      a.send({ type: "auth", password: backend.password });
      const { token } = await a.next("authResult");
      expect(token).toMatch(TOKEN);
      expect(token).not.toContain(backend.password);

      const b = await backend.connect();
      await b.next("state");
      b.send({ type: "auth", token });
      expect(await b.next("authResult")).toEqual({ type: "authResult", success: true, token });
      b.send({ type: "setTime", virtualMs: 7 });
      expect((await b.next("state")).state.accumulatedVirtualMs).toBe(7);
      a.close();
      b.close();
    });

    it("checks held password attempts 2s apart, and rejects a backlog", async ({ backend }) => {
      const c = await backend.connect();
      await c.next("state");
      const sentAt = Date.now();
      // Slots at 0s, 2s, 4s; the 4th would wait 6s (> 5s), so it's rejected now.
      // The 3rd is the right password, to show held attempts really are checked.
      for (const password of ["wrong", "wrong", backend.password, "wrong"]) c.send({ type: "auth", password });
      const results = [];
      for (let i = 0; i < 4; i++) {
        const msg = await c.next("authResult");
        results.push({ msg, at: Date.now() - sentAt });
      }

      // (The rejection is sent before the 1st check runs, so it may arrive first)
      const rejected = results.filter((r) => r.msg.reason === "rateLimited");
      const checked = results.filter((r) => !r.msg.reason);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].at).toBeLessThan(1000);

      expect(checked.map((r) => r.msg.success)).toEqual([false, false, true]);
      expect(checked[2].msg.token).toEqual(expect.any(String));
      // Timer granularity: allow a little under the nominal 2s spacing
      expect(checked[0].at).toBeLessThan(1000);
      expect(checked[1].at).toBeGreaterThanOrEqual(1900);
      expect(checked[2].at).toBeGreaterThanOrEqual(3900);
      expect(checked[2].at - checked[1].at).toBeGreaterThanOrEqual(1900);
      c.close();
    });

    it("lets a token through while password attempts are throttled", async ({ backend }) => {
      const lead = await connectLead(backend);
      const token = tokens.get(backend);
      const attacker = await backend.connect();
      for (let i = 0; i < 4; i++) attacker.send({ type: "auth", password: "guess" });
      await attacker.next((m) => m.type === "authResult" && m.reason === "rateLimited");

      const reconnect = await backend.connect();
      reconnect.send({ type: "auth", token });
      expect(await reconnect.next("authResult", 500)).toMatchObject({ success: true });
      lead.close();
      attacker.close();
      reconnect.close();
    });

    it.for([
      ["a wrong token", "0".repeat(64)],
      ["an empty token", ""],
      // Same length in characters as a real token but longer in bytes: this
      // used to make crypto.timingSafeEqual throw and crash the local server
      ["a non-ASCII token", "é".repeat(64)],
    ])("rejects %s without throttling", async ([, token], { backend }) => {
      const c = await backend.connect();
      for (let i = 0; i < 5; i++) c.send({ type: "auth", token });
      for (let i = 0; i < 5; i++) {
        expect(await c.next("authResult", 500)).toEqual({ type: "authResult", success: false });
      }
      // Still alive
      await c.flush();
      c.close();
    });

    it("keeps the same token across a restart", async ({ backend }) => {
      (await connectLead(backend)).close();
      const token = tokens.get(backend);
      await backend.restart();
      const c = await backend.connect();
      c.send({ type: "auth", token });
      expect(await c.next("authResult")).toEqual({ type: "authResult", success: true, token });
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

    it("reset returns to the -5s count-in but keeps speed and highlight", async ({ backend }) => {
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

    it("allows start but refuses pause while locked", async ({ backend }) => {
      const lead = await lockedLead(backend);
      lead.send({ type: "start" });
      expect((await lead.next("state")).state.running).toBe(true);
      lead.send({ type: "stop" });
      expect(await lead.next("error")).toEqual({ type: "error", message: "Show lock is on" });
      await lead.flush();
      expect(lead.pending("state")).toEqual([]);
      lead.send({ type: "setLock", locked: false });
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
