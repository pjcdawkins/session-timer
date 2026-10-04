import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = 1_700_000_000_000;

/** @type {typeof import("../../public/js/timer-display.js")} */
let display;
let frames;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb) => frames.push(cb));

  document.body.innerHTML = `
    <div id="analog-clock"></div>
    <div id="digital-clock"></div>
    <div id="real-time"><span id="real-time-value"></span></div>
  `;
  vi.resetModules();
  display = await import("../../public/js/timer-display.js");
  display.initAnalogClock(document.getElementById("analog-clock"));
  display.initDisplay();
  display.startRenderLoop();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run one animation frame. */
function render() {
  frames.shift()?.(performance.now());
}

const digital = () => document.getElementById("digital-clock").textContent;
const realTime = () => document.getElementById("real-time-value").textContent;
const realTimeHidden = () => document.getElementById("real-time").classList.contains("hidden");

function state(overrides) {
  return {
    running: false,
    speed: 1,
    accumulatedVirtualMs: -3000,
    startRealTimestamp: null,
    serverNow: NOW,
    highlight: null,
    ...overrides,
  };
}

describe("getElapsedMs", () => {
  it("is zero before any state arrives", () => {
    expect(display.getElapsedMs()).toEqual({ virtual: 0, real: 0 });
  });

  it("returns the accumulated time while paused", () => {
    display.updateState(state({ accumulatedVirtualMs: 5000, speed: 2 }));
    vi.advanceTimersByTime(10_000);
    expect(display.getElapsedMs()).toEqual({ virtual: 5000, real: 2500 });
  });

  it("advances at the speed multiplier while running", () => {
    display.updateState(state({ running: true, speed: 1.5, accumulatedVirtualMs: 1000, startRealTimestamp: NOW }));
    vi.setSystemTime(NOW + 2000);
    expect(display.getElapsedMs()).toEqual({ virtual: 4000, real: 4000 / 1.5 });
  });

  it("never runs backwards if the start timestamp is in the (estimated) future", () => {
    display.updateState(state({ running: true, accumulatedVirtualMs: 0, startRealTimestamp: NOW + 500 }));
    expect(display.getElapsedMs().virtual).toBe(0);
  });
});

describe("digital display", () => {
  it("shows the -3s count-in", () => {
    display.updateState(state());
    render();
    expect(digital()).toBe("-00:00:03");
  });

  it("counts in -3, -2, -1, 0 at 1x without lingering on -0", () => {
    display.updateState(state({ running: true, startRealTimestamp: NOW }));
    vi.setSystemTime(NOW + 100);
    render();
    expect(digital()).toBe("-00:00:03");
    vi.setSystemTime(NOW + 2500);
    render();
    expect(digital()).toBe("-00:00:01");
    vi.setSystemTime(NOW + 3100);
    render();
    expect(digital()).toBe("00:00:00");
  });

  it("formats hours, minutes and seconds", () => {
    display.updateState(state({ accumulatedVirtualMs: ((1 * 60 + 2) * 60 + 3) * 1000 + 456 }));
    render();
    expect(digital()).toBe("01:02:03");
  });

  it("hides tenths at 1x and above, shows them below 1x", () => {
    display.updateState(state({ speed: 2, accumulatedVirtualMs: 1500 }));
    render();
    expect(digital()).toBe("00:00:01");
    display.updateState(state({ speed: 0.5, accumulatedVirtualMs: 1500 }));
    render();
    expect(digital()).toBe("00:00:01.5");
  });

  it("counts through zero with tenths below 1x", () => {
    display.updateState(state({ running: true, speed: 0.5, startRealTimestamp: NOW }));
    vi.setSystemTime(NOW + 5000);
    render();
    expect(digital()).toBe("-00:00:00.5");
    vi.setSystemTime(NOW + 6200);
    render();
    expect(digital()).toBe("00:00:00.1");
  });

  it("shows real elapsed time in the corner, scaled by speed", () => {
    display.updateState(state({ speed: 2, accumulatedVirtualMs: 120_000 }));
    render();
    expect(digital()).toBe("00:02:00");
    expect(realTime()).toBe("00:01:00");
  });

  it("hides the real-time corner display at 1x", () => {
    display.updateState(state({ speed: 1 }));
    expect(realTimeHidden()).toBe(true);
    display.updateState(state({ speed: 0.5 }));
    expect(realTimeHidden()).toBe(false);
  });
});

describe("analog clock", () => {
  const rotation = (cls) =>
    Number(document.querySelector(`.${cls}`).getAttribute("transform").match(/rotate\(([-\d.e]+)/)[1]);

  it("positions the hands from virtual time", () => {
    display.updateState(state({ accumulatedVirtualMs: (5 * 60 + 15) * 1000 }));
    render();
    expect(rotation("hand-second")).toBeCloseTo(90);
    expect(rotation("hand-minute")).toBeCloseTo((5.25 / 60) * 360);
  });

  it("wraps negative times onto the face", () => {
    display.updateState(state({ accumulatedVirtualMs: -3000 }));
    render();
    expect(rotation("hand-second")).toBeCloseTo((57 / 60) * 360);
  });
});

describe("tick highlighting", () => {
  const highlighted = () =>
    [...document.querySelectorAll(".analog-clock-svg line")]
      .slice(0, 60)
      .flatMap((el, i) => (el.classList.contains("tick-highlight") ? [i] : []));

  it("highlights every Nth tick from the offset", () => {
    display.updateState(state({ highlight: { interval: 15, offset: 5 } }));
    expect(highlighted()).toEqual([5, 20, 35, 50]);
  });

  it("updates when the highlight changes, and clears when disabled", () => {
    display.updateState(state({ highlight: { interval: 10, offset: 0 } }));
    expect(highlighted()).toEqual([0, 10, 20, 30, 40, 50]);
    display.updateState(state({ highlight: { interval: 30, offset: 7 } }));
    expect(highlighted()).toEqual([7, 37]);
    display.updateState(state({ highlight: null }));
    expect(highlighted()).toEqual([]);
  });
});
