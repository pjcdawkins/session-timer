let ws = null;
let onStateUpdate = null;
let onAuthResult = null;
let onConnectionChange = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let failedAttempts = 0;

// Connection status: "connected", "reconnecting", or "disconnected"
// "reconnecting" = transient, will retry soon
// "disconnected" = multiple retries failed, still retrying but user may need to act

export function connect({ onState, onAuth, onConnection }) {
  onStateUpdate = onState;
  onAuthResult = onAuth;
  onConnectionChange = onConnection;
  doConnect();
}

function doConnect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    failedAttempts = 0;
    onConnectionChange?.("connected");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "state") {
      const clockOffset = msg.state.serverNow - Date.now();
      onStateUpdate?.({ ...msg.state, clockOffset });
    } else if (msg.type === "authResult") {
      onAuthResult?.(msg.success);
    }
  };

  ws.onclose = () => {
    failedAttempts++;
    onConnectionChange?.(failedAttempts >= 3 ? "disconnected" : "reconnecting");
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    doConnect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

export function send(message) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
