export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function randomDelay(minMs, maxMs, onDelay = null) {
  if (maxMs <= 0 || minMs < 0) return 0;
  const waitMs = randomInt(minMs, maxMs);
  if (onDelay) onDelay(waitMs);
  await sleep(waitMs);
  return waitMs;
}
