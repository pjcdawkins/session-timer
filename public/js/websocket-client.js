import { addSample, setFallbackOffset, getClockOffset, getRtt } from "./clock.js";

const PING_INTERVAL = 2000;
// No message (pong or state) for this long → treat the socket as dead.
// Catches silent Wi-Fi drops where the browser never fires onclose.
const DEAD_AFTER = 6000;
const CONNECT_TIMEOUT = 4000;
const MIN_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 2000;
// Restored state older than this is ignored on page load.
const SAVED_STATE_MAX_AGE = 12 * 60 * 60 * 1000;
const SAVED_STATE_KEY = "timer-last-state";

let ws = null;
let handlers = {};
let role = "viewer";
let reconnectDelay = MIN_RECONNECT_DELAY;
let reconnectTimer = null;
let pingTimer = null;
let lastMessageAt = 0;
let failedAttempts = 0;

// Connection status: "connected", "reconnecting", or "disconnected"
// "reconnecting" = transient, will retry soon
// "disconnected" = multiple retries failed, still retrying but user may need to act

export function connect({ onState, onAuth, onConnection, onClients, clientRole = "viewer" }) {
  handlers = { onState, onAuth, onConnection, onClients };
  role = clientRole;
  restoreSavedState();
  doConnect();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkNow();
  });
  window.addEventListener("online", checkNow);
  window.addEventListener("pageshow", checkNow);
}

// Per tab (sessionStorage), so two tabs on one device show up as two screens,
// but stable across reloads and reconnects of the same tab.
export function getClientId() {
  let id = sessionStorage.getItem("timer-client-id");
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("timer-client-id", id);
  }
  return id;
}

export function getClientName() {
  const fromUrl = new URLSearchParams(location.search).get("name");
  if (fromUrl) localStorage.setItem("timer-screen-name", fromUrl);
  return localStorage.getItem("timer-screen-name") || defaultName();
}

export function setClientName(name) {
  localStorage.setItem("timer-screen-name", name);
  // URL param would override it on next load
  const url = new URL(location.href);
  if (url.searchParams.has("name")) {
    url.searchParams.set("name", name);
    history.replaceState(null, "", url);
  }
  send({ type: "hello", id: getClientId(), name, role });
}

function defaultName() {
  const ua = navigator.userAgent;
  const device =
    /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad" :
    /iPhone/.test(ua) ? "iPhone" :
    /Android/.test(ua) ? "Android" :
    /Macintosh/.test(ua) ? "Mac" :
    /Windows/.test(ua) ? "Windows" : "Device";
  return `${device} ${getClientId().slice(0, 4)}`;
}

function doConnect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  ws = socket;

  // A connect attempt to an unreachable host can hang for a minute or more.
  const connectTimeout = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) handleDisconnect(socket);
  }, CONNECT_TIMEOUT);

  socket.onopen = () => {
    clearTimeout(connectTimeout);
    if (ws !== socket) return;
    reconnectDelay = MIN_RECONNECT_DELAY;
    failedAttempts = 0;
    lastMessageAt = Date.now();
    send({ type: "hello", id: getClientId(), name: getClientName(), role });
    ping();
    startPinging();
    handlers.onConnection?.("connected");
  };

  socket.onmessage = (event) => {
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
      setFallbackOffset(msg.state.serverNow - receivedAt);
      saveState(msg.state);
      handlers.onState?.(msg.state);
    } else if (msg.type === "pong") {
      addSample(msg.t, msg.serverNow, receivedAt);
    } else if (msg.type === "clients") {
      handlers.onClients?.(msg.clients, msg.serverNow);
    } else if (msg.type === "authResult") {
      handlers.onAuth?.(msg.success, msg.reason, msg.token);
    }
  };

  socket.onclose = () => handleDisconnect(socket);
  socket.onerror = () => handleDisconnect(socket);
}

function handleDisconnect(socket) {
  if (ws !== socket) return; // already handled
  ws = null;
  stopPinging();
  try { socket.close(); } catch { /* ignore */ }
  failedAttempts++;
  handlers.onConnection?.(failedAttempts >= 3 ? "disconnected" : "reconnecting");
  scheduleReconnect();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(doConnect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
}

function ping() {
  send({ type: "ping", t: Date.now(), rtt: getRtt() });
}

function startPinging() {
  stopPinging();
  pingTimer = setInterval(() => {
    if (ws && Date.now() - lastMessageAt > DEAD_AFTER) {
      handleDisconnect(ws);
      return;
    }
    ping();
  }, PING_INTERVAL);
}

function stopPinging() {
  clearInterval(pingTimer);
  pingTimer = null;
}

/** Called when the page wakes up or the network comes back: don't wait for timers. */
function checkNow() {
  if (ws?.readyState === WebSocket.OPEN) {
    ping();
  } else if (!ws || ws.readyState !== WebSocket.CONNECTING) {
    reconnectDelay = MIN_RECONNECT_DELAY;
    doConnect();
  }
}

function saveState(state) {
  try {
    localStorage.setItem(SAVED_STATE_KEY, JSON.stringify({ state, offset: getClockOffset(), savedAt: Date.now() }));
  } catch { /* storage full or unavailable */ }
}

/** Show the last known state immediately on page load, before the socket connects. */
function restoreSavedState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_STATE_KEY));
    if (!saved || Date.now() - saved.savedAt > SAVED_STATE_MAX_AGE) return;
    setFallbackOffset(saved.offset);
    handlers.onState?.(saved.state);
  } catch { /* corrupt or unavailable */ }
}

export function send(message) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}
