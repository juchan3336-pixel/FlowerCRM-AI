import { normalizeUrl } from "./normalize.js";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PREFERRED_PREFIXES = ["info@", "admin@", "contact@", "sales@"];
const CONTACT_PATHS = ["", "/contact", "/contact-us", "/about", "/company", "/customer"];

export async function extractEmail(homepage, timeoutMs = 7000) {
  const base = normalizeUrl(homepage);
  if (!base) return "";

  const found = new Set();
  for (const path of CONTACT_PATHS) {
    const url = new URL(path, base).toString();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": "FlowerB2BLeadCollector/0.1" },
      });
      clearTimeout(timer);

      if (!response.ok) continue;
      const text = await response.text();
      for (const email of text.match(EMAIL_RE) || []) found.add(email.toLowerCase());

      const preferred = pickPreferredEmail(found);
      if (preferred) return preferred;
    } catch {
      continue;
    }
  }

  return pickPreferredEmail(found) || [...found].sort()[0] || "";
}

function pickPreferredEmail(emails) {
  const sorted = [...emails].sort();
  for (const prefix of PREFERRED_PREFIXES) {
    const match = sorted.find((email) => email.startsWith(prefix));
    if (match) return match;
  }
  return "";
}
