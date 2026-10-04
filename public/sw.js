// Offline fallback: network-first, so updates always come through when online,
// but a reload with no connection still shows the app (it then resumes from the
// last known timer state saved in localStorage).
// Service workers only run in a secure context (HTTPS or localhost), so this
// covers the online deployment, not plain-HTTP LAN mode.

const CACHE = "timer-v1";
const SHELL = [
  "/",
  "/lead",
  "/css/style.css",
  "/fonts/fonts.css",
  "/fonts/DMMono-300.woff2",
  "/fonts/DMMono-400.woff2",
  "/fonts/DMMono-500.woff2",
  "/fonts/InstrumentSans-var.woff2",
  "/js/clock.js",
  "/js/fullscreen.js",
  "/js/lead.js",
  "/js/offline.js",
  "/js/timer-display.js",
  "/js/viewer.js",
  "/js/wake-lock.js",
  "/js/websocket-client.js",
  "/js/vendor/uqr.js",
];
const NETWORK_TIMEOUT = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname === "/ws") return;
  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT)),
    ]);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}
