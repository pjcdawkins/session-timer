/** Register the offline-fallback service worker (HTTPS / localhost only). */
export function initOffline() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register("/sw.js").catch(() => { /* not fatal */ });
}
