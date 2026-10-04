import { connect, getClientName, setClientName } from "./websocket-client.js";
import { updateState, initAnalogClock, initDisplay, startRenderLoop } from "./timer-display.js";
import { initWakeLock } from "./wake-lock.js";
import { initFullscreen } from "./fullscreen.js";
import { initOffline } from "./offline.js";

initAnalogClock(document.getElementById("analog-clock"));
initDisplay();
initWakeLock();
initFullscreen();
initOffline();

const statusBar = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const connectionDot = document.getElementById("connection-dot");
const speedValue = document.getElementById("speed-value");
const screenName = document.getElementById("screen-name");

// Name shown in the lead's screens list. Set via ?name=Stage%20L or by tapping it.
screenName.textContent = getClientName();
screenName.addEventListener("click", () => {
  const name = prompt("Name this screen (shown to the lead):", getClientName());
  if (name?.trim()) {
    setClientName(name.trim());
    screenName.textContent = getClientName();
  }
});

connect({
  onState: (state) => {
    updateState(state);
    statusText.textContent = state.running ? "RUNNING" : "STOPPED";
    statusBar.className = state.running ? "status running" : "status stopped";
    speedValue.textContent = `${state.speed.toFixed(2)}x`;
  },
  onAuth: null,
  onConnection: (status) => {
    connectionDot.className = status === "connected" ? "dot connected" : "dot";
    if (status === "reconnecting") {
      statusText.textContent = "RECONNECTING";
      statusBar.className = "status";
    } else if (status === "disconnected") {
      statusText.textContent = "DISCONNECTED";
      statusBar.className = "status";
    }
  },
});

startRenderLoop();
