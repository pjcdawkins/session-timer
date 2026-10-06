#!/usr/bin/env node
// QLab bridge: fires a QLab cue at the moment the timer reaches zero, then
// pauses, resumes and stops it as the lead pauses, restarts and resets the
// timer. The lead page can turn QLab off, which disconnects the bridge from it.
//
// Joins the timer (local server or the online one) as a screen, keeps its clock
// in sync the same way the browser screens do, and sends an OSC message to QLab
// at zero. Works with any QLab on the network; run it on the QLab Mac for the
// lowest latency.
//
//   node qlab-bridge.mjs --cue 2
//   node qlab-bridge.mjs --cue 2 --server https://timer.ligetiquartet.com
//
// Run with --help for all options.

import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// OSC
// ---------------------------------------------------------------------------

// Characters that can't appear in an OSC address part: separators, whitespace
// and pattern-matching wildcards (a "*" would start every matching cue).
const OSC_RESERVED = /[\s#*,/?[\]{}!]/;

/** Throws if `value` can't be used as one part of an OSC address. */
export function checkAddressPart(value, what) {
  if (typeof value !== "string" || value === "") throw new Error(`${what} is empty`);
  if (OSC_RESERVED.test(value) || /[^\x21-\x7e]/.test(value)) {
    throw new Error(
      `${what} "${value}" contains a character OSC can't address (spaces and # * , / ? [ ] { } ! are not allowed). ` +
        "Use the cue's unique ID with --cue-id instead.",
    );
  }
}

/** The OSC address prefix for a cue, e.g. "/cue/2" or "/workspace/ABC/cue_id/XYZ". */
export function cuePath({ cue, cueId, workspace }) {
  if ((cue == null) === (cueId == null)) throw new Error("Give exactly one of --cue or --cue-id");
  let prefix = "";
  if (workspace != null) {
    checkAddressPart(workspace, "Workspace ID");
    prefix = `/workspace/${workspace}`;
  }
  if (cue != null) {
    checkAddressPart(cue, "Cue number");
    return `${prefix}/cue/${cue}`;
  }
  checkAddressPart(cueId, "Cue ID");
  return `${prefix}/cue_id/${cueId}`;
}

function oscString(s) {
  const bytes = Buffer.from(s, "utf8");
  const padded = Buffer.alloc((bytes.length + 4) & ~3); // at least one NUL, padded to 4
  bytes.copy(padded);
  return padded;
}

function oscInt(n) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(n);
  return buf;
}

/** Encode an OSC message with string and integer arguments. */
export function encodeOsc(address, args = []) {
  const tags = args.map((a) => (typeof a === "number" ? "i" : "s")).join("");
  return Buffer.concat([
    oscString(address),
    oscString(`,${tags}`),
    ...args.map((a) => (typeof a === "number" ? oscInt(a) : oscString(a))),
  ]);
}

/** Decode an OSC message; only string arguments are returned. */
export function decodeOsc(buf) {
  let pos = 0;
  const readString = () => {
    const end = buf.indexOf(0, pos);
    if (end < 0) throw new Error("Unterminated OSC string");
    const s = buf.toString("utf8", pos, end);
    pos = (end + 4) & ~3;
    return s;
  };
  const address = readString();
  const args = [];
  if (pos < buf.length) {
    const tags = readString();
    for (const tag of tags.slice(1)) {
      if (tag === "s") args.push(readString());
      else break;
    }
  }
  return { address, args };
}

// QLab's TCP OSC uses SLIP framing (OSC 1.1)
const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

export function slipEncode(packet) {
  const out = [SLIP_END];
  for (const b of packet) {
    if (b === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
    else if (b === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
    else out.push(b);
  }
  out.push(SLIP_END);
  return Buffer.from(out);
}

/** Returns a function that takes stream chunks and calls `onPacket` for each complete packet. */
export function slipDecoder(onPacket) {
  let current = [];
  let escaped = false;
  return (chunk) => {
    for (const b of chunk) {
      if (escaped) {
        current.push(b === SLIP_ESC_END ? SLIP_END : b === SLIP_ESC_ESC ? SLIP_ESC : b);
        escaped = false;
      } else if (b === SLIP_ESC) {
        escaped = true;
      } else if (b === SLIP_END) {
        if (current.length) onPacket(Buffer.from(current));
        current = [];
      } else {
        current.push(b);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// QLab connection
// ---------------------------------------------------------------------------

const QLAB_RECONNECT_MS = 2000;
const QLAB_CHECK_INTERVAL_MS = 15_000;
const QLAB_REPLY_TIMEOUT_MS = 1500;

/**
 * Talks to QLab over TCP (so we get replies and can check the cue exists).
 * If TCP is down when a cue must fire, falls back to UDP to the same port.
 * QLab authorises a passcode per connection, and for UDP per sending socket,
 * so the UDP socket sends /connect too and keeps it fresh, ready for that.
 * The lead can turn it off (setEnabled), which closes the connection.
 */
class QLabLink {
  constructor({ host, port, path, workspace, passcode, log }) {
    Object.assign(this, { host, port, path, workspace, passcode, log });
    this.socket = null;
    this.connected = false;
    this.pending = new Map(); // reply address → [resolve]
    this.lastStatus = null;
    this.stopped = false;
    this.enabled = true;
    this.udp = dgram.createSocket("udp4");
    this.udp.on("error", (err) => this.log(`UDP socket error: ${err.message}`));
    this.connect();
    this.udpConnect();
    this.checkTimer = setInterval(() => {
      this.check();
      this.udpConnect();
    }, QLAB_CHECK_INTERVAL_MS);
  }

  connectAddress() {
    return `${this.workspace != null ? `/workspace/${this.workspace}` : ""}/connect`;
  }

  /** Authorise the UDP fallback socket with the passcode (QLab replies to port 53001, which we don't need). */
  udpConnect() {
    if (this.passcode == null || this.stopped || !this.enabled) return;
    this.udp.send(encodeOsc(this.connectAddress(), [this.passcode]), this.port, this.host);
  }

  connect() {
    if (this.stopped || !this.enabled || this.socket) return;
    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("connect", async () => {
      this.connected = true;
      if (this.passcode != null) {
        const reply = await this.request(this.connectAddress(), [this.passcode]);
        if (reply && reply.status !== "ok") this.log(`QLab refused the passcode (${reply.status}${reply.data ? `: ${reply.data}` : ""})`);
      }
      // So that /start replies too, confirming the cue started
      this.socket?.write(slipEncode(encodeOsc("/alwaysReply", [1])));
      this.check();
    });
    socket.on("data", slipDecoder((packet) => this.onPacket(packet)));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.socket = null;
      if (this.stopped) return;
      this.report("unreachable", `QLab not reachable at ${this.host}:${this.port} (is it running?) — retrying`);
      this.dropPending();
      setTimeout(() => this.connect(), QLAB_RECONNECT_MS);
    });
  }

  dropPending() {
    for (const resolvers of this.pending.values()) for (const r of resolvers) r(null);
    this.pending.clear();
  }

  /** Connect to QLab, or disconnect and leave it alone until turned on again. */
  setEnabled(on) {
    if (on === this.enabled || this.stopped) return;
    this.enabled = on;
    if (on) {
      this.lastStatus = null;
      this.log("QLab turned on from the lead page — connecting");
      this.connect();
      this.udpConnect();
      return;
    }
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    socket?.destroy();
    this.dropPending();
    this.report("off", "QLab turned off from the lead page — disconnected (the cue won't be fired, paused or stopped)");
  }

  onPacket(packet) {
    let msg;
    try {
      msg = decodeOsc(packet);
    } catch {
      return;
    }
    if (!msg.address.startsWith("/reply/")) return;
    const resolvers = this.pending.get(msg.address);
    if (!resolvers?.length) return;
    let body = {};
    try {
      body = JSON.parse(msg.args[0] ?? "{}");
    } catch { /* not JSON */ }
    resolvers.shift()(body);
    if (!resolvers.length) this.pending.delete(msg.address);
  }

  /** Send over TCP and wait for QLab's reply ({status, data}), or null on timeout. */
  request(address, args = []) {
    if (!this.connected) return Promise.resolve(null);
    const replyAddress = `/reply${address}`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (body) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(body);
      };
      const timer = setTimeout(() => {
        const list = this.pending.get(replyAddress);
        list?.splice(list.indexOf(finish), 1);
        finish(null);
      }, QLAB_REPLY_TIMEOUT_MS);
      if (!this.pending.has(replyAddress)) this.pending.set(replyAddress, []);
      this.pending.get(replyAddress).push(finish);
      this.socket.write(slipEncode(encodeOsc(address, args)));
    });
  }

  /** Ask QLab for the cue's name, to show the cue is there before we need it. */
  async check() {
    if (!this.connected) return;
    const reply = await this.request(`${this.path}/name`);
    if (!this.connected) return;
    if (!reply) {
      this.report("noreply", `QLab at ${this.host}:${this.port} didn't reply — is a workspace open?`);
    } else if (reply.status === "ok") {
      const name = reply.data ? ` "${reply.data}"` : "";
      this.report(`ok${name}`, `QLab ready: ${this.path}${name}`);
    } else if (reply.status === "denied") {
      this.report("denied", "QLab denied access — give a passcode with View and Control access with --passcode (QLab: Workspace Settings → Network → OSC Access)");
    } else {
      this.report(reply.status, `QLab can't find ${this.path} (${reply.status}) — check the cue number and that the right workspace is in front`);
    }
  }

  report(status, message) {
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.log(message);
  }

  /**
   * Start, pause, resume or stop the cue. Resolves with QLab's reply status,
   * or how the UDP send went.
   */
  async cue(action) {
    if (!this.enabled) return "not sent (QLab is turned off)";
    const address = `${this.path}/${action}`;
    if (this.connected) {
      const reply = await this.request(address);
      return reply?.status ?? "no reply";
    }
    return new Promise((resolve) => {
      this.udp.send(encodeOsc(address), this.port, this.host, (err) => {
        resolve(err ? `UDP send failed (TCP was down): ${err.message}` : "sent over UDP (TCP was down)");
      });
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.checkTimer);
    this.socket?.destroy();
    this.udp.close();
  }
}

// ---------------------------------------------------------------------------
// Timer connection and scheduling
// ---------------------------------------------------------------------------

const PING_INTERVAL = 2000;
const DEAD_AFTER = 6000;
const RECONNECT_DELAY = 1000;
const CLOCK_WINDOW = 10;
// Sleep with a timer until this close to zero, then spin for sub-ms precision
const SPIN_MS = 20;
// A clock correction while armed that puts zero this far in the past still fires
const LATE_CORRECTION_MS = 50;

/**
 * Server time at which a running timer reaches virtual zero, or null if it
 * isn't counting towards zero. accumulatedVirtualMs only moves on pause or a
 * speed change, so this keeps returning the same (past) time after zero.
 */
export function zeroAt(state) {
  if (!state?.running || state.startRealTimestamp == null) return null;
  if (state.accumulatedVirtualMs >= 0) return null;
  return state.startRealTimestamp - state.accumulatedVirtualMs / state.speed;
}

/** A virtual position for the log, e.g. "-0:05" or "1:23.4". */
export function formatPosition(ms) {
  const sign = ms < 0 ? "-" : "";
  const tenths = Math.round(Math.abs(ms) / 100);
  const s = Math.floor(tenths / 10);
  const frac = tenths % 10 ? `.${tenths % 10}` : "";
  return `${sign}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}${frac}`;
}

function wsUrl(server) {
  const url = new URL("/ws", server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * @param {object} options
 * @param {string} options.server   Timer URL, e.g. http://localhost:8787
 * @param {string} [options.cue]    QLab cue number
 * @param {string} [options.cueId]  QLab cue unique ID (instead of a number)
 * @param {string} [options.workspace] QLab workspace ID
 * @param {string} [options.qlabHost]
 * @param {number} [options.qlabPort]
 * @param {string} [options.passcode] QLab OSC passcode
 * @param {string} [options.name]   Name in the lead's Screens panel
 * @param {(msg: string) => void} [options.log]
 */
export function createBridge({ server, cue, cueId, workspace, qlabHost = "127.0.0.1", qlabPort = 53000, passcode, name, log = console.log }) {
  const path = cuePath({ cue, cueId, workspace });
  const label = cue != null ? `cue ${cue}` : `cue ID ${cueId}`;
  const qlab = new QLabLink({ host: qlabHost, port: qlabPort, path, workspace, passcode, log });

  // Stable across restarts (so the Screens panel doesn't collect stale entries)
  // but distinct for each cue, so two bridges on one Mac show separately
  const clientId = `qlab-${crypto.createHash("sha256").update(`${os.hostname()}\n${path}`).digest("hex").slice(0, 16)}`;
  const clientName = name ?? `QLab bridge (${label})`;

  let ws = null;
  let state = null;
  let samples = [];
  let fallbackOffset = 0;
  let pingTimer = null;
  let reconnectTimer = null;
  let lastMessageAt = 0;
  let stopped = false;
  let wasConnected = null;

  // Scheduling
  let timer = null;
  let generation = 0; // bumped on every (re)arm, so an older spin loop stops
  let armedFor = null; // server time of the zero we're waiting for
  let armedKey = null; // and the run it belongs to
  let firedKey = null; // run (start time + position + speed) we've already fired for

  // The cue as far as the bridge knows: null (not started by us, or stopped),
  // { playing: true }, or { pausedAt } (the timer position it was paused at)
  let cueState = null;

  const best = () => (samples.length ? samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)) : null);
  const offset = () => best()?.offset ?? fallbackOffset;

  function connect() {
    if (stopped) return;
    const socket = new WebSocket(wsUrl(server));
    ws = socket;
    const connectTimeout = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) drop(socket);
    }, 4000);

    socket.addEventListener("open", () => {
      clearTimeout(connectTimeout);
      if (ws !== socket) return;
      lastMessageAt = Date.now();
      samples = [];
      send({ type: "hello", id: clientId, name: clientName, role: "qlab" });
      ping();
      pingTimer = setInterval(() => {
        if (Date.now() - lastMessageAt > DEAD_AFTER) drop(socket);
        else ping();
      }, PING_INTERVAL);
      if (wasConnected !== true) log(`Connected to timer at ${server}`);
      wasConnected = true;
    });

    socket.addEventListener("message", (event) => {
      if (ws !== socket) return;
      const receivedAt = Date.now();
      lastMessageAt = receivedAt;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "state") {
        fallbackOffset = msg.state.serverNow - receivedAt;
        state = msg.state;
        qlab.setEnabled(state.qlab !== false);
        if (!qlab.enabled) cueState = null; // Left alone while off, so no longer ours to pause
        followCue();
        schedule();
      } else if (msg.type === "pong") {
        const rtt = receivedAt - msg.t;
        if (rtt < 0) return;
        samples.push({ rtt, offset: msg.serverNow + rtt / 2 - receivedAt });
        if (samples.length > CLOCK_WINDOW) samples.shift();
        schedule();
      }
    });

    socket.addEventListener("close", () => drop(socket));
    socket.addEventListener("error", () => drop(socket));
  }

  function drop(socket) {
    if (ws !== socket) return;
    ws = null;
    clearInterval(pingTimer);
    try { socket.close(); } catch { /* ignore */ }
    if (stopped) return;
    if (wasConnected === true) log(`Lost the timer at ${server} — reconnecting (a cue already armed will still fire)`);
    else if (wasConnected === null) log(`Can't reach the timer at ${server} — retrying`);
    wasConnected = false;
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  }

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function ping() {
    send({ type: "ping", t: Date.now(), rtt: best()?.rtt ?? null });
  }

  function disarm() {
    generation++;
    clearTimeout(timer);
    timer = null;
    armedFor = null;
    armedKey = null;
  }

  /**
   * Make a cue we started follow the timer: Pause pauses it, Start resumes it
   * from there, and Reset (or setting another time) stops it, since it can't
   * follow a jump.
   */
  function followCue() {
    if (!cueState) return;
    const position = state.accumulatedVirtualMs;
    if (cueState.playing) {
      if (state.running) return;
      if (position > 0) {
        cueState = { pausedAt: position };
        cueAction("pause", "Paused", `timer paused at ${formatPosition(position)}`);
      } else {
        cueState = null;
        cueAction("stop", "Stopped", `timer reset to ${formatPosition(position)}`);
      }
    } else if (state.running) {
      const from = state.startedFromMs ?? position;
      if (from === cueState.pausedAt) {
        cueState = { playing: true };
        cueAction("resume", "Resumed", `timer started at ${formatPosition(from)}`);
      } else {
        cueState = null;
        cueAction("stop", "Stopped", `timer started from ${formatPosition(from)}, not where it was paused`);
      }
    } else if (position !== cueState.pausedAt) {
      cueState = null;
      cueAction("stop", "Stopped", `timer reset or set to ${formatPosition(position)}`);
    }
  }

  async function cueAction(action, verb, why) {
    const status = await qlab.cue(action);
    log(`${verb} ${label} (${why}) — QLab: ${status}`);
  }

  /** (Re)arm for the next zero from the current state and clock offset. */
  function schedule() {
    if (!qlab.enabled) {
      if (armedFor != null) log("Disarmed (QLab turned off from the lead page)");
      disarm();
      return;
    }
    const target = zeroAt(state);
    const key = state && `${state.startRealTimestamp}:${state.accumulatedVirtualMs}:${state.speed}`;
    if (target == null || key === firedKey) {
      if (armedFor != null) log("Disarmed (timer paused, cancelled, reset or past zero)");
      disarm();
      return;
    }
    // Local time of zero, as a performance.now() value
    const localTarget = target - offset();
    const delay = localTarget - Date.now();
    if (delay <= 0 && armedKey === key && delay > -LATE_CORRECTION_MS) {
      // A clock update for this same run moved zero just into the past
      fire(key, performance.now() + delay);
      return;
    }
    if (delay <= 0) {
      // Joining long after zero (e.g. mid-piece) isn't worth a message
      if (delay > -5000) log(`Missed zero by ${(-delay).toFixed(0)} ms — not firing ${label}`);
      firedKey = key;
      disarm();
      return;
    }
    const perfTarget = performance.now() + delay;
    const wasArmed = armedFor != null;
    clearTimeout(timer);
    const mine = ++generation;
    armedFor = target;
    armedKey = key;
    if (!wasArmed) log(`Armed: ${label} fires in ${(delay / 1000).toFixed(2)} s`);

    const spin = () => {
      if (generation !== mine) return;
      if (performance.now() >= perfTarget) fire(key, perfTarget);
      else setImmediate(spin);
    };
    timer = setTimeout(spin, Math.max(0, delay - SPIN_MS));
  }

  async function fire(key, perfTarget) {
    const late = performance.now() - perfTarget;
    firedKey = key;
    disarm();
    cueState = { playing: true };
    const status = await qlab.cue("start");
    log(`Fired ${label} at zero (${late.toFixed(1)} ms after) — QLab: ${status}`);
  }

  connect();

  return {
    get armed() {
      return armedFor != null;
    },
    get clockOffset() {
      return offset();
    },
    get qlabEnabled() {
      return qlab.enabled;
    },
    stop() {
      stopped = true;
      disarm();
      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
      qlab.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = `Usage: node qlab-bridge.mjs --cue <number> [options]

Fires a QLab cue when the timer reaches zero; Pause, Start and Reset on the
lead page then pause, resume and stop it. The lead page can also turn QLab off.

  --cue <number>       QLab cue number, e.g. 2, 2a, 1.5
  --cue-id <id>        QLab cue unique ID (instead of --cue)
  --server <url>       Timer to follow (default http://localhost:8787),
                       e.g. https://timer.ligetiquartet.com
  --qlab <host[:port]> Where QLab is (default 127.0.0.1:53000)
  --workspace <id>     QLab workspace ID (default: the front workspace)
  --passcode <code>    QLab OSC passcode (Workspace Settings → Network →
                       OSC Access); it needs View and Control access
  --name <name>        Name in the lead's Screens panel
  -h, --help           Show this help`;

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        cue: { type: "string" },
        "cue-id": { type: "string" },
        server: { type: "string", default: "http://localhost:8787" },
        qlab: { type: "string", default: "127.0.0.1:53000" },
        workspace: { type: "string" },
        passcode: { type: "string" },
        name: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const [qlabHost, qlabPortStr] = values.qlab.split(":");
  const qlabPort = qlabPortStr ? Number(qlabPortStr) : 53000;
  if (!qlabHost || !Number.isInteger(qlabPort) || qlabPort < 1 || qlabPort > 65535) {
    console.error(`Invalid --qlab "${values.qlab}" (expected host or host:port)`);
    process.exit(2);
  }

  const time = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
  let bridge;
  try {
    bridge = createBridge({
      server: values.server,
      cue: values.cue,
      cueId: values["cue-id"],
      workspace: values.workspace,
      qlabHost,
      qlabPort,
      passcode: values.passcode,
      name: values.name,
      log: (msg) => console.log(`${time()}  ${msg}`),
    });
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      bridge.stop();
      process.exit(0);
    });
  }
}

if (import.meta.main) main();
