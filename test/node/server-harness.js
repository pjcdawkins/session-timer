// Spawns server.js as a child process on a free port with its own state file.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapSocket } from "../shared/client.js";

const SERVER = fileURLToPath(new URL("../../server.js", import.meta.url));
export const PASSWORD = "test-password";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer({ stateFile, port, password = PASSWORD, env = {} } = {}) {
  port ??= await freePort();
  stateFile ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), "timer-test-")), "state.json");

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), STATE_FILE: stateFile, LEAD_PASSWORD: password, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      if (output.includes("Lead password")) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => reject(new Error(`server.js exited (${code}) before listening:\n${output}`)));
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    stateFile,
    baseUrl,
    get output() {
      return output;
    },

    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const client = wrapSocket(ws);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      return client;
    },

    stop() {
      // A killed process has a signalCode and no exitCode
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGKILL");
      });
    },
  };
}
