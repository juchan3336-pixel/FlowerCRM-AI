import { normalizeUrl } from "./normalize.js";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PREFERRED_PREFIXES = ["info@", "contact@", "admin@", "master@", "sales@", "cs@", "help@", "support@"];
const CONTACT_PATHS = [
  "",
  "/contact",
  "/contact-us",
  "/about",
  "/company",
  "/customer",
  "/customer-center",
  "/center",
  "/inquiry",
  "/support",
  "/cs",
  "/location",
  "/directions",
  "/reservation",
  "/consulting",
];
const CONTACT_LINK_RE = /(contact|inquiry|customer|support|cs|about|company|location|direction|reservation|consulting|\uBB38\uC758|\uACE0\uAC1D|\uACE0\uAC1D\uC13C\uD130|\uD68C\uC0AC\uC18C\uAC1C|\uC624\uC2DC\uB294|\uC624\uC2DC\uB294\uAE38|\uC0C1\uB2F4|\uC608\uC57D)/i;

export async function extractEmail(homepage, timeoutMs = 7000) {
  const result = await extractEmailDetails(homepage, { timeoutMs });
  return result.email;
}

export async function extractEmailDetails(homepage, { timeoutMs = 7000, fetchImpl = fetch } = {}) {
  const base = normalizeUrl(homepage);
  if (!base) return { email: "", contactPageUrl: "", visitedUrls: [], error: "invalid homepage url" };

  const found = new Set();
  const urls = CONTACT_PATHS.map((path) => new URL(path, base).toString());
  const visitedUrls = [];
  let contactPageUrl = "";
  let lastError = "";

  for (let index = 0; index < urls.length && index < 12; index += 1) {
    const url = urls[index];
    if (visitedUrls.includes(url)) continue;
    visitedUrls.push(url);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          redirect: "follow",
          signal: controller.signal,
          headers: { "user-agent": "FlowerB2BLeadCollector/0.1" },
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) continue;
      const text = stripIgnoredHtml(await response.text());
      for (const email of text.match(EMAIL_RE) || []) found.add(email.toLowerCase());
      for (const href of extractContactLinks(text, url)) {
        if (!urls.includes(href)) urls.push(href);
        contactPageUrl ||= href;
      }

      const preferred = pickPreferredEmail(found);
      if (preferred) return { email: preferred, contactPageUrl, visitedUrls, error: "" };
    } catch {
      lastError = `failed to fetch ${url}`;
      continue;
    }
  }

  const email = pickPreferredEmail(found) || [...found].sort()[0] || "";
  return { email, contactPageUrl, visitedUrls, error: email ? "" : lastError || "email not found" };
}

function pickPreferredEmail(emails) {
  const sorted = [...emails].sort();
  for (const prefix of PREFERRED_PREFIXES) {
    const match = sorted.find((email) => email.startsWith(prefix));
    if (match) return match;
  }
  return "";
}

function extractContactLinks(html, currentUrl) {
  const links = [];
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(hrefRe)) {
    const rawHref = match[1];
    const label = match[2].replace(/<[^>]+>/g, " ");
    if (!CONTACT_LINK_RE.test(`${rawHref} ${label}`)) continue;
    try {
      const url = new URL(rawHref, currentUrl);
      if (!/^https?:$/i.test(url.protocol)) continue;
      links.push(url.toString());
    } catch {
      continue;
    }
  }
  return links;
}

function stripIgnoredHtml(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<img\b[^>]*>/gi, " ");
}
