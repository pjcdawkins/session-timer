import { connect, send, getClientId } from "./websocket-client.js";
import { updateState, initAnalogClock, initDisplay, startRenderLoop } from "./timer-display.js";
import { initWakeLock } from "./wake-lock.js";
import { renderSVG } from "./vendor/uqr.js";
import { initFullscreen } from "./fullscreen.js";
import { initOffline } from "./offline.js";

initAnalogClock(document.getElementById("analog-clock"));
initDisplay();
initWakeLock();
initFullscreen();
initOffline();

const authGate = document.getElementById("auth-gate");
const authError = document.getElementById("auth-error");
const passwordInput = document.getElementById("password-input");
const controls = document.getElementById("controls");
const statusBar = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const connectionDot = document.getElementById("connection-dot");
const speedValue = document.getElementById("speed-value");
const speedInput = document.getElementById("speed-input");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const presetButtons = document.querySelectorAll("[data-speed]");
const setTimeControls = document.getElementById("set-time-controls");
const timeMinutes = document.getElementById("time-minutes");
const timeSeconds = document.getElementById("time-seconds");

const highlightEnabled = document.getElementById("highlight-enabled");
const highlightInterval = document.getElementById("highlight-interval");
const highlightOffset = document.getElementById("highlight-offset");

const lockEnabled = document.getElementById("lock-enabled");
const lockable = document.getElementById("lockable");
const btnReset = document.getElementById("btn-reset");
const commandWarning = document.getElementById("command-warning");

const screensPanel = document.getElementById("screens-panel");
const screensList = document.getElementById("screens-list");
const screensEmpty = document.getElementById("screens-empty");

const btnQr = document.getElementById("btn-qr");
const qrModal = document.getElementById("qr-modal");
const qrSvgContainer = document.getElementById("qr-svg-container");
const qrUrlText = document.getElementById("qr-url-text");
const qrClose = document.getElementById("qr-close");

let authenticated = false;
let qrLoaded = false;
let running = false;

async function loadQr() {
  if (qrLoaded) return;
  try {
    // In local mode, /api/info provides the LAN IP URL (lead may be on localhost)
    let viewerUrl = window.location.origin;
    try {
      const res = await fetch("/api/info");
      if (res.ok) {
        const info = await res.json();
        if (info.viewerUrl) viewerUrl = info.viewerUrl;
      }
    } catch { /* Cloudflare mode — use origin */ }

    qrSvgContainer.innerHTML = renderSVG(viewerUrl);
    qrUrlText.textContent = viewerUrl;
    btnQr.classList.remove("hidden");
    qrLoaded = true;
  } catch {
    // QR generation failed — leave button hidden
  }
}

connect({
  onState: (state) => {
    updateState(state);
    statusText.textContent = state.running ? "RUNNING" : "STOPPED";
    statusBar.className = state.running ? "status running" : "status stopped";
    speedValue.textContent = `${state.speed.toFixed(2)}x`;

    running = state.running;
    btnStart.disabled = state.running;
    btnStop.disabled = !state.running;

    setTimeControls.classList.toggle("hidden", state.running);

    // Sync speed input and preset highlight
    speedInput.value = state.speed;
    presetButtons.forEach((btn) => {
      btn.classList.toggle("active", parseFloat(btn.dataset.speed) === state.speed);
    });

    // Sync highlight controls
    highlightEnabled.checked = !!state.highlight;
    if (state.highlight) {
      highlightInterval.value = state.highlight.interval;
      highlightOffset.value = state.highlight.offset;
    }
  },
  onClients: renderScreens,
  onAuth: (success) => {
    if (success) {
      authenticated = true;
      authGate.classList.add("hidden");
      controls.classList.remove("hidden");
      loadQr();
    } else {
      authenticated = false;
      localStorage.removeItem("timer-lead-pw");
      controls.classList.add("hidden");
      authGate.classList.remove("hidden");
      authError.classList.remove("hidden");
      passwordInput.value = "";
      passwordInput.focus();
    }
  },
  onConnection: (status) => {
    screensPanel.classList.toggle("stale", status !== "connected");
    connectionDot.className = status === "connected" ? "dot connected" : "dot";
    if (status === "reconnecting") {
      statusText.textContent = "RECONNECTING";
      statusBar.className = "status";
    } else if (status === "disconnected") {
      statusText.textContent = "DISCONNECTED";
      statusBar.className = "status";
    }
    if (status === "connected" && (authenticated || localStorage.getItem("timer-lead-pw"))) {
      send({ type: "auth", password: localStorage.getItem("timer-lead-pw") || "" });
    }
  },
  clientRole: "lead",
});

startRenderLoop();

// Auth form
document.getElementById("auth-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const password = passwordInput.value;
  localStorage.setItem("timer-lead-pw", password);
  send({ type: "auth", password });
});

// Commands: warn loudly if the lead itself is offline, rather than silently dropping
let warningTimer = null;
function command(msg) {
  if (send(msg)) return;
  commandWarning.classList.remove("hidden");
  clearTimeout(warningTimer);
  warningTimer = setTimeout(() => commandWarning.classList.add("hidden"), 3000);
}

// Transport
btnStart.addEventListener("click", () => command({ type: "start" }));
btnStop.addEventListener("click", () => command({ type: "stop" }));

// Reset needs a second click within 3s
let resetConfirmTimer = null;
function cancelResetConfirm() {
  clearTimeout(resetConfirmTimer);
  resetConfirmTimer = null;
  btnReset.textContent = "Reset";
  btnReset.classList.remove("confirming");
}
btnReset.addEventListener("click", () => {
  if (resetConfirmTimer) {
    cancelResetConfirm();
    command({ type: "reset" });
  } else {
    btnReset.textContent = "Confirm reset";
    btnReset.classList.add("confirming");
    resetConfirmTimer = setTimeout(cancelResetConfirm, 3000);
  }
});

// Keyboard: Space = Start (never toggles, so a double press can't pause), Esc = Pause
document.addEventListener("keydown", (e) => {
  if (!authenticated || e.repeat) return;
  if (e.target.closest("input, textarea, select")) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!running) command({ type: "start" });
  } else if (e.code === "Escape") {
    if (!qrModal.classList.contains("hidden")) return;
    e.preventDefault();
    if (running) command({ type: "stop" });
  }
});
// Stop Space from also "clicking" whichever button has focus
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && e.target.tagName === "BUTTON") e.preventDefault();
});

// Show lock: disables reset, set time, speed and highlight controls
function applyLock() {
  const locked = lockEnabled.checked;
  lockable.disabled = locked;
  btnReset.disabled = locked;
  if (locked) cancelResetConfirm();
  localStorage.setItem("timer-lead-locked", locked ? "1" : "");
}
lockEnabled.checked = !!localStorage.getItem("timer-lead-locked");
lockEnabled.addEventListener("change", applyLock);
applyLock();

// Connected screens
const KNOWN_SCREENS_KEY = "timer-known-screens";
const LOST_AFTER = 10000;
let knownScreens = loadKnownScreens(); // id → { name, lastSeenAt }

function loadKnownScreens() {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(KNOWN_SCREENS_KEY)) || {}));
  } catch {
    return new Map();
  }
}

function saveKnownScreens() {
  try {
    localStorage.setItem(KNOWN_SCREENS_KEY, JSON.stringify(Object.fromEntries(knownScreens)));
  } catch { /* ignore */ }
}

function formatAgo(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

let lastClients = [];

function renderScreens(clients) {
  lastClients = clients;
  const now = Date.now();
  const selfId = getClientId();
  const live = new Map();
  for (const c of clients) {
    if (c.id === selfId || c.role !== "viewer") continue;
    // A device can briefly have two sockets while reconnecting; keep the freshest
    const prev = live.get(c.id);
    if (!prev || c.lastSeenAgoMs < prev.lastSeenAgoMs) live.set(c.id, c);
  }
  for (const c of live.values()) {
    // Don't refresh lost sockets, or "Clear lost" would immediately re-add them
    if (c.lastSeenAgoMs >= LOST_AFTER) continue;
    knownScreens.set(c.id, { name: c.name, lastSeenAt: now - c.lastSeenAgoMs });
  }
  saveKnownScreens();

  const rows = [...knownScreens.entries()]
    .map(([id, k]) => {
      const c = live.get(id);
      const ago = c ? c.lastSeenAgoMs : now - k.lastSeenAt;
      const health = c && ago < 5000 ? "ok" : c && ago < LOST_AFTER ? "warn" : "lost";
      const detail =
        health === "ok" ? (c.rtt != null ? `${Math.round(c.rtt)} ms` : "connected") :
        health === "warn" ? `quiet ${formatAgo(ago)}` :
        `lost ${formatAgo(ago)} ago`;
      return { name: k.name, health, detail };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  screensList.replaceChildren(...rows.map(({ name, health, detail }) => {
    const li = document.createElement("li");
    li.className = `screen ${health}`;
    const dot = document.createElement("span");
    dot.className = "screen-dot";
    const label = document.createElement("span");
    label.className = "screen-name";
    label.textContent = name;
    const info = document.createElement("span");
    info.className = "screen-detail";
    info.textContent = detail;
    li.append(dot, label, info);
    return li;
  }));
  screensEmpty.classList.toggle("hidden", rows.length > 0);
}

document.getElementById("btn-screens-clear").addEventListener("click", () => {
  const now = Date.now();
  for (const [id, k] of knownScreens) {
    if (now - k.lastSeenAt >= LOST_AFTER) knownScreens.delete(id);
  }
  saveKnownScreens();
  renderScreens(lastClients);
});

document.getElementById("btn-set-time").addEventListener("click", () => {
  const minutes = Math.max(0, Math.min(59, parseInt(timeMinutes.value, 10) || 0));
  const seconds = Math.max(-59, Math.min(59, parseInt(timeSeconds.value, 10) || 0));
  const virtualMs = ((minutes * 60) + seconds) * 1000;
  command({ type: "setTime", virtualMs });
});

// Speed presets
presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const speed = parseFloat(btn.dataset.speed);
    command({ type: "setSpeed", speed });
  });
});

// Custom speed input
speedInput.addEventListener("change", () => {
  const speed = parseFloat(speedInput.value);
  if (speed >= 0.1 && speed <= 10.0) {
    command({ type: "setSpeed", speed });
  }
});

// Highlight controls
function sendHighlight() {
  if (highlightEnabled.checked) {
    const interval = Math.max(1, Math.min(60, parseInt(highlightInterval.value, 10) || 10));
    const offset = Math.max(0, Math.min(59, parseInt(highlightOffset.value, 10) || 0));
    command({ type: "setHighlight", highlight: { interval, offset } });
  } else {
    command({ type: "setHighlight", highlight: null });
  }
}
highlightEnabled.addEventListener("change", sendHighlight);
highlightInterval.addEventListener("change", sendHighlight);
highlightOffset.addEventListener("change", sendHighlight);

// QR modal
btnQr.addEventListener("click", () => qrModal.classList.remove("hidden"));
qrClose.addEventListener("click", () => qrModal.classList.add("hidden"));
qrModal.addEventListener("click", (e) => {
  if (e.target === qrModal) qrModal.classList.add("hidden");
});
