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

export async function extractEmailDetails(
  homepage,
  {
    timeoutMs = 7000,
    fetchImpl = fetch,
    maxPages = 12,
    deadlineAt = 0,
    now = () => Date.now(),
    signal = null,
    // Decides, per address, whether it may be this site's answer at all. It is asked before the
    // winner is picked, not after: rejecting only the winner would stop the crawl at the first
    // wrong address and never reach a right one on a later page. Receives the address, the URL the
    // page was finally served from (after redirects) and the address's contact cards.
    accept = null,
    // Called once per fetched page with its final URL and text, emails or not.
    onPage = null,
  } = {},
) {
  const base = normalizeUrl(homepage);
  if (!base) return { email: "", contactPageUrl: "", visitedUrls: [], visited: [], pagesVisited: 0, error: "invalid homepage url" };

  const pageLimit = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 12;
  const hasDeadline = Number.isFinite(deadlineAt) && deadlineAt > 0;
  // The row's signal must cancel an in-flight homepage request, not merely stop the next one:
  // without it a hung page runs to its own timeout and blows past the row deadline.
  const rowAborted = () => Boolean(signal?.aborted);
  const found = new Set();
  // Addresses seen but not accepted, with why they could not be used — kept for the row's debug.
  const rejectedEmails = new Set();
  const sourceUrls = new Map(); // accepted address -> the page it was accepted on
  const urls = CONTACT_PATHS.map((path) => new URL(path, base).toString());
  const visitedUrls = [];
  const visited = [];
  let contactPageUrl = "";
  let contactLinksFound = false;
  let lastError = "";
  let budgetExceeded = false;

  for (let index = 0; index < urls.length && visitedUrls.length < pageLimit; index += 1) {
    if ((hasDeadline && now() >= deadlineAt) || rowAborted()) {
      budgetExceeded = true;
      break;
    }
    const url = urls[index];
    if (visitedUrls.includes(url)) continue;
    visitedUrls.push(url);
    const visit = { url, ok: false, status: 0, error: "" };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Cancel this request as soon as the row is cancelled, then detach so a long crawl does
      // not accumulate listeners on the row signal.
      const onRowAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener?.("abort", onRowAbort, { once: true });
      let response;
      try {
        response = await fetchImpl(url, {
          redirect: "follow",
          signal: controller.signal,
          headers: { "user-agent": "FlowerB2BLeadCollector/0.1" },
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onRowAbort);
      }

      // A task that ignores the signal can still resolve after the row was cancelled, so every
      // await is re-checked before its result is used. Wiring the signal alone is not enough.
      if (rowAborted()) {
        budgetExceeded = true;
        break;
      }
      visit.status = response.status;
      visit.ok = response.ok;
      if (!response.ok) continue;
      const body = await response.text();
      if (rowAborted()) {
        budgetExceeded = true;
        break;
      }
      const text = stripIgnoredHtml(body);
      const finalUrl = response.url || url;
      if (typeof onPage === "function") onPage({ url: finalUrl, text });
      for (const rawEmail of new Set(text.match(EMAIL_RE) || [])) {
        const email = rawEmail.toLowerCase();
        if (found.has(email)) continue;
        if (typeof accept === "function" && !accept({ email, url: finalUrl, cards: contactCards(text, rawEmail) })) {
          rejectedEmails.add(email);
          continue;
        }
        found.add(email);
        sourceUrls.set(email, finalUrl);
      }
      for (const href of extractContactLinks(text, url)) {
        if (!urls.includes(href)) urls.push(href);
        contactPageUrl ||= href;
        contactLinksFound = true;
      }
      if (rowAborted()) {
        budgetExceeded = true;
        break;
      }

      const preferred = pickPreferredEmail(found);
      if (preferred) {
        visited.push(visit);
        return {
          email: preferred,
          emailSourceUrl: sourceUrls.get(preferred) || "",
          rejectedEmails: [...rejectedEmails].filter((email) => !found.has(email)),
          contactPageUrl,
          visitedUrls,
          visited,
          contactLinksFound,
          pagesVisited: visitedUrls.length,
          error: "",
        };
      }
    } catch (error) {
      visit.error = error.message || String(error);
      // A row cancellation is not a site failure: stop the crawl instead of blaming the page
      // and instead of trying the remaining contact URLs.
      if (rowAborted()) {
        budgetExceeded = true;
        break;
      }
      lastError = `failed to fetch ${url}`;
      continue;
    } finally {
      if (!visited.includes(visit)) visited.push(visit);
    }
  }

  // Final guard: a cancelled row returns no email or contact URL, whatever late work produced.
  if (rowAborted()) {
    return {
      email: "",
      rejectedEmails: [],
      contactPageUrl: "",
      visitedUrls,
      visited,
      contactLinksFound,
      pagesVisited: visitedUrls.length,
      error: "row budget exceeded before email found",
    };
  }
  const email = pickPreferredEmail(found) || [...found].sort()[0] || "";
  return {
    email,
    emailSourceUrl: sourceUrls.get(email) || "",
    rejectedEmails: [...rejectedEmails].filter((item) => !found.has(item)),
    contactPageUrl,
    visitedUrls,
    visited,
    contactLinksFound,
    pagesVisited: visitedUrls.length,
    error: email ? "" : budgetExceeded ? "row budget exceeded before email found" : lastError || "email not found",
  };
}

const HARD_BREAK = "\u0001";
// Elements that start a new region of a page: what follows is not part of what came before.
// A list item and a table row are each their own region — sibling items are how a page lists
// several businesses, and one item's phone number must never vouch for the next item's address.
const HARD_BREAK_TAG_RE = /<\/?(?:footer|section|article|header|nav|aside|main|form|table|ul|ol|dl|li|tr|hr|h[1-6])\b[^>]*>/gi;
// Elements that end a line inside a region.
const LINE_BREAK_TAG_RE = /<(?:br|\/p|\/div|\/dd|\/dt|\/address|\/td|\/th)\b[^>]*>/gi;
const CARD_LINES_ABOVE = 3;
const CARD_LINES_BELOW = 1;
const CARD_LINE_LIMIT = 400;

function fragmentLines(fragment, isHtml) {
  let value = String(fragment || "");
  if (isHtml) {
    value = value
      .replace(HARD_BREAK_TAG_RE, `\n${HARD_BREAK}\n`)
      .replace(LINE_BREAK_TAG_RE, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ");
  } else {
    // In plain text a blank line is the only region boundary there is.
    value = value.replace(/\n[ \t]*\n+/g, `\n${HARD_BREAK}\n`);
  }
  return value
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// The contact card(s) an address sits in: its own line plus the few lines directly around it, never
// reaching across a region boundary (a footer, a section, a heading, a blank line). One card per
// place the address is printed. This — not "the text nearby" — is what may tie an address to a
// business: a branch's details followed by a site-wide footer are two cards, not one.
// Each card: { line: the address's own line, text: the whole card }.
export function contactCards(text, rawEmail) {
  const value = String(text || "");
  const lower = value.toLowerCase();
  const needle = String(rawEmail || "").toLowerCase();
  const isHtml = /<[a-z!/][^>]*>/i.test(value);
  const cards = [];
  let from = 0;
  while (needle && cards.length < 6) {
    const index = lower.indexOf(needle, from);
    if (index < 0) break;
    from = index + needle.length;
    const above = fragmentLines(value.slice(Math.max(0, index - 2000), index), isHtml);
    const below = fragmentLines(value.slice(index + needle.length, index + needle.length + 2000), isHtml);
    // The fragment edges are mid-line: the last line above and the first below are the address's own.
    const endsLine = /(?:\n|<(?:br|\/p|\/div|\/dd|\/dt|\/address|\/td|\/th)\b[^>]*>)\s*$/i;
    const startsLine = /^\s*(?:\n|<(?:br|\/p|\/div|\/dd|\/dt|\/address|\/td|\/th)\b[^>]*>)/i;
    const rawAbove = value.slice(Math.max(0, index - 2000), index);
    const rawBelow = value.slice(index + needle.length, index + needle.length + 2000);
    const left = above.length && above.at(-1) !== HARD_BREAK && !endsLine.test(rawAbove) ? above.pop() : "";
    const right = below.length && below[0] !== HARD_BREAK && !startsLine.test(rawBelow) ? below.shift() : "";
    const line = `${left.slice(-CARD_LINE_LIMIT)} ${value.slice(index, index + needle.length)} ${right.slice(0, CARD_LINE_LIMIT)}`.trim();
    const lines = [];
    for (let i = above.length - 1, taken = 0; i >= 0 && taken < CARD_LINES_ABOVE; i -= 1, taken += 1) {
      if (above[i] === HARD_BREAK) break;
      lines.unshift(above[i].slice(-CARD_LINE_LIMIT));
    }
    lines.push(line);
    for (let i = 0; i < below.length && i < CARD_LINES_BELOW; i += 1) {
      if (below[i] === HARD_BREAK) break;
      lines.push(below[i].slice(0, CARD_LINE_LIMIT));
    }
    // above/below are kept apart so a reader of the card can tell how far each line is from the
    // address; `text` stays the whole card.
    cards.push({ line, above: lines.slice(0, lines.indexOf(line)), below: lines.slice(lines.indexOf(line) + 1), text: lines.join("\n") });
  }
  return cards;
}

export function pickPreferredEmail(emails) {
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
