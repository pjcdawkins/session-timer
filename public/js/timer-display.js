let currentState = null;
let secondHand = null;
let minuteHand = null;
let digitalEl = null;
let realTimeEl = null;
let ticks = [];
let lastHighlight = undefined;

export function updateState(state) {
  currentState = state;
  const hl = state?.highlight;
  if (hl !== lastHighlight && JSON.stringify(hl) !== JSON.stringify(lastHighlight)) {
    lastHighlight = hl;
    applyHighlight(hl);
  }
}

function applyHighlight(hl) {
  for (let i = 0; i < ticks.length; i++) {
    const matches = hl && ((i - hl.offset) % hl.interval + hl.interval) % hl.interval === 0;
    ticks[i].classList.toggle("tick-highlight", !!matches);
  }
}

export function getElapsedMs() {
  if (!currentState) return { virtual: 0, real: 0 };

  let virtualMs = currentState.accumulatedVirtualMs;

  if (currentState.running && currentState.startRealTimestamp) {
    const now = Date.now() + (currentState.clockOffset || 0);
    const elapsed = Math.max(0, now - currentState.startRealTimestamp);
    virtualMs += elapsed * currentState.speed;
  }

  return { virtual: virtualMs, real: virtualMs / currentState.speed };
}

function formatTime(ms) {
  const negative = ms < 0;
  const absMs = Math.abs(ms);
  const totalSeconds = Math.floor(absMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((absMs % 1000) / 100);

  return {
    negative,
    hh: String(hours).padStart(2, "0"),
    mm: String(minutes).padStart(2, "0"),
    ss: String(seconds).padStart(2, "0"),
    tenths: String(tenths),
  };
}

export function initAnalogClock(container) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.setAttribute("class", "analog-clock-svg");

  // Clock face
  const face = document.createElementNS(NS, "circle");
  face.setAttribute("cx", "100");
  face.setAttribute("cy", "100");
  face.setAttribute("r", "95");
  face.setAttribute("class", "clock-face");
  svg.appendChild(face);

  // Tick marks
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * 360;
    const isHour = i % 5 === 0;
    const innerR = isHour ? 80 : 86;
    const outerR = 92;
    const rad = (angle - 90) * (Math.PI / 180);

    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(100 + innerR * Math.cos(rad)));
    line.setAttribute("y1", String(100 + innerR * Math.sin(rad)));
    line.setAttribute("x2", String(100 + outerR * Math.cos(rad)));
    line.setAttribute("y2", String(100 + outerR * Math.sin(rad)));
    line.setAttribute("class", isHour ? "tick-hour" : "tick-minute");
    svg.appendChild(line);
    ticks.push(line);
  }

  // Minute hand
  minuteHand = document.createElementNS(NS, "line");
  minuteHand.setAttribute("x1", "100");
  minuteHand.setAttribute("y1", "100");
  minuteHand.setAttribute("x2", "100");
  minuteHand.setAttribute("y2", "30");
  minuteHand.setAttribute("class", "hand-minute");
  svg.appendChild(minuteHand);

  // Second hand
  secondHand = document.createElementNS(NS, "line");
  secondHand.setAttribute("x1", "100");
  secondHand.setAttribute("y1", "110");
  secondHand.setAttribute("x2", "100");
  secondHand.setAttribute("y2", "18");
  secondHand.setAttribute("class", "hand-second");
  svg.appendChild(secondHand);

  // Center dot
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", "100");
  dot.setAttribute("cy", "100");
  dot.setAttribute("r", "4");
  dot.setAttribute("class", "center-dot");
  svg.appendChild(dot);

  container.appendChild(svg);
}

export function initDisplay() {
  digitalEl = document.getElementById("digital-clock");
  realTimeEl = document.getElementById("real-time-value");
}

function renderDigital(virtualMs, realMs) {
  const vt = formatTime(virtualMs);
  const vSign = vt.negative ? "-" : "";
  digitalEl.innerHTML = `${vSign}${vt.hh}:${vt.mm}:${vt.ss}<span class="tenths">.${vt.tenths}</span>`;

  const rt = formatTime(realMs);
  const rSign = rt.negative ? "-" : "";
  realTimeEl.textContent = `${rSign}${rt.hh}:${rt.mm}:${rt.ss}`;
}

function renderAnalog(virtualMs) {
  const totalSeconds = virtualMs / 1000;
  const seconds = ((totalSeconds % 60) + 60) % 60;
  const minutes = (((totalSeconds / 60) % 60) + 60) % 60;

  const secondDeg = (seconds / 60) * 360;
  const minuteDeg = (minutes / 60) * 360;

  secondHand.setAttribute("transform", `rotate(${secondDeg} 100 100)`);
  minuteHand.setAttribute("transform", `rotate(${minuteDeg} 100 100)`);
}

export function startRenderLoop() {
  function frame() {
    const { virtual, real } = getElapsedMs();
    renderDigital(virtual, real);
    renderAnalog(virtual);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
