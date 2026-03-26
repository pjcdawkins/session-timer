import { connect, send } from "./websocket-client.js";
import { updateState, initAnalogClock, initDisplay, startRenderLoop } from "./timer-display.js";
import { initWakeLock } from "./wake-lock.js";
import { renderSVG } from "./vendor/uqr.js";

initAnalogClock(document.getElementById("analog-clock"));
initDisplay();
initWakeLock();

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

const btnQr = document.getElementById("btn-qr");
const qrModal = document.getElementById("qr-modal");
const qrSvgContainer = document.getElementById("qr-svg-container");
const qrUrlText = document.getElementById("qr-url-text");
const qrClose = document.getElementById("qr-close");

let authenticated = false;
let qrLoaded = false;

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
  onAuth: (success) => {
    if (success) {
      authenticated = true;
      authGate.classList.add("hidden");
      controls.classList.remove("hidden");
      loadQr();
    } else {
      authError.classList.remove("hidden");
      passwordInput.value = "";
      passwordInput.focus();
    }
  },
  onConnection: (status) => {
    connectionDot.className = status === "connected" ? "dot connected" : "dot";
    if (status === "reconnecting") {
      statusText.textContent = "RECONNECTING";
      statusBar.className = "status";
    } else if (status === "disconnected") {
      statusText.textContent = "DISCONNECTED";
      statusBar.className = "status";
    }
    if (status === "connected" && authenticated) {
      send({ type: "auth", password: localStorage.getItem("timer-lead-pw") || "" });
    }
  },
});

startRenderLoop();

// Auth form
document.getElementById("auth-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const password = passwordInput.value;
  localStorage.setItem("timer-lead-pw", password);
  send({ type: "auth", password });
});

// Transport
btnStart.addEventListener("click", () => send({ type: "start" }));
btnStop.addEventListener("click", () => send({ type: "stop" }));
document.getElementById("btn-reset").addEventListener("click", () => {
  send({ type: "reset" });
});

document.getElementById("btn-set-time").addEventListener("click", () => {
  const minutes = Math.max(0, Math.min(59, parseInt(timeMinutes.value, 10) || 0));
  const seconds = Math.max(-59, Math.min(59, parseInt(timeSeconds.value, 10) || 0));
  const virtualMs = ((minutes * 60) + seconds) * 1000;
  send({ type: "setTime", virtualMs });
});

// Speed presets
presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const speed = parseFloat(btn.dataset.speed);
    send({ type: "setSpeed", speed });
  });
});

// Custom speed input
speedInput.addEventListener("change", () => {
  const speed = parseFloat(speedInput.value);
  if (speed >= 0.1 && speed <= 10.0) {
    send({ type: "setSpeed", speed });
  }
});

// Highlight controls
function sendHighlight() {
  if (highlightEnabled.checked) {
    const interval = Math.max(1, Math.min(60, parseInt(highlightInterval.value, 10) || 10));
    const offset = Math.max(0, Math.min(59, parseInt(highlightOffset.value, 10) || 0));
    send({ type: "setHighlight", highlight: { interval, offset } });
  } else {
    send({ type: "setHighlight", highlight: null });
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
