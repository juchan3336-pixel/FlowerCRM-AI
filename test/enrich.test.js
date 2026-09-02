import assert from "node:assert/strict";
import test from "node:test";

import { extractEmailDetails } from "../src/emailExtractor.js";
import {
  FallbackHomepageSearchProvider,
  GoogleHomepageSearchProvider,
  JobSiteDiscoveryProvider,
  NaverHomepageSearchProvider,
  PlaywrightHomepageSearchProvider,
  ROW_BUDGET_KEYS,
  SourceUrlHomepageProvider,
  ROW_STOP_REASONS,
  RowExplorationContext,
  buildHomepageQueries,
  discoverEmail,
  enrichCandidate,
  extractAddressParts,
  filterSearchResultLinks,
  isPlatformUrl,
  isRowAbortError,
  matchCompanyAddressScore,
  pickOfficialHomepage,
  platformUrlReason,
  runEnrich,
  scoreDiscoveredEmail,
  scoreOfficialCandidate,
} from "../src/enrich.js";
import { googleRetryDelayMs } from "../src/googleSheets.js";

test("picks only official-looking homepage candidates", () => {
  const picked = pickOfficialHomepage(
    [
      {
        url: "https://map.naver.com/p/entry/place/123",
        title: "Example Construction",
        snippet: "directory",
        source: "naver-web",
      },
      {
        url: "https://example-construction.co.kr/",
        title: "Example Construction official website",
        snippet: "Busan construction company",
        source: "naver-web",
      },
    ],
    { companyName: "Example Construction" },
  );

  assert.equal(picked.url, "https://example-construction.co.kr/");
});

test("pickOfficialHomepage rejects realistic news/article URLs even with strong company context", () => {
  const picked = pickOfficialHomepage(
    [
      {
        url: "https://www.hankyung.com/article/2024010100001",
        title: "Example Construction, 부산 아파트 수주 확대",
        snippet: "Example Construction 공식 발표",
        source: "naver-web",
      },
      {
        url: "https://example-construction.co.kr/",
        title: "Example Construction official website",
        snippet: "Busan construction company",
        source: "naver-web",
      },
      {
        url: "https://www.mk.co.kr/news/business/123456",
        title: "Example Construction 부산 사업 확대",
        snippet: "공식 발표 기사",
        source: "naver-web",
      },
      {
        url: "https://www.fnnews.com/news/202401010900000000",
        title: "Example Construction 대형 수주",
        snippet: "회사 소개 기사",
        source: "naver-web",
      },
      {
        url: "https://news.mt.co.kr/mtview.php?no=2024010100001",
        title: "Example Construction 지역 확장",
        snippet: "기사 본문",
        source: "naver-web",
      },
      {
        url: "http://www.fintechpost.co.kr/news/articleView.html?idxno=79953",
        title: "Example Construction 관련 뉴스",
        snippet: "부산 기업 기사",
        source: "naver-web",
      },
      {
        url: "http://www.kyosu.net/news/articleView.html?idxno=125134",
        title: "Example Construction 관련 뉴스",
        snippet: "부산 기업 기사",
        source: "naver-web",
      },
    ],
    { companyName: "Example Construction", region: "부산" },
  );

  assert.equal(picked?.url, "https://example-construction.co.kr/");
});

test("pickOfficialHomepage returns null when only news/article URLs exist", () => {
  const picked = pickOfficialHomepage(
    [
      {
        url: "https://www.hankyung.com/article/2024010100001",
        title: "Example Construction, 부산 아파트 수주 확대",
        snippet: "Example Construction 공식 발표",
        source: "naver-web",
      },
      {
        url: "https://www.mk.co.kr/news/business/123456",
        title: "Example Construction 부산 사업 확대",
        snippet: "공식 발표 기사",
        source: "naver-web",
      },
      {
        url: "https://www.fnnews.com/news/202401010900000000",
        title: "Example Construction 대형 수주",
        snippet: "회사 소개 기사",
        source: "naver-web",
      },
      {
        url: "https://news.mt.co.kr/mtview.php?no=2024010100001",
        title: "Example Construction 지역 확장",
        snippet: "기사 본문",
        source: "naver-web",
      },
    ],
    { companyName: "Example Construction", region: "부산" },
  );

  assert.equal(picked, null);
});

test("enrichCandidate leaves homepage blank when only news/article candidates exist", async () => {
  const homepageProvider = {
    async findOfficial() {
      return {
        official: null,
        failures: [],
        candidates: [
          {
            url: "https://www.hankyung.com/article/2024010100001",
            title: "Example Construction, 부산 아파트 수주 확대",
            snippet: "Example Construction 공식 발표",
            source: "naver-web",
          },
          {
            url: "https://www.mk.co.kr/news/business/123456",
            title: "Example Construction 부산 사업 확대",
            snippet: "공식 발표 기사",
            source: "naver-web",
          },
        ],
        searchEvents: [],
      };
    },
  };
  const fetchImpl = async () => new Response("", { status: 200 });
  const row = ["Example Construction", "건설", "", "부산", "부산광역시 해운대구 우동 1", "051-111-2222", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl });

  assert.equal(result.homepageUpdated, false);
  assert.equal(result.updates.homepage, undefined);
  assert.equal(result.failureReason.includes("홈페이지 없음"), true);
});

test("builds Naver-first homepage queries with address and support intents", () => {
  const company = {
    companyName: "Acme Flower",
    region: "서울",
    address: "서울특별시 강남구 역삼동 테헤란로 1",
  };

  assert.deepEqual(buildHomepageQueries(company), [
    "Acme Flower 서울특별시 강남구 역삼동",
    "Acme Flower 서울",
    "Acme Flower 공식 홈페이지",
    "Acme Flower 고객센터",
    "Acme Flower 문의",
    "Acme Flower 이메일",
  ]);
  assert.deepEqual(extractAddressParts(company.address), ["서울특별시", "강남구", "역삼동"]);
  assert.equal(matchCompanyAddressScore("서울 강남구 역삼동 회사소개", company) >= 16, true);
});

test("browser search filters Naver utility links before result limiting", () => {
  const filtered = filterSearchResultLinks([
    {
      url: "https://search.naver.com/search.naver?query=삼영기술#lnb",
      title: "메뉴 영역으로 바로가기",
      snippet: "skip navigation",
      source: "playwright-naver",
    },
    {
      url: "https://www.naver.com/",
      title: "NAVER",
      snippet: "search box",
      source: "playwright-naver",
    },
    {
      url: "https://www.saramin.co.kr/zf_user/company-info/view?csn=abc",
      title: "(주)삼영기술 2026년 기업정보",
      snippet: "부산 부산진구 홈페이지 http://samyoungeng.com",
      source: "playwright-naver",
    },
    {
      url: "http://samyoungeng.com/",
      title: "삼영기술 공식 홈페이지",
      snippet: "부산 토목 엔지니어링",
      source: "playwright-naver",
    },
  ]);

  assert.deepEqual(
    filtered.map((item) => item.url),
    ["https://www.saramin.co.kr/zf_user/company-info/view?csn=abc", "http://samyoungeng.com/"],
  );
});

test("extracts preferred email and contact page URL from homepage links", async () => {
  const pages = new Map([
    [
      "https://example.com/",
      '<html><a href="/contact">Contact</a><span>hello@example.com</span></html>',
    ],
    ["https://example.com/contact", "<html>Sales: sales@example.com</html>"],
  ]);
  const fetchImpl = async (url) => new Response(pages.get(url), { status: pages.has(url) ? 200 : 404 });

  const result = await extractEmailDetails("https://example.com", { fetchImpl });

  assert.equal(result.email, "sales@example.com");
  assert.equal(result.contactPageUrl, "https://example.com/contact");
});

test("enriches blank homepage and email without touching existing values", async () => {
  const homepageProvider = {
    async search() {
      return [
        {
          url: "https://acme-flower.co.kr/",
          title: "Acme Flower official",
          snippet: "Seoul flower delivery",
          source: "naver-web",
        },
      ];
    },
  };
  const fetchImpl = async () => new Response("info@acme-flower.co.kr", { status: 200 });
  const row = ["Acme Flower", "flower", "", "Seoul", "", "02-111-2222", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl });

  assert.equal(result.homepageUpdated, true);
  assert.equal(result.emailUpdated, true);
  assert.equal(result.updates.homepage, "https://acme-flower.co.kr/");
  assert.equal(result.updates.email, "info@acme-flower.co.kr");
});

test("discoverEmail reads result pages through provider before fetch fallback", async () => {
  let fetchCalls = 0;
  let pageReads = 0;
  const searchProvider = {
    async search() {
      return [
        {
          url: "https://www.jobkorea.co.kr/company/provider-read",
          title: "Provider Build 채용",
          snippet: "부산 해운대구 담당자",
          source: "mock-job-search",
        },
      ];
    },
    async readPageText(url) {
      pageReads += 1;
      assert.equal(url, "https://www.jobkorea.co.kr/company/provider-read");
      return "Provider Build 부산 해운대구 채용 담당자 provider@provider-build.co.kr";
    },
  };
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("fetch fallback should not run when provider can read pages");
  };

  const result = await discoverEmail(
    { companyName: "Provider Build", region: "부산", address: "부산광역시 해운대구 우동 1" },
    { searchProvider, fetchImpl },
  );

  assert.equal(result.email, "provider@provider-build.co.kr");
  // All 6 discovery queries return the same URL; per-row page dedupe reads it once (PR-A feature 3).
  assert.equal(pageReads, 1);
  assert.equal(fetchCalls, 0);
});

test("email-first enrich accepts job-site email while homepage remains blank", async () => {
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: ["mock: no homepage"], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (query === "DaeHan Build 문의") {
        return [
          {
            url: "https://www.jobkorea.co.kr/company/daehan-build",
            title: "대한건설 채용 담당자 이메일",
            snippet: "부산 해운대구 담당자 contact@daehan-build.co.kr",
            source: "mock-job-search",
          },
        ];
      }
      return [];
    },
  };
  const fetchImpl = async (url) =>
    new Response(
      String(url).includes("jobkorea")
        ? "대한건설 부산 해운대구 채용 문의 담당자 contact@daehan-build.co.kr"
        : "",
      { status: 200 },
    );
  const row = ["DaeHan Build", "건설", "", "부산", "부산광역시 해운대구 우동 1", "051-111-2222", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, debug: true });

  assert.equal(result.homepageUpdated, false);
  assert.equal(result.updates.homepage, undefined);
  assert.equal(result.emailUpdated, true);
  assert.equal(result.updates.email, "contact@daehan-build.co.kr");
  assert.equal(result.failureReason, "");
  assert.equal(result.updates.memo.includes("홈페이지/이메일 미확보"), false);
  assert.equal(result.updates.memo.includes("enrich email_source=잡코리아 https://www.jobkorea.co.kr/company/daehan-build"), true);
});

test("runEnrich counts email with blank homepage as success, not homepage failure", async () => {
  const batches = [];
  const logs = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-blank-homepage" };
    },
    async readSystemState() {
      return {};
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          { rowNumber: 2, row: ["DaeHan Build", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""] },
        ],
        nextRow: 3,
        scanned: 1,
        skipped: 0,
        totalDataRows: 1,
      };
    },
    async batchUpdateEnrichRows(spreadsheetId, rowUpdates) {
      batches.push({ spreadsheetId, rowUpdates });
      return { updated: rowUpdates.length, batchUpdate: 1 };
    },
    async writeSystemState() {
      return { updated: 1, updates: 1 };
    },
    async appendEnrichLog(spreadsheetId, summary) {
      logs.push({ spreadsheetId, summary });
      return { written: 1, appendCalls: 1 };
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: ["mock: no homepage"], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (query === "DaeHan Build 문의") {
        return [{ url: "https://www.saramin.co.kr/zf_user/company-info/view?csn=1", title: "대한건설 채용", snippet: "담당자 hr@daehan-build.co.kr", source: "mock-job-search" }];
      }
      return [];
    },
  };
  const fetchImpl = async () => new Response("대한건설 부산 담당자 hr@daehan-build.co.kr", { status: 200 });

  const summary = await runEnrich({ limit: 1, sheets, homepageProvider, fetchImpl });

  assert.equal(summary.processed, 1);
  assert.equal(summary.homepageFound, 0);
  assert.equal(summary.emailFound, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.failureDetails, []);
  assert.equal(batches[0].rowUpdates[0].updates.homepage, undefined);
  assert.equal(batches[0].rowUpdates[0].updates.email, "hr@daehan-build.co.kr");
  assert.equal(batches[0].rowUpdates[0].updates.memo.includes("홈페이지/이메일 미확보"), false);
  assert.equal(logs[0].summary.failed, 0);
});

test("runEnrich dry-run keeps Sheets write surfaces untouched", async () => {
  const writeCalls = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-dry-run" };
    },
    async readSystemState() {
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          { rowNumber: 2, row: ["DaeHan Build", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""] },
        ],
        nextRow: 3,
        scanned: 1,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows() {
      writeCalls.push("batch");
      throw new Error("dry-run must not batch write");
    },
    async writeSystemState() {
      writeCalls.push("system");
      throw new Error("dry-run must not write SYSTEM");
    },
    async appendEnrichLog() {
      writeCalls.push("log");
      throw new Error("dry-run must not append LOG");
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: ["mock: no homepage"], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      return [{ url: "https://www.jobkorea.co.kr/company/dry-run", title: "대한건설 채용", snippet: "담당자 dry@daehan-build.co.kr", source: "mock-job-search" }];
    },
  };
  const fetchImpl = async () => new Response("대한건설 부산 담당자 dry@daehan-build.co.kr", { status: 200 });

  const summary = await runEnrich({ limit: 1, sheets, homepageProvider, fetchImpl, dryRun: true });

  assert.equal(summary.processed, 1);
  assert.equal(summary.emailFound, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.sheetsApi, { batchUpdate: 0, append: 0, update: 0, total: 0 });
  assert.deepEqual(writeCalls, []);
});

test("runEnrich defaults to SYSTEM enrich_current_row for queued enrichment reads", async () => {
  let readOptions;
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-default-start-row" };
    },
    async readSystemState() {
      return { enrich_current_row: "17" };
    },
    async readQueuedEnrichmentRows(spreadsheetId, options) {
      readOptions = { spreadsheetId, options };
      return { candidates: [], nextRow: 17, scanned: 0, skipped: 0 };
    },
    async batchUpdateEnrichRows() {
      return { updated: 0, batchUpdate: 0 };
    },
    async writeSystemState() {
      return { updates: 1 };
    },
    async appendEnrichLog() {
      return { appendCalls: 1 };
    },
  };

  const summary = await runEnrich({ limit: 10, sheets, homepageProvider: { async close() {} } });

  // readOnly is passed explicitly on every read so the gateway never has to infer dry-run.
  assert.deepEqual(readOptions, { spreadsheetId: "sheet-default-start-row", options: { startRow: 17, limit: 10, readOnly: false } });
  assert.equal(summary.startRow, 17);
});

test("runEnrich explicit startRow overrides later SYSTEM enrich_current_row for this run", async () => {
  let readOptions;
  const systemWrites = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-explicit-start-row" };
    },
    async readSystemState() {
      return { enrich_current_row: "88" };
    },
    async readQueuedEnrichmentRows(spreadsheetId, options) {
      readOptions = { spreadsheetId, options };
      return { candidates: [], nextRow: 4, scanned: 2, skipped: 2 };
    },
    async batchUpdateEnrichRows() {
      return { updated: 0, batchUpdate: 0 };
    },
    async writeSystemState(spreadsheetId, updates) {
      systemWrites.push({ spreadsheetId, updates });
      return { updates: 1 };
    },
    async appendEnrichLog() {
      return { appendCalls: 1 };
    },
  };

  const summary = await runEnrich({ limit: 10, startRow: 2, sheets, homepageProvider: { async close() {} } });

  assert.deepEqual(readOptions, { spreadsheetId: "sheet-explicit-start-row", options: { startRow: 2, limit: 10, readOnly: false } });
  assert.equal(summary.startRow, 2);
  assert.equal(systemWrites[0].updates.enrich_current_row, "4");
});

test("runEnrich dry-run with explicit startRow does not write batch LOG or SYSTEM", async () => {
  let readOptions;
  const writeCalls = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-dry-run-start-row" };
    },
    async readSystemState() {
      return { enrich_current_row: "44" };
    },
    async readQueuedEnrichmentRows(spreadsheetId, options) {
      readOptions = { spreadsheetId, options };
      return { candidates: [], nextRow: 3, scanned: 1, skipped: 1 };
    },
    async batchUpdateEnrichRows() {
      writeCalls.push("batch");
      throw new Error("dry-run must not batch write");
    },
    async writeSystemState() {
      writeCalls.push("system");
      throw new Error("dry-run must not write SYSTEM");
    },
    async appendEnrichLog() {
      writeCalls.push("log");
      throw new Error("dry-run must not append LOG");
    },
  };

  const summary = await runEnrich({ limit: 10, startRow: 2, sheets, homepageProvider: { async close() {} }, dryRun: true });

  // Blocker 6 — a dry run must request read-only access so the gateway skips shape/header repair.
  assert.deepEqual(readOptions, { spreadsheetId: "sheet-dry-run-start-row", options: { startRow: 2, limit: 10, readOnly: true } });
  assert.equal(summary.startRow, 2);
  assert.deepEqual(summary.sheetsApi, { batchUpdate: 0, append: 0, update: 0, total: 0 });
  assert.deepEqual(writeCalls, []);
});

test("runEnrich stops gracefully at maxRuntimeMs before starting the next row", async () => {
  const batches = [];
  const systemWrites = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-max-runtime" };
    },
    async readSystemState() {
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          { rowNumber: 2, row: ["Runtime One", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""] },
          { rowNumber: 3, row: ["Runtime Two", "건설", "", "부산", "부산광역시 해운대구 우동 2", "", "", "", "", "", "", "", ""] },
        ],
        nextRow: 4,
        scanned: 2,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows(spreadsheetId, rowUpdates) {
      batches.push({ spreadsheetId, rowUpdates });
      return { updated: rowUpdates.length, batchUpdate: 1 };
    },
    async writeSystemState(spreadsheetId, updates) {
      systemWrites.push({ spreadsheetId, updates });
      return { updates: 1 };
    },
    async appendEnrichLog() {
      return { appendCalls: 1 };
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: ["mock: no homepage"], candidates: [], searchEvents: [] };
    },
    async close() {},
  };
  let nowCalls = 0;
  const now = () => (nowCalls++ < 2 ? 0 : 1000);

  const summary = await runEnrich({ limit: 2, sheets, homepageProvider, maxRuntimeMs: 1, now });

  assert.equal(summary.processed, 1);
  assert.equal(summary.stopReason, "max_runtime_reached");
  assert.equal(summary.nextRow, 3);
  assert.equal(systemWrites[0].updates.enrich_current_row, "3");
  assert.equal(batches[0].rowUpdates.length, 1);
});

test("runEnrich isolates source failures and continues to update the next candidate", async () => {
  const batches = [];
  const logs = [];
  const searchQueries = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-failure-isolation" };
    },
    async readSystemState() {
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          { rowNumber: 2, row: ["Bad Source Co", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""] },
          { rowNumber: 3, row: ["Good Source Co", "제조", "", "창원", "창원시 성산구 중앙동 1", "", "", "", "", "", "", "", ""] },
        ],
        nextRow: 4,
        scanned: 2,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows(spreadsheetId, rowUpdates) {
      batches.push({ spreadsheetId, rowUpdates });
      return { updated: rowUpdates.length, batchUpdate: rowUpdates.length > 0 ? 1 : 0 };
    },
    async writeSystemState() {
      return { updates: 1 };
    },
    async appendEnrichLog(spreadsheetId, summary) {
      logs.push({ spreadsheetId, summary });
      return { appendCalls: 1 };
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: ["mock: no homepage"], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      searchQueries.push(query);
      if (query.startsWith("Bad Source Co")) throw new Error("mock source timeout for Bad Source Co");
      if (query === "Good Source Co 문의") {
        return [
          {
            url: "https://www.jobkorea.co.kr/company/good-source",
            title: "Good Source Co 채용",
            snippet: "창원 담당자 good@good-source.co.kr",
            source: "mock-job-search",
          },
        ];
      }
      return [];
    },
    async close() {
      searchQueries.push("close");
    },
  };
  const fetchImpl = async (url) =>
    new Response(String(url).includes("good-source") ? "Good Source Co 창원 담당자 good@good-source.co.kr" : "", { status: 200 });

  const summary = await runEnrich({ limit: 2, sheets, homepageProvider, fetchImpl, debug: true });

  assert.equal(summary.processed, 2);
  assert.equal(summary.emailFound, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failureDetails, ["2 Bad Source Co: site_access_failed"]);
  assert.equal(searchQueries.some((query) => query === "Good Source Co 문의"), true);
  assert.equal(searchQueries.at(-1), "close");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].rowUpdates.length, 1);
  assert.equal(batches[0].rowUpdates[0].rowNumber, 3);
  assert.equal(batches[0].rowUpdates[0].updates.email, "good@good-source.co.kr");
  assert.equal(logs[0].summary.processed, 2);
  assert.equal(logs[0].summary.emailFound, 1);
});

test("runEnrich dry-run debug records failure evidence without Sheets writes", async () => {
  const writeCalls = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-dry-run-debug-failure" };
    },
    async readSystemState() {
      return { enrich_current_row: "8" };
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          { rowNumber: 8, row: ["Debug Fail Co", "제조", "", "울산", "울산광역시 남구 삼산동 1", "", "", "", "", "", "", "", ""] },
        ],
        nextRow: 9,
        scanned: 1,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows() {
      writeCalls.push("batch");
      throw new Error("dry-run must not batch write");
    },
    async writeSystemState() {
      writeCalls.push("system");
      throw new Error("dry-run must not write SYSTEM");
    },
    async appendEnrichLog() {
      writeCalls.push("log");
      throw new Error("dry-run must not append LOG");
    },
  };
  const homepageProvider = {
    async search() {
      throw new Error("mock browser page timeout while loading job-site fixture");
    },
  };
  const fetchImpl = async () => {
    throw new Error("live web must not be used");
  };

  const summary = await runEnrich({ limit: 1, sheets, homepageProvider, fetchImpl, dryRun: true, debug: true });

  assert.equal(summary.processed, 1);
  assert.equal(summary.emailFound, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.debug, true);
  assert.deepEqual(summary.sheetsApi, { batchUpdate: 0, append: 0, update: 0, total: 0 });
  assert.deepEqual(writeCalls, []);
  assert.deepEqual(summary.failureDetails, ["8 Debug Fail Co: site_access_failed"]);
  assert.equal(summary.candidateHighlights.length, 1);
  assert.equal(summary.candidateHighlights[0].includes("Debug Fail Co"), true);
  assert.equal(summary.candidateHighlights[0].includes("email="), true);
});

test("enrich row update objects expose only homepage email memo contract keys", async () => {
  const batches = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-update-contract" };
    },
    async readSystemState() {
      return {};
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          { rowNumber: 9, row: ["한빛제조", "제조", "", "창원", "창원시 성산구 중앙동 1", "", "", "", "", "", "", "", "기존메모"] },
        ],
        nextRow: 10,
        scanned: 1,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows(spreadsheetId, rowUpdates) {
      batches.push({ spreadsheetId, rowUpdates });
      return { updated: rowUpdates.length, batchUpdate: 1 };
    },
    async writeSystemState() {
      return { updates: 1 };
    },
    async appendEnrichLog() {
      return { appendCalls: 1 };
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.includes("잡코리아")) return [];
      return [{ url: "https://www.jobkorea.co.kr/company/hanbit", title: "한빛제조 채용", snippet: "창원 담당자 email@hanbit.co.kr", source: "mock-job-search" }];
    },
  };
  const fetchImpl = async () => new Response("한빛제조 창원 담당자 email@hanbit.co.kr", { status: 200 });

  // This test exercises the update-object contract via a late ("잡코리아") job-site query, so
  // disable the per-row search budget to keep it independent of budget tuning.
  await runEnrich({ limit: 1, sheets, homepageProvider, fetchImpl, maxSearchQueries: 0 });

  const updates = batches[0].rowUpdates[0].updates;
  assert.deepEqual(Object.keys(updates).sort(), ["email", "memo"]);
  assert.equal(updates.email, "email@hanbit.co.kr");
  assert.equal(updates.memo.includes("enrich email_source=잡코리아 https://www.jobkorea.co.kr/company/hanbit"), true);
});

test("debug details include source visits and candidate rejection evidence for blank diagnosis", async () => {
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: ["mock: no homepage"], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.includes("잡코리아")) return [];
      return [{ url: "https://www.jobkorea.co.kr/company/diagnose", title: "오더코프 채용", snippet: "서울 담당자 sales@othercorp.co.kr", source: "mock-job-search" }];
    },
  };
  const fetchImpl = async () => new Response("오더코프 서울 담당자 이메일 sales@othercorp.co.kr", { status: 200 });
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 11, row }, { homepageProvider, fetchImpl, debug: true });

  assert.equal(result.emailUpdated, false);
  assert.equal(result.failureCode, "no_email_found");
  assert.equal(result.debug.sourceVisits.includes("https://www.jobkorea.co.kr/company/diagnose"), true);
  assert.equal(result.debug.rejectedEmails.includes("sales@othercorp.co.kr"), true);
  assert.equal(result.debug.failureCode, "no_email_found");
});

test("public-web discovery rejects unrelated realistic company-domain email and can select a later valid candidate", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      return [
        {
          url: "https://public.example.com/othercorp-contact",
          title: "오더코프 문의",
          snippet: "서울 강남구 담당자 sales@othercorp.co.kr",
          source: "browser-public-fixture",
        },
        {
          url: "https://public.example.com/daehan-contact",
          title: "대한건설 문의",
          snippet: "부산 해운대구 대표메일 contact@daehan-build.co.kr",
          source: "browser-public-fixture",
        },
      ];
    },
    async readPageText(url) {
      if (url.includes("othercorp")) return "오더코프 서울 강남구 담당자 이메일 sales@othercorp.co.kr";
      return "대한건설 부산광역시 해운대구 문의 대표메일 contact@daehan-build.co.kr";
    },
  };

  const result = await discoverEmail(
    { companyName: "대한건설", region: "부산", address: "부산광역시 해운대구 우동 1" },
    { searchProvider },
  );

  assert.equal(result.email, "contact@daehan-build.co.kr");
  assert.equal(result.email === "sales@othercorp.co.kr", false);
  assert.equal(Number.isFinite(result.score), true);
  assert.equal(result.rejectedEmails.includes("sales@othercorp.co.kr"), true);
});

test("email-first debug exposes selected email with score and source reason", async () => {
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: ["mock: no homepage"], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      return [
        {
          url: "https://public.example.com/daehan-debug",
          title: "대한건설 문의",
          snippet: "부산 해운대구 담당자 debug@daehan-build.co.kr",
          source: "browser-public-fixture",
        },
      ];
    },
  };
  const fetchImpl = async () => new Response("대한건설 부산광역시 해운대구 담당자 이메일 debug@daehan-build.co.kr", { status: 200 });
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 12, row }, { homepageProvider, fetchImpl, debug: true });

  assert.equal(result.updates.email, "debug@daehan-build.co.kr");
  assert.equal(result.debug.selectedEmail, "debug@daehan-build.co.kr");
  assert.equal(Number.isFinite(result.debug.selectedEmailScore), true);
  assert.match(result.debug.selectedEmailScoreReason, /company-context|address-context/);
  assert.equal(result.debug.selectedEmailSourceReason.includes("browser-public-fixture"), true);
});

test("existing non-empty email is never overwritten by discovery", async () => {
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (query.includes("채용") || query.includes("문의")) {
        return [{ url: "https://www.jobkorea.co.kr/company/acme", title: "Acme Flower 채용", snippet: "담당자 new@acme-flower.co.kr", source: "mock-job-search" }];
      }
      return [];
    },
  };
  const fetchImpl = async () => new Response("담당자 new@acme-flower.co.kr", { status: 200 });
  const row = ["Acme Flower", "flower", "", "Seoul", "", "02-111-2222", "", "kept@acme-flower.co.kr", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl });

  assert.equal(result.emailUpdated, false);
  assert.equal(result.updates.email, undefined);
});

test("discovers email from search results and excludes personal portal emails", async () => {
  const queries = [];
  const searchProvider = {
    async search({ query }) {
      queries.push(query);
      if (query.endsWith("문의")) {
        return [
          {
            url: "https://jobs.example.com/acme",
            title: "Acme Flower 채용",
            snippet: "문의 contact@acme-flower.co.kr 또는 ceo@gmail.com",
            source: "google-search",
          },
        ];
      }
      return [];
    },
  };
  const fetchImpl = async () => new Response("이메일은 채용공고 본문 상단을 확인하세요.", { status: 200 });

  const result = await discoverEmail(
    { companyName: "Acme Flower", region: "Seoul", industry: "flower" },
    { homepage: "https://www.acme-flower.co.kr/", searchProvider, fetchImpl },
  );

  // Early stop (PR-A feature 2): the "문의" query yields a company-domain email that matches the
  // official homepage host, so discovery stops before running the remaining queries.
  assert.deepEqual(queries, ["Acme Flower 이메일", "Acme Flower 대표메일", "Acme Flower 문의"]);
  assert.equal(result.email, "contact@acme-flower.co.kr");
  assert.equal(result.sourceUrl, "https://jobs.example.com/acme");
});

test("scores discovered emails by company domain, role prefix, and official source", () => {
  assert.equal(scoreDiscoveredEmail("person@gmail.com", "https://official.example.com", "official.example.com"), -Infinity);
  assert.equal(scoreDiscoveredEmail("contact@example.com", "https://official.example.com/contact", "official.example.com"), 120);
  assert.equal(scoreDiscoveredEmail("hello@example.com", "https://blog.example.com/post", "official.example.com"), 50);
});

test("enrich uses email discovery when homepage email extraction fails", async () => {
  const homepageProvider = {
    async search({ query }) {
      if (query) {
        return [
          {
            url: "https://news.example/post",
            title: "Acme Flower 기업소개",
            snippet: "대표메일 support@acme-flower.co.kr",
            source: "google-search",
          },
        ];
      }
      return [
        {
          url: "https://acme-flower.co.kr/",
          title: "Acme Flower official",
          snippet: "Seoul flower delivery",
          source: "google-search",
        },
      ];
    },
  };
  const fetchImpl = async (url) => new Response(url.includes("news.example") ? "support@acme-flower.co.kr" : "", { status: 200 });
  const row = ["Acme Flower", "flower", "", "Seoul", "", "02-111-2222", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl });

  assert.equal(result.homepageUpdated, true);
  assert.equal(result.emailUpdated, true);
  assert.equal(result.updates.email, "support@acme-flower.co.kr");
  assert.equal(result.updates.memo.includes("enrich email_source=google-search https://news.example/post"), true);
});

test("public email discovery uses provider page reads before fetch fallback", async () => {
  const pageReads = [];
  const fetchReads = [];
  const searchProvider = {
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      return [{ url: "https://public.example.com/acme", title: "Acme Flower 문의", snippet: "채용 안내", source: "browser-fixture" }];
    },
    async readPageText(url) {
      pageReads.push(url);
      return "Acme Flower 서울 강남구 담당자 이메일 browser-only@acme-flower.co.kr";
    },
  };
  const fetchImpl = async (url) => {
    fetchReads.push(String(url));
    return new Response("Acme Flower 서울 강남구 담당자 이메일 fetch-only@acme-flower.co.kr", { status: 200 });
  };

  const result = await discoverEmail(
    { companyName: "Acme Flower", region: "서울", address: "서울특별시 강남구 역삼동 1" },
    { searchProvider, fetchImpl },
  );

  assert.equal(result.email, "browser-only@acme-flower.co.kr");
  assert.equal(result.sourceName, "browser-fixture");
  assert.deepEqual(pageReads, ["https://public.example.com/acme"]);
  assert.deepEqual(fetchReads, []);
});

test("trusted job-site discovery falls back to injected fetch after page read failure", async () => {
  const pageReads = [];
  const fetchReads = [];
  const searchProvider = {
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      return [{ url: "https://www.jobkorea.co.kr/company/fallback", title: "한빛제조 채용", snippet: "창원 성산구", source: "browser-fixture" }];
    },
    async readPageText(url) {
      pageReads.push(url);
      throw new Error("browser navigation timeout");
    },
  };
  const fetchImpl = async (url) => {
    fetchReads.push(String(url));
    return new Response("한빛제조 창원 성산구 담당자 이메일 fallback@hanbit.co.kr", { status: 200 });
  };

  const result = await discoverEmail(
    { companyName: "한빛제조", region: "창원", address: "창원시 성산구 중앙동 1" },
    { searchProvider, fetchImpl },
  );

  assert.equal(result.email, "fallback@hanbit.co.kr");
  assert.deepEqual(pageReads, ["https://www.jobkorea.co.kr/company/fallback"]);
  assert.deepEqual(fetchReads, ["https://www.jobkorea.co.kr/company/fallback"]);
});

test("fallback provider page read failures do not affect job-site email discovery", async () => {
  const provider = new FallbackHomepageSearchProvider({
    providers: [
      {
        name: "browser-fixture",
        label: "BrowserFixture",
        enabled: () => true,
        async search({ query }) {
          if (!query.endsWith("문의")) return [];
          return [{ url: "https://www.jobkorea.co.kr/company/fallback-provider", title: "한빛제조 채용", snippet: "창원 성산구", source: "browser-fixture" }];
        },
        async readPageText() {
          throw new Error("page closed during evaluate");
        },
      },
    ],
  });
  const fetchImpl = async () => new Response("한빛제조 창원 성산구 담당자 이메일 provider-fallback@hanbit.co.kr", { status: 200 });

  const result = await discoverEmail(
    { companyName: "한빛제조", region: "창원", address: "창원시 성산구 중앙동 1" },
    { searchProvider: provider, fetchImpl },
  );

  assert.equal(result.email, "provider-fallback@hanbit.co.kr");
});

test("directory and job portal support emails are rejected as company contacts", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      return [
        {
          url: "https://www.jobploy.kr/ko/company/samyoung-technology-co-ltd",
          title: "삼영기술 채용",
          snippet: "삼영기술 부산 문의 support@jobploy.kr",
          source: "browser-fixture",
        },
        {
          url: "https://www.nicebizinfo.com/ep/EP0100M002GE.nice?kiscode=OP5152",
          title: "삼영기술 기업정보",
          snippet: "삼영기술 부산 문의 help@nicebizinfo.com",
          source: "browser-fixture",
        },
      ];
    },
  };
  const fetchImpl = async (url) =>
    new Response(String(url).includes("jobploy") ? "삼영기술 부산 문의 support@jobploy.kr" : "삼영기술 부산 문의 help@nicebizinfo.com", { status: 200 });

  const result = await discoverEmail(
    { companyName: "삼영기술", region: "부산", address: "부산 부산진구 전포대로199번길 15" },
    { searchProvider, fetchImpl },
  );

  assert.equal(result.email, "");
  assert.equal(result.rejectedEmails.includes("support@jobploy.kr"), true);
  assert.equal(result.rejectedEmails.includes("help@nicebizinfo.com"), true);
});

test("news and unrelated source-domain emails are rejected without target evidence", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      return [
        {
          url: "http://www.intn.co.kr/news/articleView.html?idxno=373234",
          title: "세무 뉴스 기사",
          snippet: "부산 건설 업계 기사 제보 ntn@intn.co.kr",
          source: "browser-fixture",
        },
        {
          url: "https://w-eng.co.kr/partner",
          title: "다른 회사 파트너 문의",
          snippet: "더블유이엔지 문의 weng@w-eng.co.kr",
          source: "browser-fixture",
        },
      ];
    },
  };
  const fetchImpl = async (url) =>
    new Response(String(url).includes("intn") ? "부산 건설 업계 기사 제보 ntn@intn.co.kr" : "더블유이엔지 문의 weng@w-eng.co.kr", { status: 200 });

  const result = await discoverEmail(
    { companyName: "광도설비 본사", region: "부산", address: "부산 해운대구 센텀중앙로 97" },
    { searchProvider, fetchImpl },
  );

  assert.equal(result.email, "");
  assert.equal(result.rejectedEmails.includes("ntn@intn.co.kr"), true);
  assert.equal(result.rejectedEmails.includes("weng@w-eng.co.kr"), true);
});

test("fallback provider skips disabled Naver and continues from Google to Playwright", async () => {
  const messages = [];
  const provider = new FallbackHomepageSearchProvider({
    logger: { info: (message, data) => messages.push({ message, data }) },
    providers: [
      {
        name: "naver",
        label: "Naver",
        enabled: () => false,
        async search() {
          throw new Error("should not run");
        },
      },
      {
        name: "google",
        label: "Google",
        enabled: () => true,
        async search() {
          throw new Error("blocked");
        },
      },
      {
        name: "playwright",
        label: "Playwright",
        enabled: () => true,
        async search() {
          return [
            {
              url: "https://acme-flower.co.kr/",
              title: "Acme Flower official",
              snippet: "Seoul flower delivery",
              source: "playwright-google",
            },
          ];
        },
      },
    ],
  });

  const result = await provider.findOfficial({ companyName: "Acme Flower", region: "Seoul", industry: "flower" });

  assert.equal(result.official.url, "https://acme-flower.co.kr/");
  assert.deepEqual(provider.getUsedLabels(), ["Google", "Playwright"]);
  assert.deepEqual(
    messages.filter((item) => item.message === "homepage_search_provider").map((item) => item.data.message),
    ["Using Google", "Using Playwright"],
  );
});

test("fallback provider disables Google after 429 and uses Playwright", async () => {
  let googleCalls = 0;
  const provider = new FallbackHomepageSearchProvider({
    providers: [
      {
        name: "google",
        label: "Google",
        enabled: () => true,
        async search() {
          googleCalls += 1;
          const error = new Error("Google search error: 429");
          error.status = 429;
          error.providerDisabled = true;
          throw error;
        },
      },
      {
        name: "playwright",
        label: "Playwright",
        enabled: () => true,
        async search() {
          return [{ url: "https://acme-flower.co.kr/", title: "Acme Flower", snippet: "official Busan", source: "playwright-google" }];
        },
      },
    ],
  });

  const result = await provider.findOfficial({ companyName: "Acme Flower", region: "Busan", industry: "hotel" });

  assert.equal(result.official.url, "https://acme-flower.co.kr/");
  assert.equal(googleCalls, 1);
  assert.deepEqual(provider.getUsedLabels(), ["Google", "Playwright"]);
});

test("job site discovery extracts official homepage and keeps personal recruiter email out of email field", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.includes("잡코리아")) return [];
      return [
        {
          url: "https://www.jobkorea.co.kr/company/acme",
          title: "Acme Flower 채용 잡코리아",
          snippet: "서울 강남구 역삼동",
          source: "naver-web",
        },
      ];
    },
  };
  const fetchImpl = async () =>
    new Response(
      '<a href="https://www.acme-flower.co.kr">회사 홈페이지</a> 담당자 recruit@naver.com 서울 강남구 역삼동',
      { status: 200 },
    );
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl });

  const result = await provider.discover({
    companyName: "Acme Flower",
    address: "서울특별시 강남구 역삼동 테헤란로 1",
  });

  assert.equal(result.homepage, "https://www.acme-flower.co.kr/");
  assert.equal(result.email, "");
  assert.equal(result.personalEmail, "recruit@naver.com");
  assert.equal(result.sourceName, "잡코리아");
});

test("job-site discovery does not treat platform service links as official homepage", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.includes("문의")) return [];
      return [
        {
          url: "https://www.saramin.co.kr/zf_user/company-info/view?csn=platform",
          title: "경진지엠피 채용 사람인",
          snippet: "부산 남구 수영로13번길 25",
          source: "browser-search-fixture",
        },
      ];
    },
  };
  const fetchImpl = async () =>
    new Response(
      '<a href="https://www.saraminhr.co.kr/">사람인 고객센터</a> <a href="https://minwon.dataline.co.kr/p06/A0601M001.nice">기업정보 민원</a> 경진지엠피 부산 남구',
      { status: 200 },
    );
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl });

  const result = await provider.discover({ companyName: "경진지엠피", address: "부산 남구 수영로13번길 25" });

  assert.equal(result.homepage, "");
});

test("pickOfficialHomepage rejects recruiting directory result pages", () => {
  const picked = pickOfficialHomepage(
    [
      {
        url: "https://www.catch.co.kr/Comp/CompSummary/F38828",
        title: "경진지엠피 기업정보",
        snippet: "부산 남구 수영로13번길 25",
        source: "browser-search-fixture",
      },
      {
        url: "https://corp.udanax.org/corporation/72421",
        title: "주식회사삼영기술 기업정보",
        snippet: "부산 부산진구 전포대로199번길 15",
        source: "browser-search-fixture",
      },
      {
        url: "https://g2bmarket.com/detail/seokgyeong",
        title: "주식회사 석경 기업정보",
        snippet: "부산 해운대구 해운대해변로 394",
        source: "browser-search-fixture",
      },
      {
        url: "https://www.webify.kr/기업/company/동아플랜",
        title: "동아플랜 업체정보",
        snippet: "부산 사하구 낙동대로 536",
        source: "browser-search-fixture",
      },
      {
        url: "https://local.114-service.co.kr/bizno/detail/6178162818/1801110567173/경진지엠피",
        title: "경진지엠피 전화번호부",
        snippet: "부산 남구 수영로13번길 25",
        source: "browser-search-fixture",
      },
      {
        url: "https://www.grandculture.net/busan/toc/GC04214817",
        title: "성운ENG 향토문화백과",
        snippet: "부산 기장군 철마면 안평로 33",
        source: "browser-search-fixture",
      },
      {
        url: "https://www.haeundae.go.kr/board/download.do?boardId=BBS_0000038&dataSid=3092447",
        title: "광도설비 본사 구청 첨부파일",
        snippet: "부산 해운대구 센텀중앙로 97",
        source: "browser-search-fixture",
      },
      {
        url: "https://www.job-post.co.kr/news/articleView.html?idxno=115353",
        title: "남경ENG 채용 뉴스",
        snippet: "부산 사상구 주례로 101",
        source: "browser-search-fixture",
      },
      {
        url: "https://www.saramin-team.kr/",
        title: "사람인 팀 서비스",
        snippet: "경진지엠피 부산 남구 수영로13번길 25",
        source: "browser-search-fixture",
      },
      {
        url: "http://www.financialpost.co.kr/",
        title: "성운ENG 관련 경제 뉴스",
        snippet: "부산 기장군 철마면 안평로 33",
        source: "browser-search-fixture",
      },
      {
        url: "https://his.pusan.ac.kr/wetech/76460/subview.do",
        title: "부산대학교 페이지",
        snippet: "광도설비 본사 부산 해운대구 센텀중앙로 97",
        source: "browser-search-fixture",
      },
      {
        url: "https://cookiedeal.io/company-search/2715500863/남경ENG",
        title: "남경ENG 기업검색",
        snippet: "부산 사상구 주례로 101",
        source: "browser-search-fixture",
      },
      {
        url: "https://allthatcompany.com/c/1807070/세동하우징-도배공사",
        title: "세동하우징 공사 정보",
        snippet: "부산 남구 지게골로 101-5",
        source: "browser-search-fixture",
      },
      {
        url: "https://www.happycampus.com/corp-doc/12709503/",
        title: "경진지엠피 기업보고서",
        snippet: "부산 남구 수영로13번길 25",
        source: "browser-search-fixture",
      },
      {
        url: "http://www.happyhaksul.com/srch/?qt=금창토건",
        title: "금창토건 검색 결과",
        snippet: "부산 강서구 공항로 255",
        source: "browser-search-fixture",
      },
      {
        url: "https://tapemro.com/product/성운eng님의-개인결제창입니다/232/category/175/display/1/",
        title: "성운ENG 개인결제창",
        snippet: "부산 기장군 철마면 안평로 33",
        source: "browser-search-fixture",
      },
      {
        url: "https://bizlookup.co.kr/bizno/detail/6178162818/1801110567173/경진지엠피",
        title: "경진지엠피 사업자 조회",
        snippet: "부산 남구 수영로13번길 25",
        source: "browser-search-fixture",
      },
      {
        url: "https://kind.krx.co.kr/external/2026/03/19/000841/20260319003658/11011.htm",
        title: "광도설비 본사 공시 첨부",
        snippet: "부산 해운대구 센텀중앙로 97",
        source: "browser-search-fixture",
      },
      {
        url: "https://www.thinkzon.com/sale_bizreport/3164717",
        title: "세동하우징 기업보고서",
        snippet: "부산 남구 지게골로 101-5",
        source: "browser-search-fixture",
      },
    ],
    { companyName: "경진지엠피", address: "부산 남구 수영로13번길 25" },
  );

  assert.equal(picked, null);
});

test("job-site discovery requires extracted homepage links to look official before address boost", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.includes("문의")) return [];
      return [
        {
          url: "https://www.saramin.co.kr/zf_user/company-info/view?csn=random-link",
          title: "광도설비 본사 채용 사람인",
          snippet: "부산 해운대구 센텀중앙로 97",
          source: "browser-search-fixture",
        },
      ];
    },
  };
  const fetchImpl = async () => new Response('<a href="https://www.worxphere.ai/">협업툴</a> 광도설비 본사 부산 해운대구 센텀중앙로 97', { status: 200 });
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl });

  const result = await provider.discover({ companyName: "광도설비 본사", address: "부산 해운대구 센텀중앙로 97" });

  assert.equal(result.homepage, "");
});

test("fallback homepage search does not let job-site page text promote unrelated extracted links", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.includes("사람인")) return [];
      return [
        {
          url: "https://www.saramin.co.kr/zf_user/company-info/view?csn=follow-link",
          title: "경진지엠피 채용 사람인",
          snippet: "부산 남구 수영로13번길 25",
          source: "browser-search-fixture",
        },
      ];
    },
  };
  const fetchImpl = async () =>
    new Response(
      [
        '<a href="https://www.saramin-team.kr/">사람인 팀 서비스</a>',
        '<a href="https://moneypin.biz/bizno/detail/6178162818/">기업정보</a>',
        '<a href="https://www.kmcca.or.kr/ks/construct/evaluation.do?memberNo=2120230032&singoYear=2022">협회 조회</a>',
        '<a href="http://www.kyosu.net/news/articleView.html?idxno=125134">뉴스 기사</a>',
        "경진지엠피 부산 남구 수영로13번길 25",
      ].join(" "),
      { status: 200 },
    );
  const provider = new FallbackHomepageSearchProvider({
    providers: [new JobSiteDiscoveryProvider({ searchProvider, fetchImpl })],
    sourceProvider: { name: "source-fixture", enabled: () => true, async search() { return []; } },
    fetchImpl,
  });

  const result = await provider.findOfficial({ companyName: "경진지엠피", address: "부산 남구 수영로13번길 25" });

  assert.equal(result.official, null);
});

test("job-site discovery reads posting bodies through provider pages", async () => {
  const pageReads = [];
  const fetchReads = [];
  const searchProvider = {
    async search({ query }) {
      if (!query.includes("잡코리아")) return [];
      return [{ url: "https://www.jobkorea.co.kr/company/seam", title: "한빛제조 채용 잡코리아", snippet: "창원 성산구", source: "browser-search-fixture" }];
    },
    async readPageText(url) {
      pageReads.push(url);
      return "한빛제조 창원 성산구 담당자 이메일 seam@hanbit.co.kr";
    },
  };
  const fetchImpl = async (url) => {
    fetchReads.push(String(url));
    return new Response("한빛제조 창원 성산구 담당자 이메일 seam@hanbit.co.kr", { status: 200 });
  };
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl });

  const result = await provider.discover({ companyName: "한빛제조", address: "창원시 성산구 중앙동 1" });

  assert.equal(result.email, "seam@hanbit.co.kr");
  assert.deepEqual(pageReads, ["https://www.jobkorea.co.kr/company/seam"]);
  assert.deepEqual(fetchReads, []);
});

test("job-site discovery uses the required search terms", async () => {
  const queries = [];
  const searchProvider = {
    async search({ query }) {
      queries.push(query);
      return [];
    },
  };
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl: async () => new Response("", { status: 200 }) });

  await provider.discover({ companyName: "한빛제조", address: "창원시 성산구 중앙동 1" });

  assert.deepEqual(queries, [
    "한빛제조 채용",
    "한빛제조 문의",
    "한빛제조 대표메일",
    "한빛제조 담당자 이메일",
    "한빛제조 인사담당자",
    "한빛제조 채용 이메일",
    "한빛제조 인사담당자 이메일",
    "한빛제조 사람인",
    "한빛제조 잡코리아",
    "한빛제조 워크넷",
    "한빛제조 홈페이지",
  ]);
});

test("job-site extraction selects 담당자 company-domain email with source provenance", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.includes("사람인")) return [];
      return [
        {
          url: "https://www.saramin.co.kr/zf_user/company-info/view?csn=daehan",
          title: "대한건설 채용 사람인",
          snippet: "부산 해운대구 인사담당자 문의",
          source: "browser-search-fixture",
        },
      ];
    },
  };
  const fetchImpl = async () =>
    new Response(
      [
        '<a href="mailto:recruit@daehan-build.co.kr">인사담당자 이메일</a>',
        "대한건설 부산광역시 해운대구 채용공고",
        "무관한회사 unrelated@example.com",
      ].join(" "),
      { status: 200 },
    );
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl });

  const result = await provider.discover({
    companyName: "대한건설",
    address: "부산광역시 해운대구 우동 1",
  });

  assert.equal(result.email, "recruit@daehan-build.co.kr");
  assert.equal(result.sourceName, "사람인");
  assert.equal(result.sourceUrl, "https://www.saramin.co.kr/zf_user/company-info/view?csn=daehan");
  assert.equal(Array.isArray(result.rejectedEmails), true);
  assert.equal(result.rejectedEmails.includes("unrelated@example.com"), true);
});

test("public portal 담당자 email can be accepted only with published-contact provenance", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.includes("잡코리아")) return [];
      return [
        {
          url: "https://www.jobkorea.co.kr/company/portal-contact",
          title: "한빛제조 채용 잡코리아",
          snippet: "창원 성산구 담당자 이메일 공개",
          source: "browser-search-fixture",
        },
      ];
    },
  };
  const fetchImpl = async () => new Response("한빛제조 창원 성산구 담당자 이메일 hb-recruit@naver.com", { status: 200 });
  const row = ["한빛제조", "제조", "", "창원", "창원시 성산구 중앙동 1", "055-111-2222", "", "", "", "", "", "", ""];
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    search: searchProvider.search,
  };

  const result = await enrichCandidate({ rowNumber: 7, row }, { homepageProvider, fetchImpl });

  assert.equal(result.homepageUpdated, false);
  assert.equal(result.emailUpdated, true);
  assert.equal(result.updates.email, "hb-recruit@naver.com");
  assert.equal(result.updates.memo.includes("enrich email_source=잡코리아 https://www.jobkorea.co.kr/company/portal-contact"), true);
  assert.equal(result.updates.memo.includes("email_kind=published_contact"), true);
});

test("job-site scoring rejects realistic unrelated company-domain emails without target evidence", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.includes("잡코리아")) return [];
      return [
        {
          url: "https://www.jobkorea.co.kr/company/othercorp",
          title: "오더코프 채용 잡코리아",
          snippet: "서울 강남구 담당자 문의 sales@othercorp.co.kr",
          source: "browser-search-fixture",
        },
      ];
    },
    async readPageText() {
      return "오더코프 서울 강남구 채용 담당자 이메일 sales@othercorp.co.kr";
    },
  };
  const provider = new JobSiteDiscoveryProvider({ searchProvider });

  const result = await provider.discover({ companyName: "대한건설", address: "부산광역시 해운대구 우동 1" });

  assert.equal(result.email, "");
  assert.equal(result.rejectedEmails.includes("sales@othercorp.co.kr"), true);
});

test("default enrich provider composition excludes API-backed search providers", () => {
  const provider = new FallbackHomepageSearchProvider();
  const defaultProviders = provider.providers || [];

  assert.equal(defaultProviders.some((item) => item instanceof NaverHomepageSearchProvider), false);
  assert.equal(defaultProviders.some((item) => item instanceof GoogleHomepageSearchProvider), false);
  assert.deepEqual(
    defaultProviders.map((item) => item.name),
    ["playwright-naver", "job-site-discovery"],
  );
  assert.equal(typeof defaultProviders[0].readPageText, "function");
  assert.equal(typeof defaultProviders[1].searchProvider.readPageText, "function");
});

test("default fallback search uses browser and job-site providers without SourceUrl-only short circuit", async () => {
  const calls = [];
  const provider = new FallbackHomepageSearchProvider({
    providers: [
      {
        name: "browser-fixture",
        label: "BrowserFixture",
        enabled: () => true,
        async search({ query }) {
          calls.push(`browser:${query}`);
          return [];
        },
      },
      {
        name: "job-site-fixture",
        label: "JobSiteFixture",
        enabled: () => true,
        async search({ query }) {
          calls.push(`job:${query}`);
          if (query === "대한건설 문의") {
            return [
              {
                url: "https://www.jobkorea.co.kr/company/default-flow",
                title: "대한건설 채용",
                snippet: "부산 해운대구 담당자 default-flow@daehan-build.co.kr",
                source: "job-site-fixture",
              },
            ];
          }
          return [];
        },
        async readPageText(url) {
          calls.push(`browser-read:${url}`);
          return "대한건설 부산광역시 해운대구 담당자 이메일 default-flow@daehan-build.co.kr";
        },
      },
    ],
  });
  const fetchImpl = async (url) => {
    calls.push(`fetch:${url}`);
    return new Response("대한건설 부산광역시 해운대구 담당자 이메일 default-flow@daehan-build.co.kr", { status: 200 });
  };
  const row = [
    "대한건설",
    "건설",
    "",
    "부산",
    "부산광역시 해운대구 우동 1",
    "051-111-2222",
    "",
    "",
    "http://place.map.kakao.com/12345",
    "",
    "",
    "",
    "",
  ];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider: provider, fetchImpl, debug: true });

  assert.equal(result.emailUpdated, true);
  assert.equal(result.updates.email, "default-flow@daehan-build.co.kr");
  assert.equal(calls.some((item) => item === "browser:대한건설 문의"), true);
  assert.equal(calls.some((item) => item === "job:대한건설 문의"), true);
  assert.equal(calls.some((item) => item.startsWith("fetch:https://www.jobkorea.co.kr/company/default-flow")), false);
  assert.equal(calls.some((item) => item.startsWith("browser-read:https://www.jobkorea.co.kr/company/default-flow")), true);
  assert.deepEqual(provider.getUsedLabels().slice(0, 2), ["BrowserFixture", "JobSiteFixture"]);
  assert.equal(result.debug.selectedEmailSourceReason.includes("잡코리아"), true);
});

test("enrich records homepage missing memo when every provider fails", async () => {
  const homepageProvider = new FallbackHomepageSearchProvider({
    providers: [
      {
        name: "google",
        label: "Google",
        enabled: () => true,
        async search() {
          return [];
        },
      },
      {
        name: "playwright",
        label: "Playwright",
        enabled: () => true,
        async search() {
          throw new Error("browser unavailable");
        },
      },
    ],
  });
  const row = ["No Home Co", "flower", "", "Seoul", "", "02-111-2222", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider });

  assert.equal(result.homepageUpdated, false);
  assert.equal(result.emailUpdated, false);
  assert.equal(result.failureReason.includes("홈페이지 없음"), true);
  assert.equal(result.updates.memo.includes("enrich: 홈페이지/이메일 미확보"), true);
  assert.equal(result.updates.memo.includes("browser unavailable"), false);
});

test("builds expanded homepage search queries", () => {
  assert.deepEqual(buildHomepageQueries({ companyName: "Acme 병원", region: "부산", address: "부산광역시 해운대구 우동 1" }), [
    "Acme 병원 부산광역시 해운대구 우동",
    "Acme 병원 부산",
    "Acme 병원 공식 홈페이지",
    "Acme 병원 고객센터",
    "Acme 병원 문의",
    "Acme 병원 이메일",
  ]);
});

test("runEnrich processes queued rows and persists SYSTEM progress", async () => {
  const batches = [];
  const logs = [];
  const states = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-1" };
    },
    async readSystemState(spreadsheetId) {
      assert.equal(spreadsheetId, "sheet-1");
      return {
        enrich_current_row: "5",
        enrich_total_runs: "2",
        enrich_total_processed: "10",
        enrich_homepage_found: "3",
        enrich_email_found: "4",
      };
    },
    async readQueuedEnrichmentRows(spreadsheetId, { startRow, limit }) {
      assert.equal(spreadsheetId, "sheet-1");
      assert.equal(startRow, 5);
      assert.equal(limit, 1);
      return {
        candidates: [
          { rowNumber: 5, row: ["Acme Flower", "flower", "", "Seoul", "", "", "", "", "", "", "", "", ""] },
        ],
        nextRow: 6,
        scanned: 1,
        skipped: 0,
        totalDataRows: 10,
      };
    },
    async updateEnrichRow() {
      throw new Error("row-level update should not be called during enrich");
    },
    async batchUpdateEnrichRows(spreadsheetId, rowUpdates) {
      batches.push({ spreadsheetId, rowUpdates });
      return { updated: rowUpdates.length, batchUpdate: rowUpdates.length > 0 ? 1 : 0 };
    },
    async writeSystemState(spreadsheetId, updates, memo, existingState) {
      states.push({ spreadsheetId, updates, memo, existingState });
      return { updated: Object.keys(updates).length, updates: 1 };
    },
    async appendEnrichLog(spreadsheetId, summary) {
      logs.push({ spreadsheetId, summary });
      return { written: 1, appendCalls: 1 };
    },
  };
  const homepageProvider = {
    async search() {
      return [{ url: "https://acme-flower.co.kr/", title: "Acme Flower", snippet: "official", source: "naver-web" }];
    },
  };
  const fetchImpl = async () => new Response("contact@acme-flower.co.kr", { status: 200 });

  const summary = await runEnrich({ limit: 1, sheets, homepageProvider, fetchImpl });

  assert.equal(summary.processed, 1);
  assert.equal(summary.homepageFound, 1);
  assert.equal(summary.emailFound, 1);
  assert.equal(summary.startRow, 5);
  assert.equal(summary.nextRow, 6);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].rowUpdates.length, 1);
  assert.equal(states.length, 1);
  assert.deepEqual(states[0].updates, {
    enrich_current_row: "6",
    enrich_total_runs: "3",
    enrich_total_processed: "11",
    enrich_homepage_found: "4",
    enrich_email_found: "5",
    enrich_last_run_at: states[0].updates.enrich_last_run_at,
  });
  assert.equal(logs.length, 1);
  assert.deepEqual(summary.sheetsApi, { batchUpdate: 1, append: 1, update: 1, total: 3 });
});

test("Google Sheets 429 retry delays use the requested exponential backoff", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((attempt) => googleRetryDelayMs(attempt)),
    [5000, 10000, 20000, 40000, 40000, null],
  );
});

// ---------------------------------------------------------------------------
// PR-A — Fast Path, Early Stop, in-row dedupe, and per-row budgets
// ---------------------------------------------------------------------------

test("PR-A fast path: existing homepage email is extracted without any web or job-site search", async () => {
  let searchCalls = 0;
  const homepageProvider = {
    async findOfficial() {
      searchCalls += 1;
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      searchCalls += 1;
      return [];
    },
  };
  const pages = new Map([["https://acme-flower.co.kr/", '<html><a href="/contact">문의</a> info@acme-flower.co.kr</html>']]);
  const fetchImpl = async (url) => new Response(pages.get(url) ?? "", { status: pages.has(url) ? 200 : 404 });
  // Column G (homepage) present, column H (email) blank.
  const row = ["Acme Flower", "flower", "", "Seoul", "", "02-111-2222", "https://acme-flower.co.kr/", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, debug: true });

  assert.equal(result.emailUpdated, true);
  assert.equal(result.updates.email, "info@acme-flower.co.kr");
  assert.equal(result.updates.homepage, undefined);
  assert.equal(result.debug.fastPathUsed, true);
  assert.equal(searchCalls, 0);
});

test("PR-A fast path falls back to public-web discovery when the existing homepage has no email", async () => {
  const searched = [];
  const homepageProvider = {
    async search({ query }) {
      searched.push(query);
      if (query === "Acme Flower 문의") {
        return [
          {
            url: "https://public.example.com/acme",
            title: "Acme Flower 문의",
            snippet: "서울 강남구 담당자 contact@acme-flower.co.kr",
            source: "browser-fixture",
          },
        ];
      }
      return [];
    },
  };
  const fetchImpl = async (url) =>
    new Response(String(url).includes("acme-flower.co.kr") ? "<html>대표번호 02-111-2222</html>" : "", { status: 200 });
  const row = ["Acme Flower", "flower", "", "Seoul", "서울특별시 강남구 역삼동 1", "02-111-2222", "https://acme-flower.co.kr/", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl });

  assert.equal(result.emailUpdated, true);
  assert.equal(result.updates.email, "contact@acme-flower.co.kr");
  assert.equal(searched.includes("Acme Flower 문의"), true);
});

// Blocker 2 — the first *acceptable* email must not suppress a later, higher-confidence one.
// The first job-site page yields an off-domain address; a later query yields the company's own
// official-domain address. The official-domain candidate must win.
test("PR-A JobSite ranking: an official-domain email outranks an earlier off-domain email", async () => {
  const queries = [];
  const searchProvider = {
    // The first affordable query surfaces only an off-domain (agency) address; the second
    // surfaces the company's own official-domain address.
    async search({ query }) {
      queries.push(query);
      if (queries.length === 1) {
        return [{ url: "https://www.jobkorea.co.kr/company/hanbit-a", title: "한빛제조 채용", snippet: "창원 성산구", source: "mock" }];
      }
      if (queries.length === 2) {
        return [{ url: "https://www.saramin.co.kr/company/hanbit-b", title: "한빛제조 채용", snippet: "창원 성산구", source: "mock" }];
      }
      return [];
    },
    async readPageText(url) {
      // Off-domain (agency) address discovered first.
      if (url.includes("hanbit-a")) return "한빛제조 창원 성산구 채용 문의 recruit@agency-partner.co.kr";
      // The company's own domain, discovered on a later affordable query.
      if (url.includes("hanbit-b")) return "한빛제조 창원 성산구 대표메일 info@hanbit.co.kr 홈페이지 https://hanbit.co.kr";
      return "";
    },
  };
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl: async () => new Response("", { status: 200 }) });

  const result = await provider.discover(
    { companyName: "한빛제조", region: "창원", address: "창원시 성산구 중앙동 1" },
    { homepage: "https://hanbit.co.kr" },
  );

  // The later official-domain candidate wins even though an acceptable email existed first.
  assert.equal(result.email, "info@hanbit.co.kr");
  // Exploration continued past the first email-bearing page.
  assert.equal(queries.length >= 2, true);
});

// Blocker 2 — a low-confidence (off-domain) email is kept as a candidate but never ends the search.
test("PR-A JobSite ranking: a low-confidence email does not early-stop the search", async () => {
  const queries = [];
  const searchProvider = {
    async search({ query }) {
      queries.push(query);
      return [{ url: `https://www.jobkorea.co.kr/company/${queries.length}`, title: "한빛제조", snippet: "창원", source: "mock" }];
    },
    async readPageText() {
      return "한빛제조 창원 성산구 문의 recruit@agency-partner.co.kr";
    },
  };
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl: async () => new Response("", { status: 200 }) });

  await provider.discover({ companyName: "한빛제조", region: "창원", address: "창원시 성산구 중앙동 1" });

  // All job-site terms were tried; the first off-domain hit did not stop the loop.
  assert.equal(queries.length > 1, true);
});

// Blocker 1 — an exhausted homepage-page budget must not suppress job-site fallback.
test("PR-A budget independence: exhausted homepage pages still allow JobSite fallback", async () => {
  const ctx = new RowExplorationContext({ maxHomepagePages: 6, fetchImpl: async () => new Response("", { status: 200 }) });
  ctx.noteHomepagePages(6);
  ctx.markBudget("homepage_pages");

  const queries = [];
  const searchProvider = {
    async search({ query }) {
      queries.push(query);
      return [{ url: "https://www.jobkorea.co.kr/company/hanbit", title: "한빛제조", snippet: "창원", source: "mock" }];
    },
    async readPageText() {
      return "한빛제조 창원 성산구 대표메일 info@hanbit.co.kr";
    },
  };
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl: async () => new Response("", { status: 200 }) });

  const result = await provider.discover({ companyName: "한빛제조", region: "창원", address: "창원시 성산구 중앙동 1" }, { context: ctx });

  // The homepage-page budget is a breadth limit for its own phase only.
  assert.equal(queries.length > 0, true);
  assert.equal(result.email, "info@hanbit.co.kr");
  assert.equal(ctx.budgetsHit.has("homepage_pages"), true);
});

// Blocker 1 — an exhausted result-page budget must not suppress further public-web searching.
test("PR-A budget independence: exhausted result pages still allow public-web discovery", async () => {
  const ctx = new RowExplorationContext({ maxResultPages: 1, fetchImpl: async () => new Response("", { status: 200 }) });
  const searched = [];
  const searchProvider = {
    async search({ query }) {
      searched.push(query);
      // The snippet alone carries the email, so no result-page read is required.
      return [{ url: `https://news.example/${searched.length}`, title: "한빛제조", snippet: "대표메일 info@hanbit.co.kr", source: "mock" }];
    },
    async readPageText() {
      return "";
    },
  };
  ctx.resultPagesUsed = 1;
  ctx.markBudget("result_pages");

  const result = await discoverEmail(
    { companyName: "한빛제조", region: "창원", address: "창원시 성산구 중앙동 1" },
    { homepage: "https://hanbit.co.kr", searchProvider, fetchImpl: async () => new Response("", { status: 200 }), context: ctx },
  );

  assert.equal(searched.length > 0, true);
  assert.equal(result.email, "info@hanbit.co.kr");
});

// Blocker 3 — only time/abort is a global stop; breadth budgets are telemetry, not cancellation.
test("PR-A row cancellation: hardStopped reflects time/abort only, and cleanup is idempotent", () => {
  const ctx = new RowExplorationContext({ maxRuntimeMs: 45000, maxSearchQueries: 1 });

  ctx.markBudget("search_queries");
  assert.equal(ctx.budgetExceeded, true, "breadth budget is recorded as telemetry");
  assert.equal(ctx.hardStopped(), false, "a breadth budget must not stop the whole row");

  ctx.abortRow("time");
  assert.equal(ctx.signal.aborted, true);
  assert.equal(ctx.hardStopped(), true);
  assert.equal(ctx.budgetsHit.has("time"), true);

  // Aborting twice and cleaning up twice must both be safe.
  ctx.abortRow("time");
  ctx.cleanup();
  ctx.cleanup();
  assert.equal(ctx.deadlineTimer, null);
});

// Blocker 3 — the row signal reaches in-flight page reads and cancels them.
test("PR-A row cancellation: an aborted row stops reading further pages", async () => {
  const ctx = new RowExplorationContext({ maxResultPages: 10, fetchImpl: async () => new Response("", { status: 200 }) });
  let reads = 0;
  const searchProvider = {
    async search() {
      return [];
    },
    async readPageText(_url, options = {}) {
      reads += 1;
      assert.equal(Boolean(options.signal), true, "row signal is threaded into page reads");
      return "";
    },
  };

  await ctx.readPage(searchProvider, "https://example.test/a");
  assert.equal(reads, 1);

  ctx.abortRow("time");
  await ctx.readPage(searchProvider, "https://example.test/b");
  assert.equal(reads, 1, "no page read starts after the row is aborted");
});

// Blocker 4 — one unit == one real provider.search(); a budget of 1 must not fan out to B.
test("PR-A search budget: budget 1 launches provider A only and keeps its result", async () => {
  const calls = [];
  const providerA = {
    name: "provider-a",
    label: "A",
    enabled: () => true,
    async search({ query }) {
      calls.push("A");
      return [{ url: "https://a.example/hit", title: query, snippet: "", source: "A" }];
    },
  };
  const providerB = {
    name: "provider-b",
    label: "B",
    enabled: () => true,
    async search() {
      calls.push("B");
      return [{ url: "https://b.example/hit", title: "b", snippet: "", source: "B" }];
    },
  };
  const fallback = new FallbackHomepageSearchProvider({ providers: [providerA, providerB], fetchImpl: async () => new Response("", { status: 200 }) });
  const ctx = new RowExplorationContext({ maxSearchQueries: 1, fetchImpl: async () => new Response("", { status: 200 }) });

  const results = await fallback.search({ query: "한빛제조 이메일", context: ctx });

  assert.deepEqual(calls, ["A"], "provider B must not be launched once capacity is spent");
  assert.equal(results.length, 1, "provider A's result survives");
  assert.equal(ctx.searchQueriesUsed, 1);
  assert.equal(ctx.budgetsHit.has("search_queries"), true);
});

// Blocker 4 — a failed request still consumed its unit (the request was actually issued).
test("PR-A search budget: a failing provider still consumes its unit", async () => {
  const calls = [];
  const providerA = {
    name: "provider-a",
    label: "A",
    enabled: () => true,
    async search() {
      calls.push("A");
      throw new Error("provider A exploded");
    },
  };
  const providerB = {
    name: "provider-b",
    label: "B",
    enabled: () => true,
    async search() {
      calls.push("B");
      return [];
    },
  };
  const fallback = new FallbackHomepageSearchProvider({ providers: [providerA, providerB], fetchImpl: async () => new Response("", { status: 200 }) });
  const ctx = new RowExplorationContext({ maxSearchQueries: 1, fetchImpl: async () => new Response("", { status: 200 }) });

  await fallback.search({ query: "한빛제조 이메일", context: ctx });

  assert.deepEqual(calls, ["A"]);
  assert.equal(ctx.searchQueriesUsed, 1);
});

// Blocker 4 — a deduped (cached) query issues no provider request, so it costs nothing.
test("PR-A search budget: a repeated query is served from cache at zero cost", async () => {
  const ctx = new RowExplorationContext({ maxSearchQueries: 5, fetchImpl: async () => new Response("", { status: 200 }) });
  let runs = 0;
  const runner = async () => {
    runs += 1;
    ctx.reserveSearch();
    return [{ url: "https://a.example/1" }];
  };

  await ctx.cachedSearch("한빛제조 이메일", runner);
  await ctx.cachedSearch("한빛제조 이메일", runner);

  assert.equal(runs, 1, "the second identical query issues no provider request");
  assert.equal(ctx.searchQueriesUsed, 1, "cache replay consumes no budget");
});

// Blocker 6 — a dry run must ask every Sheets read to be read-only, so no folder/spreadsheet/tab/
// header is created or repaired and no SYSTEM/LOG/DB write can happen.
test("PR-A dry-run requests read-only on target lookup, SYSTEM read, and queued-row read", async () => {
  const readOnlyFlags = {};
  const mutations = [];
  const sheets = {
    async getTargetSpreadsheet(options = {}) {
      readOnlyFlags.target = options.readOnly;
      return { spreadsheetId: "sheet-dry-run", readOnly: Boolean(options.readOnly) };
    },
    async readSystemState(_id, options = {}) {
      readOnlyFlags.system = options.readOnly;
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows(_id, options = {}) {
      readOnlyFlags.queued = options.readOnly;
      return { candidates: [], nextRow: 2, scanned: 0, skipped: 0 };
    },
    async batchUpdateEnrichRows() {
      mutations.push("batch");
    },
    async writeSystemState() {
      mutations.push("system");
    },
    async appendEnrichLog() {
      mutations.push("log");
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };

  await runEnrich({ limit: 1, sheets, homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), dryRun: true });

  assert.equal(readOnlyFlags.target, true, "target lookup must be read-only in dry-run");
  assert.equal(readOnlyFlags.system, true, "SYSTEM read must be read-only in dry-run");
  assert.equal(readOnlyFlags.queued, true, "queued-row read must be read-only in dry-run");
  assert.deepEqual(mutations, [], "dry-run performs no Sheets mutation");
});

// A real (non dry) run keeps its existing behaviour: reads are not forced read-only.
test("PR-A non-dry run does not request read-only Sheets access", async () => {
  const readOnlyFlags = {};
  const sheets = {
    async getTargetSpreadsheet(options = {}) {
      readOnlyFlags.target = options.readOnly;
      return { spreadsheetId: "sheet-live" };
    },
    async readSystemState(_id, options = {}) {
      readOnlyFlags.system = options.readOnly;
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows(_id, options = {}) {
      readOnlyFlags.queued = options.readOnly;
      return { candidates: [], nextRow: 2, scanned: 0, skipped: 0 };
    },
    // A non-dry run reaches the write path, so these must return the real gateway shapes.
    async batchUpdateEnrichRows() {
      return { updated: 0, batchUpdate: 0 };
    },
    async writeSystemState() {
      return { updates: 1 };
    },
    async appendEnrichLog() {
      return { appendCalls: 1 };
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };

  await runEnrich({ limit: 1, sheets, homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), dryRun: false });

  assert.equal(readOnlyFlags.target, false);
  assert.equal(readOnlyFlags.system, false);
  assert.equal(readOnlyFlags.queued, false);
});

// Blocker 5 — Enrich activation is manual-only. Static source assertion; no Action is triggered.
test("PR-A enrich workflow is manual-only (workflow_dispatch, no schedule/cron)", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflowUrl = new URL("../.github/workflows/enrich.yml", import.meta.url);
  const source = await readFile(workflowUrl, "utf8");

  assert.equal(source.includes("workflow_dispatch:"), true, "manual dispatch must remain available");
  assert.equal(/^\s*schedule:/m.test(source), false, "no schedule: trigger may remain");
  assert.equal(/^\s*-\s*cron:/m.test(source), false, "no cron entry may remain");
  // The dispatch contract (inputs -> env -> CLI) must survive the removal.
  for (const input of ["limit", "dry_run", "max_row_runtime_ms", "max_search_queries", "max_result_pages", "max_homepage_pages"]) {
    assert.equal(source.includes(`${input}:`), true, `dispatch input ${input} must be preserved`);
  }
});

test("PR-A in-row dedupe: a query shared by the public-web and job-site phases is searched once", async () => {
  const searched = [];
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      searched.push(query);
      return [];
    },
  };
  const fetchImpl = async () => new Response("", { status: 200 });
  // Homepage present so findOfficial (which has its own query set) is skipped; only the two
  // email phases run, exercising cross-phase query dedupe.
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "https://daehan.example/", "", "", "", "", "", ""];

  await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl });

  // "문의" and "채용" appear in both the email and job-site term lists but are searched once each.
  assert.equal(searched.filter((q) => q === "대한건설 문의").length, 1);
  assert.equal(searched.filter((q) => q === "대한건설 채용").length, 1);
});

test("PR-A row time budget stops exploration and records row_budget_exceeded", async () => {
  let searchCalls = 0;
  const homepageProvider = {
    async findOfficial() {
      searchCalls += 1;
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      searchCalls += 1;
      return [];
    },
  };
  const fetchImpl = async () => new Response("", { status: 200 });
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];
  let n = 0;
  const now = () => (n++ === 0 ? 0 : 10_000);

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl, maxRuntimeMs: 1, now, debug: true },
  );

  assert.equal(result.emailUpdated, false);
  assert.equal(result.budgetExceeded, true);
  assert.equal(result.budgetsHit.includes("time"), true);
  assert.equal(result.failureCode, "row_budget_exceeded");
  assert.equal(searchCalls, 0);
});

test("PR-A search-query budget caps the number of searches per row", async () => {
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  const fetchImpl = async () => new Response("", { status: 200 });
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl, maxSearchQueries: 3, debug: true },
  );

  // Public-web discovery has 6 queries; only 3 searches run before the search-query budget trips.
  assert.equal(result.searchQueriesUsed, 3);
  assert.equal(result.budgetsHit.includes("search_queries"), true);
  assert.equal(result.emailUpdated, false);
});

test("PR-A result-page budget caps search-result page reads per row", async () => {
  let reads = 0;
  const homepageProvider = {
    async search({ query }) {
      return [
        { url: `https://a.example/${encodeURIComponent(query)}`, title: "t", snippet: "s", source: "x" },
        { url: `https://b.example/${encodeURIComponent(query)}`, title: "t", snippet: "s", source: "x" },
      ];
    },
    async readPageText() {
      reads += 1;
      return "";
    },
  };
  const fetchImpl = async () => new Response("", { status: 200 });
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl, maxResultPages: 2, maxSearchQueries: 0, debug: true },
  );

  assert.equal(result.resultPagesUsed, 2);
  assert.equal(reads, 2);
  assert.equal(result.budgetsHit.includes("result_pages"), true);
});

test("PR-A budget stop reasons stay 1:1 with budgetHits keys", () => {
  assert.deepEqual(ROW_BUDGET_KEYS, ["time", "search_queries", "result_pages", "homepage_pages"]);
  // Every budget key has exactly one `budget_<key>` stop reason, and no budget stop reason
  // exists without a matching key — the two telemetry fields cannot drift apart.
  const budgetReasons = ROW_STOP_REASONS.filter((reason) => reason.startsWith("budget_"));
  assert.deepEqual(budgetReasons, ROW_BUDGET_KEYS.map((key) => `budget_${key}`));
  assert.deepEqual(budgetReasons, ["budget_time", "budget_search_queries", "budget_result_pages", "budget_homepage_pages"]);
  // Non-budget stop reasons keep their confirmed names.
  assert.deepEqual(
    ROW_STOP_REASONS.filter((reason) => !reason.startsWith("budget_")),
    [
      "already_complete",
      "email_already_present",
      "email_found_fast_path",
      "email_found_public_web",
      "email_found_job_site",
      "email_found_homepage",
      "exhausted",
    ],
  );
});

test("PR-A stop reason attributes the row to the phase that produced the email", async () => {
  const fastPathRow = ["Acme Flower", "flower", "", "Seoul", "", "", "https://acme-flower.co.kr/", "", "", "", "", "", ""];
  const fastPathProvider = {
    async search() {
      throw new Error("fast path must not search");
    },
  };
  const fastPathFetch = async () => new Response("info@acme-flower.co.kr", { status: 200 });

  const fastPath = await enrichCandidate({ rowNumber: 2, row: fastPathRow }, { homepageProvider: fastPathProvider, fetchImpl: fastPathFetch });
  assert.equal(fastPath.stopReason, "email_found_fast_path");
  assert.equal(fastPath.fastPathSucceeded, true);

  const publicWebProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      return [
        {
          url: "https://public.example.com/daehan",
          title: "대한건설 문의",
          snippet: "부산 해운대구 대표메일 contact@daehan-build.co.kr",
          source: "browser-fixture",
        },
      ];
    },
  };
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];
  const publicWeb = await enrichCandidate(
    { rowNumber: 3, row },
    { homepageProvider: publicWebProvider, fetchImpl: async () => new Response("", { status: 200 }) },
  );
  assert.equal(publicWeb.stopReason, "email_found_public_web");
  assert.equal(publicWeb.fastPathAttempted, false);
});

test("PR-A stop reason reports the binding budget when no email is found", async () => {
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  const fetchImpl = async () => new Response("", { status: 200 });
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const searchBound = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, maxSearchQueries: 2 });
  assert.equal(searchBound.stopReason, "budget_search_queries");

  let n = 0;
  const now = () => (n++ === 0 ? 0 : 10_000);
  const timeBound = await enrichCandidate({ rowNumber: 3, row }, { homepageProvider, fetchImpl, maxRuntimeMs: 1, now });
  assert.equal(timeBound.stopReason, "budget_time");

  const exhausted = await enrichCandidate({ rowNumber: 4, row }, { homepageProvider, fetchImpl });
  assert.equal(exhausted.stopReason, "exhausted");
});

test("PR-A runEnrich aggregates stop reasons and per-row budget telemetry", async () => {
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-telemetry" };
    },
    async readSystemState() {
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          // Fast path row: homepage present, email missing.
          { rowNumber: 2, row: ["Acme Flower", "flower", "", "Seoul", "", "", "https://acme-flower.co.kr/", "", "", "", "", "", ""] },
          // No-homepage row that will exhaust discovery without an email.
          { rowNumber: 3, row: ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""] },
        ],
        nextRow: 4,
        scanned: 2,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows(spreadsheetId, rowUpdates) {
      return { updated: rowUpdates.length, batchUpdate: 1 };
    },
    async writeSystemState() {
      return { updates: 1 };
    },
    async appendEnrichLog() {
      return { appendCalls: 1 };
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
    async close() {},
  };
  const fetchImpl = async (url) =>
    new Response(String(url).includes("acme-flower") ? "info@acme-flower.co.kr" : "", { status: 200 });

  const summary = await runEnrich({ limit: 2, sheets, homepageProvider, fetchImpl });

  assert.equal(summary.processed, 2);
  assert.equal(summary.emailFound, 1);
  assert.equal(summary.fastPathAttempted, 1);
  assert.equal(summary.fastPathSucceeded, 1);
  assert.equal(summary.stopReasons.email_found_fast_path, 1);
  // The second row wants 6 public-web + 11 job-site queries (3 shared, so 14 distinct) but the
  // confirmed budget allows 8, so the search-query budget binds and is reported as such.
  // stopReasons uses `budget_<key>` for the matching budgetHits key.
  assert.equal(summary.stopReasons.budget_search_queries, 1);
  assert.equal(summary.budgetHits.search_queries, 1);
  assert.equal(summary.searchQueriesUsed, 8);
  // Confirmed budgets are surfaced for tuning against real runs.
  assert.deepEqual(summary.rowBudgets, {
    maxRuntimeMs: 45000,
    maxSearchQueries: 8,
    maxResultPages: 12,
    maxHomepagePages: 6,
  });
  // The fast-path row spends homepage pages but no search queries.
  assert.equal(summary.homepagePagesUsed > 0, true);
  assert.equal(typeof summary.rowMsAvg, "number");
});

test("PR-A homepage-page budget caps the company homepage crawl", async () => {
  const homepageProvider = {
    async search() {
      return [];
    },
  };
  const fetchImpl = async () => new Response("<html>대표번호 02-000-0000</html>", { status: 200 });
  // Homepage present, email missing → Fast Path crawls the homepage, capped at 2 contact pages.
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "https://daehan.example/", "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl, maxHomepagePages: 2, maxSearchQueries: 0, debug: true },
  );

  assert.equal(result.homepagePagesUsed, 2);
  assert.equal(result.budgetsHit.includes("homepage_pages"), true);
});

// ---------------------------------------------------------------------------
// Remediation matrix — Blocker 3 (Runtime Abort) A~E
// All deterministic: fake providers/fetch and an explicit abort, never a real wait.
// ---------------------------------------------------------------------------

// A. A row cancellation is not a provider fault and must be distinguishable from a real error.
test("PR-A abort A: row cancellation is not counted as a provider failure", async () => {
  const ctx = new RowExplorationContext({ maxSearchQueries: 5, fetchImpl: async () => new Response("", { status: 200 }) });
  const abortingProvider = {
    name: "aborting",
    label: "Aborting",
    enabled: () => true,
    async search({ signal }) {
      assert.equal(Boolean(signal), true, "row signal reaches the provider");
      ctx.abortRow("time");
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    },
  };
  const fallback = new FallbackHomepageSearchProvider({
    providers: [abortingProvider],
    fetchImpl: async () => new Response("", { status: 200 }),
  });

  const results = await fallback.search({ query: "테스트 문의", context: ctx });

  assert.deepEqual(results, [], "an aborted search yields nothing");
  // The cancellation is classified as ours, not as a provider defect.
  const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(isRowAbortError(abortError, ctx.signal), true);
  assert.equal(isRowAbortError(new Error("mock provider exploded"), null), false, "a real provider error stays a failure");
  assert.equal(fallback.disabledProviders.has("aborting"), false, "abort must not disable the provider");
});

// B. Work that resolves after the abort must not be written into the row's result.
test("PR-A abort B: a late provider resolve is ignored after the row aborts", async () => {
  const ctx = new RowExplorationContext({ maxResultPages: 10, fetchImpl: async () => new Response("", { status: 200 }) });
  let lateResolved = false;
  const searchProvider = {
    async search() {
      return [];
    },
    async readPageText() {
      lateResolved = true;
      return "late@late-corp.co.kr";
    },
  };

  ctx.abortRow("time");
  const text = await ctx.readPage(searchProvider, "https://late.test/page");

  assert.equal(text, "", "an aborted row returns no page text");
  assert.equal(lateResolved, false, "the late read never starts");
  assert.equal(ctx.pageTextCache.has("https://late.test/page"), false, "nothing is cached from an aborted read");
  assert.equal(ctx.resultPagesUsed, 0, "an aborted read consumes no result-page budget");
});

// C. Whatever the row proved *before* the deadline must survive the cancellation. findOfficial
// confirms the homepage while the row is still inside its budget; the deadline then passes during
// the homepage crawl, so the email is dropped but the homepage is kept and never blanked.
test("PR-A abort C: an aborted row keeps the homepage it already confirmed", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    // Resolves inside the budget — this homepage is legitimately confirmed.
    async findOfficial() {
      const official = { url: "https://partial-corp.co.kr/", score: 30 };
      return { official, failures: [], candidates: [official], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  let homepageFetches = 0;
  const fetchImpl = async () => {
    homepageFetches += 1;
    clock = 10_000; // the deadline passes while the homepage crawl is in flight
    return new Response("info@partial-corp.co.kr", { status: 200 });
  };
  const row = ["Partial Corp", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, maxRuntimeMs: 1, now });

  assert.equal(result.homepageUpdated, true, "the homepage confirmed before the deadline is kept");
  assert.equal(result.updates.homepage, "https://partial-corp.co.kr/");
  assert.notEqual(result.updates.homepage, "", "a cancelled row must not blank a confirmed value");
  assert.equal(homepageFetches, 1, "the crawl had started before the deadline passed");
  assert.equal(result.emailUpdated, false, "the email arrived too late to be used");
  assert.equal(result.updates.email, undefined);
  assert.equal(result.budgetsHit.includes("time"), true, "the row records the time budget");
});

// D. One row's deadline must not end the run.
test("PR-A abort D: a cancelled row still lets the next row process and advances SYSTEM", async () => {
  const systemWrites = [];
  const batches = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-abort-continues" };
    },
    async readSystemState() {
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          { rowNumber: 2, row: ["Slow Corp", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""] },
          { rowNumber: 3, row: ["Fast Corp", "flower", "", "Seoul", "", "", "https://fast-corp.co.kr/", "", "", "", "", "", ""] },
        ],
        nextRow: 4,
        scanned: 2,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows(_id, rowUpdates) {
      batches.push(rowUpdates);
      return { updated: rowUpdates.length, batchUpdate: 1 };
    },
    async writeSystemState(_id, updates) {
      systemWrites.push(updates);
      return { updates: 1 };
    },
    async appendEnrichLog() {
      return { appendCalls: 1 };
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
    async close() {},
  };
  const fetchImpl = async (url) =>
    new Response(String(url).includes("fast-corp") ? "info@fast-corp.co.kr" : "", { status: 200 });

  // Row 2's cancellation surfaces as an AbortError out of its provider. Row budgets are left
  // disabled so the test is driven purely by the fake provider — no wall-clock timing, no waits.
  // (The time-triggered abort itself is covered deterministically by "abort C" and "abort E".)
  homepageProvider.findOfficial = async (company) => {
    if (company.companyName === "Slow Corp") {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    return { official: null, failures: [], candidates: [], searchEvents: [] };
  };

  const summary = await runEnrich({ limit: 2, sheets, homepageProvider, fetchImpl, maxRowRuntimeMs: 0 });

  assert.equal(summary.processed, 2, "the run does not stop at the cancelled row");
  assert.equal(summary.emailFound, 1, "the second row still resolves");
  assert.notEqual(summary.stopReason, "max_runtime_reached", "a row cancellation is not a run deadline");
  assert.equal(systemWrites[0].enrich_current_row, "4", "SYSTEM advances past both rows");
  assert.equal(batches[0].some((item) => item.rowNumber === 3), true, "the healthy row is still written");
});

// ---------------------------------------------------------------------------
// Remediation matrix — Blocker 4 (actual provider-request budget)
// ---------------------------------------------------------------------------

// A JobSite provider delegates to a real search provider, so its nested request must be charged
// to the same row budget rather than being free.
test("PR-A budget: a nested JobSite search charges the same row budget", async () => {
  let nestedCalls = 0;
  const innerProvider = {
    name: "inner-search",
    label: "Inner",
    enabled: () => true,
    async search() {
      nestedCalls += 1;
      return [{ url: "https://www.jobkorea.co.kr/company/nested", title: "한빛제조 채용", snippet: "창원", source: "Inner" }];
    },
  };
  const jobSite = new JobSiteDiscoveryProvider({
    searchProvider: new FallbackHomepageSearchProvider({
      providers: [innerProvider],
      fetchImpl: async () => new Response("", { status: 200 }),
    }),
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  const ctx = new RowExplorationContext({ maxSearchQueries: 2, fetchImpl: async () => new Response("", { status: 200 }) });

  await jobSite.discover({ companyName: "한빛제조", region: "창원", address: "창원시 성산구 중앙동 1" }, { context: ctx });

  assert.equal(ctx.searchQueriesUsed, 2, "the nested requests consume the row budget");
  assert.equal(nestedCalls, 2, "exactly the budgeted number of real requests are issued");
  assert.equal(ctx.budgetsHit.has("search_queries"), true, "hitting the cap is recorded");
});

// A provider that fails still issued a real request, so it must still cost its unit — and with a
// budget of 1 that failure must not be retried on the next provider.
test("PR-A budget: a failing provider consumes its unit and blocks the fallback provider", async () => {
  const calls = [];
  const failing = {
    name: "provider-a",
    label: "A",
    enabled: () => true,
    async search() {
      calls.push("A");
      throw new Error("mock upstream 500");
    },
  };
  const fallbackProvider = {
    name: "provider-b",
    label: "B",
    enabled: () => true,
    async search() {
      calls.push("B");
      return [{ url: "https://b.example/hit", title: "b", snippet: "", source: "B" }];
    },
  };
  const provider = new FallbackHomepageSearchProvider({
    providers: [failing, fallbackProvider],
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  const ctx = new RowExplorationContext({ maxSearchQueries: 1, fetchImpl: async () => new Response("", { status: 200 }) });

  const results = await provider.search({ query: "대한건설 문의", context: ctx });

  assert.deepEqual(calls, ["A"], "the fallback provider is never launched once the budget is spent");
  assert.equal(ctx.searchQueriesUsed, 1, "the failed request still cost its unit");
  assert.deepEqual(results, [], "a failed provider contributes no results");
});

// Telemetry must be the real invocation count, not the count of logical queries.
test("PR-A budget: search telemetry equals the actual provider invocation count", async () => {
  let actualInvocations = 0;
  const countingProvider = {
    name: "counting",
    label: "Counting",
    enabled: () => true,
    async search() {
      actualInvocations += 1;
      return [];
    },
  };
  const homepageProvider = new FallbackHomepageSearchProvider({
    providers: [countingProvider],
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), maxSearchQueries: 5 },
  );

  assert.equal(result.searchQueriesUsed, 5, "the budget is fully spent");
  assert.equal(
    actualInvocations,
    result.searchQueriesUsed,
    "telemetry matches real provider.search() invocations exactly",
  );
});

// ---------------------------------------------------------------------------
// Remediation matrix — Blocker 2 (JobSite ranking exclusions)
// ---------------------------------------------------------------------------

// Free consumer mail, noreply, and recruiting-platform addresses are never treated as the
// company's contact, so none of them may end the search as a "high confidence" hit.
test("PR-A JobSite ranking: free-mail, noreply and platform addresses never win", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.includes("채용")) return [];
      return [{ url: "https://www.jobkorea.co.kr/company/excluded", title: "제외테스트 채용", snippet: "부산", source: "fixture" }];
    },
    async readPageText() {
      return [
        "제외테스트 부산 해운대구 채용 담당자",
        "recruit@naver.com",
        "noreply@jobkorea.co.kr",
        "help@jobkorea.co.kr",
      ].join(" ");
    },
  };
  const provider = new JobSiteDiscoveryProvider({ searchProvider, fetchImpl: async () => new Response("", { status: 200 }) });

  const result = await provider.discover({ companyName: "제외테스트", region: "부산", address: "부산 해운대구 우동 1" });

  assert.equal(result.email, "", "no excluded address is promoted to the company email");
  assert.notEqual(result.email, "recruit@naver.com", "free consumer mail is not a company contact");
  assert.notEqual(result.email, "noreply@jobkorea.co.kr", "noreply is never a contact");
  assert.notEqual(result.email, "help@jobkorea.co.kr", "the platform's own support address is not the company's");
});

// ---------------------------------------------------------------------------
// Remediation matrix — Blocker 1 (budget independence, remaining case)
// ---------------------------------------------------------------------------

// A spent search budget must not prevent processing results that were already fetched.
test("PR-A budget independence: a spent query budget still processes already-fetched results", async () => {
  let searches = 0;
  const searchProvider = {
    async search({ query }) {
      searches += 1;
      if (!query.endsWith("이메일")) return [];
      return [
        {
          url: "https://public.example.com/daehan",
          title: "대한건설 이메일",
          snippet: "부산 해운대구 대표메일 contact@daehan-build.co.kr",
          source: "fixture",
        },
      ];
    },
  };

  // Budget of exactly 1: the first query issues the only allowed request, and its results must
  // still be scored and selected even though no further query may run.
  const result = await discoverEmail(
    { companyName: "대한건설", region: "부산", address: "부산광역시 해운대구 우동 1" },
    {
      searchProvider,
      fetchImpl: async () => new Response("", { status: 200 }),
      context: new RowExplorationContext({ maxSearchQueries: 1, fetchImpl: async () => new Response("", { status: 200 }) }),
    },
  );

  assert.equal(searches, 1, "only the budgeted request is issued");
  assert.equal(result.email, "contact@daehan-build.co.kr", "results already in hand are still processed");
});

// ---------------------------------------------------------------------------
// Re-review fixes — homepage crawl honours the row signal; nested fan-out is charged
// ---------------------------------------------------------------------------

// The homepage crawl previously only polled the deadline between pages, so an in-flight request
// kept running to its own timeout. It must now receive the row signal and be cancellable.
test("PR-A abort: the homepage crawl receives the row signal and cancels in flight", async () => {
  const controller = new AbortController();
  const seenSignals = [];
  let fetches = 0;
  const fetchImpl = async (_url, options = {}) => {
    fetches += 1;
    seenSignals.push(Boolean(options.signal));
    // The row deadline expires while this first request is still in flight.
    controller.abort();
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  };

  const result = await extractEmailDetails("https://abort-crawl.test/", { fetchImpl, signal: controller.signal });

  assert.equal(fetches, 1, "the crawl stops at the cancelled request instead of trying every contact URL");
  assert.deepEqual(seenSignals, [true], "the request carries an abort signal");
  assert.equal(result.email, "");
  assert.equal(result.error, "row budget exceeded before email found", "cancellation is not reported as a site failure");
});

// An already-cancelled row must not start the crawl at all.
test("PR-A abort: an already-aborted row starts no homepage request", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetches = 0;

  const result = await extractEmailDetails("https://never.test/", {
    fetchImpl: async () => {
      fetches += 1;
      return new Response("info@never.test", { status: 200 });
    },
    signal: controller.signal,
  });

  assert.equal(fetches, 0, "no request is issued for a cancelled row");
  assert.equal(result.pagesVisited, 0);
  assert.equal(result.email, "");
});

// A nested provider that fans out must charge one unit per real request. Previously the outer
// caller reserved a single unit and the fan-out inside ran free, so N requests cost 1.
test("PR-A budget: a nested fan-out charges one unit per real provider request", async () => {
  const calls = [];
  const makeProvider = (name) => ({
    name,
    label: name,
    enabled: () => true,
    async search() {
      calls.push(name);
      return [{ url: `https://www.jobkorea.co.kr/company/${name}`, title: "테스트 채용", snippet: "부산", source: name }];
    },
  });
  const innerFallback = new FallbackHomepageSearchProvider({
    providers: [makeProvider("A"), makeProvider("B")],
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  const jobSite = new JobSiteDiscoveryProvider({
    searchProvider: innerFallback,
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  const ctx = new RowExplorationContext({ maxSearchQueries: 3, fetchImpl: async () => new Response("", { status: 200 }) });

  await jobSite.discover({ companyName: "테스트", region: "부산", address: "부산 해운대구 우동 1" }, { context: ctx });

  assert.equal(calls.length, 3, "exactly the budgeted number of real requests are issued");
  assert.equal(
    ctx.searchQueriesUsed,
    calls.length,
    "budget consumed equals real provider invocations — a fan-out is not free",
  );
  assert.equal(ctx.budgetsHit.has("search_queries"), true);
});

// ---------------------------------------------------------------------------
// Re-review — Playwright signal wiring (fake page/context; no real browser)
// ---------------------------------------------------------------------------

// Builds a fake Playwright browser whose navigation never settles on its own, so the only way a
// call can finish is for the row abort to close the context.
function makeFakePlaywright() {
  const state = { contextsOpened: 0, closes: 0, gotos: 0, evaluated: 0 };
  const makeContext = () => {
    let rejectNav = null;
    const ctx = {
      async newPage() {
        return {
          async goto() {
            state.gotos += 1;
            // Never resolves until the context is closed.
            return new Promise((_resolve, reject) => {
              rejectNav = reject;
            });
          },
          async $$eval() {
            state.evaluated += 1;
            return [];
          },
          async evaluate() {
            state.evaluated += 1;
            return "late text";
          },
        };
      },
      async close() {
        state.closes += 1;
        const error = new Error("Target page, context or browser has been closed");
        rejectNav?.(error);
      },
    };
    return ctx;
  };
  const browser = {
    closed: false,
    async newContext() {
      state.contextsOpened += 1;
      return makeContext();
    },
    async close() {
      browser.closed = true;
    },
  };
  return { browser, state };
}

test("PR-A abort: an aborted row closes the Playwright context and not the browser", async () => {
  const { browser, state } = makeFakePlaywright();
  const provider = new PlaywrightHomepageSearchProvider();
  provider.browserPromise = Promise.resolve(browser);
  const controller = new AbortController();

  const pending = provider.search({ query: "테스트 문의", signal: controller.signal });
  // Let the navigation start, then cancel the row.
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, /closed/, "the in-flight navigation is cancelled, not left hanging");
  assert.equal(state.contextsOpened, 1);
  assert.equal(state.closes, 1, "the row context is closed exactly once");
  assert.equal(browser.closed, false, "the shared browser is never closed by a row abort");
});

test("PR-A abort: an already-aborted row opens no Playwright context", async () => {
  const { browser, state } = makeFakePlaywright();
  const provider = new PlaywrightHomepageSearchProvider();
  provider.browserPromise = Promise.resolve(browser);
  const controller = new AbortController();
  controller.abort();

  assert.deepEqual(await provider.search({ query: "테스트", signal: controller.signal }), []);
  assert.equal(await provider.readPageText("https://x.test/", { signal: controller.signal }), "");
  assert.equal(state.contextsOpened, 0, "no browser context is opened for a cancelled row");
  assert.equal(browser.closed, false);
});

// The Fallback wrapper must hand the row signal to the child provider's page read.
test("PR-A abort: fallback page-read forwards the row signal to the child provider", async () => {
  const seen = [];
  const child = {
    name: "child",
    label: "Child",
    enabled: () => true,
    async search() {
      return [];
    },
    async readPageText(_url, options = {}) {
      seen.push(Boolean(options.signal));
      return "child text";
    },
  };
  const fallback = new FallbackHomepageSearchProvider({ providers: [child], fetchImpl: async () => new Response("", { status: 200 }) });
  const controller = new AbortController();

  const text = await fallback.readPageText("https://child.test/page", { signal: controller.signal });

  assert.equal(text, "child text");
  assert.deepEqual(seen, [true], "the child provider receives the row signal");

  // Once cancelled, the wrapper must not read at all and must not fall through to another provider.
  controller.abort();
  assert.equal(await fallback.readPageText("https://child.test/page", { signal: controller.signal }), "");
  assert.deepEqual(seen, [true], "no further child read is attempted after cancellation");
});

// ---------------------------------------------------------------------------
// Re-review — a cancellation is never reported as a site/provider failure
// ---------------------------------------------------------------------------

test("PR-A abort: a cancelled homepage search is not recorded as a provider failure", async () => {
  const controller = new AbortController();
  const cancelling = {
    name: "cancelling",
    label: "Cancelling",
    enabled: () => true,
    async search() {
      controller.abort();
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    },
  };
  const nextProvider = {
    name: "next",
    label: "Next",
    enabled: () => true,
    async search() {
      throw new Error("must not run after a row cancellation");
    },
  };
  const provider = new FallbackHomepageSearchProvider({
    providers: [cancelling, nextProvider],
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  const ctx = new RowExplorationContext({ maxSearchQueries: 5, fetchImpl: async () => new Response("", { status: 200 }) });
  ctx.controller = controller;
  ctx.signal = controller.signal;

  const result = await provider.findOfficial({ companyName: "취소테스트", region: "부산", address: "부산 해운대구 우동 1" }, { context: ctx });

  assert.equal(result.official, null);
  assert.deepEqual(result.failures, [], "a cancellation contributes no provider failure");
  assert.equal(provider.disabledProviders.has("cancelling"), false, "a cancelled provider is not disabled");
});

// classifyFailureCode must not blame the site for our own cancellation.
test("PR-A abort: a row cancellation is not classified as site_access_failed", async () => {
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  // The clock jumps past the deadline the moment discovery starts, so the row is cancelled
  // without any site actually failing.
  let clock = 0;
  const now = () => clock;
  const fetchImpl = async () => new Response("", { status: 200 });
  const row = ["취소분류", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "https://cancel-class.test/", "", "", "", "", "", ""];
  homepageProvider.search = async () => {
    clock = 10_000;
    return [];
  };

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, maxRuntimeMs: 1, now });

  assert.notEqual(result.failureCode, "site_access_failed", "a cancellation must not be blamed on the site");
  assert.equal(result.failureCode, "row_budget_exceeded");
});

// ---------------------------------------------------------------------------
// Re-review 3 — a task that IGNORES the abort signal must still not corrupt the row.
// Wiring the signal is not enough: every await has to re-check before using its result.
// ---------------------------------------------------------------------------

// Blocker A — Fast Path: a late email that arrives after the row was cancelled is discarded.
test("PR-A abort: a late Fast Path email is discarded after the row is cancelled", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  // This fetch deliberately ignores the signal and resolves *after* the row deadline passes.
  const fetchImpl = async () => {
    clock = 10_000; // row deadline (1ms) is now in the past
    return new Response("info@late-example.test", { status: 200 });
  };
  const row = ["Late Corp", "flower", "", "Seoul", "", "", "https://late-example.test/", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, maxRuntimeMs: 1, now });

  assert.equal(result.updates.email, undefined, "a late email is not written");
  assert.equal(result.emailUpdated, false);
  assert.notEqual(result.stopReason, "email_found_fast_path", "a cancelled row did not 'find' an email");
  assert.equal(result.stopReason, "budget_time");
  assert.notEqual(result.failureCode, "site_access_failed", "cancellation is not the site's fault");
  assert.equal("homepage" in result.updates, false, "the pre-existing homepage is untouched");
});

// Blocker B — extractEmailDetails: a fetch that ignores the signal and resolves late.
test("PR-A abort: extractEmailDetails discards a late fetch that ignored the signal", async () => {
  const controller = new AbortController();
  let textReads = 0;
  const fetchImpl = async () => {
    controller.abort(); // the row is cancelled while this request is in flight
    return {
      ok: true,
      status: 200,
      async text() {
        textReads += 1;
        return "late@ignored-signal.test";
      },
    };
  };

  const result = await extractEmailDetails("https://ignored.test/", { fetchImpl, signal: controller.signal });

  assert.equal(result.email, "", "a late response must not yield an email");
  assert.equal(textReads, 0, "the late response body is not even read");
});

// Blocker B — response.text() itself resolves after the cancellation.
test("PR-A abort: extractEmailDetails discards a late response body", async () => {
  const controller = new AbortController();
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        controller.abort(); // cancelled while the body is being read
        return "late-body@ignored-signal.test";
      },
    };
  };

  const result = await extractEmailDetails("https://late-body.test/", { fetchImpl, signal: controller.signal });

  assert.equal(result.email, "", "an email extracted from a late body is discarded");
  assert.equal(fetches, 1, "no further contact URL is visited after the cancellation");
});

// Blocker C — readPage: a late page text is neither returned nor cached.
test("PR-A abort: readPage discards and does not cache a late page read", async () => {
  const ctx = new RowExplorationContext({ maxResultPages: 10, fetchImpl: async () => new Response("", { status: 200 }) });
  const searchProvider = {
    async search() {
      return [];
    },
    async readPageText() {
      ctx.abortRow("time"); // cancelled while this read is in flight
      return "late@cached-anyway.test";
    },
  };

  const text = await ctx.readPage(searchProvider, "https://late-cache.test/page");

  assert.equal(text, "", "a late page read returns nothing");
  assert.equal(ctx.pageTextCache.has("https://late-cache.test/page"), false, "a late page read is not cached");
});

// Blocker D — abort races against each stage of Playwright context setup.
function makeRacePlaywright({ pendingStage }) {
  const state = { newContext: 0, newPage: 0, goto: 0, contextClose: 0 };
  let releaseContext = null;
  let releasePage = null;
  let releaseGoto = null;
  const context = {
    async newPage() {
      state.newPage += 1;
      if (pendingStage === "newPage") await new Promise((resolve) => (releasePage = resolve));
      return {
        async goto() {
          state.goto += 1;
          if (pendingStage === "goto") await new Promise((resolve) => (releaseGoto = resolve));
        },
        async $$eval() {
          return [];
        },
        async evaluate() {
          return "late text";
        },
      };
    },
    async close() {
      state.contextClose += 1;
    },
  };
  const browser = {
    closed: false,
    async newContext() {
      state.newContext += 1;
      if (pendingStage === "newContext") await new Promise((resolve) => (releaseContext = resolve));
      return context;
    },
    async close() {
      browser.closed = true;
    },
  };
  return {
    browser,
    state,
    release: () => {
      releaseContext?.();
      releasePage?.();
      releaseGoto?.();
    },
  };
}

test("PR-A abort race 1: aborting during newContext closes the late context and starts no page", async () => {
  const { browser, state, release } = makeRacePlaywright({ pendingStage: "newContext" });
  const provider = new PlaywrightHomepageSearchProvider();
  provider.browserPromise = Promise.resolve(browser);
  const controller = new AbortController();

  const pending = provider.search({ query: "레이스", signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  release();
  const results = await pending;

  assert.deepEqual(results, []);
  assert.equal(state.newContext, 1);
  assert.equal(state.contextClose, 1, "the late context is closed exactly once");
  assert.equal(state.newPage, 0, "no page is opened after the cancellation");
  assert.equal(state.goto, 0, "no navigation starts after the cancellation");
  assert.equal(browser.closed, false, "the shared browser is never closed");
});

test("PR-A abort race 2: aborting during newPage starts no navigation", async () => {
  const { browser, state, release } = makeRacePlaywright({ pendingStage: "newPage" });
  const provider = new PlaywrightHomepageSearchProvider();
  provider.browserPromise = Promise.resolve(browser);
  const controller = new AbortController();

  const pending = provider.search({ query: "레이스2", signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  release();
  const results = await pending;

  assert.deepEqual(results, []);
  assert.equal(state.contextClose, 1, "the context is closed exactly once");
  assert.equal(state.goto, 0, "navigation never starts");
  assert.equal(browser.closed, false);
});

test("PR-A abort race 3: aborting during goto discards the late navigation result", async () => {
  const { browser, state, release } = makeRacePlaywright({ pendingStage: "goto" });
  const provider = new PlaywrightHomepageSearchProvider();
  provider.browserPromise = Promise.resolve(browser);
  const controller = new AbortController();

  const pending = provider.readPageText("https://race3.test/", { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  release();
  const text = await pending;

  assert.equal(text, "", "the late navigation result is discarded");
  assert.equal(state.contextClose, 1, "the context is closed exactly once");
  assert.equal(browser.closed, false);
});

// Blocker E — SourceUrl provider must receive the signal and drop a late result.
test("PR-A abort: SourceUrl receives the row signal and drops a late result", async () => {
  const provider = new SourceUrlHomepageProvider();
  const controller = new AbortController();
  const seenSignals = [];
  const fetchImpl = async (_url, options = {}) => {
    seenSignals.push(Boolean(options.signal));
    controller.abort(); // cancelled while the source page is being fetched
    return new Response('<a href="https://late-source.test/">공식 홈페이지</a>', { status: 200 });
  };

  const results = await provider.search({
    sourceUrl: "https://source.test/company",
    fetchImpl,
    signal: controller.signal,
  });

  assert.deepEqual(seenSignals, [true], "the source fetch carries the row signal");
  assert.deepEqual(results, [], "a late source result yields no homepage candidate");
});

// ---------------------------------------------------------------------------
// Re-review 4 — the LOGICAL deadline, not just an explicit abort, must block a late commit.
// A provider that ignores the signal can resolve after the row deadline while signal.aborted is
// still false; the result must not reach `updates` (runEnrich would write it to Sheets).
// Deterministic: an injected clock the fake provider moves past the deadline mid-await.
// ---------------------------------------------------------------------------

// Test A — a public-web email that resolves after the deadline is not committed.
test("PR-A deadline: a late public-web email is not written to the row", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      clock = 2; // the row deadline (1ms) passes while this search is in flight
      return [
        {
          url: "https://public.example.com/daehan",
          title: "대한건설 문의",
          snippet: "부산 해운대구 대표메일 contact@daehan-build.co.kr",
          source: "browser-fixture",
        },
      ];
    },
  };
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), maxRuntimeMs: 1, now, debug: true },
  );

  assert.equal(result.updates.email, undefined, "a late email must never reach updates");
  assert.equal(result.emailUpdated, false);
  assert.notEqual(result.stopReason, "email_found_public_web");
  assert.equal(result.stopReason, "budget_time");
  assert.notEqual(result.failureCode, "site_access_failed");
  assert.equal(result.debug.selectedEmail, "", "no late email is recorded as the selection");
  assert.equal((result.updates.memo || "").includes("email_source"), false, "no late source memo is written");
});

// Test B — a job-site homepage that resolves after the deadline is not committed.
test("PR-A deadline: a late JobSite homepage is not written to the row", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.includes("잡코리아")) return [];
      clock = 2; // deadline passes during the job-site search
      return [{ url: "https://www.jobkorea.co.kr/company/late", title: "Acme Flower 채용 잡코리아", snippet: "서울 강남구 역삼동", source: "fixture" }];
    },
    async readPageText() {
      return '<a href="https://www.acme-flower.co.kr">회사 홈페이지</a> 서울 강남구 역삼동';
    },
  };
  const row = ["Acme Flower", "flower", "", "서울", "서울특별시 강남구 역삼동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), maxRuntimeMs: 1, now },
  );

  assert.equal(result.updates.homepage, undefined, "a late homepage must never reach updates");
  assert.equal(result.homepageUpdated, false);
  assert.equal(result.stopReason, "budget_time");
});

// Test C — a job-site email that resolves after the deadline is not committed.
test("PR-A deadline: a late JobSite email is not written to the row", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.includes("잡코리아")) return [];
      clock = 2;
      return [{ url: "https://www.jobkorea.co.kr/company/late-mail", title: "대한건설 채용 잡코리아", snippet: "부산 해운대구", source: "fixture" }];
    },
    async readPageText() {
      return "대한건설 부산 해운대구 채용 담당자 이메일 contact@daehan-build.co.kr";
    },
  };
  const row = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), maxRuntimeMs: 1, now, debug: true },
  );

  assert.equal(result.updates.email, undefined, "a late job-site email must never reach updates");
  assert.equal(result.emailUpdated, false);
  assert.notEqual(result.stopReason, "email_found_job_site");
  assert.equal(result.stopReason, "budget_time");
  assert.equal((result.updates.memo || "").includes("email_source"), false);
});

// Test D — an official homepage that resolves after the deadline is not committed.
test("PR-A deadline: a late official homepage is not written to the row", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      clock = 2; // deadline passes while the homepage search is in flight
      const official = { url: "https://late-official.co.kr/", score: 40 };
      return { official, failures: [], candidates: [official], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  const row = ["레이트공식", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), maxRuntimeMs: 1, now, debug: true },
  );

  assert.equal(result.updates.homepage, undefined, "a late official homepage must never reach updates");
  assert.equal(result.homepageUpdated, false);
  assert.equal(result.debug.selectedHomepage, "", "no late homepage is recorded as the selection");
  assert.equal(result.stopReason, "budget_time");
});

// Test E — everything confirmed before the deadline survives; only the late value is dropped.
test("PR-A deadline: a pre-deadline homepage is kept while the late email is dropped", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    // The job-site phase confirms a homepage while the row is still inside its budget.
    async search({ query }) {
      if (!query.includes("잡코리아")) return [];
      return [{ url: "https://www.jobkorea.co.kr/company/partial", title: "Acme Flower 채용 잡코리아", snippet: "서울 강남구 역삼동", source: "fixture" }];
    },
    async readPageText() {
      return '<a href="https://www.acme-flower.co.kr">회사 홈페이지</a> 서울 강남구 역삼동';
    },
  };
  // The homepage crawl then runs past the deadline and returns an email too late to use.
  const fetchImpl = async () => {
    clock = 2;
    return new Response("info@acme-flower.co.kr", { status: 200 });
  };
  const row = ["Acme Flower", "flower", "", "서울", "서울특별시 강남구 역삼동 1", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, maxRuntimeMs: 1, now });

  assert.equal(result.homepageUpdated, true, "the homepage confirmed before the deadline is kept");
  assert.equal(result.updates.homepage, "https://www.acme-flower.co.kr/");
  assert.equal(result.emailUpdated, false, "the late email is dropped");
  assert.equal(result.updates.email, undefined);
  assert.equal(result.stopReason, "budget_time");
});

// Test F — cachedSearch must not cache or return a result that arrives past the deadline.
test("PR-A deadline: cachedSearch discards a result that arrives past the deadline", async () => {
  let clock = 0;
  const ctx = new RowExplorationContext({
    maxRuntimeMs: 1,
    maxSearchQueries: 5,
    fetchImpl: async () => new Response("", { status: 200 }),
    now: () => clock,
  });

  const results = await ctx.cachedSearch("late query", async () => {
    clock = 2; // deadline passes while the provider is running
    return [{ url: "https://late.test/hit", title: "late", snippet: "", source: "fixture" }];
  });

  assert.deepEqual(results, [], "a late provider result is not handed back as usable");
  assert.equal(ctx.searchResultCache.has("late query"), false, "a late provider result is not cached");
});

// Test G — a Playwright evaluate that resolves after the abort is discarded (coverage gap).
test("PR-A abort: a late Playwright evaluate result is discarded and the context closes once", async () => {
  const state = { contextClose: 0, evaluate: 0 };
  let releaseEvaluate = null;
  const context = {
    async newPage() {
      return {
        async goto() {},
        async $$eval() {
          return [];
        },
        async evaluate() {
          state.evaluate += 1;
          await new Promise((resolve) => (releaseEvaluate = resolve));
          return "late evaluate text";
        },
      };
    },
    async close() {
      state.contextClose += 1;
    },
  };
  const browser = {
    closed: false,
    async newContext() {
      return context;
    },
    async close() {
      browser.closed = true;
    },
  };
  const provider = new PlaywrightHomepageSearchProvider();
  provider.browserPromise = Promise.resolve(browser);
  const controller = new AbortController();

  const pending = provider.readPageText("https://late-eval.test/", { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  releaseEvaluate?.();
  const text = await pending;

  assert.equal(text, "", "the late evaluate result is discarded");
  assert.equal(state.evaluate, 1);
  assert.equal(state.contextClose, 1, "the context is closed exactly once");
  assert.equal(browser.closed, false, "the shared browser is never closed");
});

// ---------------------------------------------------------------------------
// Re-review 5 — a phase whose await returns after the row stopped contributes NOTHING:
// not just updates, but memo, debug, candidates, search events and telemetry.
// State confirmed by an earlier phase that finished inside the budget is preserved.
// ---------------------------------------------------------------------------

const LATE_ROW = ["대한건설", "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];

// Test A — public-web rejected emails collected before the deadline are not committed after it.
test("PR-A late-state: public-web rejected emails are not committed after the deadline", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (query.endsWith("이메일")) {
        // First query completes inside the budget and yields an unrelated (rejected) address.
        return [{ url: "https://other.example.com/x", title: "오더코프 이메일", snippet: "서울 담당자 sales@othercorp.co.kr", source: "fixture" }];
      }
      clock = 2; // a later query pushes the row past its deadline
      return [];
    },
  };

  const result = await enrichCandidate(
    { rowNumber: 2, row: LATE_ROW },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), maxRuntimeMs: 1, now, debug: true },
  );

  assert.equal(result.updates.email, undefined);
  assert.deepEqual(result.debug.rejectedEmails, [], "no rejected email is recorded after the deadline");
  assert.deepEqual(result.debug.foundEmails, [], "no found email is recorded after the deadline");
  assert.equal(result.stopReason, "budget_time");
});

// Test B/C — job-site source debug and personal-email memo are not committed after the deadline.
test("PR-A late-state: job-site source debug and personal-email memo are dropped after the deadline", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (query.includes("채용") && !query.includes("이메일")) {
        return [{ url: "https://www.jobkorea.co.kr/company/late-state", title: "대한건설 채용", snippet: "부산 해운대구", source: "fixture" }];
      }
      if (query.includes("잡코리아")) {
        clock = 2; // the row passes its deadline on a later job-site query
        return [];
      }
      return [];
    },
    async readPageText() {
      return "대한건설 부산 해운대구 채용 담당자 recruit@naver.com";
    },
  };

  const result = await enrichCandidate(
    { rowNumber: 2, row: LATE_ROW },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), maxRuntimeMs: 1, now, debug: true },
  );

  assert.equal(result.debug.jobSiteSource, "", "no job-site source is recorded after the deadline");
  assert.deepEqual(result.debug.sourceVisits, [], "no source visit is recorded after the deadline");
  assert.deepEqual(result.debug.foundEmails, [], "no personal email is recorded after the deadline");
  assert.equal((result.updates.memo || "").includes("jobsite_personal_email"), false, "no personal-email memo after the deadline");
  assert.equal(result.updates.email, undefined);
  assert.equal(result.stopReason, "budget_time");
});

// Test D/E — official/fallback candidates and search events are not committed after the deadline.
test("PR-A late-state: official candidateUrls and search events are dropped after the deadline", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      // The provider succeeded, but only after the row deadline passed.
      clock = 2;
      return {
        official: null,
        failures: [],
        candidates: [{ url: "https://late-candidate.co.kr/", title: "t", snippet: "s", source: "fixture" }],
        searchEvents: [{ provider: "Fixture", query: "q", candidateUrls: ["https://late-candidate.co.kr/"], ok: true, error: "" }],
      };
    },
    async search() {
      return [];
    },
  };

  const result = await enrichCandidate(
    { rowNumber: 2, row: LATE_ROW },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), maxRuntimeMs: 1, now, debug: true },
  );

  assert.deepEqual(result.debug.candidateUrls, [], "no late candidate URL is recorded");
  assert.deepEqual(result.debug.searchEvents, [], "no late search event (including ok:true) is recorded");
  assert.equal(result.debug.selectedHomepage, "");
  assert.equal(result.updates.homepage, undefined);
  assert.equal(result.stopReason, "budget_time");
});

// Test D (provider level) — findOfficial must not record a child result that lands after the deadline.
test("PR-A late-state: findOfficial drops a child provider result that lands after the deadline", async () => {
  let clock = 0;
  const ctx = new RowExplorationContext({
    maxRuntimeMs: 1,
    maxSearchQueries: 10,
    fetchImpl: async () => new Response("", { status: 200 }),
    now: () => clock,
  });
  const child = {
    name: "late-child",
    label: "LateChild",
    enabled: () => true,
    async search() {
      clock = 2; // resolves past the deadline, but with a perfectly valid-looking result
      return [{ url: "https://late-child.co.kr/", title: "대한건설 공식", snippet: "부산 해운대구", source: "LateChild" }];
    },
  };
  const provider = new FallbackHomepageSearchProvider({ providers: [child], fetchImpl: async () => new Response("", { status: 200 }) });

  const result = await provider.findOfficial(
    { companyName: "대한건설", region: "부산", address: "부산광역시 해운대구 우동 1" },
    { context: ctx },
  );

  assert.equal(result.official, null, "a late child result never becomes the official homepage");
  assert.deepEqual(result.candidates, [], "a late child result is not accumulated as a candidate");
  assert.deepEqual(result.searchEvents, [], "no late ok:true search event is recorded");
  assert.deepEqual(result.failures, [], "a deadline is not a provider failure");
});

// Test F — SourceUrl must honour the logical deadline, not just an explicit abort.
test("PR-A late-state: SourceUrl drops a candidate that arrives past the logical deadline", async () => {
  let clock = 0;
  const ctx = new RowExplorationContext({
    maxRuntimeMs: 1,
    fetchImpl: async () => new Response("", { status: 200 }),
    now: () => clock,
  });
  const provider = new SourceUrlHomepageProvider();
  const fetchImpl = async () => {
    clock = 2; // deadline passes while the source page is being fetched; signal never fires
    return new Response('<a href="https://late-source.co.kr/">공식 홈페이지</a>', { status: 200 });
  };

  const results = await provider.search({ sourceUrl: "https://source.test/company", fetchImpl, context: ctx });

  assert.equal(ctx.signal.aborted, false, "the explicit signal never fired — only the logical deadline passed");
  assert.deepEqual(results, [], "a late source result yields no candidate");
});

// Test G — no new memo may be appended once the row has stopped.
test("PR-A late-state: no generic failure memo is appended after the deadline", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      clock = 2;
      return [];
    },
  };

  const result = await enrichCandidate(
    { rowNumber: 2, row: LATE_ROW },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), maxRuntimeMs: 1, now },
  );

  assert.equal(result.updates.memo, undefined, "a stopped row appends no closing memo");
  assert.equal(result.stopReason, "budget_time");
});

// Test H — state confirmed by a phase that finished inside the budget is preserved.
test("PR-A late-state: pre-deadline homepage and debug survive a later deadline", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    // Completes inside the budget: this homepage and its debug are legitimate.
    async findOfficial() {
      const official = { url: "https://confirmed-corp.co.kr/", score: 40 };
      return {
        official,
        failures: [],
        candidates: [official],
        searchEvents: [{ provider: "Fixture", query: "q", candidateUrls: [official.url], ok: true, error: "" }],
      };
    },
    async search() {
      return [];
    },
  };
  // The homepage crawl then runs past the deadline.
  const fetchImpl = async () => {
    clock = 2;
    return new Response("info@confirmed-corp.co.kr", { status: 200 });
  };

  const result = await enrichCandidate(
    { rowNumber: 2, row: LATE_ROW },
    { homepageProvider, fetchImpl, maxRuntimeMs: 1, now, debug: true },
  );

  assert.equal(result.homepageUpdated, true, "the pre-deadline homepage is kept");
  assert.equal(result.updates.homepage, "https://confirmed-corp.co.kr/");
  assert.equal(result.debug.selectedHomepage, "https://confirmed-corp.co.kr/", "pre-deadline debug is kept");
  assert.deepEqual(result.debug.candidateUrls, ["https://confirmed-corp.co.kr/"], "pre-deadline candidates are kept");
  assert.equal(result.debug.searchEvents.length, 1, "pre-deadline search events are kept");
  assert.equal(result.emailUpdated, false, "the late email is dropped");
  assert.equal(result.stopReason, "budget_time");
});

// Test I — the row-finished payload that reaches the logger carries no late state.
test("PR-A late-state: the row-finished log payload carries no late state", async () => {
  const events = [];
  const logger = { info: (message, data) => events.push({ message, data }) };
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-late-payload" };
    },
    async readSystemState() {
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows() {
      return { candidates: [{ rowNumber: 2, row: LATE_ROW }], nextRow: 3, scanned: 1, skipped: 0 };
    },
    async batchUpdateEnrichRows() {
      throw new Error("dry-run must not write");
    },
    async writeSystemState() {
      throw new Error("dry-run must not write");
    },
    async appendEnrichLog() {
      throw new Error("dry-run must not write");
    },
  };
  // Injected clock: the row starts inside its budget and the first provider call pushes it past
  // the deadline, so "late" is deterministic instead of depending on wall-clock timing.
  let clock = 0;
  const homepageProvider = {
    async findOfficial() {
      return {
        official: null,
        failures: [],
        candidates: [{ url: "https://late-payload.co.kr/", title: "t", snippet: "s", source: "fixture" }],
        searchEvents: [{ provider: "Fixture", query: "q", candidateUrls: ["https://late-payload.co.kr/"], ok: true, error: "" }],
      };
    },
    async search({ query }) {
      if (query.endsWith("이메일")) {
        return [{ url: "https://other.example.com/y", title: "오더코프", snippet: "서울 sales@othercorp.co.kr", source: "fixture" }];
      }
      clock = 5; // a later query pushes the row past its deadline
      return [];
    },
    async close() {},
  };

  const summary = await runEnrich({
    limit: 1,
    sheets,
    homepageProvider,
    fetchImpl: async () => new Response("", { status: 200 }),
    logger,
    debug: true,
    dryRun: true,
    maxRowRuntimeMs: 1,
    now: () => clock,
  });

  const rowFinished = events.find((event) => event.message === "enrich_row_finished");
  assert.notEqual(rowFinished, undefined, "the row still reports that it finished");
  const payload = JSON.stringify(rowFinished.data);
  assert.equal(payload.includes("sales@othercorp.co.kr"), false, "no late rejected email in the row payload");
  assert.equal(payload.includes("late-payload.co.kr"), false, "no late candidate URL in the row payload");
  assert.deepEqual(summary.sheetsApi, { batchUpdate: 0, append: 0, update: 0, total: 0 }, "dry-run writes nothing");
});

// ---------------------------------------------------------------------------
// Re-review 6 — row-owned state must never alias provider-owned arrays/objects, and a stopped
// row must not append any memo (contact memo included).
// ---------------------------------------------------------------------------

// Regression A + E — a provider that mutates its own arrays/objects after returning must not be
// able to change what the row recorded (array identity AND nested object contents).
test("PR-A immutability: late provider mutation cannot change recorded search events", async () => {
  const event = { provider: "Fixture", query: "q1", candidateUrls: ["https://one.test/"], ok: true, error: "" };
  const providerEvents = [event];
  const providerCandidates = [{ url: "https://one.test/", title: "t", snippet: "s", source: "fixture" }];
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: providerCandidates, searchEvents: providerEvents };
    },
    async search() {
      return [];
    },
  };

  const result = await enrichCandidate(
    { rowNumber: 2, row: LATE_ROW },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), debug: true },
  );

  const recordedEvents = result.debug.searchEvents;
  const recordedUrls = result.debug.candidateUrls;
  assert.equal(recordedEvents.length, 1);
  assert.notEqual(recordedEvents, providerEvents, "row state must not alias the provider array");

  // The provider keeps working on its own arrays after handing back the result.
  providerEvents.push({ provider: "Fixture", query: "q2", candidateUrls: ["https://two.test/"], ok: true, error: "" });
  event.ok = false;
  event.query = "mutated";
  event.candidateUrls.push("https://mutated.test/");
  providerCandidates.push({ url: "https://three.test/", title: "t", snippet: "s", source: "fixture" });

  assert.equal(recordedEvents.length, 1, "a late push must not grow the recorded events");
  assert.equal(recordedEvents[0].ok, true, "a late field mutation must not change the recorded event");
  assert.equal(recordedEvents[0].query, "q1");
  assert.deepEqual(recordedEvents[0].candidateUrls, ["https://one.test/"], "nested arrays are copied too");
  assert.deepEqual(recordedUrls, ["https://one.test/"], "recorded candidate URLs are unaffected");
});

// Regression D — the homepage-crawl arrays are copied as well.
test("PR-A immutability: late mutation of crawl arrays cannot change recorded visits", async () => {
  const visitedUrls = ["https://visited.test/"];
  const visited = [{ url: "https://visited.test/", ok: true, status: 200, error: "" }];
  const row = ["Visit Corp", "flower", "", "Seoul", "", "", "https://visit-corp.test/", "", "", "", "", "", ""];
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  // Stub the extractor's shape by returning HTML with no email so the crawl finishes normally.
  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl: async () => new Response("<html>no mail here</html>", { status: 200 }), debug: true },
  );

  const recordedPages = result.debug.visitedPages;
  const recordedResults = result.debug.visitResults;
  assert.equal(Array.isArray(recordedPages), true);
  assert.equal(Array.isArray(recordedResults), true);
  // Mutating our local fixtures must never be observable; more importantly the recorded arrays
  // must be the row's own copies, so mutating them cannot corrupt anything upstream either.
  const pagesBefore = recordedPages.length;
  const resultsBefore = recordedResults.length;
  visitedUrls.push("https://late.test/");
  visited.push({ url: "https://late.test/", ok: true, status: 200, error: "" });
  assert.equal(recordedPages.length, pagesBefore);
  assert.equal(recordedResults.length, resultsBefore);
  if (recordedResults.length > 0) {
    assert.equal(typeof recordedResults[0], "object", "visit results are plain copied objects");
  }
});

// Regression C — the logger payload must carry the row's copies, immune to later mutation.
test("PR-A immutability: the row-finished logger payload is immune to late provider mutation", async () => {
  const events = [];
  const logger = { info: (message, data) => events.push({ message, data }) };
  const event = { provider: "Fixture", query: "q1", candidateUrls: ["https://one.test/"], ok: true, error: "" };
  const providerEvents = [event];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-immutable" };
    },
    async readSystemState() {
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows() {
      return { candidates: [{ rowNumber: 2, row: LATE_ROW }], nextRow: 3, scanned: 1, skipped: 0 };
    },
    async batchUpdateEnrichRows() {
      throw new Error("dry-run must not write");
    },
    async writeSystemState() {
      throw new Error("dry-run must not write");
    },
    async appendEnrichLog() {
      throw new Error("dry-run must not write");
    },
  };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: providerEvents };
    },
    async search() {
      return [];
    },
    async close() {},
  };

  await runEnrich({
    limit: 1,
    sheets,
    homepageProvider,
    fetchImpl: async () => new Response("", { status: 200 }),
    logger,
    debug: true,
    dryRun: true,
  });

  const rowFinished = events.find((e) => e.message === "enrich_row_finished");
  assert.notEqual(rowFinished, undefined);
  const loggedEvents = rowFinished.data.debug.searchEvents;
  assert.equal(loggedEvents.length, 1);

  providerEvents.push({ provider: "Fixture", query: "q2", candidateUrls: [], ok: true, error: "" });
  event.ok = false;

  assert.equal(loggedEvents.length, 1, "the logged payload does not grow after the fact");
  assert.equal(loggedEvents[0].ok, true, "the logged event is not mutated after the fact");
});

// Regression B — a contact URL found before the deadline must not produce a memo after it.
test("PR-A late-state: no contact memo is appended after the deadline", async () => {
  let clock = 0;
  const now = () => clock;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    // The public-web phase pushes the row past its deadline; finalization happens after.
    async search() {
      clock = 5;
      return [];
    },
  };
  // Fast Path finds a contact link but no email, inside the budget.
  const fetchImpl = async () => new Response('<html><a href="/contact">문의</a></html>', { status: 200 });
  const row = ["Contact Corp", "flower", "", "Seoul", "", "", "https://contact-corp.test/", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, maxRuntimeMs: 1, now });

  assert.equal(result.updates.memo, undefined, "a stopped row appends no memo at all");
  assert.equal((result.updates.memo || "").includes("enrich contact="), false, "the contact memo is not appended");
  assert.equal(result.stopReason, "budget_time");
});

// ---------------------------------------------------------------------------
// Remediation matrix — Blocker 6 (dry-run causes zero Sheets mutations)
// ---------------------------------------------------------------------------

// A dry run must not mutate Sheets in any way, even when the tab and header are missing and the
// live path would normally repair them. Every mutating gateway throws so any call fails the test.
test("PR-A dry-run performs zero Sheets mutations even with a missing tab and header", async () => {
  const calls = [];
  const mutationGuard = (name) => () => {
    calls.push(name);
    throw new Error(`dry-run must not call ${name}`);
  };
  const sheets = {
    async getTargetSpreadsheet(options = {}) {
      calls.push(`read:getTargetSpreadsheet(readOnly=${options.readOnly})`);
      return { spreadsheetId: "sheet-dry-run-no-mutation" };
    },
    async readSystemState(_id, options = {}) {
      calls.push(`read:readSystemState(readOnly=${options.readOnly})`);
      return {};
    },
    async readQueuedEnrichmentRows(_id, options = {}) {
      // Simulates a spreadsheet whose tab/header do not exist yet: no rows, nothing repaired.
      calls.push(`read:readQueuedEnrichmentRows(readOnly=${options.readOnly})`);
      return { candidates: [], nextRow: 2, scanned: 0, skipped: 0 };
    },
    batchUpdateEnrichRows: mutationGuard("batchUpdateEnrichRows"),
    writeSystemState: mutationGuard("writeSystemState"),
    appendEnrichLog: mutationGuard("appendEnrichLog"),
    ensureSpreadsheetShape: mutationGuard("ensureSpreadsheetShape"),
  };

  const summary = await runEnrich({
    limit: 5,
    sheets,
    homepageProvider: { async close() {} },
    fetchImpl: async () => {
      throw new Error("dry-run must not reach the live web");
    },
    dryRun: true,
  });

  const mutations = calls.filter((name) => !name.startsWith("read:"));
  assert.deepEqual(mutations, [], "no mutating Sheets call is made in a dry run");
  // Every read announces read-only so the gateway skips shape/header repair.
  assert.equal(calls.includes("read:getTargetSpreadsheet(readOnly=true)"), true);
  assert.equal(calls.includes("read:readSystemState(readOnly=true)"), true);
  assert.equal(calls.includes("read:readQueuedEnrichmentRows(readOnly=true)"), true);
  // SYSTEM / LOG / 기업DB write counters all stay at zero.
  assert.deepEqual(summary.sheetsApi, { batchUpdate: 0, append: 0, update: 0, total: 0 });
});

// The same run without dryRun must still perform its normal writes — no regression.
test("PR-A non-dry run still performs its normal Sheets writes", async () => {
  const calls = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-live-writes" };
    },
    async readSystemState() {
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          { rowNumber: 2, row: ["Live Corp", "flower", "", "Seoul", "", "", "https://live-corp.co.kr/", "", "", "", "", "", ""] },
        ],
        nextRow: 3,
        scanned: 1,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows(_id, rowUpdates) {
      calls.push("batchUpdateEnrichRows");
      return { updated: rowUpdates.length, batchUpdate: 1 };
    },
    async writeSystemState() {
      calls.push("writeSystemState");
      return { updates: 1 };
    },
    async appendEnrichLog() {
      calls.push("appendEnrichLog");
      return { appendCalls: 1 };
    },
  };

  const summary = await runEnrich({
    limit: 1,
    sheets,
    homepageProvider: { async search() { return []; }, async close() {} },
    fetchImpl: async () => new Response("info@live-corp.co.kr", { status: 200 }),
    dryRun: false,
  });

  assert.deepEqual(calls.sort(), ["appendEnrichLog", "batchUpdateEnrichRows", "writeSystemState"]);
  assert.equal(summary.emailFound, 1);
  assert.equal(summary.sheetsApi.total > 0, true, "live runs still report Sheets API usage");
});

// E. Teardown runs exactly once even when abort and cleanup race.
test("PR-A abort E: cleanup is idempotent and safe to interleave with a late abort", () => {
  const ctx = new RowExplorationContext({ maxRuntimeMs: 45000 });
  assert.notEqual(ctx.deadlineTimer, null, "a runtime budget arms a deadline timer");

  ctx.cleanup();
  assert.equal(ctx.deadlineTimer, null, "the first cleanup clears the timer");

  // A late abort arriving after teardown, then a second cleanup, must both be no-ops.
  ctx.abortRow("time");
  ctx.abortRow("time");
  ctx.cleanup();
  ctx.cleanup();

  assert.equal(ctx.deadlineTimer, null);
  assert.equal(ctx.signal.aborted, true, "the abort is still recorded exactly once");
  assert.equal(ctx.budgetsHit.has("time"), true);
});

// ---------------------------------------------------------------------------
// PR-B — a third-party listing platform is never the company's homepage, and a platform's own
// address is never the company's email. Reproduces run 30540681783 row 3029 (마린모터스).
// ---------------------------------------------------------------------------

const MARINE = { companyName: "마린모터스", region: "울산", address: "울산 북구 진장유통로 95" };

// Test A — the exact false positive from the validation run.
test("PR-B: a platform listing detail page is not an official homepage", () => {
  const picked = pickOfficialHomepage(
    [
      {
        url: "https://fcmt.purpleo.co.kr/view/17601",
        title: "마린모터스 - 울산 북구 진장유통로 95",
        snippet: "마린모터스 울산 북구 중고차 매매 052-000-0000",
        source: "playwright-naver",
      },
    ],
    MARINE,
  );

  assert.equal(picked, null, "a /view/{id} listing page never becomes the official homepage");
  assert.equal(
    scoreOfficialCandidate({ url: "https://fcmt.purpleo.co.kr/view/17601", title: "마린모터스", snippet: "울산 북구", source: "x" }, MARINE),
    0,
    "a platform listing page scores zero",
  );
});

// Test B — a different company's page on the same platform must not win either.
test("PR-B: another company page on the same platform is not an official homepage", () => {
  const picked = pickOfficialHomepage(
    [{ url: "https://fcw.purpleo.co.kr/view/9877", title: "마린모터스 관련 업체", snippet: "울산 북구 중고차", source: "playwright-naver" }],
    MARINE,
  );
  assert.equal(picked, null, "a company-name match in listing text is not ownership evidence");
});

// Test C — the platform operator's own email must never become the company's email.
test("PR-B: a platform-owned email is rejected, not selected as the company email", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.endsWith("이메일")) return [];
      return [
        {
          url: "http://engine.sdn-i.com/Customer/Agency",
          title: "마린모터스 업체정보",
          snippet: "마린모터스 울산 북구 진장유통로 95 문의 0612345@sdn-i.com",
          source: "playwright-naver",
        },
      ];
    },
    async readPageText() {
      return "마린모터스 울산 북구 진장유통로 95 대표 문의 0612345@sdn-i.com";
    },
  };

  const result = await discoverEmail(MARINE, { searchProvider, fetchImpl: async () => new Response("", { status: 200 }) });

  assert.equal(result.email, "", "no platform-owned address is selected");
  assert.equal(result.rejectedEmails.includes("0612345@sdn-i.com"), true, "the platform address is explicitly rejected");
});

// Test D — source-domain credit applies on a company's own site, never on a platform page.
test("PR-B: source-domain credit applies to a company site but not to a platform page", async () => {
  const companySite = {
    async search({ query }) {
      if (!query.endsWith("이메일")) return [];
      return [
        {
          url: "https://company-example.com/contact",
          title: "Company Example 문의",
          snippet: "Company Example 울산 북구 진장유통로 95 sales@company-example.com",
          source: "playwright-naver",
        },
      ];
    },
    async readPageText() {
      return "Company Example 울산 북구 진장유통로 95 문의 sales@company-example.com";
    },
  };
  const ok = await discoverEmail(
    { ...MARINE, companyName: "Company Example" },
    { searchProvider: companySite, fetchImpl: async () => new Response("", { status: 200 }) },
  );
  assert.equal(ok.email, "sales@company-example.com", "a company own-domain email is still selected");

  const platformSite = {
    async search({ query }) {
      if (!query.endsWith("이메일")) return [];
      return [
        {
          url: "https://platform-example.com/company/123",
          title: "Company Example 업체정보",
          snippet: "Company Example 울산 북구 진장유통로 95 support@platform-example.com",
          source: "playwright-naver",
        },
      ];
    },
    async readPageText() {
      return "Company Example 울산 북구 진장유통로 95 문의 support@platform-example.com";
    },
  };
  const bad = await discoverEmail(
    { ...MARINE, companyName: "Company Example" },
    { searchProvider: platformSite, fetchImpl: async () => new Response("", { status: 200 }) },
  );
  assert.equal(bad.email, "", "a platform address is not selected even with company and address context");
});

// Test E — company name + address on a listing page is not ownership evidence.
test("PR-B: company and address context on a platform page does not confirm a homepage", () => {
  const picked = pickOfficialHomepage(
    [
      {
        url: "https://platform-example.com/store/456",
        title: "마린모터스 울산 북구 진장유통로 95",
        snippet: "마린모터스 울산 북구 진장유통로 95 052-000-0000 중고차 매매",
        source: "playwright-naver",
      },
    ],
    MARINE,
  );
  assert.equal(picked, null, "name, address and phone on a listing page is still not the company site");
});

// Test F — a platform candidate must never trigger Early Stop.
test("PR-B: a platform result does not early-stop the public-web search", async () => {
  const queries = [];
  const searchProvider = {
    async search({ query }) {
      queries.push(query);
      return [
        {
          url: "http://engine.sdn-i.com/Customer/Agency",
          title: "마린모터스 업체정보",
          snippet: "마린모터스 울산 북구 진장유통로 95 0612345@sdn-i.com",
          source: "playwright-naver",
        },
      ];
    },
    async readPageText() {
      return "마린모터스 울산 북구 진장유통로 95 0612345@sdn-i.com";
    },
  };

  const result = await discoverEmail(MARINE, { searchProvider, fetchImpl: async () => new Response("", { status: 200 }) });

  assert.equal(result.email, "");
  assert.equal(queries.length, 6, "all discovery queries run — a platform hit never ends the search early");
});

// Test G — a genuine official site keeps working exactly as before.
test("PR-B: a real official homepage and its contact email still win", async () => {
  const picked = pickOfficialHomepage(
    [{ url: "https://marine-motors.co.kr/", title: "마린모터스 공식 홈페이지", snippet: "울산 북구 진장유통로 95 중고차", source: "playwright-naver" }],
    MARINE,
  );
  assert.notEqual(picked, null, "the company own domain is still selected");
  assert.equal(picked.url, "https://marine-motors.co.kr/");

  const searchProvider = {
    async search({ query }) {
      if (!query.endsWith("이메일")) return [];
      return [
        {
          url: "https://marine-motors.co.kr/contact",
          title: "마린모터스 문의",
          snippet: "마린모터스 울산 북구 진장유통로 95 info@marine-motors.co.kr",
          source: "playwright-naver",
        },
      ];
    },
    async readPageText() {
      return "마린모터스 울산 북구 진장유통로 95 문의 info@marine-motors.co.kr";
    },
  };
  const result = await discoverEmail(MARINE, {
    homepage: "https://marine-motors.co.kr/",
    searchProvider,
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  assert.equal(result.email, "info@marine-motors.co.kr", "the official-domain email is still selected");
});

// Test H — an existing homepage is never overwritten by a platform candidate.
test("PR-B: an existing homepage is not replaced by a platform listing page", async () => {
  const homepageProvider = {
    async findOfficial() {
      return {
        official: null,
        failures: [],
        candidates: [{ url: "https://fcmt.purpleo.co.kr/view/17601", title: "삼성자동차매매상사", snippet: "울산", source: "x" }],
        searchEvents: [],
      };
    },
    async search() {
      return [
        {
          url: "http://engine.sdn-i.com/Customer/Agency",
          title: "삼성자동차매매상사",
          snippet: "삼성자동차매매상사 울산 북구 진장유통로 95 0612345@sdn-i.com",
          source: "x",
        },
      ];
    },
    async readPageText() {
      return "삼성자동차매매상사 울산 북구 진장유통로 95 0612345@sdn-i.com";
    },
  };
  const row = ["삼성자동차매매상사", "자동차", "", "울산", "울산 북구 진장유통로 95", "", "http://sscar.net/", "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl: async () => new Response("<html>대표번호 052</html>", { status: 200 }), debug: true },
  );

  assert.equal(result.updates.homepage, undefined, "the existing homepage is never overwritten");
  assert.equal(result.updates.email, undefined, "a platform email is never written");
  assert.notEqual(result.debug.selectedEmail, "0612345@sdn-i.com");
});

// Guard against over-blocking: a company's own /company/about style page is not a platform page.
test("PR-B: a company own section page is not mistaken for a platform listing", () => {
  const allowed = [
    "https://marine-motors.co.kr/company/about",
    "https://marine-motors.co.kr/store/introduction",
    "https://marine-motors.co.kr/about",
    "https://marine-motors.co.kr/",
  ];
  for (const url of allowed) {
    assert.equal(isPlatformUrl(url), false, `${url} must not be treated as a platform page`);
  }

  const blocked = [
    "https://fcmt.purpleo.co.kr/view/17601",
    "https://platform-example.com/company/123",
    "https://platform-example.com/store/456",
    "https://www.daangn.com/kr/local-profile/some-shop-i14himuv54ut/",
    "https://www.carulsan.co.kr/car/sangsa_detail.html?ShopNo=160628",
  ];
  for (const url of blocked) {
    assert.equal(isPlatformUrl(url), true, `${url} must be treated as a platform page`);
  }
  assert.equal(platformUrlReason("https://fcmt.purpleo.co.kr/view/17601").startsWith("platform-host"), true);
  assert.equal(platformUrlReason("https://platform-example.com/company/123"), "platform-path");
});

// ---------------------------------------------------------------------------
// PR-B follow-up — an existing homepage is data, not proof. A platform URL already stored on the
// row must not be crawled by the Fast Path, and must not become the officialHost that promotes
// the platform's own address to "official-domain".
// ---------------------------------------------------------------------------

const PLATFORM_ROW_HOMEPAGE = "https://fcmt.purpleo.co.kr/view/17601";

// Test A — a stored platform homepage must not be crawled by the Fast Path.
test("PR-B2: an existing platform homepage is not crawled by the Fast Path", async () => {
  let crawls = 0;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  const fetchImpl = async () => {
    crawls += 1;
    return new Response("문의 info@purpleo.co.kr", { status: 200 });
  };
  const row = ["마린모터스", "자동차", "", "울산", "울산 북구 진장유통로 95", "", PLATFORM_ROW_HOMEPAGE, "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, debug: true });

  assert.equal(crawls, 0, "no crawl is issued against a platform listing page");
  assert.equal(result.updates.email, undefined, "no platform email is written");
  assert.equal(result.emailUpdated, false);
  assert.notEqual(result.stopReason, "email_found_fast_path");
  assert.equal(result.fastPathSucceeded, false, "a suppressed Fast Path never counts as a success");
  assert.equal(result.debug.fastPathSuppressedReason, "platform-homepage", "the suppression is explained in debug");
});

// Test B — the same holds for an unknown platform recognised only by its URL shape.
test("PR-B2: an existing unknown-platform homepage is not crawled and grants no trust", async () => {
  let crawls = 0;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.endsWith("이메일")) return [];
      return [
        {
          url: "https://public.example.com/profile",
          title: "테스트상사 문의",
          snippet: "테스트상사 울산 북구 진장유통로 95 support@unknown-platform.test",
          source: "playwright-naver",
        },
      ];
    },
    async readPageText() {
      return "테스트상사 울산 북구 진장유통로 95 support@unknown-platform.test";
    },
  };
  const fetchImpl = async () => {
    crawls += 1;
    return new Response("support@unknown-platform.test", { status: 200 });
  };
  const row = ["테스트상사", "자동차", "", "울산", "울산 북구 진장유통로 95", "", "https://unknown-platform.test/company/123", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, debug: true });

  assert.equal(crawls, 0, "an unknown platform path is still not crawled");
  assert.equal(result.updates.email, undefined, "the platform address is never written");
  assert.notEqual(result.stopReason, "email_found_fast_path");
});

// Test C — a stored platform homepage must not become the officialHost.
test("PR-B2: a platform homepage does not promote its own domain to official-domain", async () => {
  const queries = [];
  const searchProvider = {
    async search({ query }) {
      queries.push(query);
      return [
        {
          url: "https://public.example.com/listing-copy",
          title: "마린모터스 문의",
          snippet: "마린모터스 울산 북구 진장유통로 95 info@purpleo.co.kr",
          source: "playwright-naver",
        },
      ];
    },
    async readPageText() {
      return "마린모터스 울산 북구 진장유통로 95 info@purpleo.co.kr";
    },
  };

  const result = await discoverEmail(
    { companyName: "마린모터스", region: "울산", address: "울산 북구 진장유통로 95" },
    { homepage: PLATFORM_ROW_HOMEPAGE, searchProvider, fetchImpl: async () => new Response("", { status: 200 }) },
  );

  assert.equal(result.email, "", "a platform address is not promoted by a contaminated officialHost");
  assert.equal(queries.length, 6, "no early stop — all discovery queries still run");
});

// Test D — a genuine existing homepage still supplies officialHost.
test("PR-B2: a normal existing homepage still acts as officialHost", async () => {
  const searchProvider = {
    async search({ query }) {
      if (!query.endsWith("이메일")) return [];
      return [
        {
          url: "https://public.example.com/press",
          title: "삼성자동차매매상사 문의",
          snippet: "삼성자동차매매상사 울산 북구 sales@sscar.net",
          source: "playwright-naver",
        },
      ];
    },
    async readPageText() {
      return "삼성자동차매매상사 울산 북구 sales@sscar.net";
    },
  };

  const result = await discoverEmail(
    { companyName: "삼성자동차매매상사", region: "울산", address: "울산 북구 진장유통로 95" },
    { homepage: "https://sscar.net", searchProvider, fetchImpl: async () => new Response("", { status: 200 }) },
  );

  assert.equal(result.email, "sales@sscar.net", "an own-domain email is still selected via officialHost");
});

// Test E — the stored platform homepage value itself is left untouched.
test("PR-B2: a stored platform homepage is neither blanked nor overwritten", async () => {
  const homepageProvider = {
    async findOfficial() {
      return {
        official: null,
        failures: [],
        candidates: [{ url: "https://fcw.purpleo.co.kr/view/9877", title: "마린모터스", snippet: "울산", source: "x" }],
        searchEvents: [],
      };
    },
    async search() {
      return [];
    },
  };
  const row = ["마린모터스", "자동차", "", "울산", "울산 북구 진장유통로 95", "", PLATFORM_ROW_HOMEPAGE, "", "", "", "", "", ""];

  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }) },
  );

  assert.equal("homepage" in result.updates, false, "the stored value is not rewritten");
  assert.notEqual(result.updates.homepage, "", "the stored value is never blanked");
  assert.equal(result.homepageUpdated, false);
});

// Test F — normal company section pages must not be classified as platform listings.
test("PR-B2: normal company section paths are not platform listings", () => {
  const allowed = [
    "https://company.test/company-info/about",
    "https://company.test/local-profile/about",
    "https://company.test/sangsa_detail/about",
    "https://company.test/region_view/about",
    "https://company.test/company/2024",
    "https://company.test/store/v2",
    "https://company.test/company/about",
    "https://company.test/store/introduction",
  ];
  for (const url of allowed) {
    assert.equal(isPlatformUrl(url), false, `${url} must not be treated as a platform listing`);
  }
});

// Test G — real listing/detail paths stay blocked.
test("PR-B2: listing detail paths stay blocked", () => {
  const blocked = [
    "https://platform.test/view/17601",
    "https://platform.test/company/123",
    "https://platform.test/store/abc123",
    "https://platform.test/dealer/987",
    "https://platform.test/listing/1001",
    "https://platform.test/local-profile/123",
    "https://platform.test/company-info/123",
    "https://platform.test/sangsa_detail/10",
    "https://platform.test/region_view/20",
  ];
  for (const url of blocked) {
    assert.equal(isPlatformUrl(url), true, `${url} must be treated as a platform listing`);
  }
});

// ---------------------------------------------------------------------------
// PR-B3 — the id-segment rule was still too wide. Any word carrying two digits counted as a record
// id, so a company's own `/company/about2024` was rejected as a listing. A year or a small ordinal
// after a topic word is content; only real id shapes may reject a candidate.
// ---------------------------------------------------------------------------

// Test I — informational slugs on a company's own site are content, not listing ids.
test("PR-B3: informational company slugs are not listing ids", () => {
  const allowed = [
    "https://company.test/company/about2024",
    "https://company.test/company/history2023",
    "https://company.test/company/company01",
    "https://company.test/company/profile2024",
    "https://company.test/company/news2023",
    "https://company.test/company/intro01",
  ];
  for (const url of allowed) {
    assert.equal(isPlatformUrl(url), false, `${url} must not be treated as a platform listing`);
    assert.equal(platformUrlReason(url), "", `${url} must carry no rejection reason`);
  }
});

// Test J — an informational slug stays a scorable homepage candidate, not just a passing classifier
// check: over-blocking cost the row its own site, so the candidate has to survive selection.
test("PR-B3: an informational company slug still scores as a homepage candidate", () => {
  const picked = pickOfficialHomepage(
    [
      {
        url: "https://marine-motors.co.kr/company/about2024",
        title: "마린모터스 회사소개",
        snippet: "마린모터스 울산 북구 진장유통로 95 중고차 매매",
        source: "playwright-naver",
      },
    ],
    MARINE,
  );
  assert.notEqual(picked, null, "a company own section page is still selectable");
  assert.equal(picked.url, "https://marine-motors.co.kr/company/about2024");
});

// Test K — everything the previous rule already allowed stays allowed.
test("PR-B3: previously allowed segments stay allowed", () => {
  const allowed = [
    "https://company.test/company/2024",
    "https://company.test/company/1999",
    "https://company.test/store/v2",
    "https://company.test/company/model3",
    "https://company.test/company/b2b",
    "https://company.test/company/about",
    "https://company.test/company/history",
    "https://company.test/company/profile",
    "https://company.test/store/introduction",
  ];
  for (const url of allowed) {
    assert.equal(isPlatformUrl(url), false, `${url} must not be treated as a platform listing`);
  }
});

// Test L — real record ids stay blocked, including the id-prefixed and zero-padded shapes a looser
// word rule must not let through.
test("PR-B3: listing id shapes stay blocked", () => {
  const blocked = [
    "https://platform.test/view/17601",
    "https://platform.test/company/123",
    "https://platform.test/store/abc123",
    "https://platform.test/dealer/987",
    "https://platform.test/listing/1001",
    "https://platform.test/local-profile/123",
    "https://platform.test/company-info/123",
    "https://platform.test/sangsa_detail/10",
    "https://platform.test/region_view/20",
    "https://platform.test/company/id0001",
    "https://platform.test/company/dealer99",
    "https://platform.test/company/000123",
  ];
  for (const url of blocked) {
    assert.equal(isPlatformUrl(url), true, `${url} must be treated as a platform listing`);
    assert.notEqual(platformUrlReason(url), "", `${url} must carry a rejection reason`);
  }
});

// ---------------------------------------------------------------------------
// PR-B4 — two holes left by the id-segment rule. A department abbreviation is too short to clear
// the four-letter word rule (`/company/hr2024`), and a malformed percent escape in any candidate
// URL threw out of decodeURIComponent and rejected the whole row.
// ---------------------------------------------------------------------------

const SHORT_INFORMATIONAL_SLUGS = ["hr2024", "pr2024", "it2024", "ir2024"];

// Test A — a two-letter department page is content, not a record id.
test("PR-B4: short informational slugs are not listing ids", () => {
  for (const slug of SHORT_INFORMATIONAL_SLUGS) {
    const url = `https://company.test/company/${slug}`;
    assert.equal(isPlatformUrl(url), false, `${url} must not be treated as a platform listing`);
    assert.equal(platformUrlReason(url), "", `${url} must carry no rejection reason`);
  }
});

// Test A (continued) — and it still reaches candidate selection, which is what over-blocking cost.
test("PR-B4: a short informational slug still scores as a homepage candidate", () => {
  for (const slug of SHORT_INFORMATIONAL_SLUGS) {
    const picked = pickOfficialHomepage(
      [
        {
          url: `https://marine-motors.co.kr/company/${slug}`,
          title: "마린모터스 회사소개",
          snippet: "마린모터스 울산 북구 진장유통로 95 중고차 매매",
          source: "playwright-naver",
        },
      ],
      MARINE,
    );
    assert.notEqual(picked, null, `${slug} must stay selectable as a homepage`);
    assert.equal(picked.url, `https://marine-motors.co.kr/company/${slug}`);
  }
});

// Test B — widening the word rule must not let real record ids through.
test("PR-B4: strong id shapes stay blocked after the short-word allowance", () => {
  const blocked = [
    "https://platform.test/company/id0001",
    "https://platform.test/company/dealer99",
    "https://platform.test/company/abc123",
    "https://platform.test/company/ab12",
    "https://platform.test/company/000123",
    "https://platform.test/company/store01",
    "https://platform.test/company/item2024",
  ];
  for (const url of blocked) {
    assert.equal(isPlatformUrl(url), true, `${url} must be treated as a platform listing`);
  }
});

const MALFORMED_ESCAPE_URLS = [
  "https://company.test/company/%",
  "https://company.test/company/%E0%A4",
  "https://company.test/company/%ZZ",
  "https://company.test/company/%2",
];

// Test C — a malformed percent escape must never throw out of URL classification.
test("PR-B4: a malformed percent escape does not throw out of classification", () => {
  for (const url of MALFORMED_ESCAPE_URLS) {
    assert.doesNotThrow(() => platformUrlReason(url), `${url} must not throw`);
    assert.doesNotThrow(() => isPlatformUrl(url), `${url} must not throw`);
    assert.equal(typeof platformUrlReason(url), "string", `${url} must return a reason string`);
    assert.equal(typeof isPlatformUrl(url), "boolean", `${url} must return a boolean`);
    assert.doesNotThrow(
      () =>
        pickOfficialHomepage(
          [{ url, title: "마린모터스", snippet: "마린모터스 울산 북구 진장유통로 95", source: "playwright-naver" }],
          MARINE,
        ),
      `${url} must not throw during candidate selection`,
    );
  }
});

// Test D — the guard must not stop real decoding. `%61bout2024` is `about2024`, and
// `%32%30%32%34` is the year `2024`, which is only allowed once it is actually decoded.
test("PR-B4: valid percent encoding is still decoded", () => {
  const allowed = [
    "https://company.test/company/about%202024",
    "https://company.test/company/%61bout2024",
    "https://company.test/company/%ED%9A%8C%EC%82%AC%EC%86%8C%EA%B0%9C",
    "https://company.test/company/%32%30%32%34",
  ];
  for (const url of allowed) {
    assert.doesNotThrow(() => isPlatformUrl(url), `${url} must not throw`);
    assert.equal(isPlatformUrl(url), false, `${url} must not be treated as a platform listing`);
  }
  assert.equal(
    isPlatformUrl("https://platform.test/company/%61bc123"),
    true,
    "a decoded record id (`abc123`) is still blocked, proving the escape was decoded",
  );
});

// Test E — end to end: a malformed candidate URL costs that candidate, never the row.
test("PR-B4: a malformed candidate URL does not reject the row", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    let providerFailures = 0;
    const homepageProvider = {
      async findOfficial() {
        return { official: null, failures: [], candidates: [], searchEvents: [] };
      },
      async search() {
        return [
          {
            url: "https://company.test/company/%E0%A4",
            title: "마린모터스",
            snippet: "마린모터스 울산 북구 진장유통로 95",
            source: "playwright-naver",
          },
          {
            url: "https://marine-motors.co.kr/",
            title: "마린모터스 공식 홈페이지",
            snippet: "마린모터스 울산 북구 진장유통로 95 중고차 매매 info@marine-motors.co.kr",
            source: "playwright-naver",
          },
        ];
      },
      async readPageText() {
        return "마린모터스 울산 북구 진장유통로 95 info@marine-motors.co.kr";
      },
    };
    const row = ["마린모터스", "자동차", "", "울산", "울산 북구 진장유통로 95", "", "", "", "", "", "", "", ""];

    const result = await enrichCandidate(
      { rowNumber: 2, row },
      {
        homepageProvider,
        fetchImpl: async () => {
          providerFailures += 0;
          return new Response("문의 info@marine-motors.co.kr", { status: 200 });
        },
        debug: true,
      },
    );

    assert.equal(typeof result.stopReason, "string", "the row still produces a stop reason");
    assert.notEqual(result.stopReason, "", "the stop reason is not empty");
    assert.notEqual(result.failureCode, "site_access_failed", "a malformed URL is not a site access failure");
    assert.equal(providerFailures, 0, "no provider failure is recorded for a malformed candidate");
    assert.notEqual(
      result.debug.selectedHomepage,
      "https://company.test/company/%E0%A4",
      "the malformed candidate is never selected",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(rejections, [], "no unhandled rejection escapes the row");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

// Test E (continued) — the same holds when the malformed URL is the value already stored on the row.
test("PR-B4: a malformed stored homepage does not reject the row", async () => {
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  const row = [
    "마린모터스",
    "자동차",
    "",
    "울산",
    "울산 북구 진장유통로 95",
    "",
    "https://company.test/company/%E0%A4",
    "",
    "",
    "",
    "",
    "",
    "",
  ];

  await assert.doesNotReject(
    () =>
      enrichCandidate(
        { rowNumber: 2, row },
        { homepageProvider, fetchImpl: async () => new Response("", { status: 200 }), debug: true },
      ),
    "a malformed stored homepage must not reject the row",
  );
});

// Test H — a genuine official domain works end to end, with Fast Path and Early Stop intact.
test("PR-B2: a real official homepage still drives Fast Path and email selection", async () => {
  let crawls = 0;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      throw new Error("Fast Path should have resolved this row without searching");
    },
  };
  const fetchImpl = async (url) => {
    crawls += 1;
    return new Response(String(url).includes("contact") ? "sales@marine-motors.co.kr" : '<a href="/contact">문의</a>', { status: 200 });
  };
  const row = ["마린모터스", "자동차", "", "울산", "울산 북구 진장유통로 95", "", "https://marine-motors.co.kr", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl, debug: true });

  assert.equal(crawls > 0, true, "the real homepage is crawled");
  assert.equal(result.updates.email, "sales@marine-motors.co.kr", "its contact email is selected");
  assert.equal(result.stopReason, "email_found_fast_path", "Fast Path still short-circuits the row");
  assert.equal(result.fastPathSucceeded, true);
  assert.equal(result.debug.fastPathSuppressedReason, undefined, "no suppression on a real homepage");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PR-D - synthetic press and media email false-positive fixtures.
// These fixtures preserve the article-shaped source-domain and reporter-context semantics without
// carrying production names, domains, addresses, localparts, identifiers, or copied PR text.
// ---------------------------------------------------------------------------

const VOLVO_ULSAN = { companyName: "TEST_COMPANY_A", region: "TEST_REGION_A", address: "TEST_ADDRESS_A" };
const FORD_ULSAN = { companyName: "TEST_COMPANY_B", region: "TEST_REGION_B", address: "TEST_ADDRESS_B" };
const LINCOLN_ULSAN = { companyName: "TEST_COMPANY_C", region: "TEST_REGION_C", address: "TEST_ADDRESS_C" };

function singleSourceProvider(url, text, { queries = null } = {}) {
  return {
    async search({ query }) {
      if (queries) queries.push(query);
      return [{ url, title: "TEST_SOURCE_LABEL", snippet: text, source: "TEST_SOURCE_LABEL" }];
    },
    async readPageText() {
      return text;
    },
  };
}

const noopFetch = async () => new Response("", { status: 200 });

// Test A - source-domain reporter address on an article-shaped media URL is rejected.
test("PR-D: a newspaper reporter address is not the company email", async () => {
  const queries = [];
  const url = "https://media-a.test/news/article/1001";
  const text = "TEST_COMPANY_A TEST_ADDRESS_A 기자 이메일 reporter@media-a.test";
  const result = await discoverEmail(VOLVO_ULSAN, {
    homepage: "https://official-a.test",
    searchProvider: singleSourceProvider(url, text, { queries }),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "media reporter candidate must be rejected");
  assert.equal(String(result.scoreReason || "").includes("source-domain"), false, "rejected media source must not win source-domain credit");
  assert.equal(queries.length, 6, "rejected media candidates must not early-stop public-web discovery");
});

// Test B - another article-shaped source-domain reporter address is rejected.
test("PR-D: a tech-press reporter address is not the company email", async () => {
  const queries = [];
  const url = "https://media-b.test/news/article/1002";
  const text = "TEST_COMPANY_B TEST_ADDRESS_B 기자 이메일 press@media-b.test";
  const result = await discoverEmail(FORD_ULSAN, {
    homepage: "https://official-b.test",
    searchProvider: singleSourceProvider(url, text, { queries }),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "media reporter candidate must be rejected");
  assert.equal(queries.length, 6, "rejected media candidates must not early-stop public-web discovery");
});

// Test C - article shape, not host membership, blocks an otherwise plausible source-domain contact.
test("PR-D: a trade-press reporter address is not the company email", async () => {
  const queries = [];
  const url = "https://media-c.test/news/article/1003";
  const text = "TEST_COMPANY_C TEST_ADDRESS_C 기자 이메일 reporter@media-c.test";
  const result = await discoverEmail(LINCOLN_ULSAN, {
    homepage: "https://official-c.test",
    searchProvider: singleSourceProvider(url, text, { queries }),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "media reporter candidate must be rejected");
  assert.equal(queries.length, 6, "rejected media candidates must not early-stop public-web discovery");
});

// Test D - an unlisted media host is still rejected by article URL shape and reporter context.
test("PR-D: an unknown media host is rejected by article shape, not by a host list", async () => {
  const queries = [];
  const url = "https://unlisted-media.test/news/article/1004";
  const text = "TEST_COMPANY_D TEST_ADDRESS_D 기자 이메일 reporter@unlisted-media.test";
  const result = await discoverEmail(
    { companyName: "TEST_COMPANY_D", region: "TEST_REGION_D", address: "TEST_ADDRESS_D" },
    { searchProvider: singleSourceProvider(url, text, { queries }), fetchImpl: noopFetch },
  );

  assert.equal(result.email, "", "article-shaped media candidate must be rejected even for unlisted hosts");
  assert.equal(queries.length, 6, "article-shaped rejection must not early-stop public-web discovery");
});

// Test E - official-domain media owner contact remains allowed.
test("PR-D: an official-domain address still wins", async () => {
  const url = "https://official-media.test/news/article/1005";
  const text = "TEST_MEDIA_OWNER TEST_MEDIA_ADDRESS 고객문의 이메일 official@official-media.test";
  const result = await discoverEmail(
    { companyName: "TEST_MEDIA_OWNER", region: "TEST_MEDIA_REGION", address: "TEST_MEDIA_ADDRESS" },
    { homepage: url, searchProvider: singleSourceProvider(url, text), fetchImpl: noopFetch },
  );

  assert.equal(result.email, "official@official-media.test", "official media owner address must still win");
  assert.equal(String(result.scoreReason || "").includes("official-domain"), true, "official-domain exception must survive media rejection rule");
});

// Test F - company address and press address side by side: the company's own domain wins.
test("PR-D: a company-domain address beats a press address on the same row", async () => {
  const pressUrl = "https://media-d.test/news/article/1006";
  const ownUrl = "https://company-b.test/contact/1001";
  const searchProvider = {
    async search() {
      return [
        { url: pressUrl, title: "TEST_SOURCE_LABEL", snippet: "TEST_COMPANY_B TEST_ADDRESS_B 기자 이메일 reporter@media-d.test", source: "TEST_SOURCE_LABEL" },
        {
          url: ownUrl,
          title: "TEST_SOURCE_LABEL",
          snippet: "TEST_COMPANY_B TEST_ADDRESS_B 고객문의 이메일 contact@company-b.test",
          source: "TEST_SOURCE_LABEL",
        },
      ];
    },
    async readPageText(url) {
      return String(url).includes("company-b.test")
        ? "TEST_COMPANY_B TEST_ADDRESS_B 고객문의 이메일 contact@company-b.test"
        : "TEST_COMPANY_B TEST_ADDRESS_B 기자 이메일 reporter@media-d.test";
    },
  };

  const result = await discoverEmail(FORD_ULSAN, {
    homepage: "https://company-b.test",
    searchProvider,
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "contact@company-b.test", "company-domain address must outrank rejected press address");
  assert.notEqual(result.email, "reporter@media-d.test", "press address must not win over company-domain address");
});

// Test G - when the target company is the publisher, its official address is allowed; reporter contact stays blocked.
test("PR-D: a publisher's own official address is allowed when the publisher is the target", async () => {
  const url = "https://publisher-target.test/news/article/1007";
  const text = "TEST_PUBLISHER_TARGET TEST_PUBLISHER_ADDRESS 고객문의 이메일 official@publisher-target.test";
  const result = await discoverEmail(
    { companyName: "TEST_PUBLISHER_TARGET", region: "TEST_PUBLISHER_REGION", address: "TEST_PUBLISHER_ADDRESS" },
    { homepage: "https://publisher-target.test", searchProvider: singleSourceProvider(url, text), fetchImpl: noopFetch },
  );

  assert.equal(result.email, "official@publisher-target.test", "publisher official address must be allowed for publisher target");
});

test("PR-D: a reporter address is blocked even when the publisher is the target company", async () => {
  const url = "https://publisher-target.test/news/article/1008";
  const text = "TEST_PUBLISHER_TARGET TEST_PUBLISHER_ADDRESS 기자 이메일 reporter@publisher-target.test";
  const result = await discoverEmail(
    { companyName: "TEST_PUBLISHER_TARGET", region: "TEST_PUBLISHER_REGION", address: "TEST_PUBLISHER_ADDRESS" },
    { homepage: "https://publisher-target.test", searchProvider: singleSourceProvider(url, text), fetchImpl: noopFetch },
  );

  assert.equal(result.email, "", "reporter-context address must remain blocked for publisher target");
});

// Test H - rejecting a press candidate is not a provider failure and does not fail the row.
test("PR-D: a press rejection is not a provider or site-access failure", async () => {
  const url = "https://media-e.test/news/article/1009";
  const text = "TEST_COMPANY_B TEST_ADDRESS_B 기자 이메일 reporter@media-e.test";
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    ...singleSourceProvider(url, text),
  };
  const row = ["TEST_COMPANY_B", "", "", "TEST_REGION_B", "TEST_ADDRESS_B", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl: noopFetch, debug: true });

  assert.equal(result.updates.email, undefined, "rejected press candidate must not update email");
  assert.notEqual(result.failureCode, "site_access_failed", "candidate rejection is not a site-access failure");
  assert.equal(typeof result.stopReason, "string", "row still records a stop reason");
  assert.notEqual(result.stopReason, "email_found_public_web", "rejected press candidate must not be recorded as found email");
});

// ---------------------------------------------------------------------------
// PR-D2 - synthetic association notice-board false-positive fixtures.
// The board URL keeps query-string board markers while all fixture identity values are synthetic.
// ---------------------------------------------------------------------------

const KIRA_BOARD_URL = "https://association-board.test/jsp/1001/1002/1003.jsp?ba_bbsId=1004&ba_id=1005&mode=read";
const BENZ_ULSAN = {
  companyName: "TEST_COMPANY_E",
  region: "TEST_REGION_E",
  address: "TEST_ADDRESS_E",
};

// Test A - a third-party board source-domain address is rejected and does not early-stop discovery.
test("PR-D2: an association board address is not the company email", async () => {
  const queries = [];
  const text = "TEST_COMPANY_E TEST_ADDRESS_E 담당자 이메일 contact@association-board.test";
  const result = await discoverEmail(BENZ_ULSAN, {
    homepage: "https://official-e.test",
    searchProvider: singleSourceProvider(KIRA_BOARD_URL, text, { queries }),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "third-party board source-domain candidate must be rejected");
  assert.equal(String(result.scoreReason || "").includes("source-domain"), false, "rejected board source must not win source-domain credit");
  assert.equal(queries.length, 6, "rejected board candidates must not early-stop public-web discovery");
});

test("PR-D2: an association board rejection does not fail the row", async () => {
  const text = "TEST_COMPANY_E TEST_ADDRESS_E 담당자 이메일 contact@association-board.test";
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    ...singleSourceProvider(KIRA_BOARD_URL, text),
  };
  const row = [
    "TEST_COMPANY_E",
    "",
    "",
    "TEST_REGION_E",
    "TEST_ADDRESS_E",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl: noopFetch, debug: true });

  assert.equal(result.updates.email, undefined, "rejected board candidate must not update email");
  assert.notEqual(result.failureCode, "site_access_failed", "candidate rejection is not a site-access failure");
  assert.notEqual(result.stopReason, "email_found_public_web", "rejected board candidate must not be recorded as found email");
});

// Test B - an unlisted association board is recognised by board-shaped URL, not host membership.
test("PR-D2: an unlisted association board is rejected by shape, not by a host list", async () => {
  const url = "https://unlisted-board.test/notice/view/1006?board_id=1007";
  const text = "TEST_COMPANY_E TEST_ADDRESS_E 담당자 이메일 office@unlisted-board.test";
  const result = await discoverEmail(BENZ_ULSAN, {
    homepage: "https://official-e.test",
    searchProvider: singleSourceProvider(url, text),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "board-shaped candidate must be rejected even for unlisted hosts");
});

// Test C - the association itself is the company being enriched: its own address is allowed.
test("PR-D2: an association's own address is allowed when the association is the target", async () => {
  const text = "TEST_ASSOCIATION TEST_ASSOCIATION_ADDRESS 고객문의 이메일 contact@association-board.test";
  const result = await discoverEmail(
    { companyName: "TEST_ASSOCIATION", region: "TEST_ASSOCIATION_REGION", address: "TEST_ASSOCIATION_ADDRESS" },
    { homepage: "https://association-board.test", searchProvider: singleSourceProvider(KIRA_BOARD_URL, text), fetchImpl: noopFetch },
  );

  assert.equal(result.email, "contact@association-board.test", "association-owned board address must be allowed for association target");
});

// Test D - a company running a board on its own site keeps its address.
test("PR-D2: a company's own notice board address is allowed", async () => {
  const url = "https://company-board.test/board/read/1008";
  const text = "TEST_COMPANY_BOARD TEST_COMPANY_BOARD_ADDRESS 고객문의 이메일 support@company-board.test";
  const result = await discoverEmail(
    { companyName: "TEST_COMPANY_BOARD", region: "TEST_COMPANY_BOARD_REGION", address: "TEST_COMPANY_BOARD_ADDRESS" },
    { homepage: "https://company-board.test", searchProvider: singleSourceProvider(url, text), fetchImpl: noopFetch },
  );

  assert.equal(result.email, "support@company-board.test", "company-owned board address must be allowed");
});

// Test E - the press fixes are untouched by the board rule.
test("PR-D2: press rejections still hold after the board rule", async () => {
  const press = [
    { url: "https://media-a.test/news/article/1001", email: "reporter@media-a.test" },
    { url: "https://media-b.test/news/article/1002", email: "press@media-b.test" },
    { url: "https://media-c.test/news/article/1003", email: "reporter@media-c.test" },
    { url: "https://media-d.test/news/article/1004", email: "reporter@media-d.test" },
  ];
  for (const { url, email } of press) {
    const text = "TEST_COMPANY_B TEST_ADDRESS_B 기자 이메일 " + email;
    const result = await discoverEmail(FORD_ULSAN, {
      homepage: "https://official-b.test",
      searchProvider: singleSourceProvider(url, text),
      fetchImpl: noopFetch,
    });
    assert.equal(result.email, "", url + " must still be rejected");
  }
});

// Test F - a shared source domain on its own is not enough. Without a board or press shape the
// existing source-domain path is untouched, so ordinary third-party pages keep working as before.
test("PR-D2: a matching source domain without a board shape is not blocked", async () => {
  const url = "https://shared-source.test/profile/1009";
  const text = "TEST_COMPANY_B TEST_ADDRESS_B 고객문의 이메일 contact@shared-source.test";
  const result = await discoverEmail(FORD_ULSAN, {
    homepage: "https://official-b.test",
    searchProvider: singleSourceProvider(url, text),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "contact@shared-source.test", "non-board source-domain path must remain allowed");
});


// ---------------------------------------------------------------------------
// PR-D3 - synthetic no-officialHost notice-board ownership fixtures.
// These cases keep the board/source-domain regression matrix while using only
// reserved .test domains, TEST_* identity labels, and synthetic route tokens.
// ---------------------------------------------------------------------------

const PR_D3_BOARD_URL = "https://association-d3.test/board/read/1001?board_id=1002";
const PR_D3_COMPANY = { companyName: "TEST_COMPANY_D3", region: "TEST_REGION_D3", address: "TEST_ADDRESS_D3" };

// Test A - a board operator address is rejected even when no homepage was found.
test("PR-D3: a board address is rejected even when the row has no officialHost", async () => {
  const queries = [];
  const text = "TEST_COMPANY_D3 TEST_ADDRESS_D3 담당자 이메일 contact@association-d3.test";
  const result = await discoverEmail(PR_D3_COMPANY, {
    searchProvider: singleSourceProvider(PR_D3_BOARD_URL, text, { queries }),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "third-party board candidate must be rejected without officialHost");
  assert.equal(result.rejectedEmails.includes("contact@association-d3.test"), true, "board candidate is recorded as rejected");
  assert.equal(String(result.scoreReason || "").includes("source-domain"), false, "a board grants no source-domain credit");
  assert.equal(queries.length, 6, "rejected board candidates must not early-stop public-web discovery");
});

test("PR-D3: a board rejection without officialHost does not fail the row", async () => {
  const text = "TEST_COMPANY_D3 TEST_ADDRESS_D3 담당자 이메일 contact@association-d3.test";
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    ...singleSourceProvider(PR_D3_BOARD_URL, text),
  };
  const row = ["TEST_COMPANY_D3", "", "", "TEST_REGION_D3", "TEST_ADDRESS_D3", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl: noopFetch, debug: true });

  assert.equal(result.updates.email, undefined, "rejected board candidate must not update email");
  assert.notEqual(result.failureCode, "site_access_failed", "candidate rejection is not a site-access failure");
  assert.notEqual(result.stopReason, "email_found_public_web", "rejected board candidate must not be recorded as found email");
  assert.equal(result.debug.rejectedEmails.includes("contact@association-d3.test"), true, "row debug records the rejected board address");
});

// Test B - a company's own board subdomain remains allowed when official ownership is known.
test("PR-D3: a board on a subdomain of the official host is allowed", async () => {
  const url = "https://notice.company-d3.test/board/read/1003";
  const text = "TEST_COMPANY_D3_OWN TEST_ADDRESS_D3_OWN 고객문의 이메일 support@company-d3.test";
  const result = await discoverEmail(
    { companyName: "TEST_COMPANY_D3_OWN", region: "TEST_REGION_D3_OWN", address: "TEST_ADDRESS_D3_OWN" },
    { homepage: "https://company-d3.test", searchProvider: singleSourceProvider(url, text), fetchImpl: noopFetch },
  );

  assert.equal(result.email, "support@company-d3.test", "company-owned board address must be allowed");
  assert.equal(String(result.scoreReason || "").includes("official-domain"), true, "official-domain ownership must be preserved");
});

// Test C - ordinary source-domain discovery is unchanged when the source is not board-shaped.
test("PR-D3: a non-board third-party page is untouched when there is no officialHost", async () => {
  const url = "https://directory-d3.test/profile/1004";
  const text = "TEST_COMPANY_D3 TEST_ADDRESS_D3 고객문의 이메일 office@directory-d3.test";
  const result = await discoverEmail(PR_D3_COMPANY, {
    searchProvider: singleSourceProvider(url, text),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "office@directory-d3.test", "non-board source-domain candidate remains selectable");
  assert.equal(String(result.scoreReason || "").includes("source-domain"), true, "non-board source-domain credit remains intact");
});

// Test D - the earlier PR-D and PR-D2 verdicts stay separate from this no-officialHost rule.
test("PR-D3: earlier board and press verdicts are unchanged", async () => {
  const boardQueries = [];
  const boardResult = await discoverEmail(BENZ_ULSAN, {
    homepage: "https://official-e.test",
    searchProvider: singleSourceProvider(KIRA_BOARD_URL, "TEST_COMPANY_E TEST_ADDRESS_E 담당자 이메일 contact@association-board.test", {
      queries: boardQueries,
    }),
    fetchImpl: noopFetch,
  });
  const pressQueries = [];
  const pressResult = await discoverEmail(FORD_ULSAN, {
    homepage: "https://official-b.test",
    searchProvider: singleSourceProvider("https://media-d3.test/news/article/1005", "TEST_COMPANY_B TEST_ADDRESS_B 기자 이메일 reporter@media-d3.test", {
      queries: pressQueries,
    }),
    fetchImpl: noopFetch,
  });

  assert.equal(boardResult.email, "", "existing board rejection must remain rejected");
  assert.equal(boardResult.rejectedEmails.includes("contact@association-board.test"), true, "existing board rejection remains recorded");
  assert.equal(boardQueries.length, 6, "existing board rejection must not early-stop discovery");
  assert.equal(pressResult.email, "", "existing press rejection must remain rejected");
  assert.equal(pressResult.rejectedEmails.includes("reporter@media-d3.test"), true, "existing press rejection remains recorded");
  assert.equal(pressQueries.length, 6, "existing press rejection must not early-stop discovery");
});

// ---------------------------------------------------------------------------
// PR-D4 - synthetic bidirectional ownership and boundary fixtures.
// These cases prove root/subdomain ownership in both directions without allowing
// hostile suffix, prefix, exact third-party, board, or article source ownership.
// ---------------------------------------------------------------------------

const PR_D4_COMPANY = { companyName: "TEST_COMPANY_D4", region: "TEST_REGION_D4", address: "TEST_ADDRESS_D4" };

// Test A - source subdomain ownership is rejected when it belongs to the board operator.
test("PR-D4: a board address on a subdomain of the board host is rejected", async () => {
  const queries = [];
  const url = "https://board.owner-d4.test/board/read/1001";
  const text = "TEST_COMPANY_D4 TEST_ADDRESS_D4 담당자 이메일 contact@owner-d4.test";
  const result = await discoverEmail(PR_D4_COMPANY, {
    homepage: "https://official-d4.test",
    searchProvider: singleSourceProvider(url, text, { queries }),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "board operator root-domain address must be rejected from subdomain board host");
  assert.equal(result.rejectedEmails.includes("contact@owner-d4.test"), true, "subdomain board rejection is recorded");
  assert.equal(String(result.scoreReason || "").includes("source-domain"), false, "rejected board source must not win source-domain credit");
  assert.equal(queries.length, 6, "rejected board candidates must not early-stop public-web discovery");
});

// Test B - company board ownership is recognised root-to-subdomain and subdomain-to-root.
test("PR-D4: board host and email domain are compared in both directions", async () => {
  const rootToSubdomain = await discoverEmail(
    { companyName: "TEST_COMPANY_D4_ROOT", region: "TEST_REGION_D4_ROOT", address: "TEST_ADDRESS_D4_ROOT" },
    {
      homepage: "https://company-d4-root.test",
      searchProvider: singleSourceProvider(
        "https://notice.company-d4-root.test/board/read/1002",
        "TEST_COMPANY_D4_ROOT TEST_ADDRESS_D4_ROOT 고객문의 이메일 contact@company-d4-root.test",
      ),
      fetchImpl: noopFetch,
    },
  );
  const subdomainToRoot = await discoverEmail(
    { companyName: "TEST_COMPANY_D4_SUB", region: "TEST_REGION_D4_SUB", address: "TEST_ADDRESS_D4_SUB" },
    {
      homepage: "https://official.company-d4-sub.test",
      searchProvider: singleSourceProvider(
        "https://company-d4-sub.test/board/read/1003",
        "TEST_COMPANY_D4_SUB TEST_ADDRESS_D4_SUB 고객문의 이메일 office@official.company-d4-sub.test",
      ),
      fetchImpl: noopFetch,
    },
  );

  assert.equal(rootToSubdomain.email, "contact@company-d4-root.test", "root official domain must own a board subdomain");
  assert.equal(subdomainToRoot.email, "office@official.company-d4-sub.test", "official subdomain email must be allowed on the owned root board");
});

test("PR-D4: a board subdomain address is rejected against a mismatched officialHost", async () => {
  const url = "https://owner-d4-mismatch.test/board/read/1004";
  const text = "TEST_COMPANY_D4 TEST_ADDRESS_D4 담당자 이메일 office@owner-d4-mismatch.test";
  const result = await discoverEmail(PR_D4_COMPANY, {
    homepage: "https://official-d4.test",
    searchProvider: singleSourceProvider(url, text),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "exact third-party board host must be rejected when officialHost differs");
  assert.equal(result.rejectedEmails.includes("office@owner-d4-mismatch.test"), true, "exact-host board rejection is recorded");

  const hostileCases = [
    {
      url: "https://company-d4.test.evil.test/board/read/1001",
      email: "contact@company-d4.test.evil.test",
    },
    {
      url: "https://evilcompany-d4.test/board/read/1002",
      email: "office@evilcompany-d4.test",
    },
    {
      url: "https://company-d4-boundary.test/board/read/1003",
      email: "team@company-d4-boundary.test",
    },
  ];

  for (const hostileCase of hostileCases) {
    const hostileResult = await discoverEmail(PR_D4_COMPANY, {
      homepage: "https://company-d4.test",
      searchProvider: singleSourceProvider(hostileCase.url, "TEST_COMPANY_D4 TEST_ADDRESS_D4 담당자 이메일 " + hostileCase.email),
      fetchImpl: noopFetch,
    });
    assert.equal(hostileResult.email, "", hostileCase.url + " must not inherit ownership");
    assert.equal(hostileResult.rejectedEmails.includes(hostileCase.email), true, hostileCase.email + " is recorded as rejected");
  }
});

test("PR-D4: a publisher subdomain address is rejected on an article", async () => {
  const url = "https://news.media-d4.test/news/article/1005";
  const text = "TEST_COMPANY_D4 TEST_ADDRESS_D4 고객문의 이메일 press@media-d4.test";
  const result = await discoverEmail(PR_D4_COMPANY, {
    homepage: "https://official-d4.test",
    searchProvider: singleSourceProvider(url, text),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "publisher root-domain address must be rejected from article subdomain");
  assert.equal(result.rejectedEmails.includes("press@media-d4.test"), true, "media subdomain rejection is recorded");

  const officialMediaUrl = "https://news.official-media-d4.test/news/article/1006";
  const officialMediaText = "TEST_MEDIA_D4 TEST_MEDIA_ADDRESS_D4 고객문의 이메일 official@official-media-d4.test";
  const officialMediaResult = await discoverEmail(
    { companyName: "TEST_MEDIA_D4", region: "TEST_MEDIA_REGION_D4", address: "TEST_MEDIA_ADDRESS_D4" },
    { homepage: "https://official-media-d4.test", searchProvider: singleSourceProvider(officialMediaUrl, officialMediaText), fetchImpl: noopFetch },
  );

  assert.equal(officialMediaResult.email, "official@official-media-d4.test", "official media owner address must still win");
  assert.equal(String(officialMediaResult.scoreReason || "").includes("official-domain"), true, "official media allowance keeps official-domain credit");
});

test("PR-D4: ownership exemptions survive the two-way comparison", async () => {
  const targetOwned = await discoverEmail(
    { companyName: "TEST_TARGET_D4", region: "TEST_TARGET_REGION_D4", address: "TEST_TARGET_ADDRESS_D4" },
    {
      homepage: "https://target-d4.test",
      searchProvider: singleSourceProvider("https://board.target-d4.test/board/read/1007", "TEST_TARGET_D4 TEST_TARGET_ADDRESS_D4 고객문의 이메일 team@target-d4.test"),
      fetchImpl: noopFetch,
    },
  );
  const partnerOwned = await discoverEmail(
    { companyName: "TEST_PARTNER_D4", region: "TEST_PARTNER_REGION_D4", address: "TEST_PARTNER_ADDRESS_D4" },
    {
      homepage: "https://partner.target-d4.test",
      searchProvider: singleSourceProvider("https://target-d4.test/board/read/1008", "TEST_PARTNER_D4 TEST_PARTNER_ADDRESS_D4 고객문의 이메일 office@partner.target-d4.test"),
      fetchImpl: noopFetch,
    },
  );
  const inverseOwned = await discoverEmail(
    { companyName: "TEST_INVERSE_D4", region: "TEST_INVERSE_REGION_D4", address: "TEST_INVERSE_ADDRESS_D4" },
    {
      homepage: "https://official.inverse-d4.test",
      searchProvider: singleSourceProvider("https://inverse-d4.test/board/read/1009", "TEST_INVERSE_D4 TEST_INVERSE_ADDRESS_D4 고객문의 이메일 support@official.inverse-d4.test"),
      fetchImpl: noopFetch,
    },
  );

  assert.equal(targetOwned.email, "team@target-d4.test", "target company board address must be allowed");
  assert.equal(partnerOwned.email, "office@partner.target-d4.test", "partner subdomain ownership must be allowed");
  assert.equal(inverseOwned.email, "support@official.inverse-d4.test", "inverse root/subdomain ownership must be allowed");
});

// ---------------------------------------------------------------------------
// PR-E — a candidate whose own score reason says `rejected:` was still winning. The 50-row dry run
// on main (run 31464546504, row 3041 제이케이모터스) took `helpdesk@worxphere.ai` off a JobKorea
// company listing: the page is a platform listing, so the reason recorded
// `rejected:platform-path`, but the score stayed finite because the address is on a *third* domain
// rather than the listing host, and selection keys off the score alone.
//
// The `rejected:` marker means the source disowns the address. That verdict has to bind selection
// on both the public-web and JobSite paths, and must not end the search early. An address on the
// company's own official domain is unaffected — ownership outranks the source's shape.
// ---------------------------------------------------------------------------

const JK_MOTORS = { companyName: "제이케이모터스", region: "울산", address: "울산 남구 삼산로 300" };
const JOBKOREA_LISTING_URL = "https://www.jobkorea.co.kr/company/42884449";
const JK_LISTING_TEXT = "제이케이모터스 채용 문의 담당자 이메일 helpdesk@worxphere.ai 울산 남구 삼산로 300";

// Test A — the recorded row 3041 case on the public-web discovery path.
test("PR-E: a rejected candidate does not win on the public-web path", async () => {
  const queries = [];
  const result = await discoverEmail(JK_MOTORS, {
    searchProvider: singleSourceProvider(JOBKOREA_LISTING_URL, JK_LISTING_TEXT, { queries }),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "", "an address the source disowns is never the company email");
  assert.notEqual(result.email, "helpdesk@worxphere.ai");
  assert.equal(queries.length, 6, "the search continues — a rejected candidate never ends it early");
});

// Test B — the same page reached through the JobSite provider.
test("PR-E: a rejected candidate does not win on the JobSite path", async () => {
  const provider = new JobSiteDiscoveryProvider({
    searchProvider: singleSourceProvider(JOBKOREA_LISTING_URL, JK_LISTING_TEXT),
    fetchImpl: noopFetch,
  });

  const result = await provider.discover(JK_MOTORS, {});

  assert.equal(result.email, "", "the JobSite path applies the same verdict");
  assert.notEqual(result.email, "helpdesk@worxphere.ai");
});

// Test C — the row still completes normally: no provider failure, no site-access failure.
test("PR-E: a rejected candidate is not a provider or site-access failure", async () => {
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    ...singleSourceProvider(JOBKOREA_LISTING_URL, JK_LISTING_TEXT),
  };
  const row = ["제이케이모터스", "자동차", "", "울산", "울산 남구 삼산로 300", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 3041, row }, { homepageProvider, fetchImpl: noopFetch, debug: true });

  assert.equal(result.updates.email, undefined, "the disowned address is not written to the row");
  assert.notEqual(result.failureCode, "site_access_failed", "a rejected candidate is not a site access failure");
  assert.notEqual(result.stopReason, "email_found_public_web", "the row no longer ends as a find");
  assert.equal(
    (result.debug.rejectedEmails || []).includes("helpdesk@worxphere.ai"),
    true,
    "the candidate is recorded as rejected, so the reason stays auditable",
  );
});

// Test D — over-blocking guard: the company's own address on the very same listing still wins.
// A listing page is not ownership evidence, but the official domain is.
test("PR-E: an official-domain address on a listing page is still collected", async () => {
  const text = "제이케이모터스 채용 문의 담당자 이메일 recruit@jkmotors.co.kr 울산 남구 삼산로 300";
  const result = await discoverEmail(JK_MOTORS, {
    homepage: "https://www.jkmotors.co.kr/",
    searchProvider: singleSourceProvider(JOBKOREA_LISTING_URL, text),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "recruit@jkmotors.co.kr", "ownership outranks the shape of the page it was found on");
});

// Test E — over-blocking guard: an ordinary business address on an ordinary page is untouched.
test("PR-E: a normal public business email is still collected", async () => {
  const result = await discoverEmail(JK_MOTORS, {
    searchProvider: singleSourceProvider(
      "https://jkmotors.co.kr/contact",
      "제이케이모터스 울산 남구 삼산로 300 문의 info@jkmotors.co.kr",
    ),
    fetchImpl: noopFetch,
  });

  assert.equal(result.email, "info@jkmotors.co.kr", "an ordinary company page keeps working");
});

// Test F — the JobSite path keeps collecting a genuine job-board contact that nothing disowns.
test("PR-E: a JobSite candidate with no rejection marker still wins", async () => {
  const url = "https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=12345678";
  const text = "제이케이모터스 인사담당자 이메일 hr@jkmotors.co.kr 울산 남구 삼산로 300";
  const provider = new JobSiteDiscoveryProvider({
    searchProvider: singleSourceProvider(url, text),
    fetchImpl: noopFetch,
  });

  const result = await provider.discover(JK_MOTORS, {});

  assert.equal(result.email, "hr@jkmotors.co.kr", "a job posting that discloses the company's own address still counts");
});

// Test G — the earlier press and board verdicts are unchanged by the widened rule.
test("PR-E: press and board rejections still hold", async () => {
  const cases = [
    {
      url: "https://www.busan.com/view/busan/view.php?code=2022051609321030583",
      text: "포드링컨 울산전시장 울산 남구 삼산로 200 기자 person1@busan.com",
    },
    {
      url: "https://regional-association.or.kr/bbs/notice/view?id=123",
      text: "포드링컨 울산전시장 울산 남구 삼산로 200 공지 office@regional-association.or.kr",
    },
  ];
  for (const { url, text } of cases) {
    const result = await discoverEmail(FORD_ULSAN, {
      homepage: "https://www.suninford.co.kr/",
      searchProvider: singleSourceProvider(url, text),
      fetchImpl: noopFetch,
    });
    assert.equal(result.email, "", `${url} must still be rejected`);
  }
});

// ---------------------------------------------------------------------------
// PR-E normal candidates — the rejection rules above must not cost the row its real answer. These
// pin the three findings of run 31464546504 that are legitimate, at the point that matters: the
// address actually written to the row. Row 3041 is the negative half of the same run; row 3059 is
// deliberately left out and tracked as a separate follow-up.
// ---------------------------------------------------------------------------

// N1 — row 3030, taken off the dealer site's own detail page, alongside a listing that is vetoed.
// Both candidates arrive in the same result set, so this also pins that the veto removes only the
// disowned one.
test("PR-E N1: row 3030 selects webmaster@ulsancar.com as the written winner", async () => {
  const dealerUrl = "https://ulsancar.kr/car/car_detail.html?DemoNo=0761600381";
  const dealerText = "솔로몬자동차매매상사 울산 남구 삼산로 100 문의 webmaster@ulsancar.com";
  const listingUrl = "https://www.jobkorea.co.kr/company/42884449";
  const listingText = "솔로몬자동차매매상사 채용 문의 담당자 이메일 helpdesk@worxphere.ai 울산 남구 삼산로 100";
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      return [
        { url: listingUrl, title: "솔로몬자동차매매상사 채용", snippet: listingText, source: "playwright-naver" },
        { url: dealerUrl, title: "솔로몬자동차매매상사", snippet: dealerText, source: "playwright-naver" },
      ];
    },
    async readPageText(url) {
      return String(url).includes("jobkorea") ? listingText : dealerText;
    },
  };
  const row = ["솔로몬자동차매매상사", "자동차", "", "울산", "울산 남구 삼산로 100", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 3030, row }, { homepageProvider, fetchImpl: noopFetch, debug: true });

  assert.equal(result.updates.email, "webmaster@ulsancar.com", "the dealer site address is the written winner");
  assert.equal(result.emailUpdated, true);
  assert.equal(result.debug.selectedEmail, "webmaster@ulsancar.com");
  assert.equal(result.stopReason, "email_found_public_web", "found on the public-web path, as in the run");
  assert.equal(
    (result.debug.rejectedEmails || []).includes("helpdesk@worxphere.ai"),
    true,
    "the listing candidate is vetoed in the same pass without costing the row its answer",
  );
});

// N2 — row 3035, the same address off the dealer site root.
test("PR-E N2: row 3035 selects webmaster@ulsancar.com as the written winner", async () => {
  const url = "https://ulsancar.kr/";
  const text = "중고자동차울산 울산 남구 삼산로 200 문의 webmaster@ulsancar.com";
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    ...singleSourceProvider(url, text),
  };
  const row = ["중고자동차울산", "자동차", "", "울산", "울산 남구 삼산로 200", "", "", "", "", "", "", "", ""];

  const result = await enrichCandidate({ rowNumber: 3035, row }, { homepageProvider, fetchImpl: noopFetch, debug: true });

  assert.equal(result.updates.email, "webmaster@ulsancar.com", "the dealer site address is the written winner");
  assert.equal(result.emailUpdated, true);
  assert.equal(result.debug.selectedEmail, "webmaster@ulsancar.com");
  assert.equal(result.stopReason, "email_found_public_web", "found on the public-web path, as in the run");
});

// N3 — row 3060, resolved by the Fast Path off the homepage already stored on the row. No search
// runs at all, so this pins that the veto never reaches the Fast Path.
test("PR-E N3: row 3060 selects mbk_cs@mercedes-benz.com via the homepage Fast Path", async () => {
  let crawls = 0;
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search() {
      throw new Error("Fast Path should have resolved this row without searching");
    },
  };
  const fetchImpl = async () => {
    crawls += 1;
    return new Response("메르세데스벤츠 고객센터 문의 mbk_cs@mercedes-benz.com", { status: 200 });
  };
  const row = [
    "메르세데스벤츠 스타자동차 울산전시장",
    "자동차",
    "",
    "울산",
    "울산 남구 삼산로 500",
    "",
    "https://www.mercedes-benz.co.kr/",
    "",
    "",
    "",
    "",
    "",
    "",
  ];

  const result = await enrichCandidate({ rowNumber: 3060, row }, { homepageProvider, fetchImpl, debug: true });

  assert.equal(crawls > 0, true, "the stored homepage is crawled");
  assert.equal(result.updates.email, "mbk_cs@mercedes-benz.com", "the homepage address is the written winner");
  assert.equal(result.emailUpdated, true);
  assert.equal(result.debug.selectedEmail, "mbk_cs@mercedes-benz.com");
  assert.equal(result.stopReason, "email_found_fast_path", "resolved by the Fast Path, as in the run");
  assert.equal(result.fastPathSucceeded, true);
  assert.equal(result.debug.fastPathSuppressedReason, undefined, "a real homepage is never suppressed");
});
