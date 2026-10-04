import { beforeEach, describe, expect, it, vi } from "vitest";

/** @type {typeof import("../../public/js/clock.js")} */
let clock;

beforeEach(async () => {
  // clock.js keeps module-level state; load a fresh copy per test
  vi.resetModules();
  clock = await import("../../public/js/clock.js");
});

describe("clock", () => {
  it("uses the fallback offset until a ping sample arrives", () => {
    expect(clock.getClockOffset()).toBe(0);
    expect(clock.getRtt()).toBeNull();
    clock.setFallbackOffset(500);
    expect(clock.getClockOffset()).toBe(500);
  });

  it("estimates offset as serverNow + rtt/2 - receivedAt", () => {
    clock.setFallbackOffset(999);
    // Sent at 1000, server stamped 5050, received at 1100 → rtt 100, offset 5050 + 50 - 1100
    clock.addSample(1000, 5050, 1100);
    expect(clock.getRtt()).toBe(100);
    expect(clock.getClockOffset()).toBe(4000);
  });

  it("trusts the lowest-RTT sample", () => {
    clock.addSample(0, 1000, 300); // rtt 300, offset 850
    clock.addSample(0, 1000, 20); // rtt 20, offset 990
    clock.addSample(0, 1000, 200); // rtt 200, offset 900
    expect(clock.getRtt()).toBe(20);
    expect(clock.getClockOffset()).toBe(990);
  });

  it("forgets samples older than the last 10", () => {
    clock.addSample(0, 1000, 10); // best, but will fall out of the window
    for (let i = 0; i < 10; i++) clock.addSample(0, 1000, 100 + i);
    expect(clock.getRtt()).toBe(100);
  });

  it("ignores samples with a negative round trip", () => {
    clock.addSample(1000, 5000, 900);
    expect(clock.getRtt()).toBeNull();
  });

  it("serverNow applies the offset to the local clock", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    clock.setFallbackOffset(-2500);
    expect(clock.serverNow()).toBe(7500);
    vi.restoreAllMocks();
  });
});
