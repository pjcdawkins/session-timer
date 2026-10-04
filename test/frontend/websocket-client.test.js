import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal stand-in for the browser WebSocket, controlled by the test. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // --- test controls ---
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const latest = () => FakeWebSocket.instances.at(-1);

const STATE = {
  running: true,
  speed: 2,
  accumulatedVirtualMs: 1000,
  startRealTimestamp: 1_700_000_000_000,
  serverNow: 1_700_000_000_500,
  highlight: null,
};

/** @type {typeof import("../../public/js/websocket-client.js")} */
let client;
let handlers;
let listeners;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  localStorage.clear();
  sessionStorage.clear();
  // connect() adds page lifecycle listeners; track them so they can be removed
  listeners = [];
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, fn, opts) => {
      listeners.push(() => target.removeEventListener(type, fn, opts));
      add(type, fn, opts);
    });
  }
  handlers = { onState: vi.fn(), onAuth: vi.fn(), onConnection: vi.fn(), onClients: vi.fn() };
  vi.resetModules();
  client = await import("../../public/js/websocket-client.js");
});

afterEach(() => {
  for (const remove of listeners) remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function connect(opts = {}) {
  client.connect({ ...handlers, ...opts });
  return latest();
}

describe("connecting", () => {
  it("connects to /ws on the page's host", () => {
    const ws = connect();
    expect(ws.url).toBe(`ws://${location.host}/ws`);
  });

  it("introduces itself and pings on open", () => {
    const ws = connect({ clientRole: "lead" });
    ws.open();
    expect(handlers.onConnection).toHaveBeenLastCalledWith("connected");
    expect(ws.sent[0]).toMatchObject({ type: "hello", role: "lead", id: client.getClientId() });
    expect(ws.sent[1]).toMatchObject({ type: "ping", t: Date.now(), rtt: null });
  });

  it("pings every 2s", () => {
    const ws = connect();
    ws.open();
    ws.sent = [];
    vi.advanceTimersByTime(2000);
    ws.receive({ type: "pong", t: 0, serverNow: 0 });
    vi.advanceTimersByTime(2000);
    expect(ws.sent.map((m) => m.type)).toEqual(["ping", "ping"]);
  });

  it("send() reports whether the message went out", () => {
    const ws = connect();
    expect(client.send({ type: "start" })).toBe(false);
    ws.open();
    expect(client.send({ type: "start" })).toBe(true);
    expect(ws.sent.at(-1)).toEqual({ type: "start" });
  });
});

describe("messages", () => {
  it("passes state to onState and remembers it", () => {
    const ws = connect();
    ws.open();
    ws.receive({ type: "state", state: STATE });
    expect(handlers.onState).toHaveBeenCalledWith(STATE);
    expect(JSON.parse(localStorage.getItem("timer-last-state")).state).toEqual(STATE);
  });

  it("routes authResult and clients messages", () => {
    const ws = connect();
    ws.open();
    ws.receive({ type: "authResult", success: true, token: "abc" });
    ws.receive({ type: "authResult", success: false, reason: "rateLimited" });
    ws.receive({ type: "clients", clients: [{ id: "a" }], serverNow: 5 });
    expect(handlers.onAuth).toHaveBeenNthCalledWith(1, true, undefined, "abc");
    expect(handlers.onAuth).toHaveBeenNthCalledWith(2, false, "rateLimited", undefined);
    expect(handlers.onClients).toHaveBeenCalledWith([{ id: "a" }], 5);
  });

  it("ignores malformed messages", () => {
    const ws = connect();
    ws.open();
    expect(() => ws.onmessage({ data: "{nope" })).not.toThrow();
    expect(handlers.onState).not.toHaveBeenCalled();
  });
});

describe("saved state", () => {
  it("restores the last state on load, before connecting", () => {
    localStorage.setItem("timer-last-state", JSON.stringify({ state: STATE, offset: 0, savedAt: Date.now() - 60_000 }));
    connect();
    expect(handlers.onState).toHaveBeenCalledWith(STATE);
  });

  it("ignores state saved more than 12 hours ago", () => {
    localStorage.setItem(
      "timer-last-state",
      JSON.stringify({ state: STATE, offset: 0, savedAt: Date.now() - 13 * 60 * 60 * 1000 }),
    );
    connect();
    expect(handlers.onState).not.toHaveBeenCalled();
  });

  it("survives corrupt saved state", () => {
    localStorage.setItem("timer-last-state", "{corrupt");
    expect(() => connect()).not.toThrow();
  });
});

describe("reconnecting", () => {
  it("reconnects after a drop, backing off from 500ms", () => {
    const ws = connect();
    ws.open();
    ws.drop();
    expect(handlers.onConnection).toHaveBeenLastCalledWith("reconnecting");

    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Second failure waits longer (750ms)
    latest().drop();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(250);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("caps the backoff at 2s", () => {
    connect().drop();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(2000);
      latest().drop();
    }
    const count = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances).toHaveLength(count + 1);
  });

  it("reports disconnected after 3 failed attempts, then connected again", () => {
    connect().drop();
    vi.advanceTimersByTime(500);
    latest().drop();
    vi.advanceTimersByTime(750);
    expect(handlers.onConnection).toHaveBeenLastCalledWith("reconnecting");
    latest().drop();
    expect(handlers.onConnection).toHaveBeenLastCalledWith("disconnected");

    vi.advanceTimersByTime(2000);
    latest().open();
    expect(handlers.onConnection).toHaveBeenLastCalledWith("connected");
  });

  it("gives up on a connect attempt that hangs for 4s", () => {
    connect();
    vi.advanceTimersByTime(4000);
    expect(handlers.onConnection).toHaveBeenLastCalledWith("reconnecting");
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("treats a silent socket as dead after 6s", () => {
    const ws = connect();
    ws.open();
    // Nothing received: dead by the first ping tick after 6s
    vi.advanceTimersByTime(6000);
    expect(handlers.onConnection).not.toHaveBeenCalledWith("reconnecting");
    vi.advanceTimersByTime(2000);
    expect(handlers.onConnection).toHaveBeenLastCalledWith("reconnecting");
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("keeps a socket alive while messages arrive", () => {
    const ws = connect();
    ws.open();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(2000);
      ws.receive({ type: "pong", t: Date.now(), serverNow: Date.now() });
    }
    expect(handlers.onConnection).toHaveBeenCalledTimes(1);
  });

  it("ignores events from a socket it has already replaced", () => {
    const old = connect();
    old.open();
    old.drop();
    vi.advanceTimersByTime(500);
    latest().open();
    old.receive({ type: "state", state: STATE });
    old.onclose();
    expect(handlers.onState).not.toHaveBeenCalled();
    expect(handlers.onConnection).toHaveBeenLastCalledWith("connected");
  });

  it("reconnects immediately when the page becomes visible", () => {
    connect().drop();
    expect(FakeWebSocket.instances).toHaveLength(1);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("pings instead of reconnecting when the network returns on a healthy socket", () => {
    const ws = connect();
    ws.open();
    ws.sent = [];
    window.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.sent.map((m) => m.type)).toEqual(["ping"]);
  });
});

describe("screen name", () => {
  it("defaults to the device type plus part of the client id", () => {
    expect(client.getClientName()).toMatch(new RegExp(`^\\w+ ${client.getClientId().slice(0, 4)}$`));
  });

  it("takes ?name= from the URL and remembers it", () => {
    history.replaceState(null, "", "/?name=Stage%20L");
    expect(client.getClientName()).toBe("Stage L");
    history.replaceState(null, "", "/");
    expect(client.getClientName()).toBe("Stage L");
  });

  it("keeps the client id stable within a tab", () => {
    expect(client.getClientId()).toBe(client.getClientId());
    expect(client.getClientId()).toMatch(/^[a-z0-9]+$/);
  });
});
