// Tests for the local Node.js server (server.js), run as a real child process.

import fs from "node:fs";
import http from "node:http";
import { describe, expect, test } from "vitest";
import { defineProtocolTests } from "../shared/protocol-suite.js";
import { PASSWORD, startServer } from "./server-harness.js";

// Each test gets its own server process (own port and state file), so the
// tests are independent and can run concurrently.
const it = test.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures must destructure their context
  server: async ({}, use) => {
    let current = await startServer();
    const sockets = [];
    await use({
      get port() {
        return current.port;
      },
      get stateFile() {
        return current.stateFile;
      },
      get output() {
        return current.output;
      },
      async connect() {
        const c = await current.connect();
        sockets.push(c);
        return c;
      },
      /** SIGKILL (like a crash) then start again on the same port and state file. */
      async restart(beforeStart) {
        const { port, stateFile } = current;
        await current.stop();
        beforeStart?.(stateFile);
        current = await startServer({ stateFile, port });
      },
    });
    for (const s of sockets) s.close();
    await current.stop();
    fs.rmSync(current.stateFile, { force: true });
  },
  backend: async ({ server }, use) => {
    await use({ connect: () => server.connect(), restart: () => server.restart(), password: PASSWORD });
  },
});

describe.concurrent("protocol", () => {
  defineProtocolTests(it);
});

/** Raw GET so paths like /../ reach the server un-normalised (fetch would resolve them). */
function get(server, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: server.port, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

describe.concurrent("static files", () => {
  it("serves the viewer at /", async ({ server }) => {
    const res = await get(server, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toBe(fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8"));
  });

  it.for(["/lead", "/lead/", "/lead?x=1"])("serves the lead page at %s", async (path, { server }) => {
    const res = await get(server, path);
    expect(res.status).toBe(200);
    expect(res.body).toBe(fs.readFileSync(new URL("../../public/lead.html", import.meta.url), "utf8"));
  });

  it("serves JS modules with a JS content type and no-cache", async ({ server }) => {
    const res = await get(server, "/js/clock.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("404s for missing files", async ({ server }) => {
    expect((await get(server, "/nope.html")).status).toBe(404);
  });

  it.for(["/../server.js", "/..%2fserver.js", "/js/../../package.json"])(
    "does not serve files outside public/ (%s)",
    async (path, { server }) => {
      const res = await get(server, path);
      expect([403, 404]).toContain(res.status);
      expect(res.body).not.toContain("LEAD_PASSWORD");
      expect(res.body).not.toContain("shared-timer");
    },
  );
});

describe.concurrent("state file", () => {
  it("is written on every change", async ({ server }) => {
    const lead = await server.connect();
    await lead.next("state");
    lead.send({ type: "auth", password: PASSWORD });
    await lead.next("authResult");
    lead.send({ type: "setTime", virtualMs: 1234 });
    await lead.next("state");
    expect(JSON.parse(fs.readFileSync(server.stateFile, "utf8"))).toMatchObject({ accumulatedVirtualMs: 1234 });
  });

  it("starts with defaults if the state file is corrupt", async ({ server }) => {
    await server.restart((stateFile) => fs.writeFileSync(stateFile, "{corrupt"));
    expect(server.output).toContain("Could not read");

    const c = await server.connect();
    const { state } = await c.next("state");
    expect(state).toMatchObject({ running: false, speed: 1, accumulatedVirtualMs: -3000 });
  });
});
