import assert from "node:assert/strict";
import test from "node:test";

import { extractEmailDetails } from "../src/emailExtractor.js";
import { enrichCandidate, pickOfficialHomepage, runEnrich } from "../src/enrich.js";

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

test("runEnrich processes at most the supplied candidate limit and logs summary", async () => {
  const written = [];
  const logs = [];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-1" };
    },
    async readRowsNeedingEnrichment(spreadsheetId, limit) {
      assert.equal(spreadsheetId, "sheet-1");
      return [
        { rowNumber: 2, row: ["Acme Flower", "flower", "", "Seoul", "", "", "", "", "", "", "", "", ""] },
      ].slice(0, limit);
    },
    async updateEnrichRow(spreadsheetId, rowNumber, updates) {
      written.push({ spreadsheetId, rowNumber, updates });
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
  assert.equal(summary.homepageUpdated, 1);
  assert.equal(summary.emailUpdated, 1);
  assert.equal(written.length, 1);
  assert.equal(logs.length, 1);
});
