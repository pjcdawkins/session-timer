// Tests for qlab-bridge.mjs: OSC encoding, and firing a fake QLab at zero
// while following a real server.js.

import net from "node:net";
import { describe, expect, test } from "vitest";
import {
  createBridge,
  cuePath,
  decodeOsc,
  encodeOsc,
  formatPosition,
  slipDecoder,
  slipEncode,
  zeroAt,
} from "../../qlab-bridge.mjs";
import { sleep } from "../shared/client.js";
import { PASSWORD, startServer } from "./server-harness.js";

describe("OSC", () => {
  test("encodes a message with no arguments, padded to 4 bytes", () => {
    const buf = encodeOsc("/cue/2/start");
    // "/cue/2/start" is 12 bytes → 16 with its NUL; ",\0\0\0"
    expect(buf.length).toBe(20);
    expect(buf.toString("latin1")).toBe("/cue/2/start\0\0\0\0,\0\0\0");
    expect(decodeOsc(buf)).toEqual({ address: "/cue/2/start", args: [] });
  });

  test("round-trips string arguments and encodes integers", () => {
    expect(decodeOsc(encodeOsc("/reply/cue/2/name", ['{"status":"ok"}']))).toEqual({
      address: "/reply/cue/2/name",
      args: ['{"status":"ok"}'],
    });
    expect(encodeOsc("/alwaysReply", [1]).toString("hex")).toBe(
      Buffer.from("/alwaysReply\0\0\0\0,i\0\0\0\0\0\x01", "latin1").toString("hex"),
    );
  });

  test("SLIP-frames packets, escaping END and ESC bytes", () => {
    const packets = [];
    const decode = slipDecoder((p) => packets.push(p));
    const a = Buffer.from([1, 0xc0, 2, 0xdb, 3]);
    const b = encodeOsc("/x");
    const stream = Buffer.concat([slipEncode(a), slipEncode(b)]);
    // Split across chunks, including between an ESC and its escaped byte
    decode(stream.subarray(0, 4));
    decode(stream.subarray(4));
    expect(packets).toEqual([a, b]);
  });
});

describe("cuePath", () => {
  test.for([
    [{ cue: "2" }, "/cue/2"],
    [{ cue: "2a" }, "/cue/2a"],
    [{ cue: "1.5.3" }, "/cue/1.5.3"],
    [{ cue: "intro_B-2" }, "/cue/intro_B-2"],
    [{ cueId: "1A2B-3C" }, "/cue_id/1A2B-3C"],
    [{ cue: "2", workspace: "W1" }, "/workspace/W1/cue/2"],
  ])("%o → %s", ([opts, path]) => {
    expect(cuePath(opts)).toBe(path);
  });

  test.for(["1 2", "1*", "a/b", "x?", "[1]", "{a}", "a,b", "#1", "!", "", "é"])(
    "rejects cue number %j",
    (cue) => {
      expect(() => cuePath({ cue })).toThrow();
    },
  );

  test("needs exactly one of cue and cue ID", () => {
    expect(() => cuePath({})).toThrow(/exactly one/);
    expect(() => cuePath({ cue: "1", cueId: "X" })).toThrow(/exactly one/);
  });
});

describe("formatPosition", () => {
  test.for([
    [-5000, "-0:05"],
    [0, "0:00"],
    [83_400, "1:23.4"],
    [600_000, "10:00"],
    [-59_960, "-1:00"],
  ])("%d → %s", ([ms, text]) => {
    expect(formatPosition(ms)).toBe(text);
  });
});

describe("zeroAt", () => {
  const running = { running: true, speed: 1, accumulatedVirtualMs: -5000, startRealTimestamp: 1000 };

  test("is the start time plus the count-in in real time", () => {
    expect(zeroAt(running)).toBe(6000);
    expect(zeroAt({ ...running, speed: 2 })).toBe(3500);
    expect(zeroAt({ ...running, speed: 0.5 })).toBe(11_000);
  });

  test("is null when paused or not counting towards zero", () => {
    expect(zeroAt(null)).toBeNull();
    expect(zeroAt({ ...running, running: false, startRealTimestamp: null })).toBeNull();
    expect(zeroAt({ ...running, accumulatedVirtualMs: 0 })).toBeNull();
    expect(zeroAt({ ...running, accumulatedVirtualMs: 3000 })).toBeNull();
  });
});

/** A fake QLab: accepts SLIP/OSC over TCP and replies like QLab does. */
async function startFakeQLab({ cues = { 2: "Tape" }, passcode } = {}) {
  const received = []; // { address, args, at }
  const sockets = new Set();
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    let authorised = passcode == null;
    socket.on(
      "data",
      slipDecoder((packet) => {
        const at = Date.now();
        const msg = decodeOsc(packet);
        received.push({ ...msg, at });
        const reply = (body) => socket.write(slipEncode(encodeOsc(`/reply${msg.address}`, [JSON.stringify(body)])));
        if (msg.address === "/connect") {
          authorised = msg.args[0] === passcode;
          return reply({ status: authorised ? "ok" : "badpass" });
        }
        if (msg.address === "/alwaysReply") return;
        if (!authorised) return reply({ status: "denied" });
        const m = msg.address.match(/^\/cue\/([^/]+)\/(name|start|pause|resume|stop)$/);
        if (!m || !(m[1] in cues)) return reply({ status: "error" });
        reply(m[2] === "name" ? { status: "ok", data: cues[m[1]] } : { status: "ok" });
      }),
    );
    // The bridge resets its connection when stopped
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return {
    port: srv.address().port,
    received,
    starts: () => received.filter((m) => m.address.endsWith("/start")),
    /** Cue commands received, e.g. ["start", "pause"] */
    actions: () => received.map((m) => m.address.match(/^\/cue\/[^/]+\/(start|pause|resume|stop)$/)?.[1]).filter(Boolean),
    connections: () => sockets.size,
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => srv.close(resolve));
    },
  };
}

async function waitFor(check, timeout = 5000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await sleep(10);
  }
}

const it = test.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures must destructure their context
  server: async ({}, use) => {
    const server = await startServer();
    await use(server);
    await server.stop();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures must destructure their context
  qlab: async ({}, use) => {
    const qlab = await startFakeQLab();
    await use(qlab);
    await qlab.close();
  },
  lead: async ({ server }, use) => {
    const c = await server.connect();
    c.send({ type: "auth", password: PASSWORD });
    await c.next("authResult");
    await use(c);
    c.close();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures must destructure their context
  logs: async ({}, use) => {
    await use([]);
  },
  bridgeFor: async ({ server, qlab, logs }, use) => {
    const bridges = [];
    await use((options = {}) => {
      const b = createBridge({
        server: server.baseUrl,
        cue: "2",
        qlabPort: qlab.port,
        log: (m) => logs.push(m),
        ...options,
      });
      bridges.push(b);
      return b;
    });
    for (const b of bridges) b.stop();
  },
});

/** Wait until the bridge is connected, has a clock sample, and QLab has checked out. */
async function ready(logs) {
  await waitFor(() => logs.some((l) => l.startsWith("QLab ready")) && logs.some((l) => l.startsWith("Connected")));
  await sleep(100); // first pong
}

describe.concurrent("bridge", () => {
  it("fires the cue at zero", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    expect(logs).toContain('QLab ready: /cue/2 "Tape"');

    lead.send({ type: "setTime", virtualMs: -600 });
    await lead.flush();
    lead.send({ type: "start" });
    const { state } = await lead.next((m) => m.type === "state" && m.state.running);

    await waitFor(() => qlab.starts().length > 0);
    const [start] = qlab.starts();
    expect(start.address).toBe("/cue/2/start");
    // Server and bridge share this machine's clock, so this is the bridge's error
    expect(Math.abs(start.at - (state.startRealTimestamp + 600))).toBeLessThan(25);
    await waitFor(() => logs.some((l) => l.startsWith("Fired")));
    expect(logs.find((l) => l.startsWith("Fired"))).toMatch(/QLab: ok$/);

    // Heartbeats and pongs after zero don't fire it again
    await sleep(2500);
    expect(qlab.starts()).toHaveLength(1);
  });

  it("allows for the speed", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    lead.send({ type: "setSpeed", speed: 2 });
    lead.send({ type: "setTime", virtualMs: -1200 });
    await lead.flush();
    lead.send({ type: "start" });
    const { state } = await lead.next((m) => m.type === "state" && m.state.running);
    await waitFor(() => qlab.starts().length > 0);
    expect(Math.abs(qlab.starts()[0].at - (state.startRealTimestamp + 600))).toBeLessThan(25);
  });

  it("re-arms after a speed change during the count-in", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    lead.send({ type: "setTime", virtualMs: -1000 });
    await lead.flush();
    lead.send({ type: "start" });
    await lead.next((m) => m.type === "state" && m.state.running);
    await sleep(200);
    lead.send({ type: "setSpeed", speed: 0.5 });
    const { state } = await lead.next((m) => m.type === "state" && m.state.speed === 0.5);
    await waitFor(() => qlab.starts().length > 0);
    expect(Math.abs(qlab.starts()[0].at - zeroAt(state))).toBeLessThan(25);
    expect(qlab.starts()).toHaveLength(1);
  });

  it("doesn't fire if paused before zero, and fires once restarted", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    lead.send({ type: "setTime", virtualMs: -500 });
    await lead.flush();
    lead.send({ type: "start" });
    await sleep(200);
    lead.send({ type: "stop" });
    await sleep(600);
    expect(qlab.starts()).toHaveLength(0);
    expect(logs.some((l) => l.startsWith("Disarmed"))).toBe(true);

    lead.send({ type: "start" });
    await waitFor(() => qlab.starts().length > 0);
  });

  it("doesn't fire if the count-in is cancelled", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    lead.send({ type: "setTime", virtualMs: -1000 });
    await lead.flush();
    lead.send({ type: "start" });
    await waitFor(() => logs.some((l) => l.startsWith("Armed")));
    lead.send({ type: "cancel" });
    await lead.next((m) => m.type === "state" && !m.state.running);
    await sleep(1200);
    expect(qlab.starts()).toHaveLength(0);
    expect(logs.some((l) => l.startsWith("Disarmed"))).toBe(true);
  });

  it("doesn't fire when started at or after zero", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    lead.send({ type: "setTime", virtualMs: 0 });
    await lead.flush();
    lead.send({ type: "start" });
    await sleep(500);
    expect(qlab.starts()).toHaveLength(0);
  });

  it("never fires late for a new run that passed zero while it was disconnected", async ({ server, qlab, logs }) => {
    const b = createBridge({ server: server.baseUrl, cue: "2", qlabPort: qlab.port, log: (m) => logs.push(m) });
    try {
      await ready(logs);
      let lead = await server.connect();
      lead.send({ type: "auth", password: PASSWORD });
      await lead.next("authResult");
      lead.send({ type: "setTime", virtualMs: -10_000 });
      await lead.flush();
      lead.send({ type: "start" });
      await waitFor(() => logs.some((l) => l.startsWith("Armed")));
      lead.close();

      // The server goes away; while the bridge is disconnected, a new short run passes zero
      await server.stop();
      await waitFor(() => logs.some((l) => l.startsWith("Lost the timer")));
      const restarted = await startServer({ port: server.port, stateFile: server.stateFile });
      try {
        lead = await restarted.connect();
        lead.send({ type: "auth", password: PASSWORD });
        await lead.next("authResult");
        lead.send({ type: "reset" });
        lead.send({ type: "setTime", virtualMs: -50 });
        await lead.flush();
        lead.send({ type: "start" });
        const { state } = await lead.next((m) => m.type === "state" && m.state.running);
        await waitFor(() => logs.filter((l) => l.startsWith("Connected")).length >= 2);
        await sleep(300);
        // Either it reconnected in time and fired at zero, or it didn't fire at all
        for (const s of qlab.starts()) expect(Math.abs(s.at - zeroAt(state))).toBeLessThan(25);
        lead.close();
      } finally {
        await restarted.stop();
      }
    } finally {
      b.stop();
    }
  });

  it("pauses the cue on Pause, resumes it on Start, and stops it on Reset", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    lead.send({ type: "setTime", virtualMs: -300 });
    await lead.flush();
    lead.send({ type: "start" });
    await waitFor(() => qlab.starts().length > 0);
    await sleep(200);

    const pausedAt = Date.now();
    lead.send({ type: "stop" });
    await waitFor(() => qlab.actions().length === 2);
    expect(qlab.actions()).toEqual(["start", "pause"]);
    // Straight away: one hop to the server, one to the bridge, one to QLab
    expect(qlab.received.find((m) => m.address === "/cue/2/pause").at - pausedAt).toBeLessThan(25);
    await waitFor(() => logs.some((l) => l.startsWith("Paused")));
    expect(logs.find((l) => l.startsWith("Paused"))).toMatch(/^Paused cue 2 \(timer paused at 0:00\.\d\) — QLab: ok$/);

    lead.send({ type: "start" });
    await waitFor(() => qlab.actions().length === 3);
    expect(qlab.actions()[2]).toBe("resume");

    // Reset while running stops it
    lead.send({ type: "reset" });
    await waitFor(() => qlab.actions().length === 4);
    expect(qlab.actions()[3]).toBe("stop");

    // Nothing more once stopped; the next count-in fires it again
    lead.send({ type: "setTime", virtualMs: -300 });
    await lead.flush();
    await sleep(100);
    expect(qlab.actions()).toHaveLength(4);
    lead.send({ type: "start" });
    await waitFor(() => qlab.actions().length === 5);
    expect(qlab.actions()[4]).toBe("start");
  });

  it("stops a paused cue on Reset or a new start time", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    for (const move of [{ type: "reset" }, { type: "setTime", virtualMs: 30_000 }]) {
      lead.send({ type: "setTime", virtualMs: -300 });
      await lead.flush();
      lead.send({ type: "start" });
      await waitFor(() => qlab.actions().at(-1) === "start");
      await sleep(100);
      lead.send({ type: "stop" });
      await waitFor(() => qlab.actions().at(-1) === "pause");
      lead.send(move);
      await waitFor(() => qlab.actions().at(-1) === "stop");
    }
    // Starting again from the new time doesn't resume it
    lead.send({ type: "start" });
    await lead.next((m) => m.type === "state" && m.state.running);
    await sleep(200);
    expect(qlab.actions()).toEqual(["start", "pause", "stop", "start", "pause", "stop"]);
  });

  it("leaves the cue alone when paused, cancelled or reset before zero", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    lead.send({ type: "setTime", virtualMs: -2000 });
    await lead.flush();
    lead.send({ type: "start" });
    await waitFor(() => logs.some((l) => l.startsWith("Armed")));
    lead.send({ type: "stop" });
    await lead.flush();
    lead.send({ type: "start" });
    await lead.flush();
    lead.send({ type: "cancel" });
    await lead.flush();
    lead.send({ type: "reset" });
    await lead.flush();
    await sleep(200);
    expect(qlab.actions()).toEqual([]);
  });

  it("disconnects from QLab when turned off, and reconnects when turned on", async ({ bridgeFor, lead, qlab, logs }) => {
    const bridge = bridgeFor();
    await ready(logs);
    expect(qlab.connections()).toBe(1);

    lead.send({ type: "setTime", virtualMs: -1000 });
    await lead.flush();
    lead.send({ type: "start" });
    await waitFor(() => logs.some((l) => l.startsWith("Armed")));
    lead.send({ type: "setQlab", enabled: false });
    await waitFor(() => qlab.connections() === 0);
    expect(bridge.qlabEnabled).toBe(false);
    expect(logs).toContain("Disarmed (QLab turned off from the lead page)");
    await sleep(1200);
    expect(qlab.actions()).toEqual([]);

    // A cue already passed zero isn't fired late when turned back on
    lead.send({ type: "setQlab", enabled: true });
    await waitFor(() => qlab.connections() === 1);
    await waitFor(() => logs.filter((l) => l.startsWith("QLab ready")).length === 2);
    lead.send({ type: "stop" });
    await lead.flush();
    await sleep(100);
    expect(qlab.actions()).toEqual([]);

    lead.send({ type: "setTime", virtualMs: -300 });
    await lead.flush();
    lead.send({ type: "start" });
    await waitFor(() => qlab.starts().length === 1);
  });

  it("leaves a cue it started alone while turned off", async ({ bridgeFor, lead, qlab, logs }) => {
    bridgeFor();
    await ready(logs);
    lead.send({ type: "setTime", virtualMs: -300 });
    await lead.flush();
    lead.send({ type: "start" });
    await waitFor(() => qlab.starts().length === 1);
    lead.send({ type: "setQlab", enabled: false });
    await waitFor(() => qlab.connections() === 0);
    lead.send({ type: "stop" });
    await lead.flush();
    lead.send({ type: "setQlab", enabled: true });
    await waitFor(() => qlab.connections() === 1);
    lead.send({ type: "start" });
    await lead.flush();
    lead.send({ type: "reset" });
    await lead.flush();
    await sleep(200);
    expect(qlab.actions()).toEqual(["start"]);
  });

  it("starts disconnected if QLab is already turned off", async ({ bridgeFor, lead, qlab, logs }) => {
    lead.send({ type: "setQlab", enabled: false });
    await lead.next("state");
    bridgeFor();
    await waitFor(() => logs.some((l) => l.startsWith("Connected")) && logs.some((l) => l.startsWith("QLab turned off")));
    await waitFor(() => qlab.connections() === 0);
    lead.send({ type: "setTime", virtualMs: -300 });
    await lead.flush();
    lead.send({ type: "start" });
    await sleep(600);
    expect(qlab.actions()).toEqual([]);
  });

  it("says when the cue isn't in QLab", async ({ bridgeFor, logs }) => {
    bridgeFor({ cue: "9" });
    await waitFor(() => logs.some((l) => l.includes("can't find /cue/9")));
  });

  it("sends the passcode first", async ({ server, logs }) => {
    const qlab = await startFakeQLab({ passcode: "1234" });
    const b = createBridge({ server: server.baseUrl, cue: "2", qlabPort: qlab.port, passcode: "1234", log: (m) => logs.push(m) });
    try {
      await waitFor(() => logs.some((l) => l.startsWith("QLab ready")));
      expect(qlab.received[0]).toMatchObject({ address: "/connect", args: ["1234"] });
    } finally {
      b.stop();
      await qlab.close();
    }
  });

  it("says when QLab denies access", async ({ server, logs }) => {
    const qlab = await startFakeQLab({ passcode: "1234" });
    const b = createBridge({ server: server.baseUrl, cue: "2", qlabPort: qlab.port, log: (m) => logs.push(m) });
    try {
      await waitFor(() => logs.some((l) => l.includes("denied access")));
    } finally {
      b.stop();
      await qlab.close();
    }
  });

  it("falls back to UDP when QLab's TCP port is down, authorised by the passcode", async ({ server, lead, logs }) => {
    const dgram = await import("node:dgram");
    const udp = dgram.createSocket("udp4");
    const got = [];
    // Like QLab: a passcode sent over UDP authorises later messages from that socket
    const authorised = new Set();
    udp.on("message", (m, rinfo) => {
      const msg = decodeOsc(m);
      const from = `${rinfo.address}:${rinfo.port}`;
      if (msg.address === "/connect" && msg.args[0] === "1234") authorised.add(from);
      else if (authorised.has(from)) got.push(msg);
    });
    await new Promise((r) => udp.bind(0, "127.0.0.1", r));
    // Nothing listens on this TCP port, only UDP
    const b = createBridge({ server: server.baseUrl, cue: "2", qlabPort: udp.address().port, passcode: "1234", log: (m) => logs.push(m) });
    try {
      await waitFor(() => logs.some((l) => l.startsWith("QLab not reachable")) && logs.some((l) => l.startsWith("Connected")));
      lead.send({ type: "setTime", virtualMs: -300 });
      await lead.flush();
      lead.send({ type: "start" });
      await waitFor(() => got.length > 0);
      expect(got[0].address).toBe("/cue/2/start");
      await waitFor(() => logs.some((l) => l.startsWith("Fired")));
      expect(logs.find((l) => l.startsWith("Fired"))).toMatch(/sent over UDP/);
    } finally {
      b.stop();
      udp.close();
    }
  });

  it("shows in the lead's Screens panel", async ({ bridgeFor, lead, logs }) => {
    bridgeFor();
    await ready(logs);
    lead.send({ type: "ping", t: Date.now(), rtt: null });
    const { clients } = await lead.next("clients");
    expect(clients).toContainEqual(expect.objectContaining({ name: "QLab bridge (cue 2)", role: "qlab" }));
  });

  it("shows bridges for different cues as separate screens", async ({ bridgeFor, lead, logs }) => {
    bridgeFor();
    bridgeFor({ cue: "3" });
    await ready(logs);
    await waitFor(() => logs.filter((l) => l.startsWith("Connected")).length === 2);
    await sleep(100);
    lead.send({ type: "ping", t: Date.now(), rtt: null });
    const { clients } = await lead.next("clients");
    const bridges = clients.filter((c) => c.name.startsWith("QLab bridge"));
    expect(bridges.map((c) => c.name).sort()).toEqual(["QLab bridge (cue 2)", "QLab bridge (cue 3)"]);
    expect(new Set(bridges.map((c) => c.id)).size).toBe(2);
  });
});
