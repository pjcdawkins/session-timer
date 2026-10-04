import { connect, send, getClientId } from "./websocket-client.js";
import { updateState, initAnalogClock, initDisplay, startRenderLoop } from "./timer-display.js";
import { initWakeLock } from "./wake-lock.js";
import { renderSVG } from "./vendor/uqr.js";
import { initFullscreen } from "./fullscreen.js";
import { initTheme } from "./theme.js";
import { initOffline } from "./offline.js";

initAnalogClock(document.getElementById("analog-clock"));
initDisplay();
initWakeLock();
initFullscreen();
initTheme();
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
const screensSummary = document.getElementById("screens-summary");
const screensSummaryText = document.getElementById("screens-summary-text");
const lockIndicator = document.getElementById("lock-indicator");
const btnPerform = document.getElementById("btn-perform");
const btnPerformExit = document.getElementById("btn-perform-exit");

const btnQr = document.getElementById("btn-qr");
const qrModal = document.getElementById("qr-modal");
const qrSvgContainer = document.getElementById("qr-svg-container");
const qrUrlText = document.getElementById("qr-url-text");
const qrClose = document.getElementById("qr-close");

let authenticated = false;
// Auth state of the *current* socket: false from (re)connect until authResult
let sessionAuthed = false;
// Whether an auth attempt is in flight. Only one is outstanding at a time, so
// a delayed (throttled) result always belongs to it.
let authPending = false;

// After a password login the server issues a reconnect token, which we store
// instead of the password. Token auth isn't throttled, so reconnects can't be
// starved by someone else on the same IP.
const TOKEN_KEY = "timer-lead-token";
const LEGACY_PASSWORD_KEY = "timer-lead-pw"; // Stored by older versions

function storedCredential() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) return { token };
  const password = localStorage.getItem(LEGACY_PASSWORD_KEY);
  return password ? { password } : null;
}

function sendAuth(credential) {
  if (authPending || !credential) return;
  if (send({ type: "auth", ...credential })) authPending = true;
}
let qrLoaded = false;
let running = false;
let lastState = null;
let resetConfirmTimer = null; // Declared early: restored state is applied during connect()

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

    lastState = state;
    syncControls(state);
  },
  onClients: renderScreens,
  onAuth: (success, reason, token) => {
    if (!authPending) return; // Stale result from a previous socket
    authPending = false;
    if (success) {
      authenticated = true;
      sessionAuthed = true;
      if (token) localStorage.setItem(TOKEN_KEY, token);
      localStorage.removeItem(LEGACY_PASSWORD_KEY);
      authGate.classList.add("hidden");
      controls.classList.remove("hidden");
      loadQr();
    } else if (reason === "rateLimited" && authenticated) {
      // Re-auth after reconnect was throttled: retry quietly
      setTimeout(() => sendAuth(storedCredential()), 3000);
    } else {
      authenticated = false;
      if (reason !== "rateLimited") {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(LEGACY_PASSWORD_KEY);
      }
      controls.classList.add("hidden");
      authGate.classList.remove("hidden");
      authError.textContent = reason === "rateLimited"
        ? "Too many attempts, try again in a few seconds"
        : "Wrong password";
      authError.classList.remove("hidden");
      passwordInput.value = "";
      passwordInput.focus();
    }
  },
  onConnection: (status) => {
    // Any connection change means a new socket that hasn't authenticated yet
    sessionAuthed = false;
    authPending = false;
    screensPanel.classList.toggle("stale", status !== "connected");
    screensSummary.classList.toggle("stale", status !== "connected");
    connectionDot.className = status === "connected" ? "dot connected" : "dot";
    if (status === "reconnecting") {
      statusText.textContent = "RECONNECTING";
      statusBar.className = "status";
    } else if (status === "disconnected") {
      statusText.textContent = "DISCONNECTED";
      statusBar.className = "status";
    }
    if (status === "connected") {
      sendAuth(storedCredential());
    }
  },
  clientRole: "lead",
});

startRenderLoop();

// Auth form
document.getElementById("auth-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sendAuth({ password: passwordInput.value });
});

// Sync controls from server state. Another lead may change things at any time,
// so skip fields being edited here; they re-sync on blur if left unchanged.
const editableInputs = [speedInput, highlightInterval, highlightOffset];
function syncValue(input, value) {
  if (document.activeElement !== input) input.value = value;
}
function syncControls(state) {
  syncValue(speedInput, state.speed);
  presetButtons.forEach((btn) => {
    btn.classList.toggle("active", parseFloat(btn.dataset.speed) === state.speed);
  });

  highlightEnabled.checked = !!state.highlight;
  if (state.highlight) {
    syncValue(highlightInterval, state.highlight.interval);
    syncValue(highlightOffset, state.highlight.offset);
  }

  applyLock(!!state.locked);
}
for (const input of editableInputs) {
  input.addEventListener("input", () => { input.dataset.edited = "1"; });
  input.addEventListener("blur", () => {
    // An edited field sent a command on change; the resulting broadcast updates it
    if (!input.dataset.edited && lastState) syncControls(lastState);
    delete input.dataset.edited;
  });
}

// Commands: warn loudly if the lead itself is offline (or its new socket is
// still re-authenticating), rather than silently dropping
let warningTimer = null;
function command(msg) {
  if (sessionAuthed && send(msg)) return true;
  commandWarning.classList.remove("hidden");
  clearTimeout(warningTimer);
  warningTimer = setTimeout(() => commandWarning.classList.add("hidden"), 3000);
  return false;
}

// Transport
btnStart.addEventListener("click", () => command({ type: "start" }));
btnStop.addEventListener("click", () => command({ type: "stop" }));

// Reset needs a second click within 3s
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

// Show lock: disables reset, set time, speed and highlight controls on every
// lead screen. It is part of the server state, and the server enforces it.
function applyLock(locked) {
  lockEnabled.checked = locked;
  lockable.disabled = locked;
  btnReset.disabled = locked;
  lockIndicator.classList.toggle("hidden", !locked);
  if (locked) cancelResetConfirm();
}
lockEnabled.addEventListener("change", () => {
  const locked = lockEnabled.checked;
  applyLock(locked);
  if (!command({ type: "setLock", locked })) applyLock(!!lastState?.locked);
});
localStorage.removeItem("timer-lead-locked"); // Was a per-device setting

// Connected screens
const KNOWN_SCREENS_KEY = "timer-known-screens";
const LOST_AFTER = 10000;
const knownScreens = loadKnownScreens(); // id → { name, lastSeenAt }

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
    if (c.id === selfId) continue;
    // A device can briefly have two sockets while reconnecting; keep the freshest
    const prev = live.get(c.id);
    if (!prev || c.lastSeenAgoMs < prev.lastSeenAgoMs) live.set(c.id, c);
  }
  for (const c of live.values()) {
    // Don't refresh lost sockets, or "Clear lost" would immediately re-add them
    if (c.lastSeenAgoMs >= LOST_AFTER) continue;
    knownScreens.set(c.id, { name: c.name, role: c.role, lastSeenAt: now - c.lastSeenAgoMs });
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
      const role = k.role !== "lead" ? null : c && !c.authenticated ? "lead · signed out" : "lead";
      return { name: k.name, role, health, detail };
    })
    // Other leads first, then viewers
    .sort((a, b) => !a.role - !b.role || a.name.localeCompare(b.name));

  screensList.replaceChildren(...rows.map(({ name, role, health, detail }) => {
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
    li.append(dot, label);
    if (role) {
      const tag = document.createElement("span");
      tag.className = "screen-role";
      tag.textContent = role;
      li.append(tag);
    }
    li.append(info);
    return li;
  }));
  screensEmpty.classList.toggle("hidden", rows.length > 0);

  // Compact version for Perform mode: count, plus how many are quiet or lost
  // (in words as well as colour), coloured by the worst screen
  const count = (health) => rows.filter((r) => r.health === health).length;
  const ok = count("ok");
  const warn = count("warn");
  const lost = count("lost");
  const worst = lost ? "lost" : warn ? "warn" : "ok";
  screensSummary.className = `perform-only screen ${rows.length ? worst : "none"}`;
  screensSummary.classList.toggle("stale", screensPanel.classList.contains("stale"));
  const total = `${ok === rows.length ? rows.length : `${ok}/${rows.length}`} ${rows.length === 1 ? "screen" : "screens"}`;
  screensSummaryText.textContent = !rows.length
    ? "No screens"
    : [total, lost && `${lost} lost`, warn && `${warn} quiet`].filter(Boolean).join(" · ");
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

// Perform mode: hide the controls and show the time as large as possible.
// A per-screen layout choice, remembered across reloads. Entering it turns on
// Show lock; leaving it doesn't turn the lock off.
const PERFORM_KEY = "timer-lead-perform";
function setPerform(on) {
  document.body.classList.toggle("perform", on);
  try {
    if (on) localStorage.setItem(PERFORM_KEY, "1");
    else localStorage.removeItem(PERFORM_KEY);
  } catch { /* ignore */ }
}
try { setPerform(localStorage.getItem(PERFORM_KEY) === "1"); } catch { /* ignore */ }

btnPerform.addEventListener("click", () => {
  if (!lastState?.locked) {
    // Offline: command() shows the warning, and we stay out of Perform mode
    // rather than hiding the controls with the lock off
    if (!command({ type: "setLock", locked: true })) return;
    applyLock(true);
  }
  setPerform(true);
});

btnPerformExit.addEventListener("click", () => setPerform(false));
