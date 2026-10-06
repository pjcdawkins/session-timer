import { connect, send, getClientId } from "./websocket-client.js";
import { updateState, getElapsedMs, initAnalogClock, initDisplay, startRenderLoop } from "./timer-display.js";
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

const authError = document.getElementById("auth-error");
const passwordInput = document.getElementById("password-input");
const btnSignOut = document.getElementById("btn-sign-out");
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
const qlabControls = document.getElementById("qlab-controls");
const qlabEnabled = document.getElementById("qlab-enabled");
const qlabIndicator = document.getElementById("qlab-indicator");
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
const btnPerformStart = document.getElementById("btn-perform-start");

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
// starved by someone else on the same IP. Each successful auth returns a fresh
// token lasting 24h. (These keys are also read by the inline script in
// lead.html, which shows the controls before first paint if one is saved.)
const TOKEN_KEY = "timer-lead-token";
const LEGACY_PASSWORD_KEY = "timer-lead-pw"; // Stored by older versions
const TOKEN_REFRESH_MS = 60 * 60 * 1000;

function forgetCredential() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_PASSWORD_KEY);
}

function setSignedIn(on) {
  document.body.classList.toggle("signed-in", on);
}

function storedCredential() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) return { token };
  const password = localStorage.getItem(LEGACY_PASSWORD_KEY);
  return password ? { password } : null;
}

// Whether the auth in flight is a password typed into the gate, as opposed to
// the saved credential (whose rejection usually means the login expired)
let authFromForm = false;

function sendAuth(credential, fromForm = false) {
  if (authPending || !credential) return;
  if (send({ type: "auth", ...credential })) {
    authPending = true;
    authFromForm = fromForm;
  }
}
let qrLoaded = false;
let running = false;
let lastState = null;
// Declared early: restored state is applied during connect()
let resetConfirmTimer = null;
let bridgeKnown = false; // Whether a QLab bridge is in the Screens panel
const CANCEL_ARM_MS = 1000;
const CANCEL_CUTOFF_MS = 500; // Matches the server
let performButtonMode = "start"; // "start" | "cancel" | "hidden"
let cancelArmedAt = 0;

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
    updatePerformButton();

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
      setSignedIn(true);
      loadQr();
    } else if (reason === "rateLimited" && authenticated) {
      // Re-auth after reconnect was throttled: retry quietly
      setTimeout(() => sendAuth(storedCredential()), 3000);
    } else {
      authenticated = false;
      if (reason !== "rateLimited") forgetCredential();
      setSignedIn(false);
      authError.textContent = reason === "rateLimited"
        ? "Too many attempts, try again in a few seconds"
        : authFromForm ? "Wrong password" : "Signed out — enter the password again";
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
  sendAuth({ password: passwordInput.value }, true);
});

// A login lasts 24h from its last use, so renew it while the page is open:
// otherwise a screen connected for a whole day would be signed out at its
// next reconnect
setInterval(() => {
  if (sessionAuthed) sendAuth(storedCredential());
}, TOKEN_REFRESH_MS);

// Sign out this screen: forget the token and drop this socket's auth. (Other
// lead screens stay signed in; changing LEAD_PASSWORD signs out every screen.)
btnSignOut.addEventListener("click", () => {
  send({ type: "logout" });
  forgetCredential();
  authenticated = false;
  sessionAuthed = false;
  authPending = false; // Ignore the result of any auth still in flight
  setSignedIn(false);
  authError.classList.add("hidden");
  passwordInput.value = "";
  passwordInput.focus();
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
  applyQlab();
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

// Perform mode's one button: Start while stopped; Cancel during the count-in
// (back to where Start was pressed, even under Show lock, so a QLab cue armed
// for zero doesn't fire); hidden from CANCEL_CUTOFF_MS before zero, when the
// server refuses Cancel, since Perform mode has no Pause. Cancel ignores taps
// for its first second, so a double tap on Start can't undo it.
function inCountIn() {
  return running && lastState?.startedFromMs != null && -getElapsedMs().real >= CANCEL_CUTOFF_MS;
}

function updatePerformButton() {
  const mode = !running ? "start" : inCountIn() ? "cancel" : "hidden";
  if (mode !== performButtonMode) {
    performButtonMode = mode;
    btnPerformStart.textContent = mode === "cancel" ? "Cancel" : "Start";
    btnPerformStart.title = mode === "cancel" ? "Esc: back to where Start was pressed" : "Space";
    btnPerformStart.classList.toggle("cancel", mode === "cancel");
    btnPerformStart.classList.toggle("hidden", mode === "hidden");
    if (mode === "cancel") cancelArmedAt = performance.now() + CANCEL_ARM_MS;
  }
  const disarmed = mode === "cancel" && performance.now() < cancelArmedAt;
  if (btnPerformStart.disabled !== disarmed) btnPerformStart.disabled = disarmed;
}

(function performButtonLoop() {
  updatePerformButton();
  requestAnimationFrame(performButtonLoop);
})();

btnPerformStart.addEventListener("click", () => {
  if (performButtonMode === "start") command({ type: "start" });
  else if (performButtonMode === "cancel" && !btnPerformStart.disabled) command({ type: "cancel" });
});

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

// Keyboard: Space = Start (never toggles, so a double press can't pause),
// Esc = Pause (except under Show lock); in Perform mode, Esc = Cancel during
// the count-in and does nothing after zero
document.addEventListener("keydown", (e) => {
  if (!authenticated || e.repeat) return;
  if (e.target.closest("input, textarea, select")) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!running) command({ type: "start" });
  } else if (e.code === "Escape") {
    if (!qrModal.classList.contains("hidden")) return;
    e.preventDefault();
    if (document.body.classList.contains("perform")) {
      if (performButtonMode === "cancel" && !btnPerformStart.disabled) command({ type: "cancel" });
    } else if (running && !lastState?.locked) {
      command({ type: "stop" });
    }
  }
});
// Stop Space from also "clicking" whichever button has focus
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && e.target.tagName === "BUTTON") e.preventDefault();
});

// Show lock: disables pause, reset, set time, speed and highlight controls on
// every lead screen (only Start stays). It is part of the server state, and
// the server enforces it.
function applyLock(locked) {
  lockEnabled.checked = locked;
  btnStop.disabled = locked || !running;
  lockable.disabled = locked;
  btnReset.disabled = locked;
  btnSignOut.disabled = locked;
  lockIndicator.classList.toggle("hidden", !locked);
  if (locked) cancelResetConfirm();
}
lockEnabled.addEventListener("change", () => {
  const locked = lockEnabled.checked;
  applyLock(locked);
  if (!command({ type: "setLock", locked })) applyLock(!!lastState?.locked);
});
localStorage.removeItem("timer-lead-locked"); // Was a per-device setting

// QLab: whether a QLab bridge talks to QLab (on by default). Turning it off
// disconnects the bridge from QLab, so it won't fire, pause or stop the cue.
// Shown once a bridge has joined, or while it is off so it can be turned on.
function applyQlab() {
  const on = lastState?.qlab !== false;
  qlabEnabled.checked = on;
  qlabControls.classList.toggle("hidden", on && !bridgeKnown);
  qlabIndicator.classList.toggle("hidden", on);
}
qlabEnabled.addEventListener("change", () => {
  if (!command({ type: "setQlab", enabled: qlabEnabled.checked })) applyQlab();
});

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
      const role =
        k.role === "lead" ? (c && !c.authenticated ? "lead · signed out" : "lead") :
        k.role === "qlab" ? (lastState?.qlab === false ? "QLab · off" : "QLab") :
        null;
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
  bridgeKnown = [...knownScreens.values()].some((k) => k.role === "qlab");
  applyQlab();

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
  // Always send it: lastState may be stale (e.g. an unlock still in flight).
  // Offline: command() shows the warning, and we stay out of Perform mode
  // rather than hiding the controls with the lock off
  if (!command({ type: "setLock", locked: true })) return;
  applyLock(true);
  setPerform(true);
});

btnPerformExit.addEventListener("click", () => setPerform(false));
