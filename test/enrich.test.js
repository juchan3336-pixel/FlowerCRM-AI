import assert from "node:assert/strict";
import test from "node:test";

import { extractEmailDetails } from "../src/emailExtractor.js";
import { FallbackHomepageSearchProvider, enrichCandidate, pickOfficialHomepage, runEnrich } from "../src/enrich.js";

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
  assert.equal(result.updates.memo.includes("enrich failed=홈페이지 없음"), true);
});

test("runEnrich processes queued rows and persists SYSTEM progress", async () => {
  const written = [];
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
    async updateEnrichRow(spreadsheetId, rowNumber, updates) {
      written.push({ spreadsheetId, rowNumber, updates });
    },
    async writeSystemState(spreadsheetId, updates, memo, existingState) {
      states.push({ spreadsheetId, updates, memo, existingState });
    },
    async appendEnrichLog(spreadsheetId, summary) {
      logs.push({ spreadsheetId, summary });
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
  assert.equal(written.length, 1);
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
});
