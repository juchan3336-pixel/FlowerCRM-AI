import assert from "node:assert/strict";
import test from "node:test";

import { extractEmailDetails } from "../src/emailExtractor.js";
import {
  FallbackHomepageSearchProvider,
  GoogleHomepageSearchProvider,
  JobSiteDiscoveryProvider,
  NaverHomepageSearchProvider,
  buildHomepageQueries,
  discoverEmail,
  enrichCandidate,
  extractAddressParts,
  filterSearchResultLinks,
  matchCompanyAddressScore,
  pickOfficialHomepage,
  runEnrich,
  scoreDiscoveredEmail,
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

  assert.deepEqual(readOptions, { spreadsheetId: "sheet-default-start-row", options: { startRow: 17, limit: 10 } });
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

  assert.deepEqual(readOptions, { spreadsheetId: "sheet-explicit-start-row", options: { startRow: 2, limit: 10 } });
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

  assert.deepEqual(readOptions, { spreadsheetId: "sheet-dry-run-start-row", options: { startRow: 2, limit: 10 } });
  assert.equal(summary.startRow, 2);
  assert.deepEqual(summary.sheetsApi, { batchUpdate: 0, append: 0, update: 0, total: 0 });
  assert.deepEqual(writeCalls, []);
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

  await runEnrich({ limit: 1, sheets, homepageProvider, fetchImpl });

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

  assert.deepEqual(queries, [
    "Acme Flower 이메일",
    "Acme Flower 대표메일",
    "Acme Flower 문의",
    "Acme Flower contact",
    "Acme Flower 채용",
    "Acme Flower 사업자등록",
  ]);
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

test("public email discovery uses fetch instead of browser reads for arbitrary public result pages", async () => {
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

  assert.equal(result.email, "fetch-only@acme-flower.co.kr");
  assert.equal(result.sourceName, "browser-fixture");
  assert.deepEqual(pageReads, []);
  assert.deepEqual(fetchReads, ["https://public.example.com/acme"]);
});

test("trusted job-site discovery reads posting bodies with fetch instead of browser", async () => {
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
  assert.deepEqual(pageReads, []);
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

test("job-site discovery reads posting bodies through fetch", async () => {
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
  assert.deepEqual(pageReads, []);
  assert.deepEqual(fetchReads, ["https://www.jobkorea.co.kr/company/seam"]);
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
          return "browser read must not be used for discovery bodies";
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
  assert.equal(calls.some((item) => item.startsWith("fetch:https://www.jobkorea.co.kr/company/default-flow")), true);
  assert.equal(calls.some((item) => item.startsWith("browser-read:https://www.jobkorea.co.kr/company/default-flow")), false);
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
