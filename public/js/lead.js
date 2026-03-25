import { connect, send } from "./websocket-client.js";
import { updateState, initAnalogClock, initDisplay, startRenderLoop } from "./timer-display.js";

initAnalogClock(document.getElementById("analog-clock"));
initDisplay();

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
const timeHours = document.getElementById("time-hours");
const timeMinutes = document.getElementById("time-minutes");
const timeSeconds = document.getElementById("time-seconds");

let authenticated = false;

connect({
  onState: (state) => {
    updateState(state);
    statusText.textContent = state.running ? "RUNNING" : "STOPPED";
    statusBar.className = state.running ? "status running" : "status stopped";
    speedValue.textContent = `${state.speed.toFixed(2)}x`;

    btnStart.disabled = state.running;
    btnStop.disabled = !state.running;

    // Show/hide set-time controls based on running state
    setTimeControls.classList.toggle("hidden", state.running);

    // Sync speed input and preset highlight
    speedInput.value = state.speed;
    presetButtons.forEach((btn) => {
      btn.classList.toggle("active", parseFloat(btn.dataset.speed) === state.speed);
    });
  },
  onAuth: (success) => {
    if (success) {
      authenticated = true;
      authGate.classList.add("hidden");
      controls.classList.remove("hidden");
    } else {
      authError.classList.remove("hidden");
      passwordInput.value = "";
      passwordInput.focus();
    }
  },
  onConnection: (connected) => {
    connectionDot.className = connected ? "dot connected" : "dot";
    if (connected && authenticated) {
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
  if (confirm("Reset timer to 0:00:00?")) {
    send({ type: "reset" });
  }
});

// Set custom start time
document.getElementById("btn-set-time").addEventListener("click", () => {
  const hours = parseInt(timeHours.value, 10) || 0;
  const minutes = parseInt(timeMinutes.value, 10) || 0;
  const seconds = parseInt(timeSeconds.value, 10) || 0;
  const virtualMs = ((hours * 3600) + (minutes * 60) + seconds) * 1000;
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
