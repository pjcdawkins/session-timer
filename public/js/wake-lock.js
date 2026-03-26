/** Screen Wake Lock — keeps the screen on while the page is visible. */

let wakeLock = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    // Wake lock request can fail (e.g. low battery, background tab).
  }
}

// Re-acquire when the page becomes visible again (lock is auto-released on hide).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestWakeLock();
  }
});

export function initWakeLock() {
  requestWakeLock();
}
