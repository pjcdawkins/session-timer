import { connect } from "./websocket-client.js";
import { updateState, initAnalogClock, initDisplay, startRenderLoop } from "./timer-display.js";

initAnalogClock(document.getElementById("analog-clock"));
initDisplay();

const statusBar = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const connectionDot = document.getElementById("connection-dot");
const speedValue = document.getElementById("speed-value");

connect({
  onState: (state) => {
    updateState(state);
    statusText.textContent = state.running ? "RUNNING" : "STOPPED";
    statusBar.className = state.running ? "status running" : "status stopped";
    speedValue.textContent = `${state.speed.toFixed(2)}x`;
  },
  onAuth: null,
  onConnection: (connected) => {
    connectionDot.className = connected ? "dot connected" : "dot";
  },
});

startRenderLoop();
