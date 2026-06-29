import { PRIMARY_DB_SHEET_NAME } from "./config.js";
import { extractEmailDetails } from "./emailExtractor.js";
import {
  appendEnrichLog,
  batchUpdateEnrichRows,
  getTargetSpreadsheet,
  readQueuedEnrichmentRows,
  readRowsNeedingEnrichment,
  readSystemState,
  writeSystemState,
} from "./googleSheets.js";
import { cleanText, normalizeUrl } from "./normalize.js";

const DEFAULT_LIMIT = 300;
const SEARCH_LIMIT = 10;
const BANNED_HOST_PARTS = [
  "naver.com",
  "kakao.com",
  "daum.net",
  "google.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "blogspot.",
  "tistory.com",
  "wixsite.com",
];
const BANNED_PATH_PARTS = ["/blog/", "/cafe/", "/map/", "/maps/", "/place/", "/entry/", "/search"];
const COMPANY_WORD_RE = /(\uC8FC\uC2DD\uD68C\uC0AC|\uC720\uD55C\uD68C\uC0AC|\uC8FC\)|\(주\)|\uC8FC\uC2DD|\uC720\uD55C|\uBC95\uC778|\uD68C\uC0AC|inc|ltd|co\.?)/gi;

export class NaverHomepageSearchProvider {
  name = "naver-homepage";
  label = "Naver";

  enabled() {
    return Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
  }

  async search({ companyName, region, industry, limit = SEARCH_LIMIT }) {
    if (!this.enabled()) return [];
    const query = [companyName, region, industry].filter(Boolean).join(" ");
    const [local, web] = await Promise.all([this.searchLocal(query, limit), this.searchWeb(query, limit)]);
    return [...local, ...web];
  }

  async searchLocal(query, limit) {
    const data = await this.naverFetch("https://openapi.naver.com/v1/search/local.json", {
      query,
      display: String(Math.min(Math.max(limit, 1), 5)),
    });
    return (data.items || [])
      .filter((item) => item.link)
      .map((item) => ({
        url: normalizeUrl(item.link),
        title: cleanText(item.title),
        snippet: cleanText([item.category, item.roadAddress || item.address].filter(Boolean).join(" ")),
        source: "naver-local",
      }));
  }

  async searchWeb(query, limit) {
    const data = await this.naverFetch("https://openapi.naver.com/v1/search/webkr.json", {
      query,
      display: String(Math.min(Math.max(limit, 1), 10)),
    });
    return (data.items || []).map((item) => ({
      url: normalizeUrl(item.link),
      title: cleanText(item.title),
      snippet: cleanText(item.description),
      source: "naver-web",
    }));
  }

  async naverFetch(baseUrl, params) {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      headers: {
        "X-Naver-Client-Id": process.env.NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": process.env.NAVER_CLIENT_SECRET,
      },
    });
    if (!response.ok) throw new Error(`Naver API error: ${response.status}`);
    return response.json();
  }
}

export class GoogleHomepageSearchProvider {
  name = "google-search";
  label = "Google";

  enabled() {
    return true;
  }

  async search({ companyName, region, industry, limit = SEARCH_LIMIT }) {
    const query = [companyName, region, industry, "공식 홈페이지"].filter(Boolean).join(" ");
    const url = new URL("https://www.google.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(Math.min(Math.max(limit, 1), 10)));
    url.searchParams.set("hl", "ko");
    const response = await fetch(url, {
      headers: {
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
        "user-agent": "Mozilla/5.0 FlowerCRM-EnrichBot/0.1",
      },
    });
    if (!response.ok) throw new Error(`Google search error: ${response.status}`);
    const html = await response.text();
    return parseGoogleResults(html).slice(0, limit);
  }
}

export class PlaywrightHomepageSearchProvider {
  name = "playwright-google";
  label = "Playwright";

  enabled() {
    return true;
  }

  async search({ companyName, region, industry, limit = SEARCH_LIMIT }) {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error("Playwright is not installed");
    }

    const query = [companyName, region, industry, "공식 홈페이지"].filter(Boolean).join(" ");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ locale: "ko-KR" });
      await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit}&hl=ko`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      const results = await page.$$eval("a", (links) =>
        links
          .map((link) => ({
            url: link.href,
            title: link.textContent || "",
            snippet: link.closest("div")?.textContent || "",
            source: "playwright-google",
          }))
          .filter((item) => item.url),
      );
      return results.slice(0, limit);
    } finally {
      await browser.close();
    }
  }
}

export class FallbackHomepageSearchProvider {
  constructor({
    providers = [
      new NaverHomepageSearchProvider(),
      new GoogleHomepageSearchProvider(),
      new PlaywrightHomepageSearchProvider(),
    ],
    logger = null,
  } = {}) {
    this.providers = providers;
    this.logger = logger;
    this.usedLabels = new Set();
  }

  async findOfficial(company, { limit = SEARCH_LIMIT } = {}) {
    const failures = [];
    for (const provider of this.providers) {
      if (provider.enabled && !provider.enabled()) continue;
      const label = provider.label || provider.name;
      this.usedLabels.add(label);
      console.log(`Using ${label}`);
      this.logger?.info("homepage_search_provider", { message: `Using ${label}`, provider: provider.name });
      try {
        const candidates = await provider.search({ ...company, limit });
        const official = pickOfficialHomepage(candidates, company);
        if (official) return { official, provider: label, failures };
        failures.push(`${label}: official homepage not found`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
        this.logger?.info("homepage_search_provider_failed", { provider: provider.name, error: error.message });
      }
    }
    return { official: null, provider: "", failures };
  }

  getUsedLabels() {
    return [...this.usedLabels];
  }
}

export async function runEnrich({
  limit = DEFAULT_LIMIT,
  sheets = defaultSheetsGateway(),
  homepageProvider = null,
  fetchImpl = fetch,
  logger = null,
  dryRun = false,
} = {}) {
  const searchProvider = homepageProvider || new FallbackHomepageSearchProvider({ logger });
  const startedAt = Date.now();
  const summary = {
    spreadsheetId: "",
    sheetName: PRIMARY_DB_SHEET_NAME,
    startRow: 2,
    nextRow: 2,
    scanned: 0,
    processed: 0,
    homepageFound: 0,
    emailFound: 0,
    contactPagesFound: 0,
    failed: 0,
    skipped: 0,
    searchProvidersUsed: [],
    sheetsApi: { batchUpdate: 0, append: 0, update: 0, total: 0 },
    dryRun,
    runMs: 0,
  };
  const pendingRowUpdates = [];

  const { spreadsheetId } = await sheets.getTargetSpreadsheet();
  summary.spreadsheetId = spreadsheetId;
  const system = await sheets.readSystemState(spreadsheetId);
  const startRow = normalizeEnrichCurrentRow(system.enrich_current_row);
  const queuedRows = await sheets.readQueuedEnrichmentRows(spreadsheetId, { startRow, limit });
  const candidates = queuedRows.candidates;
  summary.startRow = startRow;
  summary.nextRow = queuedRows.nextRow;
  summary.scanned = queuedRows.scanned;
  summary.skipped = queuedRows.skipped;
  logger?.info("enrich_candidates_loaded", {
    count: candidates.length,
    limit,
    startRow,
    nextRow: queuedRows.nextRow,
    scanned: queuedRows.scanned,
    skipped: queuedRows.skipped,
    dryRun,
  });

  for (const candidate of candidates) {
    const result = await enrichCandidate(candidate, { homepageProvider: searchProvider, fetchImpl });
    summary.processed += 1;
    if (result.skipped) summary.skipped += 1;
    if (result.homepageUpdated) summary.homepageFound += 1;
    if (result.emailUpdated) summary.emailFound += 1;
    if (result.contactPageUrl) summary.contactPagesFound += 1;
    if (!result.homepageUpdated && !result.emailUpdated && result.failureReason) summary.failed += 1;

    logger?.info("enrich_row_finished", {
      rowNumber: candidate.rowNumber,
      companyName: result.companyName,
      homepageUpdated: result.homepageUpdated,
      emailUpdated: result.emailUpdated,
      failureReason: result.failureReason,
    });

    if (Object.keys(result.updates).length > 0) {
      pendingRowUpdates.push({ rowNumber: candidate.rowNumber, updates: result.updates });
    }
  }

  summary.runMs = Date.now() - startedAt;
  if (typeof searchProvider.getUsedLabels === "function") {
    summary.searchProvidersUsed = searchProvider.getUsedLabels().map((label) => `Using ${label}`);
  }
  summary.homepageUpdated = summary.homepageFound;
  summary.emailUpdated = summary.emailFound;
  if (!dryRun) {
    const batchWrite = await sheets.batchUpdateEnrichRows(spreadsheetId, pendingRowUpdates);
    summary.sheetsApi.batchUpdate += batchWrite.batchUpdate || 0;

    const logWrite = await sheets.appendEnrichLog(spreadsheetId, summary, "success");
    summary.sheetsApi.append += logWrite.appendCalls || 0;

    const systemWrite = await sheets.writeSystemState(
      spreadsheetId,
      {
        enrich_current_row: String(summary.nextRow),
        enrich_total_runs: String(numberValue(system.enrich_total_runs) + 1),
        enrich_total_processed: String(numberValue(system.enrich_total_processed) + summary.processed),
        enrich_homepage_found: String(numberValue(system.enrich_homepage_found) + summary.homepageFound),
        enrich_email_found: String(numberValue(system.enrich_email_found) + summary.emailFound),
        enrich_last_run_at: new Date().toISOString(),
      },
      "FlowerCRM Enrich queue state",
      system,
    );
    summary.sheetsApi.update += systemWrite.updates || 0;
    summary.sheetsApi.total = summary.sheetsApi.batchUpdate + summary.sheetsApi.append + summary.sheetsApi.update;
    printSheetsApiSummary(summary.sheetsApi);
  }
  return summary;
}

export async function enrichCandidate({ rowNumber, row }, { homepageProvider, fetchImpl = fetch }) {
  const current = rowToCompany(row);
  const updates = {};
  const memoParts = [];
  let homepage = current.homepage;
  let homepageUpdated = false;
  let emailUpdated = false;
  let contactPageUrl = "";
  let failureReason = "";

  if (current.homepage && current.email) {
    return { rowNumber, companyName: current.companyName, skipped: true, updates };
  }

  if (!homepage) {
    const searchRequest = {
      companyName: current.companyName,
      region: current.region,
      industry: current.industry,
      limit: SEARCH_LIMIT,
    };
    const searchResult =
      typeof homepageProvider.findOfficial === "function"
        ? await homepageProvider.findOfficial(current, { limit: SEARCH_LIMIT })
        : { official: pickOfficialHomepage(await homepageProvider.search(searchRequest), current), failures: [] };
    const official = searchResult.official;
    if (official) {
      homepage = official.url;
      updates.homepage = homepage;
      homepageUpdated = true;
    } else {
      failureReason = "홈페이지 없음";
      if (searchResult.failures?.length) {
        failureReason = `홈페이지 없음 (${searchResult.failures.join("; ")})`;
      }
    }
  }

  if (homepage && !current.email) {
    const emailResult = await extractEmailDetails(homepage, { fetchImpl });
    contactPageUrl = emailResult.contactPageUrl;
    if (emailResult.email) {
      updates.email = emailResult.email;
      emailUpdated = true;
    } else {
      failureReason ||= emailResult.error || "email not found";
    }
  }

  if (contactPageUrl) {
    memoParts.push(`enrich contact=${contactPageUrl}`);
  }
  if (failureReason) {
    memoParts.push(`enrich failed=${failureReason}`);
  }
  if (memoParts.length > 0) {
    updates.memo = mergeMemo(current.memo, memoParts.join("; "));
  }

  return {
    rowNumber,
    companyName: current.companyName,
    homepageUpdated,
    emailUpdated,
    contactPageUrl,
    failureReason,
    updates,
  };
}

function parseGoogleResults(html) {
  const results = [];
  const seen = new Set();
  const linkRe = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(linkRe)) {
    const rawHref = decodeHtml(match[1]);
    const url = extractGoogleTargetUrl(rawHref);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      url,
      title: cleanText(match[2]),
      snippet: cleanText(match[2]),
      source: "google-search",
    });
  }
  return results;
}

function extractGoogleTargetUrl(rawHref) {
  try {
    const href = rawHref.startsWith("/url?") ? `https://www.google.com${rawHref}` : rawHref;
    const url = new URL(href);
    if (url.hostname.includes("google.") && url.searchParams.get("q")) {
      return normalizeUrl(url.searchParams.get("q"));
    }
    if (!url.hostname.includes("google.")) return normalizeUrl(url.toString());
  } catch {
    return "";
  }
  return "";
}

function decodeHtml(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function pickOfficialHomepage(candidates, company) {
  const unique = dedupeCandidates(candidates);
  const scored = unique
    .map((candidate) => ({ ...candidate, score: scoreOfficialCandidate(candidate, company) }))
    .filter((candidate) => candidate.score >= 5)
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length);
  return scored[0] || null;
}

export function scoreOfficialCandidate(candidate, company) {
  const url = normalizeUrl(candidate.url);
  if (!url) return 0;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase();
  if (BANNED_HOST_PARTS.some((part) => host.includes(part))) return 0;
  if (BANNED_PATH_PARTS.some((part) => path.includes(part))) return 0;

  const companyKey = normalizeCompanyName(company.companyName);
  const haystack = normalizeCompanyName(`${candidate.title} ${candidate.snippet}`);
  const hostKey = normalizeCompanyName(host);
  const words = significantWords(company.companyName);
  let score = 0;

  if (companyKey && haystack.includes(companyKey)) score += 5;
  if (words.length > 0) {
    const matches = words.filter((word) => haystack.includes(word) || hostKey.includes(word));
    score += Math.min(matches.length, 3) * 2;
  }
  if (candidate.source === "naver-local") score += 1;
  if (["/", ""].includes(path)) score += 1;
  if (host.endsWith(".co.kr") || host.endsWith(".com") || host.endsWith(".kr")) score += 1;
  return score;
}

export function rowToCompany(row) {
  return {
    companyName: cleanText(row[0]),
    industry: cleanText(row[1]),
    detailIndustry: cleanText(row[2]),
    region: cleanText(row[3]),
    address: cleanText(row[4]),
    phone: cleanText(row[5]),
    homepage: normalizeUrl(row[6]),
    email: cleanText(row[7]).toLowerCase(),
    sourceUrl: normalizeUrl(row[8]),
    memo: cleanText(row[12]),
  };
}

function defaultSheetsGateway() {
  return {
    getTargetSpreadsheet,
    batchUpdateEnrichRows,
    readQueuedEnrichmentRows,
    readRowsNeedingEnrichment,
    readSystemState,
    writeSystemState,
    appendEnrichLog,
  };
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates || []) {
    const url = normalizeUrl(candidate.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push({ ...candidate, url });
  }
  return result;
}

function normalizeCompanyName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(COMPANY_WORD_RE, "")
    .replace(/[^0-9a-z\uAC00-\uD7A3]+/gi, "");
}

function significantWords(value) {
  const compact = normalizeCompanyName(value);
  const spaced = cleanText(value)
    .toLowerCase()
    .replace(COMPANY_WORD_RE, " ")
    .split(/[^0-9a-z\uAC00-\uD7A3]+/gi)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  return [...new Set([compact, ...spaced].filter((word) => word.length >= 2))];
}

function mergeMemo(existingMemo, enrichMemo) {
  const existing = cleanText(existingMemo);
  return existing ? `${existing} | ${enrichMemo}` : enrichMemo;
}

function normalizeEnrichCurrentRow(value) {
  const row = Number(value || 2);
  return Number.isInteger(row) && row >= 2 ? row : 2;
}

function numberValue(value) {
  return Number(value || 0) || 0;
}

function printSheetsApiSummary(stats) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Sheets API");
  console.log(`batchUpdate ${stats.batchUpdate || 0}`);
  console.log(`append ${stats.append || 0}`);
  console.log(`update ${stats.update || 0}`);
  console.log(`total ${stats.total || 0}`);
  console.log("━━━━━━━━━━━━━━");
}
