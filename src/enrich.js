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
      return page.evaluate(() => {
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

  constructor({ searchProvider = null, fetchImpl = fetch } = {}) {
    this.searchProvider = searchProvider;
    this.fetchImpl = fetchImpl;
  }

  enabled() {
    return true;
  }

  async search(request) {
    const results = await searchEmailDiscovery(this.searchProvider, request.query, request.limit || EMAIL_DISCOVERY_LIMIT);
    return results.filter((result) => isJobSiteUrl(result.url));
  }

  async close() {
    await this.searchProvider?.close?.();
  }

  async discover(company, { homepage = "" } = {}) {
    const candidates = [];
    const officialHost = homepage ? hostnameOf(homepage) : "";
    const queries = JOB_SITE_DISCOVERY_TERMS.map((term) => `${company.companyName} ${term}`);
    for (const query of queries) {
      const results = (await searchEmailDiscovery(this.searchProvider, query, EMAIL_DISCOVERY_LIMIT)).filter((result) =>
        isJobSiteUrl(result.url),
      );
      for (const result of results) {
        const pageText = await readDiscoveredPageText(this.searchProvider, result.url, this.fetchImpl);
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
    }

    candidates.sort((a, b) => {
      const aScore = (a.homepage ? 50 : 0) + (a.email ? 30 : 0) + a.matchScore;
      const bScore = (b.homepage ? 50 : 0) + (b.email ? 30 : 0) + b.matchScore;
      return bScore - aScore;
    });
    return candidates[0] || { sourceUrl: "", sourceName: "", homepage: "", email: "", emailKind: "", personalEmail: "", rejectedEmails: [], matchScore: 0 };
  }
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

  async findOfficial(company, { limit = SEARCH_LIMIT } = {}) {
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
      const label = provider.label || provider.name;
      this.usedLabels.add(label);
      console.log(`Using ${label}`);
      this.logger?.info("homepage_search_provider", { message: `Using ${label}`, provider: provider.name });
      try {
        let candidateCount = 0;
        for (const query of buildHomepageQueries(company)) {
          const candidates = await provider.search({ ...company, query, limit, fetchImpl: this.fetchImpl });
          searchEvents.push({
            provider: label,
            query,
            candidateUrls: candidates.slice(0, DEBUG_CANDIDATE_LIMIT).map((item) => item.url),
            ok: true,
            error: "",
          });
          allCandidates.push(...candidates);
          candidateCount += candidates.length;
          const official = await pickOfficialHomepageAsync(candidates, company, this.fetchImpl, provider);
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

  async search({ query, companyName = query, region = "", industry = "", limit = EMAIL_DISCOVERY_LIMIT } = {}) {
    const results = [];
    for (const provider of this.providers) {
      if (this.disabledProviders.has(provider.name)) continue;
      if (provider.enabled && !provider.enabled()) continue;
      const label = provider.label || provider.name;
      const firstUse = !this.usedLabels.has(label);
      this.usedLabels.add(label);
      if (firstUse) console.log(`Using ${label}`);
      this.logger?.info("email_search_provider", { message: `Using ${label}`, provider: provider.name, query });
      try {
        results.push(...(await provider.search({ query, companyName, region, industry, limit, fetchImpl: this.fetchImpl })));
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
  sheets = defaultSheetsGateway(),
  homepageProvider = null,
  fetchImpl = fetch,
  logger = null,
  dryRun = false,
  debug = false,
} = {}) {
  const searchProvider = homepageProvider || new FallbackHomepageSearchProvider({ logger, fetchImpl });
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
    failureDetails: [],
    failureCodes: [],
    candidateHighlights: [],
    skipped: 0,
    searchProvidersUsed: [],
    sheetsApi: { batchUpdate: 0, append: 0, update: 0, total: 0 },
    dryRun,
    debug,
    runMs: 0,
  };
  const pendingRowUpdates = [];

  const { spreadsheetId } = await sheets.getTargetSpreadsheet();
  summary.spreadsheetId = spreadsheetId;
  const system = await sheets.readSystemState(spreadsheetId);
  const selectedStartRow = selectEnrichStartRow(startRow, system.enrich_current_row);
  const queuedRows = await sheets.readQueuedEnrichmentRows(spreadsheetId, { startRow: selectedStartRow, limit });
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
    let result;
    try {
      result = await enrichCandidate(candidate, { homepageProvider: searchProvider, fetchImpl, debug });
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

export async function enrichCandidate({ rowNumber, row }, { homepageProvider, fetchImpl = fetch, debug = false }) {
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

  if (current.homepage && current.email) {
    return { rowNumber, companyName: current.companyName, skipped: true, updates };
  }

  if (!current.email) {
    const discoveryResult = await discoverEmail(current, {
      homepage,
      searchProvider: homepageProvider,
      fetchImpl,
    });
    if (discoveryResult.email) {
      updates.email = discoveryResult.email;
      emailUpdated = true;
      debugInfo.foundEmails.push(discoveryResult.email);
      setSelectedEmailDebug(debugInfo, discoveryResult);
      if (discoveryResult.sourceUrl) memoParts.push(formatEmailSourceMemo(discoveryResult));
    }
    debugInfo.rejectedEmails.push(...(discoveryResult.rejectedEmails || []));
  }

  if (!current.email && !emailUpdated && homepageProvider) {
    const jobSiteProvider = new JobSiteDiscoveryProvider({ searchProvider: homepageProvider, fetchImpl });
    const jobResult = await jobSiteProvider.discover(current, { homepage });
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
        debugInfo.foundEmails.push(jobResult.email);
        setSelectedEmailDebug(debugInfo, jobResult);
        if (jobResult.sourceUrl) memoParts.push(formatEmailSourceMemo(jobResult));
      if (jobResult.emailKind) memoParts.push(`email_kind=${jobResult.emailKind}`);
    } else if (jobResult.personalEmail) {
      memoParts.push(`enrich jobsite_personal_email=${jobResult.personalEmail}`);
      debugInfo.foundEmails.push(jobResult.personalEmail);
    }
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
        : { official: await pickOfficialHomepageAsync(await homepageProvider.search(searchRequest), current, fetchImpl), failures: [] };
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

  if (homepage && !current.email && !emailUpdated) {
    const emailResult = await extractEmailDetails(homepage, { fetchImpl });
    contactPageUrl = emailResult.contactPageUrl;
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
  }

  if (!current.email && !emailUpdated) {
    memoParts.push("이메일 미확보");
    failureReason ||= homepage ? "email not found" : "홈페이지 없음";
    failureCode = homepage ? failureCode || "no_email" : "no_email_found";
  }

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
    updates,
    debug: debug ? debugInfo : null,
  };
}

export async function discoverEmail(company, { homepage = "", searchProvider, fetchImpl = fetch } = {}) {
  const candidates = [];
  const officialHost = homepage ? hostnameOf(homepage) : "";

  for (const query of emailDiscoveryQueries(company.companyName)) {
    const results = await searchEmailDiscovery(searchProvider, query, EMAIL_DISCOVERY_LIMIT);
    for (const result of results) {
      collectEmailCandidates(`${result.title} ${result.snippet} ${result.url}`, result.url, officialHost, candidates, {
        company,
        sourceName: sourceNameForUrl(result.url, result.source),
        sourceType: isJobSiteUrl(result.url) ? "job-site" : "public-web",
      });
      const pageText = await readDiscoveredPageText(searchProvider, result.url, fetchImpl);
      if (pageText) {
        collectEmailCandidates(pageText, result.url, officialHost, candidates, {
          company,
          sourceName: sourceNameForUrl(result.url, result.source),
          sourceType: isJobSiteUrl(result.url) ? "job-site" : "public-web",
        });
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

async function pickOfficialHomepageAsync(candidates, company, fetchImpl, pageTextProvider = null) {
  const expanded = [];
  for (const candidate of dedupeCandidates(candidates)) {
    expanded.push(candidate);
    if (isFollowableDirectoryUrl(candidate.url)) {
      const pageText = await readDiscoveredPageText(pageTextProvider, candidate.url, fetchImpl);
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

async function searchEmailDiscovery(searchProvider, query, limit) {
  if (!searchProvider) return [];
  if (typeof searchProvider.search === "function") {
    return searchProvider.search({ query, companyName: query, region: "", industry: "", limit });
  }
  if (Array.isArray(searchProvider.providers)) {
    const results = [];
    for (const provider of searchProvider.providers) {
      if (searchProvider.disabledProviders?.has(provider.name)) continue;
      if (provider.enabled && !provider.enabled()) continue;
      try {
        results.push(...(await provider.search({ query, companyName: query, region: "", industry: "", limit })));
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

async function fetchSearchResultText(url, fetchImpl) {
  const normalized = normalizeUrl(url);
  if (!normalized) return "";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    let response;
    try {
      response = await fetchImpl(normalized, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": "FlowerCRM-EnrichBot/0.1" },
      });
    } finally {
      clearTimeout(timer);
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

async function readDiscoveredPageText(searchProvider, url, fetchImpl) {
  return fetchSearchResultText(url, fetchImpl);
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
  console.log(`최종 실패 사유: ${debugInfo.failureCode || ""} ${debugInfo.failureReason || ""}`);
  console.log("━━━━━━━━━━━━━━");
}
