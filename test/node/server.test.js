// Tests for the local Node.js server (server.js), run as a real child process.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
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
      async restart(beforeStart, options) {
        const { port, stateFile } = current;
        await current.stop();
        beforeStart?.(stateFile);
        current = await startServer({ stateFile, port, ...options });
      },
    });
    for (const s of sockets) s.close();
    await current.stop();
    // The state file's directory also holds the lead token secret file
    fs.rmSync(path.dirname(current.stateFile), { recursive: true, force: true });
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
    expect(state).toMatchObject({ running: false, speed: 1, accumulatedVirtualMs: -5000 });
  });
});

describe.concurrent("lead token secret file", () => {
  const tokenFile = (server) => path.join(path.dirname(server.stateFile), ".timer-lead-secret.json");

  async function login(server, password = PASSWORD) {
    const c = await server.connect();
    c.send({ type: "auth", password });
    const result = await c.next("authResult");
    c.close();
    return result;
  }

  it("is private to the server's user", async ({ server }) => {
    await login(server);
    expect(fs.statSync(tokenFile(server)).mode & 0o777).toBe(0o600);
  });

  it("doesn't contain the password", async ({ server }) => {
    await login(server);
    expect(fs.readFileSync(tokenFile(server), "utf8")).not.toContain(PASSWORD);
  });

  it("replaces a token file from before tokens expired", async ({ server }) => {
    const legacy = path.join(path.dirname(server.stateFile), ".timer-lead-token.json");
    await server.restart(() => fs.writeFileSync(legacy, JSON.stringify({ token: "0".repeat(64), passwordCheck: "x" })));
    expect(fs.existsSync(legacy)).toBe(false);
    const c = await server.connect();
    c.send({ type: "auth", token: "0".repeat(64) });
    expect(await c.next("authResult")).toEqual({ type: "authResult", success: false });
  });

  it("tokens stop working once they expire", async ({ server }) => {
    await server.restart(undefined, { env: { LEAD_TOKEN_TTL_MS: "1000" } });
    const { token } = await login(server);
    const c = await server.connect();
    c.send({ type: "auth", token });
    expect(await c.next("authResult")).toMatchObject({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    c.send({ type: "auth", token });
    expect(await c.next("authResult")).toEqual({ type: "authResult", success: false });
  });

  it("is revoked when LEAD_PASSWORD changes", async ({ server }) => {
    const { token } = await login(server);
    await server.restart(undefined, { password: "new-password" });

    const c = await server.connect();
    c.send({ type: "auth", token });
    expect(await c.next("authResult")).toEqual({ type: "authResult", success: false });

    const fresh = await login(server, "new-password");
    expect(fresh.success).toBe(true);
    expect(fresh.token).not.toBe(token);
  });
});
