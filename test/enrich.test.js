import assert from "node:assert/strict";
import test from "node:test";

import { extractEmailDetails } from "../src/emailExtractor.js";
import {
  FallbackHomepageSearchProvider,
  JobSiteDiscoveryProvider,
  buildHomepageQueries,
  discoverEmail,
  enrichCandidate,
  extractAddressParts,
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
  assert.equal(result.updates.memo.includes("enrich email_source=https://news.example/post"), true);
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
