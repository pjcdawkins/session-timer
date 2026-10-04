/**
 * Server clock estimation.
 *
 * Each ping/pong round trip gives a sample: offset = serverNow + rtt/2 - clientNow.
 * The sample with the smallest round trip is the most trustworthy (least queuing
 * delay), so we use the min-RTT sample from a sliding window.
 */

const WINDOW = 10;

const samples = [];
let fallbackOffset = 0;
let best = null;

export function addSample(sentAt, serverNow, receivedAt) {
  const rtt = receivedAt - sentAt;
  if (rtt < 0) return;
  samples.push({ rtt, offset: serverNow + rtt / 2 - receivedAt });
  if (samples.length > WINDOW) samples.shift();
  best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
}

/** Crude estimate from a state broadcast, used until a ping sample arrives. */
export function setFallbackOffset(offset) {
  fallbackOffset = offset;
}

export function getClockOffset() {
  return best ? best.offset : fallbackOffset;
}

export function getRtt() {
  return best ? best.rtt : null;
}

export function serverNow() {
  return Date.now() + getClockOffset();
}
