// What a scheduled run may print. The repository is public, so its Actions console and its run
// artifacts can be read by anyone signed in to GitHub. A full email address appears in neither:
// each one keeps its domain only (***@example.test). The full address lives in the sheet.

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Undo percent-encoding piece by piece, a few rounds deep, so "a%40b%2Etest" and doubly encoded
// forms are seen as the addresses they decode to. A sequence that does not decode stays as it is.
function decodePercent(text) {
  let value = text;
  for (let round = 0; round < 3; round += 1) {
    const next = value.replace(/(?:%[0-9a-f]{2})+/gi, (sequence) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        return sequence;
      }
    });
    if (next === value) break;
    value = next;
  }
  return value;
}

export function maskEmails(value) {
  const text = String(value ?? "");
  const decoded = /%[0-9a-f]{2}/i.test(text) ? decodePercent(text) : text;
  return decoded.replace(EMAIL_RE, (email) => `***@${email.split("@")[1] || ""}`);
}

// Every string in a log payload, at any depth. Keys are left alone; values that are not strings,
// arrays or plain objects pass through.
export function sanitizeForPublic(value, depth = 0) {
  if (typeof value === "string") return maskEmails(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeForPublic(item, depth + 1));
  if (value instanceof Error) return { message: maskEmails(value.message), stack: maskEmails(value.stack || "") };
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = sanitizeForPublic(item, depth + 1);
  return out;
}

// For a run whose console output is public: every console.log/error/warn argument is masked.
// Returns a function that puts the original console back.
export function maskConsoleOutput(target = console) {
  const originals = { log: target.log, error: target.error, warn: target.warn, info: target.info };
  for (const name of Object.keys(originals)) {
    const original = originals[name];
    target[name] = (...args) => original.apply(target, args.map((arg) => (typeof arg === "string" ? maskEmails(arg) : sanitizeForPublic(arg))));
  }
  return () => Object.assign(target, originals);
}
