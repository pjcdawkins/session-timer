// Tests for the Cloudflare Worker + TimerRoom Durable Object, running inside
// workerd via @cloudflare/vitest-pool-workers.

import {
  abortAllDurableObjects,
  evictAllDurableObjects,
  reset,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, test } from "vitest";
import { wrapSocket } from "../shared/client.js";
import { defineProtocolTests } from "../shared/protocol-suite.js";

const PASSWORD = "test-password";
const sockets: ReturnType<typeof wrapSocket>[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await reset();
  await abortAllDurableObjects();
});

async function connect() {
  const res = await exports.default.fetch("http://timer.test/ws", { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("No WebSocket in upgrade response");
  const client = wrapSocket(ws);
  ws.accept();
  sockets.push(client);
  return client;
}

// One shared Durable Object ("default-room"), so these tests run sequentially.
// A fresh object per test, since the suite caches the lead token per backend.
const backend = {
  connect,
  password: PASSWORD,
  async restart() {
    // Tears down the in-memory instance; durable storage is kept
    await evictAllDurableObjects();
  },
};
// biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures must destructure their context
const it = test.extend({ backend: async ({}, use: (b: typeof backend) => Promise<void>) => use({ ...backend }) });

describe("protocol", () => {
  defineProtocolTests(it);
});

describe("worker routing", () => {
  it("requires a WebSocket upgrade on /ws", async () => {
    const res = await exports.default.fetch("http://timer.test/ws");
    expect(res.status).toBe(426);
  });
});

describe("hibernation", () => {
  it("keeps sockets and their auth across eviction", async () => {
    const lead = await connect();
    await lead.next("state");
    lead.send({ type: "auth", password: PASSWORD });
    await lead.next("authResult");

    await evictAllDurableObjects();

    // Same socket, woken from hibernation: still authenticated
    lead.send({ type: "setTime", virtualMs: 5000 });
    expect((await lead.next("state")).state.accumulatedVirtualMs).toBe(5000);
  });
});

describe("heartbeat alarm", () => {
  it("re-broadcasts state to connected sockets", async () => {
    const c = await connect();
    await c.next("state");

    const stub = env.TIMER_ROOM.get(env.TIMER_ROOM.idFromName("default-room"));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await c.next("state")).state.running).toBe(false);
  });
});
