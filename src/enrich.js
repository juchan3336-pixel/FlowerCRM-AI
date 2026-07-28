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
const EMAIL_DISCOVERY_LIMIT = 5;
const DEBUG_CANDIDATE_LIMIT = 5;
// Per-row exploration budgets (PR-A). Each is enforced independently; 0 disables that budget.
// Median row ≈ 61s and failure rows dominate wall-clock, so these cap the long tail per row.
const DEFAULT_ROW_MAX_RUNTIME_MS = 45000; // wall-clock per row
const DEFAULT_MAX_SEARCH_QUERIES_PER_ROW = 8; // Naver/Playwright searches per row
const DEFAULT_MAX_RESULT_PAGES_PER_ROW = 12; // search-result page reads per row
const DEFAULT_MAX_HOMEPAGE_PAGES_PER_ROW = 6; // company homepage/contact-page visits per row
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
  "jobkorea.co.kr",
  "saramin.co.kr",
  "work.go.kr",
  "incruit.com",
  "jobplanet.co.kr",
  "wanted.co.kr",
  "rocketpunch.com",
];
const NEWS_MEDIA_HOST_PARTS = [
  "hankyung.com",
  "mk.co.kr",
  "fnnews.com",
  "mt.co.kr",
  "news.mt.co.kr",
  "newsis.com",
  "yna.co.kr",
  "etnews.com",
  "sedaily.com",
  "joongang.co.kr",
  "chosun.com",
  "donga.com",
  "khan.co.kr",
  "asiae.co.kr",
  "heraldcorp.com",
  "koreaherald.com",
  "gukjenews.com",
  "sisamagazine.co.kr",
  "intn.co.kr",
  "metroseoul.co.kr",
  "fintechpost.co.kr",
  "financialpost.co.kr",
  "kyosu.net",
];
const FOLLOWABLE_HOST_PARTS = [
  "naver.com",
  "kakao.com",
  "jobkorea.co.kr",
  "saramin.co.kr",
  "work.go.kr",
  "incruit.com",
  "jobplanet.co.kr",
  "wanted.co.kr",
  "rocketpunch.com",
];
const JOB_SITE_HOST_PARTS = [
  "saramin.co.kr",
  "jobkorea.co.kr",
  "work.go.kr",
  "incruit.com",
  "jobplanet.co.kr",
  "wanted.co.kr",
  "rocketpunch.com",
  "jobploy.kr",
];
const DIRECTORY_HOST_PARTS = ["nicebizinfo.com", "moneypin.biz", "rndcircle.io", "greenremodeling.or.kr"];
const BUSINESS_DIRECTORY_HOST_PARTS = [
  ...DIRECTORY_HOST_PARTS,
  "bizno.net",
  "marketbz.com",
  "weseb.com",
  "opensalary.com",
  "kmcca.or.kr",
  "dataline.co.kr",
  "saraminhr.co.kr",
  "newworker.co.kr",
  "catch.co.kr",
  "corp.udanax.org",
  "g2bmarket.com",
  "webify.kr",
  "114.co.kr",
  "114-service.co.kr",
  "grandculture.net",
  "saramin-team.kr",
  "cookiedeal.io",
  "pusan.ac.kr",
  "allthatcompany.com",
  "happycampus.com",
  "happyhaksul.com",
  "tapemro.com",
  "bizlookup.co.kr",
  "kind.krx.co.kr",
  "thinkzon.com",
];
const BANNED_PATH_PARTS = [
  "/blog/",
  "/cafe/",
  "/map/",
  "/maps/",
  "/place/",
  "/entry/",
  "/search",
  "/srch/",
  "/download.do",
  "/company-search/",
  "/corp-doc/",
  "/product/",
];
const NEWS_ARTICLE_PATH_PATTERNS = [
  /\/(?:article|articles|newsroom|press)\//i,
  /\/news\/articleview\.html/i,
  /\/news\/\d{6,}(?:$|[/?#])/i,
  /\/news\/\d{4}\/\d{2}\/\d{2}(?:$|[/?#])/i,
  /\/(?:mtview|view)\.php(?:$|[?#])/i,
  /\/(?:article|news|read)\.php(?:$|[?#])/i,
];
const NEWS_ARTICLE_QUERY_PATTERNS = [/[?&](?:no|idx|artid|article_id|articleNo|aid|seq|newsid)=/i];
const COMPANY_WORD_RE = /(\uC8FC\uC2DD\uD68C\uC0AC|\uC720\uD55C\uD68C\uC0AC|\uC8FC\)|\(주\)|\uC8FC\uC2DD|\uC720\uD55C|\uBC95\uC778|\uD68C\uC0AC|inc|ltd|co\.?)/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PERSONAL_EMAIL_DOMAINS = new Set(["gmail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com"]);
const PREFERRED_EMAIL_PREFIXES = ["info", "contact", "admin", "master", "sales", "cs", "help", "support"];
const EMAIL_DISCOVERY_TERMS = ["이메일", "대표메일", "문의", "contact", "채용", "사업자등록"];
const JOB_SITE_DISCOVERY_TERMS = [
  "채용",
  "문의",
  "대표메일",
  "담당자 이메일",
  "인사담당자",
  "채용 이메일",
  "인사담당자 이메일",
  "사람인",
  "잡코리아",
  "워크넷",
  "홈페이지",
];
const PUBLIC_CONTACT_LABEL_RE = /담당자|인사|문의|대표메일|채용|recruit|hr|contact|email/i;
const KOREAN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 FlowerCRM-Enrich/1.0";
const SHORT_FAILURE_MEMO = "enrich: 홈페이지/이메일 미확보";

export class NaverHomepageSearchProvider {
  name = "naver-homepage";
  label = "Naver";

  enabled() {
    return Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
  }

  async search({ query: rawQuery, companyName, region, industry, limit = SEARCH_LIMIT }) {
    if (!this.enabled()) return [];
    const query = rawQuery || [companyName, region, industry].filter(Boolean).join(" ");
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

  async search({ query: rawQuery, companyName, region, industry, limit = SEARCH_LIMIT }) {
    const query = rawQuery || buildHomepageQueries({ companyName, region, industry })[0];
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
    if (!response.ok) {
      const error = new Error(`Google search error: ${response.status}`);
      error.status = response.status;
      error.providerDisabled = response.status === 429;
      throw error;
    }
    const html = await response.text();
    return parseGoogleResults(html).slice(0, limit);
  }
}

export class PlaywrightHomepageSearchProvider {
  name = "playwright-naver";
  label = "Playwright";

  constructor({ timeoutMs = 15000, userAgent = KOREAN_USER_AGENT, locale = "ko-KR" } = {}) {
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.locale = locale;
    this.browserPromise = null;
  }

  enabled() {
    return true;
  }

  async search({ query: rawQuery, companyName, region, industry, limit = SEARCH_LIMIT }) {
    const query = rawQuery || buildHomepageQueries({ companyName, region, industry })[0];
    const browser = await this.getBrowser();
    let context;
    try {
      context = await browser.newContext({
        locale: this.locale,
        userAgent: this.userAgent,
        extraHTTPHeaders: { "accept-language": "ko-KR,ko;q=0.9,en;q=0.8" },
      });
      const page = await context.newPage();
      await page.goto(`https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      const results = await page.$$eval("a", (links) =>
        links
          .map((link) => ({
            url: link.href,
            title: link.textContent || "",
            snippet: link.closest("div")?.textContent || "",
            source: "playwright-naver",
          }))
          .filter((item) => item.url),
      );
      return filterSearchResultLinks(results).slice(0, limit);
    } finally {
      await context?.close().catch(() => {});
    }
  }

  async readPageText(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return "";
    const browser = await this.getBrowser();
    let context;
    try {
      context = await browser.newContext({
        locale: this.locale,
        userAgent: this.userAgent,
        extraHTTPHeaders: { "accept-language": "ko-KR,ko;q=0.9,en;q=0.8" },
      });
      const page = await context.newPage();
      await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      return await page.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const links = Array.from(document.querySelectorAll("a"))
          .map((link) => [link.textContent || "", link.href || ""].filter(Boolean).join(" "))
          .join("\n");
        return [bodyText, links].filter(Boolean).join("\n");
      });
    } finally {
      await context?.close().catch(() => {});
    }
  }

  async getBrowser() {
    if (!this.browserPromise) {
      this.browserPromise = import("playwright")
        .then(({ chromium }) => chromium.launch({ headless: true }))
        .catch((cause) => {
          this.browserPromise = null;
          const error = new Error("Playwright is not installed");
          error.providerDisabled = true;
          error.cause = cause;
          throw error;
        });
    }
    return this.browserPromise;
  }

  async close() {
    const browser = await this.browserPromise?.catch(() => null);
    this.browserPromise = null;
    await browser?.close().catch(() => {});
  }
}

export class SourceUrlHomepageProvider {
  name = "source-url-homepage";
  label = "SourceUrl";

  enabled() {
    return true;
  }

  async search({ sourceUrl, fetchImpl = fetch, limit = SEARCH_LIMIT }) {
    const url = normalizeUrl(sourceUrl);
    if (!url) return [];
    const text = await fetchSearchResultText(url, fetchImpl);
    return extractOfficialLinks(text, url)
      .slice(0, limit)
      .map((link) => ({
        url: link,
        title: "sourceUrl official link",
        snippet: text.slice(0, 1000),
        source: this.name,
      }));
  }
}

export class JobSiteDiscoveryProvider {
  name = "job-site-discovery";
  label = "JobSite";
  // Blocker 4 — this provider delegates to a real search provider and reserves the unit there,
  // so an outer caller must not charge again for the wrapper invocation.
  chargesOwnSearchBudget = true;

  constructor({ searchProvider = null, fetchImpl = fetch } = {}) {
    this.searchProvider = searchProvider;
    this.fetchImpl = fetchImpl;
  }

  enabled() {
    return true;
  }

  async search(request) {
    const results = await searchEmailDiscovery(
      this.searchProvider,
      request.query,
      request.limit || EMAIL_DISCOVERY_LIMIT,
      request.context || null,
    );
    return results.filter((result) => isJobSiteUrl(result.url));
  }

  async close() {
    await this.searchProvider?.close?.();
  }

  async discover(company, { homepage = "", context = null } = {}) {
    const ctx = context || new RowExplorationContext({ fetchImpl: this.fetchImpl });
    const candidates = [];
    const officialHost = homepage ? hostnameOf(homepage) : "";
    const queries = JOB_SITE_DISCOVERY_TERMS.map((term) => `${company.companyName} ${term}`);
    for (const query of queries) {
      // Blocker 1 — only time/abort stops this phase. A spent search/result-page budget refuses
      // its own next unit inside cachedSearch/readPage, but must not suppress JobSite fallback.
      if (ctx.hardStopped()) break;
      const results = (
        await ctx.cachedSearch(query, () => searchEmailDiscovery(this.searchProvider, query, EMAIL_DISCOVERY_LIMIT, ctx))
      ).filter((result) => isJobSiteUrl(result.url));
      for (const result of results) {
        const pageText = await ctx.readPage(this.searchProvider, result.url, this.fetchImpl);
        const haystack = `${result.title} ${result.snippet} ${pageText}`;
        const matchScore = matchCompanyAddressScore(haystack, company);
        const officialLinks = extractOfficialLinks(pageText, result.url)
          .filter((url) => !isJobSiteUrl(url) && !isBannedHomepageUrl(url))
          .map((url) => ({ url, officialScore: scoreOfficialCandidate({ url, title: url, snippet: url, source: this.name }, company) }))
          .filter((item) => item.officialScore >= 5)
          .map((item) => ({ url: item.url, score: item.officialScore + matchScore }));
        const emails = [];
        collectEmailCandidates(haystack, result.url, officialHost, emails, {
          allowPersonalMemo: true,
          allowPublishedContact: true,
          company,
          sourceName: jobSiteName(result.url),
          sourceType: "job-site",
        });
        const sortedEmails = emails.sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));
        const selectedEmail = sortedEmails.find((item) => !item.personal && !item.rejected) || sortedEmails.find((item) => item.emailKind === "published_contact" && !item.rejected);
        candidates.push({
          sourceUrl: normalizeUrl(result.url),
          sourceName: jobSiteName(result.url),
          homepage: officialLinks.sort((a, b) => b.score - a.score)[0]?.url || "",
          email: selectedEmail?.email || "",
          emailKind: selectedEmail?.emailKind || "",
          score: selectedEmail?.score || 0,
          scoreReason: selectedEmail?.scoreReason || "",
          sourceReason: selectedEmail ? sourceReason({ sourceName: jobSiteName(result.url), sourceUrl: result.url, sourceType: "job-site" }) : "",
          personalEmail: sortedEmails.find((item) => item.personal)?.email || "",
          rejectedEmails: sortedEmails.filter((item) => item.rejected).map((item) => item.email),
          matchScore,
        });
      }
      // Blocker 2 — never stop merely because *some* email exists: a first off-domain hit (score 98)
      // would suppress a later official-domain candidate (score 148). Only a high-confidence
      // (company-domain) candidate is a safe early stop.
      if (candidates.some(isHighConfidenceEmailCandidate)) break;
    }

    candidates.sort(compareJobSiteCandidates);
    return candidates[0] || { sourceUrl: "", sourceName: "", homepage: "", email: "", emailKind: "", personalEmail: "", rejectedEmails: [], matchScore: 0 };
  }
}

// Blocker 2 — deterministic JobSite candidate ranking. Order:
//   1) a valid high-confidence (company-domain) email wins outright,
//   2) then the numeric email score (148 official-domain beats 98 off-domain),
//   3) then the original homepage/email/address-match evidence heuristic,
//   4) then normalized source URL and email, so equal candidates resolve reproducibly.
export function compareJobSiteCandidates(a, b) {
  const confidence = Number(isHighConfidenceEmailCandidate(b)) - Number(isHighConfidenceEmailCandidate(a));
  if (confidence !== 0) return confidence;

  const scoreOf = (candidate) => (candidate.email && Number.isFinite(candidate.score) ? candidate.score : -Infinity);
  const byScore = scoreOf(b) - scoreOf(a);
  if (byScore !== 0 && Number.isFinite(byScore)) return byScore;
  if (scoreOf(a) !== scoreOf(b)) return scoreOf(b) === Infinity || scoreOf(a) === -Infinity ? 1 : -1;

  const evidenceOf = (candidate) => (candidate.homepage ? 50 : 0) + (candidate.email ? 30 : 0) + (candidate.matchScore || 0);
  const byEvidence = evidenceOf(b) - evidenceOf(a);
  if (byEvidence !== 0) return byEvidence;

  return String(a.sourceUrl || "").localeCompare(String(b.sourceUrl || "")) || String(a.email || "").localeCompare(String(b.email || ""));
}

export class FallbackHomepageSearchProvider {
  constructor({
    providers = null,
    sourceProvider = new SourceUrlHomepageProvider(),
    logger = null,
    fetchImpl = fetch,
  } = {}) {
    this.providers = providers || [
      new PlaywrightHomepageSearchProvider(),
      new JobSiteDiscoveryProvider({ searchProvider: new PlaywrightHomepageSearchProvider(), fetchImpl }),
    ];
    this.sourceProvider = sourceProvider;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.usedLabels = new Set();
    this.disabledProviders = new Set();
  }

  async findOfficial(company, { limit = SEARCH_LIMIT, context = null } = {}) {
    const failures = [];
    const allCandidates = [];
    const searchEvents = [];
    const orderedProviders =
      company.sourceUrl && this.providers.length > 0
        ? [this.providers[0], this.sourceProvider, ...this.providers.slice(1)]
        : this.providers;
    for (const provider of orderedProviders) {
      if (this.disabledProviders.has(provider.name)) continue;
      if (provider.enabled && !provider.enabled()) continue;
      if (context && (context.timeExceeded() || context.searchBudgetSpent())) break;
      const label = provider.label || provider.name;
      this.usedLabels.add(label);
      console.log(`Using ${label}`);
      this.logger?.info("homepage_search_provider", { message: `Using ${label}`, provider: provider.name });
      try {
        let candidateCount = 0;
        for (const query of buildHomepageQueries(company)) {
          // Blocker 4 — one unit per underlying provider request. Providers that charge their own
          // units (nested fan-out wrappers) are not charged again here.
          if (context && !providerChargesOwnSearchBudget(provider) && !context.reserveSearch()) break;
          if (context?.hardStopped()) break;
          const candidates = await provider.search({
            ...company,
            query,
            limit,
            fetchImpl: this.fetchImpl,
            signal: context?.signal ?? null,
            ...(providerChargesOwnSearchBudget(provider) ? { context } : {}),
          });
          searchEvents.push({
            provider: label,
            query,
            candidateUrls: candidates.slice(0, DEBUG_CANDIDATE_LIMIT).map((item) => item.url),
            ok: true,
            error: "",
          });
          allCandidates.push(...candidates);
          candidateCount += candidates.length;
          const official = await pickOfficialHomepageAsync(candidates, company, this.fetchImpl, provider, context);
          if (official) return { official, provider: label, failures, candidates: allCandidates, searchEvents };
        }
        failures.push(`${label}: official homepage not found (${candidateCount} candidates)`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
        searchEvents.push({
          provider: label,
          query: "",
          candidateUrls: [],
          ok: false,
          error: error.message,
        });
        this.logger?.info("homepage_search_provider_failed", { provider: provider.name, error: error.message });
        if (error.providerDisabled || error.status === 429 || /not installed/i.test(error.message)) {
          this.disabledProviders.add(provider.name);
          this.logger?.info("homepage_search_provider_disabled", { provider: provider.name, reason: error.message });
        }
      }
    }
    return { official: null, provider: "", failures, candidates: allCandidates, searchEvents };
  }

  async search({ query, companyName = query, region = "", industry = "", limit = EMAIL_DISCOVERY_LIMIT, context = null, signal = null } = {}) {
    const results = [];
    for (const provider of this.providers) {
      if (this.disabledProviders.has(provider.name)) continue;
      if (provider.enabled && !provider.enabled()) continue;
      // Blocker 4 — each underlying provider request costs one unit. When capacity ends we stop
      // launching further providers and keep everything gathered so far.
      if (context && !providerChargesOwnSearchBudget(provider) && !context.reserveSearch()) break;
      if (context?.hardStopped()) break;
      const label = provider.label || provider.name;
      const firstUse = !this.usedLabels.has(label);
      this.usedLabels.add(label);
      if (firstUse) console.log(`Using ${label}`);
      this.logger?.info("email_search_provider", { message: `Using ${label}`, provider: provider.name, query });
      try {
        results.push(
          ...(await provider.search({
            query,
            companyName,
            region,
            industry,
            limit,
            fetchImpl: this.fetchImpl,
            signal: signal ?? context?.signal ?? null,
            ...(providerChargesOwnSearchBudget(provider) ? { context } : {}),
          })),
        );
      } catch (error) {
        this.logger?.info("email_search_provider_failed", { provider: provider.name, error: error.message, query });
        if (error.providerDisabled || error.status === 429 || /not installed/i.test(error.message)) {
          this.disabledProviders.add(provider.name);
          this.logger?.info("email_search_provider_disabled", { provider: provider.name, reason: error.message });
        }
      }
    }
    return results;
  }

  getUsedLabels() {
    return [...this.usedLabels];
  }

  async close() {
    for (const provider of [...this.providers, this.sourceProvider]) {
      if (typeof provider.close === "function") await provider.close();
    }
  }

  async readPageText(url) {
    for (const provider of this.providers) {
      if (typeof provider.readPageText !== "function") continue;
      let text = "";
      try {
        text = await provider.readPageText(url);
      } catch {
        text = "";
      }
      if (text) return text;
    }
    return "";
  }
}

export async function runEnrich({
  limit = DEFAULT_LIMIT,
  startRow = undefined,
  maxRuntimeMs = 0,
  maxRowRuntimeMs = DEFAULT_ROW_MAX_RUNTIME_MS,
  maxSearchQueries = DEFAULT_MAX_SEARCH_QUERIES_PER_ROW,
  maxResultPages = DEFAULT_MAX_RESULT_PAGES_PER_ROW,
  maxHomepagePages = DEFAULT_MAX_HOMEPAGE_PAGES_PER_ROW,
  sheets = defaultSheetsGateway(),
  homepageProvider = null,
  fetchImpl = fetch,
  logger = null,
  dryRun = false,
  debug = false,
  now = () => Date.now(),
} = {}) {
  const searchProvider = homepageProvider || new FallbackHomepageSearchProvider({ logger, fetchImpl });
  const startedAt = now();
  const runtimeLimitMs = Number(maxRuntimeMs);
  const hasRuntimeLimit = Number.isFinite(runtimeLimitMs) && runtimeLimitMs > 0;
  const maxRuntimeReached = () => hasRuntimeLimit && now() - startedAt >= runtimeLimitMs;
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
    failureDetails: [],
    failureCodes: [],
    candidateHighlights: [],
    skipped: 0,
    searchProvidersUsed: [],
    sheetsApi: { batchUpdate: 0, append: 0, update: 0, total: 0 },
    stopReason: "limit_reached",
    dryRun,
    debug,
    budgetStops: 0,
    budgetHits: Object.fromEntries(ROW_BUDGET_KEYS.map((key) => [key, 0])),
    stopReasons: Object.fromEntries(ROW_STOP_REASONS.map((reason) => [reason, 0])),
    fastPathAttempted: 0,
    fastPathSucceeded: 0,
    searchQueriesUsed: 0,
    resultPagesUsed: 0,
    homepagePagesUsed: 0,
    rowMsTotal: 0,
    rowMsMax: 0,
    rowMsAvg: 0,
    rowBudgets: { maxRuntimeMs: maxRowRuntimeMs, maxSearchQueries, maxResultPages, maxHomepagePages },
    runMs: 0,
  };
  const pendingRowUpdates = [];

  // Blocker 6 — a dry run must be read-only end to end: no folder/spreadsheet/tab/header creation,
  // no shape repair, no SYSTEM/LOG/DB write. Every read below is told it must not mutate anything.
  const { spreadsheetId } = await sheets.getTargetSpreadsheet({ readOnly: dryRun });
  summary.spreadsheetId = spreadsheetId;
  const system = await sheets.readSystemState(spreadsheetId, { readOnly: dryRun });
  const selectedStartRow = selectEnrichStartRow(startRow, system.enrich_current_row);
  const queuedRows = await sheets.readQueuedEnrichmentRows(spreadsheetId, { startRow: selectedStartRow, limit, readOnly: dryRun });
  const candidates = queuedRows.candidates;
  summary.startRow = selectedStartRow;
  summary.nextRow = queuedRows.nextRow;
  summary.scanned = queuedRows.scanned;
  summary.skipped = queuedRows.skipped;
  logger?.info("enrich_candidates_loaded", {
    count: candidates.length,
    limit,
    startRow: selectedStartRow,
    nextRow: queuedRows.nextRow,
    scanned: queuedRows.scanned,
    skipped: queuedRows.skipped,
    dryRun,
  });

  try {
    for (const candidate of candidates) {
    if (maxRuntimeReached()) {
      summary.nextRow = candidate.rowNumber;
      summary.stopReason = "max_runtime_reached";
      logger?.info("enrich_max_runtime_reached", {
        rowNumber: candidate.rowNumber,
        processed: summary.processed,
        maxRuntimeMs: runtimeLimitMs,
      });
      break;
    }
    let result;
    try {
      result = await enrichCandidate(candidate, {
        homepageProvider: searchProvider,
        fetchImpl,
        debug,
        maxRuntimeMs: maxRowRuntimeMs,
        maxSearchQueries,
        maxResultPages,
        maxHomepagePages,
      });
    } catch (error) {
      const failureReason = error?.message || String(error);
      const failureCode = classifyFailureCode({ failureReason }) || "row_error";
      result = {
        rowNumber: candidate.rowNumber,
        companyName: rowToCompany(candidate.row).companyName,
        homepageUpdated: false,
        emailUpdated: false,
        contactPageUrl: "",
        failureReason,
        failureCode,
        updates: {},
        debug: debug
          ? {
              ...createDebugInfo(rowToCompany(candidate.row), candidate.rowNumber),
              failureReason,
              failureCode,
            }
          : null,
      };
    }
    summary.processed += 1;
    if (result.skipped) summary.skipped += 1;
    if (result.homepageUpdated) summary.homepageFound += 1;
    if (result.emailUpdated) summary.emailFound += 1;
    if (result.contactPageUrl) summary.contactPagesFound += 1;
    if (result.budgetExceeded) summary.budgetStops += 1;
    for (const reason of result.budgetsHit || []) {
      if (summary.budgetHits[reason] !== undefined) summary.budgetHits[reason] += 1;
    }
    if (result.stopReason && summary.stopReasons[result.stopReason] !== undefined) {
      summary.stopReasons[result.stopReason] += 1;
    }
    if (result.fastPathAttempted) summary.fastPathAttempted += 1;
    if (result.fastPathSucceeded) summary.fastPathSucceeded += 1;
    summary.searchQueriesUsed += result.searchQueriesUsed || 0;
    summary.resultPagesUsed += result.resultPagesUsed || 0;
    summary.homepagePagesUsed += result.homepagePagesUsed || 0;
    summary.rowMsTotal += result.rowMs || 0;
    summary.rowMsMax = Math.max(summary.rowMsMax, result.rowMs || 0);
    if (!result.homepageUpdated && !result.emailUpdated && result.failureReason) summary.failed += 1;
    if (result.failureReason && summary.failureDetails.length < 30) {
      summary.failureDetails.push(`${candidate.rowNumber} ${result.companyName}: ${result.failureCode || "unknown"}`);
      summary.failureCodes.push(result.failureCode || "unknown");
    }
    if (result.debug && summary.candidateHighlights.length < 10) {
      summary.candidateHighlights.push(
        [
          result.companyName,
          `homepage=${result.debug.selectedHomepage || ""}`,
          `email=${result.debug.selectedEmail || (result.debug.foundEmails || [])[0] || ""}`,
          `score=${result.debug.selectedEmailScore ?? result.debug.matchScore ?? 0}`,
          `scoreReason=${result.debug.selectedEmailScoreReason || result.debug.selectedEmailSourceReason || ""}`,
          `candidates=${(result.debug.candidateUrls || []).slice(0, 3).join(",")}`,
        ].join(" "),
      );
    }

    logger?.info("enrich_row_finished", {
      rowNumber: candidate.rowNumber,
      companyName: result.companyName,
      homepageUpdated: result.homepageUpdated,
      emailUpdated: result.emailUpdated,
      failureReason: result.failureReason,
      failureCode: result.failureCode,
      stopReason: result.stopReason,
      fastPathSucceeded: result.fastPathSucceeded,
      searchQueriesUsed: result.searchQueriesUsed,
      resultPagesUsed: result.resultPagesUsed,
      homepagePagesUsed: result.homepagePagesUsed,
      rowMs: result.rowMs,
      debug: result.debug,
    });

    if (debug) printDebugResult(result.debug);

    if (Object.keys(result.updates).length > 0) {
      pendingRowUpdates.push({ rowNumber: candidate.rowNumber, updates: result.updates });
    }
    }
  } finally {
    await searchProvider.close?.();
  }

  summary.runMs = now() - startedAt;
  summary.rowMsAvg = summary.processed > 0 ? Math.round(summary.rowMsTotal / summary.processed) : 0;
  printEnrichTelemetry(summary);
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
    );
    summary.sheetsApi.update += systemWrite.updates || 0;
    summary.sheetsApi.total = summary.sheetsApi.batchUpdate + summary.sheetsApi.append + summary.sheetsApi.update;
    printSheetsApiSummary(summary.sheetsApi);
  }
  return summary;
}

// Per-row exploration state shared across the Fast Path, public-web, and job-site phases.
// Enforces the row time/page budgets and dedupes search queries, page reads, and homepage
// extractions so the same work is never repeated within a single row (PR-A features 3 & 4).
// Cancellation raised by a row's own deadline/abort. Kept distinct from provider errors so a
// cancelled row is attributed to `budget_time` instead of being counted as a provider failure.
export class RowAbortError extends Error {
  constructor(reason = "time") {
    super(`row aborted: ${reason}`);
    this.name = "RowAbortError";
    this.rowAborted = true;
    this.reason = reason;
  }
}

// True when an error is this row's cancellation (ours, or the platform's AbortError) rather than
// a genuine provider/network failure.
export function isRowAbortError(error, signal = null) {
  if (!error) return false;
  if (error.rowAborted) return true;
  if (signal?.aborted) return true;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

export class RowExplorationContext {
  constructor({
    maxRuntimeMs = 0,
    maxSearchQueries = 0,
    maxResultPages = 0,
    maxHomepagePages = 0,
    fetchImpl = fetch,
    now = () => Date.now(),
  } = {}) {
    this.maxRuntimeMs = positiveBudget(maxRuntimeMs);
    this.maxSearchQueries = positiveBudget(maxSearchQueries);
    this.maxResultPages = positiveBudget(maxResultPages);
    this.maxHomepagePages = positiveBudget(maxHomepagePages);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.startedAt = now();
    this.deadlineAt = this.maxRuntimeMs > 0 ? this.startedAt + this.maxRuntimeMs : 0;
    this.searchQueriesUsed = 0;
    this.resultPagesUsed = 0;
    this.homepagePagesUsed = 0;
    this.searchResultCache = new Map(); // query -> results[] (public-web + job-site share identical search semantics)
    this.pageTextCache = new Map(); // normalized url -> page text
    this.extractedHomepages = new Set(); // homepage urls already crawled for emails
    this.budgetsHit = new Set(); // "time" | "search_queries" | "result_pages" | "homepage_pages"

    // Blocker 3 — the row owns one AbortController so an expired deadline actively cancels
    // in-flight fetch/Playwright work instead of only refusing the *next* unit of work.
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.deadlineTimer = null;
    if (this.maxRuntimeMs > 0) {
      this.deadlineTimer = setTimeout(() => {
        this.abortRow("time");
      }, this.maxRuntimeMs);
      // Never keep the process (or a test run) alive just for the row deadline.
      this.deadlineTimer?.unref?.();
    }
  }

  // Telemetry only: "this row was limited by at least one budget". NOT a stop condition —
  // breadth budgets must refuse only their own next unit of work (Blocker 1).
  get budgetExceeded() {
    return this.budgetsHit.size > 0;
  }

  get aborted() {
    return this.signal.aborted;
  }

  // The single global stop condition for a row: the time budget, or an explicit abort.
  // Search/result-page/homepage-page budgets are breadth limits and never stop other phases.
  hardStopped() {
    return this.aborted || this.timeExceeded();
  }

  // Cancel every in-flight request owned by this row. Idempotent.
  abortRow(reason = "time") {
    if (this.signal.aborted) return;
    this.markBudget(reason);
    try {
      this.controller.abort(new RowAbortError(reason));
    } catch {
      this.controller.abort();
    }
  }

  // Idempotent teardown — always run in the row's finally so no timer/listener leaks.
  cleanup() {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  get budgetReason() {
    return [...this.budgetsHit].join("+");
  }

  markBudget(reason) {
    this.budgetsHit.add(reason);
  }

  timeExceeded() {
    if (this.deadlineAt > 0 && this.now() >= this.deadlineAt) {
      this.markBudget("time");
      return true;
    }
    return false;
  }

  // Budget 2 — one unit == one underlying provider.search() invocation (Blocker 4).
  // Reserve immediately before the real call so a fan-out to providers A and B costs two units,
  // and so a failed/timed-out request still counts (the request was actually issued).
  reserveSearch() {
    if (this.hardStopped()) return false;
    if (this.maxSearchQueries > 0 && this.searchQueriesUsed >= this.maxSearchQueries) {
      this.markBudget("search_queries");
      return false;
    }
    this.searchQueriesUsed += 1;
    return true;
  }

  // Back-compat alias — existing call sites that reserve one real provider request.
  consumeSearch() {
    return this.reserveSearch();
  }

  // Deduped search: a logical query runs at most once per row. A cache hit issues no provider
  // request, so it reserves nothing. Reservation happens inside the runner, per real request.
  async cachedSearch(query, runner) {
    if (this.searchResultCache.has(query)) return this.searchResultCache.get(query);
    if (this.hardStopped()) return [];
    const results = (await runner()) || [];
    this.searchResultCache.set(query, results);
    return results;
  }

  // Budget 3 — result pages. Reads a result/page URL at most once per row; repeats reuse cached
  // page text without consuming additional budget.
  async readPage(searchProvider, url, fetchImpl = this.fetchImpl) {
    const key = normalizeUrl(url) || String(url || "");
    if (this.pageTextCache.has(key)) return this.pageTextCache.get(key);
    if (this.hardStopped()) return "";
    if (this.maxResultPages > 0 && this.resultPagesUsed >= this.maxResultPages) {
      this.markBudget("result_pages");
      return "";
    }
    this.resultPagesUsed += 1;
    const text = await readDiscoveredPageText(searchProvider, url, fetchImpl, this.signal);
    this.pageTextCache.set(key, text);
    return text;
  }

  searchBudgetSpent() {
    return this.maxSearchQueries > 0 && this.searchQueriesUsed >= this.maxSearchQueries;
  }

  // Budget 4 — homepage/contact pages remaining for the company homepage crawl this row.
  homepagePagesRemaining() {
    return this.maxHomepagePages > 0 ? Math.max(0, this.maxHomepagePages - this.homepagePagesUsed) : Infinity;
  }

  noteHomepagePages(count = 0) {
    this.homepagePagesUsed += Math.max(0, count);
  }
}

function positiveBudget(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// Budget identifiers, in the precedence used to attribute a row's stop reason. Time is the hard
// cut so it wins; the rest are breadth limits. These are the `budgetHits` keys, and each maps to
// the stop reason `budget_<key>` so the two telemetry fields line up one-to-one.
export const ROW_BUDGET_KEYS = ["time", "search_queries", "result_pages", "homepage_pages"];

const budgetStopReason = (key) => `budget_${key}`;

// Stop reasons a row can end on. Rows that found an email are attributed to the phase that found
// it; rows that did not are attributed to the binding budget, or to full exhaustion.
export const ROW_STOP_REASONS = [
  "already_complete",
  "email_already_present",
  "email_found_fast_path",
  "email_found_public_web",
  "email_found_job_site",
  "email_found_homepage",
  ...ROW_BUDGET_KEYS.map(budgetStopReason),
  "exhausted",
];

function resolveRowStopReason(context) {
  const bound = ROW_BUDGET_KEYS.find((key) => context.budgetsHit.has(key));
  return bound ? budgetStopReason(bound) : "exhausted";
}

// High-confidence = the email lives on the company's own domain (official homepage host or a
// non-job-site source host). This is the safe early-stop signal that preserves accuracy.
function isHighConfidenceEmailCandidate(candidate) {
  if (!candidate || candidate.rejected || candidate.personal) return false;
  if (!Number.isFinite(candidate.score)) return false;
  const reason = candidate.scoreReason || "";
  return reason.includes("official-domain") || reason.includes("source-domain");
}

export async function enrichCandidate(
  { rowNumber, row },
  {
    homepageProvider,
    fetchImpl = fetch,
    debug = false,
    maxRuntimeMs = 0,
    maxSearchQueries = 0,
    maxResultPages = 0,
    maxHomepagePages = 0,
    now = () => Date.now(),
  } = {},
) {
  const current = rowToCompany(row);
  const updates = {};
  const memoParts = [];
  const debugInfo = createDebugInfo(current, rowNumber);
  let homepage = current.homepage;
  let homepageUpdated = false;
  let emailUpdated = false;
  let contactPageUrl = "";
  let failureReason = "";
  let failureCode = "";
  // Why this row stopped exploring — attributed to the phase that produced the email, or to the
  // budget/exhaustion that ended the search. Aggregated into run telemetry by runEnrich.
  let stopReason = "";
  let fastPathAttempted = false;

  if (current.homepage && current.email) {
    return { rowNumber, companyName: current.companyName, skipped: true, stopReason: "already_complete", updates };
  }

  const context = new RowExplorationContext({
    maxRuntimeMs,
    maxSearchQueries,
    maxResultPages,
    maxHomepagePages,
    fetchImpl,
    now,
  });

  // Blocker 3 — the row owns a deadline timer and abort listeners; release them exactly once,
  // on every exit path, so a finished row never leaves a pending handle behind.
  try {
    return await exploreRow();
  } finally {
    context.cleanup();
  }

  async function exploreRow() {

  // Extract an email directly from a known homepage. Used by the Fast Path (pre-existing
  // homepage) and again if a homepage is discovered later. Deduped so a homepage is crawled once
  // and bounded by the per-row homepage-page budget (budget 4).
  const tryHomepageEmail = async () => {
    if (!homepage || current.email || emailUpdated) return;
    const target = normalizeUrl(homepage) || homepage;
    if (context.extractedHomepages.has(target)) return;
    if (context.timeExceeded()) return;
    const remaining = context.homepagePagesRemaining();
    if (remaining <= 0) {
      context.markBudget("homepage_pages");
      return;
    }
    context.extractedHomepages.add(target);
    const emailResult = await extractEmailDetails(homepage, {
      fetchImpl,
      ...(Number.isFinite(remaining) ? { maxPages: remaining } : {}),
      deadlineAt: context.deadlineAt,
      now: context.now,
    });
    context.noteHomepagePages(emailResult.pagesVisited || 0);
    // If the crawl was cut short by the homepage-page budget without an email, record it.
    if (!emailResult.email && Number.isFinite(remaining) && (emailResult.pagesVisited || 0) >= remaining) {
      context.markBudget("homepage_pages");
    }
    contactPageUrl = contactPageUrl || emailResult.contactPageUrl;
    debugInfo.visitedPages = emailResult.visitedUrls || [];
    debugInfo.visitResults = emailResult.visited || [];
    debugInfo.contactLinksFound = Boolean(emailResult.contactLinksFound || contactPageUrl);
    if (emailResult.email) {
      updates.email = emailResult.email;
      emailUpdated = true;
      debugInfo.foundEmails.push(emailResult.email);
      setSelectedEmailDebug(debugInfo, {
        email: emailResult.email,
        score: 0,
        scoreReason: "homepage-extraction",
        sourceName: "homepage",
        sourceUrl: homepage,
        sourceReason: sourceReason({ sourceName: "homepage", sourceUrl: homepage, sourceType: "homepage" }),
      });
    } else {
      failureReason ||= emailResult.error || "email not found";
      failureCode ||= emailResult.error?.startsWith("failed to fetch") ? "site_access_failed" : "no_email";
    }
  };

  // Feature 1 — Fast Path: the row already has a homepage and only the email is missing, so probe
  // the existing homepage first. A high-confidence email here completes the row immediately,
  // skipping the public-web (6) and job-site (11) searches entirely.
  if (homepage && !current.email) {
    debugInfo.fastPathUsed = true;
    fastPathAttempted = true;
    await tryHomepageEmail();
    if (emailUpdated) stopReason = "email_found_fast_path";
  }

  // Feature 2 — public-web email discovery (early-stops internally on a high-confidence email).
  // Time is the only hard gate; the search/result-page budgets are enforced inside the phase.
  if (!current.email && !emailUpdated && !context.timeExceeded()) {
    const discoveryResult = await discoverEmail(current, {
      homepage,
      searchProvider: homepageProvider,
      fetchImpl,
      context,
    });
    if (discoveryResult.email) {
      updates.email = discoveryResult.email;
      emailUpdated = true;
      stopReason = "email_found_public_web";
      debugInfo.foundEmails.push(discoveryResult.email);
      setSelectedEmailDebug(debugInfo, discoveryResult);
      if (discoveryResult.sourceUrl) memoParts.push(formatEmailSourceMemo(discoveryResult));
    }
    debugInfo.rejectedEmails.push(...(discoveryResult.rejectedEmails || []));
  }

  if (!current.email && !emailUpdated && homepageProvider && !context.timeExceeded()) {
    const jobSiteProvider = new JobSiteDiscoveryProvider({ searchProvider: homepageProvider, fetchImpl });
    const jobResult = await jobSiteProvider.discover(current, { homepage, context });
    if (jobResult.sourceUrl) {
      debugInfo.jobSiteSource = jobResult.sourceUrl;
      debugInfo.sourceVisits.push(jobResult.sourceUrl);
      debugInfo.matchScore = Math.max(debugInfo.matchScore || 0, jobResult.matchScore || 0);
    }
    debugInfo.rejectedEmails.push(...(jobResult.rejectedEmails || []));
    if (!homepage && jobResult.homepage) {
      homepage = jobResult.homepage;
      updates.homepage = homepage;
      homepageUpdated = true;
      debugInfo.selectedHomepage = homepage;
    }
    if (jobResult.email) {
      updates.email = jobResult.email;
      emailUpdated = true;
      stopReason = "email_found_job_site";
      debugInfo.foundEmails.push(jobResult.email);
      setSelectedEmailDebug(debugInfo, jobResult);
      if (jobResult.sourceUrl) memoParts.push(formatEmailSourceMemo(jobResult));
      if (jobResult.emailKind) memoParts.push(`email_kind=${jobResult.emailKind}`);
    } else if (jobResult.personalEmail) {
      memoParts.push(`enrich jobsite_personal_email=${jobResult.personalEmail}`);
      debugInfo.foundEmails.push(jobResult.personalEmail);
    }
  }

  if (!homepage && !context.timeExceeded()) {
    const searchRequest = {
      companyName: current.companyName,
      region: current.region,
      industry: current.industry,
      limit: SEARCH_LIMIT,
    };
    const searchResult =
      typeof homepageProvider.findOfficial === "function"
        ? await homepageProvider.findOfficial(current, { limit: SEARCH_LIMIT, context })
        : {
            official: await pickOfficialHomepageAsync(
              context.consumeSearch() ? await homepageProvider.search(searchRequest) : [],
              current,
              fetchImpl,
              null,
              context,
            ),
            failures: [],
          };
    debugInfo.naverQueries = buildHomepageQueries(current);
    debugInfo.candidateUrls = searchResult.candidates?.slice(0, DEBUG_CANDIDATE_LIMIT).map((item) => item.url) || [];
    debugInfo.searchEvents = searchResult.searchEvents || [];
    const official = searchResult.official;
    if (official) {
      homepage = official.url;
      updates.homepage = homepage;
      homepageUpdated = true;
      debugInfo.selectedHomepage = homepage;
      debugInfo.matchScore = official.score || 0;
    } else {
      failureReason = "홈페이지 없음";
      failureCode = searchResult.candidates?.length ? "no_official_site" : "no_search_result";
      if (searchResult.failures?.length) {
        failureReason = `홈페이지 없음 (${searchResult.failures.join("; ")})`;
        if (searchResult.failures.some((item) => /playwright/i.test(item))) failureCode = "playwright_error";
      }
    }
  }

  // A homepage discovered above (job-site/findOfficial) still needs its email extracted. The
  // pre-existing homepage was already crawled by the Fast Path, so tryHomepageEmail dedupes it.
  if (homepage && !current.email && !emailUpdated) {
    await tryHomepageEmail();
    if (emailUpdated) stopReason = "email_found_homepage";
  }

  if (!current.email && !emailUpdated) {
    memoParts.push("이메일 미확보");
    failureReason ||= homepage ? "email not found" : "홈페이지 없음";
    // Only the row time budget is a hard cut mid-exploration; the search/result/homepage-page
    // budgets are breadth limits, so a row that exhausts them is still a normal "no email" result.
    if (context.budgetsHit.has("time")) {
      failureReason = `${failureReason} (row time budget exceeded)`;
      failureCode = "row_budget_exceeded";
    } else {
      failureCode = homepage ? failureCode || "no_email" : "no_email_found";
    }
    stopReason = resolveRowStopReason(context);
  }
  if (!stopReason) stopReason = current.email ? "email_already_present" : "exhausted";

  if (contactPageUrl) {
    memoParts.push(`enrich contact=${contactPageUrl}`);
  }
  if (failureReason && !emailUpdated) {
    memoParts.push(SHORT_FAILURE_MEMO);
  }
  if (emailUpdated) {
    failureReason = "";
    failureCode = "";
  }
  debugInfo.failureReason = failureReason;
  debugInfo.failureCode = failureCode || classifyFailureCode({ failureReason, homepage, emailUpdated });
  debugInfo.fastPathUsed = Boolean(debugInfo.fastPathUsed);
  debugInfo.stopReason = stopReason;
  debugInfo.budgetExceeded = context.budgetExceeded;
  debugInfo.budgetsHit = [...context.budgetsHit];
  debugInfo.searchQueriesUsed = context.searchQueriesUsed;
  debugInfo.resultPagesUsed = context.resultPagesUsed;
  debugInfo.homepagePagesUsed = context.homepagePagesUsed;
  debugInfo.rowMs = context.now() - context.startedAt;
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
    failureCode: debugInfo.failureCode,
    stopReason,
    fastPathAttempted,
    fastPathSucceeded: fastPathAttempted && stopReason === "email_found_fast_path",
    budgetExceeded: context.budgetExceeded,
    budgetsHit: [...context.budgetsHit],
    searchQueriesUsed: context.searchQueriesUsed,
    resultPagesUsed: context.resultPagesUsed,
    homepagePagesUsed: context.homepagePagesUsed,
    rowMs: debugInfo.rowMs,
    updates,
    debug: debug ? debugInfo : null,
  };
  }
}

export async function discoverEmail(company, { homepage = "", searchProvider, fetchImpl = fetch, context = null } = {}) {
  const ctx = context || new RowExplorationContext({ fetchImpl });
  const candidates = [];
  const officialHost = homepage ? hostnameOf(homepage) : "";
  let stop = false;

  for (const query of emailDiscoveryQueries(company.companyName)) {
    // Blocker 1 — time/abort is the only global stop; breadth budgets refuse their own unit only.
    if (stop || ctx.hardStopped()) break;
    const results = await ctx.cachedSearch(query, () => searchEmailDiscovery(searchProvider, query, EMAIL_DISCOVERY_LIMIT, ctx));
    for (const result of results) {
      collectEmailCandidates(`${result.title} ${result.snippet} ${result.url}`, result.url, officialHost, candidates, {
        company,
        sourceName: sourceNameForUrl(result.url, result.source),
        sourceType: isJobSiteUrl(result.url) ? "job-site" : "public-web",
      });
      // Feature 2 — early stop as soon as we have a high-confidence (company-domain) email.
      if (candidates.some(isHighConfidenceEmailCandidate)) {
        stop = true;
        break;
      }
      const pageText = await ctx.readPage(searchProvider, result.url, fetchImpl);
      if (pageText) {
        collectEmailCandidates(pageText, result.url, officialHost, candidates, {
          company,
          sourceName: sourceNameForUrl(result.url, result.source),
          sourceType: isJobSiteUrl(result.url) ? "job-site" : "public-web",
        });
      }
      if (candidates.some(isHighConfidenceEmailCandidate)) {
        stop = true;
        break;
      }
    }
  }

  const rejectedEmails = [...new Set(candidates.filter((item) => item.rejected || !Number.isFinite(item.score)).map((item) => item.email))];
  const validCandidates = candidates.filter((item) => !item.rejected && Number.isFinite(item.score));
  validCandidates.sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));
  const best = validCandidates[0];
  return best
    ? {
        email: best.email,
        sourceUrl: best.sourceUrl,
        sourceName: best.sourceName,
        score: best.score,
        scoreReason: best.scoreReason || "",
        sourceReason: best.sourceReason || "",
        rejectedEmails,
      }
    : { email: "", sourceUrl: "", sourceName: "", score: 0, scoreReason: "", sourceReason: "", rejectedEmails };
}

export function scoreDiscoveredEmail(email, sourceUrl = "", officialHost = "") {
  const normalized = String(email || "").toLowerCase();
  const domain = normalized.split("@")[1] || "";
  if (!normalized || PERSONAL_EMAIL_DOMAINS.has(domain)) return -Infinity;

  let score = 0;
  const sourceHost = hostnameOf(sourceUrl);
  const localPart = normalized.split("@")[0] || "";
  if ((officialHost && domainMatchesHost(domain, officialHost)) || (sourceHost && domainMatchesHost(domain, sourceHost))) {
    score += 50;
  }
  if (PREFERRED_EMAIL_PREFIXES.includes(localPart)) score += 30;
  if (officialHost && sourceHost && domainMatchesHost(sourceHost, officialHost)) score += 40;
  return score;
}

export function filterSearchResultLinks(results = []) {
  const filtered = [];
  const seen = new Set();
  for (const result of results) {
    const url = normalizeUrl(result.url);
    if (!url || seen.has(url) || isSearchUtilityUrl(url)) continue;
    seen.add(url);
    filtered.push({ ...result, url });
  }
  return filtered;
}

function isSearchUtilityUrl(url) {
  const host = hostnameOf(url);
  if (!host) return true;
  return host === "naver.com" || host.endsWith(".naver.com") || host.includes("pstatic.net");
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

async function pickOfficialHomepageAsync(candidates, company, fetchImpl, pageTextProvider = null, context = null) {
  const expanded = [];
  for (const candidate of dedupeCandidates(candidates)) {
    expanded.push(candidate);
    if (isFollowableDirectoryUrl(candidate.url)) {
      // Following a directory result to its official link is a result-page read (budget 3).
      const pageText = context
        ? await context.readPage(pageTextProvider, candidate.url, fetchImpl)
        : await readDiscoveredPageText(pageTextProvider, candidate.url, fetchImpl);
      for (const link of extractOfficialLinks(pageText, candidate.url)) {
        expanded.push({
          url: link,
          title: link,
          snippet: link,
          source: `${candidate.source}:follow`,
        });
      }
    }
  }
  return pickOfficialHomepage(expanded, company);
}

function extractOfficialLinks(html, currentUrl) {
  const links = [];
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(hrefRe)) {
    try {
      const url = new URL(decodeHtml(match[1]), currentUrl).toString();
      if (!normalizeUrl(url) || isBannedHomepageUrl(url)) continue;
      const label = cleanText(match[2]);
      if (/홈페이지|website|site|공식|회사|바로가기|home/i.test(`${label} ${url}`) || isOwnDomainUrl(url)) {
        links.push(normalizeUrl(url));
      }
    } catch {
      continue;
    }
  }
  return [...new Set(links)];
}

function isFollowableDirectoryUrl(url) {
  const host = hostnameOf(url);
  return FOLLOWABLE_HOST_PARTS.some((part) => host.includes(part));
}

function isBannedHomepageUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return true;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  return (
    BANNED_HOST_PARTS.some((part) => host.includes(part)) ||
    BUSINESS_DIRECTORY_HOST_PARTS.some((part) => host.includes(part)) ||
    isNewsMediaHost(host) ||
    BANNED_PATH_PARTS.some((part) => path.includes(part)) ||
    isNewsArticleUrl(path, search)
  );
}

function isNewsMediaHost(host) {
  return NEWS_MEDIA_HOST_PARTS.some((part) => host.includes(part));
}

function isNewsArticleUrl(path, search = "") {
  return NEWS_ARTICLE_PATH_PATTERNS.some((pattern) => pattern.test(path)) || NEWS_ARTICLE_QUERY_PATTERNS.some((pattern) => pattern.test(search));
}

function parseUrl(url) {
  try {
    return new URL(normalizeUrl(url));
  } catch {
    return null;
  }
}

function isOwnDomainUrl(url) {
  const host = hostnameOf(url);
  return /\.(co\.kr|com|kr|net|biz|org)$/i.test(host);
}

function normalizedPath(url) {
  try {
    return new URL(normalizeUrl(url)).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function emailDiscoveryQueries(companyName) {
  return EMAIL_DISCOVERY_TERMS.map((term) => `${companyName} ${term}`);
}

// Blocker 4 — every real provider.search() below reserves exactly one search unit immediately
// before the call. A provider that charges its own units (FallbackHomepageSearchProvider, which
// fans out internally) is handed the context instead, so nested calls are never double-charged.
async function searchEmailDiscovery(searchProvider, query, limit, context = null) {
  if (!searchProvider) return [];
  const request = { query, companyName: query, region: "", industry: "", limit, signal: context?.signal ?? null };
  if (typeof searchProvider.search === "function") {
    if (providerChargesOwnSearchBudget(searchProvider)) {
      return searchProvider.search({ ...request, context });
    }
    if (context && !context.reserveSearch()) return [];
    return searchProvider.search(request);
  }
  if (Array.isArray(searchProvider.providers)) {
    const results = [];
    for (const provider of searchProvider.providers) {
      if (searchProvider.disabledProviders?.has(provider.name)) continue;
      if (provider.enabled && !provider.enabled()) continue;
      // Capacity is per underlying request: when it ends, later providers are not launched and
      // everything gathered so far is kept.
      if (context && !context.reserveSearch()) break;
      try {
        results.push(...(await provider.search(request)));
      } catch (error) {
        if (error.providerDisabled || error.status === 429 || /not installed/i.test(error.message)) {
          searchProvider.disabledProviders?.add(provider.name);
        }
        continue;
      }
    }
    return results;
  }
  return [];
}

// A provider that reserves its own search units internally (so callers must not charge for the
// wrapper call itself).
function providerChargesOwnSearchBudget(provider) {
  return Boolean(provider?.chargesOwnSearchBudget);
}

function isNativeFetch(fetchImpl) {
  return fetchImpl === fetch || fetchImpl === globalThis.fetch;
}

async function fetchSearchResultText(url, fetchImpl, { allowNativeFetch = false, signal = null } = {}) {
  const normalized = normalizeUrl(url);
  if (!normalized) return "";
  if (!allowNativeFetch && isNativeFetch(fetchImpl)) return "";
  if (signal?.aborted) return "";
  try {
    // Blocker 3 — bridge the row signal to this request's own timeout controller so a row deadline
    // aborts work already in flight, not just the next request. Listener/timer always cleaned up.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const onParentAbort = () => {
      controller.abort();
    };
    signal?.addEventListener?.("abort", onParentAbort, { once: true });
    let response;
    try {
      response = await fetchImpl(normalized, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": "FlowerCRM-EnrichBot/0.1" },
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onParentAbort);
    }
    if (!response.ok) return "";
    return response.text();
  } catch {
    return "";
  }
}

function collectEmailCandidates(
  text,
  sourceUrl,
  officialHost,
  candidates,
  { allowPersonalMemo = false, allowPublishedContact = false, company = {}, sourceName = "", sourceType = "public-web" } = {},
) {
  const found = String(text || "").match(EMAIL_RE) || [];
  for (const rawEmail of found) {
    const email = rawEmail.toLowerCase();
    const personal = isPersonalEmail(email);
    const context = emailContext(text, rawEmail);
    const score = scoreEmailCandidate({ email, sourceUrl, officialHost, context, company, sourceType, allowPublishedContact });
    const publishedContact =
      personal && allowPublishedContact && /(?:담당자|인사|채용).{0,20}(?:이메일|메일)|(?:이메일|메일).{0,20}(?:담당자|인사|채용)/i.test(context);
    if (!Number.isFinite(score) && !personal) {
      candidates.push({
        email,
        sourceUrl: normalizeUrl(sourceUrl),
        sourceName: sourceName || sourceNameForUrl(sourceUrl),
        score,
        personal,
        emailKind: "",
        rejected: true,
        scoreReason: emailScoreReason({ email, sourceUrl, officialHost, context, company, sourceType, allowPublishedContact, score }),
        sourceReason: sourceReason({ sourceName: sourceName || sourceNameForUrl(sourceUrl), sourceUrl, sourceType }),
      });
      continue;
    }
    if (!Number.isFinite(score) && !(allowPersonalMemo && personal)) continue;
    candidates.push({
      email,
      sourceUrl: normalizeUrl(sourceUrl),
      sourceName: sourceName || sourceNameForUrl(sourceUrl),
      score,
      personal,
      emailKind: publishedContact ? "published_contact" : "",
      rejected: !Number.isFinite(score),
      scoreReason: emailScoreReason({ email, sourceUrl, officialHost, context, company, sourceType, allowPublishedContact, score }),
      sourceReason: sourceReason({ sourceName: sourceName || sourceNameForUrl(sourceUrl), sourceUrl, sourceType }),
    });
  }
}

async function readDiscoveredPageText(searchProvider, url, fetchImpl, signal = null) {
  if (signal?.aborted) return "";
  if (typeof searchProvider?.readPageText === "function") {
    let providerText = "";
    try {
      providerText = await searchProvider.readPageText(url, { signal });
    } catch {
      providerText = "";
    }
    if (providerText) return providerText;
  }
  if (signal?.aborted) return "";
  return fetchSearchResultText(url, fetchImpl, { allowNativeFetch: !isNativeFetch(fetchImpl), signal });
}

function formatEmailSourceMemo({ sourceName = "", sourceUrl = "" } = {}) {
  return `enrich email_source=${[sourceName || "public", sourceUrl].filter(Boolean).join(" ")}`;
}

function scoreEmailCandidate({ email, sourceUrl, officialHost, context, company, sourceType, allowPublishedContact }) {
  let score = scoreDiscoveredEmail(email, sourceUrl, officialHost);
  const personal = isPersonalEmail(email);
  const domain = String(email || "").toLowerCase().split("@")[1] || "";
  const sourceHost = hostnameOf(sourceUrl);
  if ((isDirectoryHost(sourceHost) || isJobSiteUrl(sourceUrl) || isNewsMediaHost(sourceHost)) && domainMatchesHost(domain, sourceHost)) return -Infinity;
  const hasTrustedDomain =
    (officialHost && domainMatchesHost(domain, officialHost)) || (sourceHost && !isJobSiteUrl(sourceUrl) && domainMatchesHost(domain, sourceHost));
  const hasTargetEvidence = hasCompanyContextEvidence(context, company);
  if (hasConflictingNearbyCompanyEvidence(context, email, company)) return -Infinity;
  if (!Number.isFinite(score)) {
    if (!(allowPublishedContact && personal && hasTargetEvidence && /(?:담당자|인사|채용).{0,20}(?:이메일|메일)|(?:이메일|메일).{0,20}(?:담당자|인사|채용)/i.test(context))) return -Infinity;
    score = 12;
  }
  if (!personal && !hasTargetEvidence && !(officialHost && domainMatchesHost(domain, officialHost))) return -Infinity;
  if (!personal && !hasTrustedDomain && !hasTargetEvidence) return -Infinity;
  score += matchCompanyAddressScore(context, company);
  if (PUBLIC_CONTACT_LABEL_RE.test(context)) score += 25;
  if (sourceType === "job-site") score += 15;
  if (normalizeCompanyName(company.companyName) && normalizeCompanyName(context).includes(normalizeCompanyName(company.companyName))) score += 20;
  return score;
}

function isDirectoryHost(host) {
  return BUSINESS_DIRECTORY_HOST_PARTS.some((part) => host.includes(part));
}

function emailScoreReason({ email, sourceUrl, officialHost, context, company, sourceType, allowPublishedContact, score }) {
  const parts = [];
  const domain = String(email || "").toLowerCase().split("@")[1] || "";
  const sourceHost = hostnameOf(sourceUrl);
  const personal = isPersonalEmail(email);
  if (!Number.isFinite(score)) parts.push("rejected:no-target-evidence");
  if (officialHost && domainMatchesHost(domain, officialHost)) parts.push("official-domain");
  if (sourceHost && !isJobSiteUrl(sourceUrl) && domainMatchesHost(domain, sourceHost)) parts.push("source-domain");
  if (hasCompanyContextEvidence(context, company)) parts.push("company-context");
  if (matchCompanyAddressScore(context, company) > 0) parts.push("address-context");
  if (PUBLIC_CONTACT_LABEL_RE.test(context)) parts.push("contact-label");
  if (sourceType === "job-site") parts.push("job-site-source");
  if (allowPublishedContact && personal) parts.push("published-contact-allowed");
  return parts.join("+") || "candidate-score";
}

function sourceReason({ sourceName = "", sourceUrl = "", sourceType = "" } = {}) {
  return [sourceType || "source", sourceName || sourceNameForUrl(sourceUrl), normalizeUrl(sourceUrl)].filter(Boolean).join(" ");
}

function hasConflictingNearbyCompanyEvidence(context, email, company) {
  const value = String(context || "");
  const emailIndex = value.toLowerCase().indexOf(String(email || "").toLowerCase());
  if (emailIndex < 0) return false;
  const nearbyRaw = cleanText(value.slice(Math.max(0, emailIndex - 50), emailIndex + String(email).length + 50));
  const nearby = normalizeCompanyName(nearbyRaw);
  const target = normalizeCompanyName(company.companyName);
  const targetWords = significantWords(company.companyName);
  const tokenRe = /[가-힣a-z0-9]{2,}(?:회사|corp|corporation)/gi;
  return [...nearbyRaw.matchAll(tokenRe)].some((match) => {
    const token = match[0];
    if (match.index + token.length < nearbyRaw.toLowerCase().indexOf(String(email || "").toLowerCase()) - 15) return false;
    const normalizedToken = normalizeCompanyName(token);
    if (!normalizedToken || normalizedToken === target || (target && normalizedToken.includes(target))) return false;
    if (targetWords.some((word) => normalizedToken.includes(word))) return false;
    return true;
  });
}

function hasCompanyContextEvidence(context, company) {
  const normalizedContext = normalizeCompanyName(context);
  const normalizedCompany = normalizeCompanyName(company.companyName);
  return Boolean(
    (normalizedCompany && normalizedContext.includes(normalizedCompany)) ||
      significantWords(company.companyName).some((word) => normalizedContext.includes(word)) ||
      matchCompanyAddressScore(context, company) > 0,
  );
}

function emailContext(text, rawEmail) {
  const value = String(text || "");
  const index = value.toLowerCase().indexOf(String(rawEmail).toLowerCase());
  if (index < 0) return cleanText(value.slice(0, 500));
  return cleanText(value.slice(Math.max(0, index - 180), index + String(rawEmail).length + 180));
}

function isPersonalEmail(email) {
  const domain = String(email || "").toLowerCase().split("@")[1] || "";
  return PERSONAL_EMAIL_DOMAINS.has(domain);
}

function hostnameOf(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return "";
  try {
    return new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainMatchesHost(domain, host) {
  const cleanDomain = String(domain || "").toLowerCase().replace(/^www\./, "");
  const cleanHost = String(host || "").toLowerCase().replace(/^www\./, "");
  return Boolean(cleanDomain && cleanHost && (cleanHost === cleanDomain || cleanHost.endsWith(`.${cleanDomain}`)));
}

function isJobSiteUrl(url) {
  const host = hostnameOf(url);
  return JOB_SITE_HOST_PARTS.some((part) => host.includes(part));
}

function jobSiteName(url) {
  const host = hostnameOf(url);
  if (host.includes("saramin")) return "사람인";
  if (host.includes("jobkorea")) return "잡코리아";
  if (host.includes("work.go.kr")) return "워크넷";
  if (host.includes("incruit")) return "인크루트";
  if (host.includes("jobplanet")) return "잡플래닛";
  if (host.includes("wanted")) return "원티드";
  if (host.includes("rocketpunch")) return "로켓펀치";
  return "채용사이트";
}

function sourceNameForUrl(url, fallback = "") {
  if (isJobSiteUrl(url)) return jobSiteName(url);
  return fallback || hostnameOf(url) || "public";
}

export function extractAddressParts(address = "") {
  const tokens = cleanText(address)
    .split(/\s+/)
    .map((token) => token.replace(/[(),.]/g, ""))
    .filter((token) => /[시군구동읍면]$/.test(token));
  return [...new Set(tokens)].slice(0, 4);
}

export function matchCompanyAddressScore(text, company) {
  const haystack = normalizeCompanyName(text);
  const tokens = extractAddressParts(company.address);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(normalizeCompanyName(token))) score += 8;
  }
  return Math.min(score, 24);
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
  const parsed = parseUrl(url);
  if (!parsed) return 0;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  if (isBannedHomepageUrl(url)) return 0;

  const companyKey = normalizeCompanyName(company.companyName);
  const haystack = normalizeCompanyName(`${candidate.title} ${candidate.snippet}`);
  const hostKey = normalizeCompanyName(host);
  const words = significantWords(company.companyName);
  const regionKey = normalizeCompanyName(company.region);
  const addressScore = matchCompanyAddressScore(`${candidate.title} ${candidate.snippet}`, company);
  let score = 0;

  if (companyKey && haystack.includes(companyKey)) score += 6;
  if (companyKey && hostKey.includes(companyKey)) score += 5;
  if (words.length > 0) {
    const matches = words.filter((word) => haystack.includes(word) || hostKey.includes(word));
    score += Math.min(matches.length, 3) * 3;
  }
  if (regionKey && haystack.includes(regionKey)) score += 2;
  score += addressScore;
  if (candidate.source === "naver-local") score += 1;
  if (["/", ""].includes(path)) score += 1;
  if (/\.(co\.kr|com|kr|net|biz|org)$/i.test(host)) score += 2;
  return score;
}

export function buildHomepageQueries(company) {
  const companyName = cleanText(company.companyName);
  const region = cleanText(company.region);
  const addressPart = extractAddressParts(company.address).join(" ");
  const queries = [
    [companyName, addressPart].filter(Boolean).join(" "),
    [companyName, region].filter(Boolean).join(" "),
    `${companyName} 공식 홈페이지`,
    `${companyName} 고객센터`,
    `${companyName} 문의`,
    `${companyName} 이메일`,
  ];
  return [...new Set(queries.map((query) => cleanText(query)).filter(Boolean))];
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

function selectEnrichStartRow(explicitStartRow, systemStartRow) {
  if (explicitStartRow !== undefined && explicitStartRow !== null && explicitStartRow !== "") {
    const row = Number(explicitStartRow);
    if (Number.isInteger(row) && row >= 2) return row;
  }
  return normalizeEnrichCurrentRow(systemStartRow);
}

function numberValue(value) {
  return Number(value || 0) || 0;
}

// Per-row exploration telemetry (PR-A). Makes the effect of the Fast Path, Early Stop, and the
// four budgets observable in run logs so the budgets can be tuned against real runs.
function printEnrichTelemetry(summary) {
  const rows = summary.processed || 0;
  const perRow = (total) => (rows > 0 ? (total / rows).toFixed(1) : "0.0");
  console.log("━━━━━━━━━━━━━━");
  console.log("Enrich Telemetry");
  console.log(`rows ${rows} | avg ${summary.rowMsAvg}ms | max ${summary.rowMsMax}ms`);
  console.log(
    `fastPath ${summary.fastPathSucceeded}/${summary.fastPathAttempted} | budgetStops ${summary.budgetStops}`,
  );
  console.log(
    `searchQueries ${summary.searchQueriesUsed} (${perRow(summary.searchQueriesUsed)}/row) | ` +
      `resultPages ${summary.resultPagesUsed} (${perRow(summary.resultPagesUsed)}/row) | ` +
      `homepagePages ${summary.homepagePagesUsed} (${perRow(summary.homepagePagesUsed)}/row)`,
  );
  console.log(
    `budgetHits ${Object.entries(summary.budgetHits || {})
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ") || "none"}`,
  );
  console.log(
    `stopReasons ${Object.entries(summary.stopReasons || {})
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ") || "none"}`,
  );
  console.log("━━━━━━━━━━━━━━");
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

function classifyFailureCode({ failureReason = "", homepage = "", emailUpdated = false } = {}) {
  if (/playwright/i.test(failureReason)) return "playwright_error";
  if (/failed to fetch|access|timeout|abort/i.test(failureReason)) return "site_access_failed";
  if (!homepage && /not found|홈페이지 없음/i.test(failureReason)) return "no_official_site";
  if (homepage && !emailUpdated) return "no_email";
  return failureReason ? "no_official_site" : "";
}

function createDebugInfo(company, rowNumber = "") {
  return {
    rowNumber,
    companyName: company.companyName,
    address: company.address,
    sourceUrl: company.sourceUrl,
    naverQueries: buildHomepageQueries(company),
    searchEvents: [],
    candidateUrls: [],
    selectedHomepage: company.homepage || "",
    visitedPages: [],
    sourceVisits: [],
    visitResults: [],
    contactLinksFound: false,
    foundEmails: [],
    rejectedEmails: [],
    selectedEmail: "",
    selectedEmailScore: 0,
    selectedEmailScoreReason: "",
    selectedEmailSourceReason: "",
    jobSiteSource: "",
    matchScore: 0,
    failureReason: "",
    failureCode: "",
  };
}

function setSelectedEmailDebug(debugInfo, result = {}) {
  if (!debugInfo || !result.email) return;
  debugInfo.selectedEmail = result.email;
  debugInfo.selectedEmailScore = Number.isFinite(result.score) ? result.score : 0;
  debugInfo.selectedEmailScoreReason = result.scoreReason || "";
  debugInfo.selectedEmailSourceReason = result.sourceReason || sourceReason(result);
  debugInfo.matchScore = Math.max(debugInfo.matchScore || 0, debugInfo.selectedEmailScore || 0);
}

function printDebugResult(debugInfo) {
  if (!debugInfo) return;
  console.log("━━━━━━━━━━━━━━");
  console.log("Enrich Debug");
  console.log(`row: ${debugInfo.rowNumber || ""}`);
  console.log(`회사명: ${debugInfo.companyName || ""}`);
  console.log(`주소: ${debugInfo.address || ""}`);
  console.log(`기존 sourceUrl: ${debugInfo.sourceUrl || ""}`);
  console.log(`네이버 검색 쿼리: ${(debugInfo.naverQueries || []).join(" | ")}`);
  console.log(
    `검색 이벤트: ${(debugInfo.searchEvents || [])
      .map((item) => `${item.provider}:${item.query || "-"}:${item.ok ? "ok" : `fail(${item.error})`}`)
      .join(" | ")}`,
  );
  console.log(`후보 URL: ${(debugInfo.candidateUrls || []).slice(0, DEBUG_CANDIDATE_LIMIT).join(" | ")}`);
  console.log(`선택한 홈페이지: ${debugInfo.selectedHomepage || ""}`);
  console.log(`실제 방문 URL: ${(debugInfo.visitedPages || []).join(" | ")}`);
  console.log(`소스 방문 URL: ${(debugInfo.sourceVisits || []).join(" | ")}`);
  console.log(
    `방문 성공/실패: ${(debugInfo.visitResults || [])
      .map((item) => `${item.url}:${item.ok ? "ok" : "fail"}${item.status ? `(${item.status})` : ""}`)
      .join(" | ")}`,
  );
  console.log(`footer/contact 링크 발견: ${debugInfo.contactLinksFound ? "yes" : "no"}`);
  console.log(`발견한 이메일: ${(debugInfo.foundEmails || []).join(" | ")}`);
  console.log(`거절한 이메일: ${(debugInfo.rejectedEmails || []).join(" | ")}`);
  console.log(`선택한 이메일: ${debugInfo.selectedEmail || ""}`);
  console.log(`선택 이메일 점수 사유: ${debugInfo.selectedEmailScore || 0} ${debugInfo.selectedEmailScoreReason || ""}`);
  console.log(`선택 이메일 출처 사유: ${debugInfo.selectedEmailSourceReason || ""}`);
  console.log(`Job Site: ${debugInfo.jobSiteSource || ""}`);
  console.log(`매칭 점수: ${debugInfo.matchScore || 0}`);
  console.log(`Fast Path 사용: ${debugInfo.fastPathUsed ? "yes" : "no"}`);
  console.log(`종료 사유: ${debugInfo.stopReason || ""}`);
  console.log(
    `예산 사용: search=${debugInfo.searchQueriesUsed || 0} result=${debugInfo.resultPagesUsed || 0} ` +
      `homepage=${debugInfo.homepagePagesUsed || 0} rowMs=${debugInfo.rowMs || 0}` +
      `${(debugInfo.budgetsHit || []).length ? ` hit=${(debugInfo.budgetsHit || []).join("+")}` : ""}`,
  );
  console.log(`최종 실패 사유: ${debugInfo.failureCode || ""} ${debugInfo.failureReason || ""}`);
  console.log("━━━━━━━━━━━━━━");
}
