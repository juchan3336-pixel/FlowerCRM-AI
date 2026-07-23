import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LeadCollector, duplicateKey, isRegionMatch } from "../src/collector.js";
import { randomInt } from "../src/delay.js";
import { getTargetSpreadsheet, readExistingCollectKeys } from "../src/googleSheets.js";
import { isIndustryMatch } from "../src/industryFilter.js";
import { companyKey, normalizePhone } from "../src/normalize.js";
import { buildSummaryReport, countBy } from "../src/report.js";
import { kakaoPlaceKeyFromUrl, placeKeyFromRow, toSheetRows } from "../src/rows.js";
import { scoreIndustry } from "../src/scoring.js";
import {
  buildCollectLogMemo,
  buildCollectProviders,
  buildComboFallbackQueries,
  buildKakaoQueries,
  buildQueue,
  cardDuplicateKey,
  cleanKakaoPlaceName,
  createRuntimeAbort,
  getQueueRunStopReason,
  knownCardSkipReason,
  loadOrCreateQueue,
  normalizeKakaoHomepageUrl,
  normalizeQueueAttempts,
  normalizeQueueIndex,
  resolveQueueAdvance,
} from "../src/queueCollect.js";

test("scores industries by requested flower sales priority", () => {
  assert.equal(scoreIndustry("건설회사"), "A");
  assert.equal(scoreIndustry("병원"), "A");
  assert.equal(scoreIndustry("제조업체"), "B");
  assert.equal(scoreIndustry("자동차 딜러"), "B");
  assert.equal(scoreIndustry("법무법인"), "C");
});

test("normalizes company and phone values", () => {
  assert.equal(companyKey("(주) 부산건설"), companyKey("주식회사부산건설"));
  assert.equal(normalizePhone("051-123-4567"), "0511234567");
  assert.equal(duplicateKey("(주) 부산건설", "051-123-4567"), "부산건설|0511234567");
});

test("checks region mismatch by address text", () => {
  assert.equal(isRegionMatch("부산", "부산 해운대구 센텀중앙로 1"), true);
  assert.equal(isRegionMatch("김해", "경남 창원시 의창구 1"), false);
  assert.equal(isRegionMatch("울산", ""), true);
});

test("rejects noisy Kakao keyword matches for the requested industry", () => {
  assert.equal(isIndustryMatch("건설회사", "서비스,산업 > 건설,건축 > 건설자재 > 조경자재", "그린팜농업회사법인"), false);
  assert.equal(isIndustryMatch("시행사", "의료,건강 > 의료단체", "부산사설구급차 행사의료지원 고인 이송"), false);
  assert.equal(isIndustryMatch("시행사", "서비스,산업 > 마케팅 > 판촉,기념물", "행사몰"), false);
  assert.equal(isIndustryMatch("종합건설", "서비스,산업 > 건설,건축 > 종합건설사", "우성종합건설"), true);
  assert.equal(isIndustryMatch("렌터카", "렌터카", "SK렌터카 인천연수지점"), true);
  assert.equal(isIndustryMatch("자동차 딜러", "렌터카", "SK렌터카 인천연수지점"), false);
  assert.equal(isIndustryMatch("카셰어링", "카셰어링", "쏘카존 인천공항"), true);
});

test("collector records exclusion stats", async () => {
  const provider = {
    async search() {
      return [
        { companyName: "주식회사 부산건설", industry: "서비스,산업 > 건설,건축 > 종합건설사", address: "부산 부산진구", phone: "051-111-2222" },
        { companyName: "(주) 부산건설", industry: "서비스,산업 > 건설,건축 > 종합건설사", address: "부산 부산진구", phone: "051-111-2222" },
        { companyName: "경남병원", industry: "의료,건강 > 병원", address: "창원 성산구", phone: "055-111-2222" },
        { companyName: "전화없는회사", industry: "서비스,산업 > 호텔", address: "부산 해운대구", phone: "" },
        { companyName: "그린팜농업회사법인", industry: "서비스,산업 > 건설,건축 > 건설자재 > 조경자재", address: "부산 기장군", phone: "051-621-9986" },
      ];
    },
  };
  const collector = new LeadCollector({ providers: [provider], extractEmails: false });
  const { leads, stats } = await collector.collectWithStats({
    regions: ["부산"],
    industries: ["건설회사"],
    perQuery: 10,
    delayMinMs: 0,
    delayMaxMs: 0,
  });

  assert.equal(leads.length, 1);
  assert.deepEqual(stats, {
    totalAttempts: 5,
    duplicateExcluded: 1,
    missingPhoneExcluded: 1,
    regionMismatchExcluded: 1,
    industryMismatchExcluded: 1,
  });
});

test("sheet rows match the requested 13-column Google Sheets layout", () => {
  const rows = toSheetRows([
    {
      companyName: "부산건설",
      industry: "건설회사",
      detailIndustry: "건설 / 종합건설",
      region: "부산",
      address: "부산시",
      phone: "051-111-2222",
      homepage: "https://example.com/",
      email: "info@example.com",
      sourceUrl: "https://source.example/",
      collectedAt: "2026-06-29",
      grade: "A",
      salesStatus: "신규",
      memo: "",
    },
  ]);

  assert.equal(rows[0].length, 13);
  assert.equal(rows[1].length, 13);
  assert.equal(rows[0][2], "세부업종");
  assert.equal(rows[1][11], "신규");
});

test("collector can stop after the requested total limit", async () => {
  const provider = {
    async search() {
      return Array.from({ length: 10 }, (_, index) => ({
        companyName: `테스트병원${index}`,
        industry: "의료,건강 > 병원",
        address: "부산 해운대구",
        phone: `051-200-${String(index).padStart(4, "0")}`,
      }));
    },
  };
  const collector = new LeadCollector({ providers: [provider], extractEmails: false });
  const { leads } = await collector.collectWithStats({
    regions: ["부산", "김해"],
    industries: ["병원", "건설회사"],
    perQuery: 10,
    limit: 3,
    delayMinMs: 0,
    delayMaxMs: 0,
  });

  assert.equal(leads.length, 3);
});

test("random delay helper returns a value inside the configured range", () => {
  for (let index = 0; index < 20; index += 1) {
    const value = randomInt(3000, 8000);
    assert.equal(value >= 3000, true);
    assert.equal(value <= 8000, true);
  }
});

test("builds summary report with inserted industry and grade counts", () => {
  const report = buildSummaryReport(
    {
      totalAttempts: 10,
      duplicateExcluded: 2,
      missingPhoneExcluded: 1,
      regionMismatchExcluded: 1,
      industryMismatchExcluded: 1,
    },
    {
      inserted: 4,
      skipped: 2,
      industryCounts: { 건설회사: 3, 병원: 1 },
      gradeCounts: { A: 4 },
    },
  );

  assert.equal(report.totalAttempts, 10);
  assert.equal(report.inserted, 4);
  assert.equal(report.duplicateExcluded, 4);
  assert.equal(report.industryMismatchExcluded, 1);
  assert.deepEqual(report.industryCounts, { 건설회사: 3, 병원: 1 });
  assert.deepEqual(countBy([{ grade: "A" }, { grade: "B" }, { grade: "A" }], "grade"), { A: 2, B: 1 });
});

test("queued collect builds the full operating queue", () => {
  const queue = buildQueue();

  assert.equal(queue.items.length, 1727);
  assert.deepEqual(queue.regions, ["부산", "김해", "양산", "창원", "울산", "경남", "대구", "경북", "서울", "경기", "인천"]);
  assert.equal(queue.categories.includes("자동차딜러"), true);
  assert.equal(queue.categories.includes("렌터카"), true);
  assert.equal(queue.categories.includes("카셰어링"), true);
  assert.equal(queue.categories.includes("요양병원"), true);
  assert.equal(queue.categories.includes("웨딩홀"), true);
  assert.equal(queue.items[0].query, "부산 건설회사");
  assert.equal(queue.items.some((item) => item.group === "자동차" && item.category === "렌터카" && item.query === "인천 렌터카"), true);
  assert.equal(queue.items.some((item) => item.category === "자동차딜러" && item.keyword === "렌터카"), false);
  assert.equal(queue.items.at(-1).query, "인천 푸드프랜차이즈");
  assert.equal(normalizeQueueIndex("35", queue.items.length), 35);
  assert.equal(normalizeQueueIndex("9999", queue.items.length), 0);
});

test("queued collect keeps the queue keyword in every Kakao query variant", () => {
  assert.deepEqual(
    buildKakaoQueries({
      region: "부산",
      category: "자동차딜러",
      industry: "자동차 딜러",
      keyword: "수입차딜러",
    }),
    ["부산 수입차딜러", "부산 자동차 딜러 수입차딜러"],
  );
});

test("hospital queue uses its own keyword instead of the shared hospital plan", () => {
  assert.deepEqual(
    buildKakaoQueries({
      region: "김해",
      category: "병원",
      industry: "병원",
      keyword: "의원",
    }),
    ["김해 의원", "김해 병원 의원"],
  );

  assert.deepEqual(
    buildKakaoQueries({
      region: "경북",
      category: "병원",
      industry: "병원",
      keyword: "요양병원",
    }),
    ["경북 요양병원", "경북 병원 요양병원"],
  );

  // A queue whose keyword equals its category collapses to the single primary query.
  assert.deepEqual(
    buildKakaoQueries({ region: "경북", category: "병원", industry: "병원", keyword: "병원" }),
    ["경북 병원"],
  );
});

test("every hospital queue keyword produces a distinct primary query", () => {
  const queue = buildQueue();
  const hospitalQueues = queue.items.filter((item) => item.region === "경북" && item.category === "병원");
  const primaries = hospitalQueues.map((item) => buildKakaoQueries(item)[0]);

  assert.deepEqual(primaries, ["경북 병원", "경북 종합병원", "경북 요양병원", "경북 정형외과", "경북 내과", "경북 의원"]);
  assert.equal(new Set(primaries).size, primaries.length);
  for (const item of hospitalQueues) {
    for (const query of buildKakaoQueries(item)) {
      assert.equal(query.includes(item.keyword), true, `${query} must keep keyword ${item.keyword}`);
    }
  }
});

test("combo fallback widens the qualifier but never drops the queue keyword", () => {
  assert.deepEqual(
    buildComboFallbackQueries({ region: "김해", category: "병원", industry: "병원", keyword: "요양병원" }),
    ["김해 병원 요양병원"],
  );

  // A queue whose keyword is its own category collapses instead of repeating the token.
  assert.deepEqual(
    buildComboFallbackQueries({ region: "김해", category: "병원", industry: "병원", keyword: "병원" }),
    ["김해 병원"],
  );

  assert.deepEqual(
    buildComboFallbackQueries({ region: "부산", category: "자동차딜러", industry: "자동차 딜러", keyword: "수입차딜러" }),
    ["부산 자동차 딜러 수입차딜러"],
  );
});

test("no query for any queue in the plan can omit its keyword", () => {
  const queue = buildQueue();
  const offenders = [];

  for (const item of queue.items) {
    for (const query of [...buildKakaoQueries(item), ...buildComboFallbackQueries(item)]) {
      if (!query.includes(item.keyword)) offenders.push(`${item.id} ${item.keyword} -> ${query}`);
      if (!query.includes(item.region)) offenders.push(`${item.id} ${item.region} -> ${query}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("hospital queues never fall back to the bare category search", () => {
  const queue = buildQueue();
  const hospital = queue.items.filter((item) => item.region === "경북" && item.category === "병원");
  const banned = new Set(["경북 병원", "경북 의원", "경북 내과", "경북 정형외과", "경북 치과", "경북 한의원"]);

  for (const item of hospital) {
    const queries = [...buildKakaoQueries(item), ...buildComboFallbackQueries(item)];
    for (const query of queries) {
      // "경북 병원" is only legal for the queue whose own keyword is 병원.
      if (banned.has(query)) assert.equal(query, `경북 ${item.keyword}`, `${item.keyword} produced ${query}`);
    }
  }

  assert.deepEqual(buildComboFallbackQueries(hospital.find((item) => item.keyword === "요양병원")), ["경북 병원 요양병원"]);
});

test("queued collect stop reason honors limit, queue, and runtime caps", () => {
  assert.equal(getQueueRunStopReason({ leadsCount: 300, limit: 300, queueVisits: 10 }), "limit_reached");
  assert.equal(getQueueRunStopReason({ leadsCount: 20, limit: 300, queueVisits: 40, maxQueueVisits: 40 }), "max_queue_visited");
  assert.equal(
    getQueueRunStopReason({
      leadsCount: 20,
      limit: 300,
      queueVisits: 10,
      startedAt: 0,
      now: 20 * 60 * 1000,
      maxRuntimeMs: 20 * 60 * 1000,
    }),
    "max_runtime_reached",
  );
});

test("collect providers use Kakao Map card locator by default", () => {
  const names = buildCollectProviders().map((provider) => provider.name);

  assert.deepEqual(names, ["kakao-map"]);
  assert.equal(names.includes("naver-search"), false);
  assert.equal(names.includes("google-search"), false);
});

test("collect providers keep Kakao API opt-in only", () => {
  const originalUseKakaoApiProvider = process.env.USE_KAKAO_API_PROVIDER;
  const originalKakaoRestApiKey = process.env.KAKAO_REST_API_KEY;

  try {
    delete process.env.USE_KAKAO_API_PROVIDER;
    delete process.env.KAKAO_REST_API_KEY;
    assert.deepEqual(buildCollectProviders().map((provider) => provider.name), ["kakao-map"]);

    process.env.USE_KAKAO_API_PROVIDER = "true";
    delete process.env.KAKAO_REST_API_KEY;
    assert.deepEqual(buildCollectProviders().map((provider) => provider.name), ["kakao-map"]);

    process.env.USE_KAKAO_API_PROVIDER = "true";
    process.env.KAKAO_REST_API_KEY = "test-key";
    assert.deepEqual(buildCollectProviders().map((provider) => provider.name), ["kakao-map", "kakao-api"]);
  } finally {
    if (originalUseKakaoApiProvider === undefined) delete process.env.USE_KAKAO_API_PROVIDER;
    else process.env.USE_KAKAO_API_PROVIDER = originalUseKakaoApiProvider;

    if (originalKakaoRestApiKey === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = originalKakaoRestApiKey;
  }
});

test("collect stores only external homepage href from Kakao detail", () => {
  assert.equal(normalizeKakaoHomepageUrl("https://example-hospital.co.kr/"), "https://example-hospital.co.kr/");
  assert.equal(
    normalizeKakaoHomepageUrl("https://place.map.kakao.com/out?url=https%3A%2F%2Fexample-hospital.co.kr%2F"),
    "https://example-hospital.co.kr/",
  );
  assert.equal(
    normalizeKakaoHomepageUrl("/out?target=https%3A%2F%2Fdealer.example.com%2F", "https://place.map.kakao.com/123456"),
    "https://dealer.example.com/",
  );
  assert.equal(normalizeKakaoHomepageUrl("/123456"), "");
  assert.equal(normalizeKakaoHomepageUrl("https://place.map.kakao.com/123456"), "");
  assert.equal(normalizeKakaoHomepageUrl("https://map.kakao.com/?q=test#none"), "");
  assert.equal(normalizeKakaoHomepageUrl("javascript:void(0)"), "");
  assert.equal(normalizeKakaoHomepageUrl("tel:0511234567"), "");
});

test("collect strips Kakao card markers from place names", () => {
  assert.equal(cleanKakaoPlaceName("A 현대자동차 광장대리점"), "현대자동차 광장대리점");
  assert.equal(cleanKakaoPlaceName("K 신월동자동차매매시장"), "신월동자동차매매시장");
  assert.equal(cleanKakaoPlaceName("현대자동차 광장대리점"), "현대자동차 광장대리점");
});

test("google sheets saves data tabs at the bottom with explicit A:M ranges", () => {
  const source = fs.readFileSync(new URL("../src/googleSheets.js", import.meta.url), "utf8");

  assert.equal(source.includes("writeRowsAtBottom(spreadsheetId, PRIMARY_DB_SHEET_NAME, rows)"), true);
  assert.equal(source.includes("writeRowsAtBottom(spreadsheetId, NEW_COMPANY_SHEET_NAME, rows)"), true);
  assert.equal(source.includes("appendRows(spreadsheetId, PRIMARY_DB_SHEET_NAME, rows)"), false);
  assert.equal(source.includes("appendRows(spreadsheetId, NEW_COMPANY_SHEET_NAME, rows)"), false);
  assert.equal(source.includes('appendRows(spreadsheetId, LOG_SHEET_NAME, [row], "L")'), true);
});

test("collect no longer parses full HTML with Playwright eval helpers", () => {
  const source = fs.readFileSync(new URL("../src/queueCollect.js", import.meta.url), "utf8");

  assert.equal(source.includes("$$eval"), false);
  assert.equal(source.includes("extractBrowserDocuments"), false);
});

test("collect paginates Kakao Map place results after place more", () => {
  const source = fs.readFileSync(new URL("../src/queueCollect.js", import.meta.url), "utf8");

  assert.equal(source.includes("openKakaoPlaceMore(page)"), true);
  assert.equal(source.includes("goToNextKakaoResultPage(page, pageNumber)"), true);
  assert.equal(source.includes("#info\\\\.search\\\\.place\\\\.more"), true);
  assert.equal(source.includes("#info\\\\.search\\\\.page\\\\.next"), true);
  assert.equal(source.includes("clickKakaoControlInPage(page, control)"), true);
  assert.equal(source.includes("pageNumber <= MAX_KAKAO_PAGE"), true);
});

test("collect reads Kakao detail addresses from real address text", () => {
  const source = fs.readFileSync(new URL("../src/queueCollect.js", import.meta.url), "utf8");

  assert.equal(source.includes(".detail_info .txt_detail"), true);
  assert.equal(source.includes("[class*='address']"), false);
});

test("collect preserves Kakao card homepage fallback after detail lookup", () => {
  const source = fs.readFileSync(new URL("../src/queueCollect.js", import.meta.url), "utf8");

  assert.equal(source.includes("KAKAO_CARD_HOMEPAGE_SELECTORS"), true);
  assert.equal(source.includes("homepage_url: detail.homepage_url || cardSummary.homepage_url || \"\""), true);
  assert.equal(source.includes("firstNormalizedKakaoHomepageUrl(card, KAKAO_CARD_HOMEPAGE_SELECTORS, placeUrl)"), true);
  assert.equal(source.includes("expandKakaoDetailSections(page)"), true);
});

test("kakao place keys are parsed as URLs, not pattern-matched", () => {
  const accepted = [
    ["http://place.map.kakao.com/12345", "kakao:12345"],
    ["https://place.map.kakao.com/12345", "kakao:12345"],
    ["https://place.map.kakao.com/12345/", "kakao:12345"],
    ["https://place.map.kakao.com/12345?ref=x", "kakao:12345"],
    ["https://place.map.kakao.com/12345#none", "kakao:12345"],
    ["  https://place.map.kakao.com/12345  ", "kakao:12345"],
    ["https://PLACE.MAP.KAKAO.COM/12345", "kakao:12345"],
  ];
  for (const [input, expected] of accepted) {
    assert.equal(kakaoPlaceKeyFromUrl(input), expected, `should accept ${input}`);
  }

  const rejected = [
    // The host appears in the string but is not the host - the decisive case.
    "https://example.com/?target=https://place.map.kakao.com/12345",
    "https://example.com/place.map.kakao.com/12345",
    "https://notplace.map.kakao.com/12345",
    "https://place.map.kakao.com.evil.test/12345",
    "https://place.map.kakao.com/place/12345",
    "https://place.map.kakao.com/",
    "https://place.map.kakao.com/abc",
    "https://place.map.kakao.com/12345/extra",
    "https://map.kakao.com/?q=test",
    "https://openapi.naver.com/v1/search/local.json",
    "place.map.kakao.com/12345",
    "not a url",
    "",
  ];
  for (const input of rejected) {
    assert.equal(kakaoPlaceKeyFromUrl(input), "", `should reject ${input}`);
  }

  assert.equal(kakaoPlaceKeyFromUrl(undefined), "");
  assert.equal(kakaoPlaceKeyFromUrl(null), "");

  assert.equal(placeKeyFromRow(["회사", "", "", "", "", "051-1-2345", "", "", "http://place.map.kakao.com/1"]), "kakao:1");
  assert.equal(placeKeyFromRow(["회사"]), "");
});

test("card duplicate key strips the Kakao marker prefix and needs a phone", () => {
  assert.equal(cardDuplicateKey({ place_name: "A 부산건설", phone: "051-111-2222" }), duplicateKey("부산건설", "051-111-2222"));
  assert.equal(cardDuplicateKey({ place_name: "(주) 부산건설", phone: "051-111-2222" }), "부산건설|0511234567".replace("0511234567", "0511112222"));
  assert.equal(cardDuplicateKey({ place_name: "부산건설", phone: "" }), "");
  assert.equal(cardDuplicateKey({ place_name: "", phone: "051-111-2222" }), "");
});

test("pre-detail skip only fires on an exact match against stored data", () => {
  const context = {
    existingPlaceKeys: new Set(["kakao:9813680"]),
    existingKeys: new Set([duplicateKey("부산건설", "051-111-2222")]),
    runKeys: new Set([duplicateKey("울산호텔", "052-333-4444")]),
  };

  // 1) Known Kakao place id, even though the stored row used the http scheme.
  assert.equal(
    knownCardSkipReason({ place_url: "https://place.map.kakao.com/9813680", place_name: "무관한 이름" }, context),
    "place_key",
  );
  // 2) Known company name + phone, with the marker prefix the card list adds.
  assert.equal(
    knownCardSkipReason({ place_url: "https://place.map.kakao.com/1", place_name: "A 부산건설", phone: "051-111-2222" }, context),
    "card_key",
  );
  // 3) Already collected during this run.
  assert.equal(
    knownCardSkipReason({ place_url: "https://place.map.kakao.com/2", place_name: "울산호텔", phone: "052-333-4444" }, context),
    "card_key",
  );
  // 4) Unknown place -> still opens the detail page.
  assert.equal(
    knownCardSkipReason({ place_url: "https://place.map.kakao.com/3", place_name: "신규건설", phone: "051-999-8888" }, context),
    "",
  );
  // 5) No phone on the card -> never skipped, because the stored key always carries a phone.
  assert.equal(
    knownCardSkipReason({ place_url: "https://place.map.kakao.com/4", place_name: "부산건설", phone: "" }, context),
    "",
  );
  // 6) Card with an unparseable detail url falls back to the name+phone rule only.
  assert.equal(knownCardSkipReason({ place_url: "", place_name: "부산건설", phone: "051-111-2222" }, context), "card_key");
  // 7) Empty context never skips.
  assert.equal(knownCardSkipReason({ place_url: "https://place.map.kakao.com/9813680" }, {}), "");
});

test("runtime abort flips exactly at the configured cap", () => {
  let now = 0;
  const abort = createRuntimeAbort(0, 1000, () => now);

  assert.equal(abort.exceeded(), false);
  now = 999;
  assert.equal(abort.exceeded(), false);
  now = 1000;
  assert.equal(abort.exceeded(), true);
  now = 5000;
  assert.equal(abort.exceeded(), true);
});

test("incomplete queues keep their index and are retried, never force-advanced", () => {
  const queue = { items: [{ id: "1" }, { id: "2" }, { id: "3" }] };

  const completed = resolveQueueAdvance({ queue, queueIndex: 0, completed: true, attempts: 2 });
  assert.deepEqual(completed, { nextIndex: 1, attempts: 0, advanced: true });

  // The index never moves while the queue is incomplete, no matter how many attempts pile up.
  for (const attempts of [0, 1, 2, 5, 99]) {
    assert.deepEqual(resolveQueueAdvance({ queue, queueIndex: 1, completed: false, attempts }), {
      nextIndex: 1,
      attempts: attempts + 1,
      advanced: false,
    });
  }

  // Wrap-around stays inside the queue.
  assert.equal(resolveQueueAdvance({ queue, queueIndex: 2, completed: true }).nextIndex, 0);

  assert.equal(normalizeQueueAttempts("2"), 2);
  assert.equal(normalizeQueueAttempts(""), 0);
  assert.equal(normalizeQueueAttempts("abc"), 0);
  assert.equal(normalizeQueueAttempts(-1), 0);
});

test("queue advance exposes no force-advance switch", () => {
  const source = fs.readFileSync(new URL("../src/queueCollect.js", import.meta.url), "utf8");

  assert.equal(source.includes("MAX_QUEUE_ATTEMPTS"), false);
  assert.equal(source.includes("forcedAdvances"), false);
  assert.equal(source.includes("queue_force_advanced"), false);

  // An unknown option cannot re-enable advancing on an incomplete queue.
  const queue = { items: [{ id: "1" }, { id: "2" }] };
  assert.equal(resolveQueueAdvance({ queue, queueIndex: 0, completed: false, maxAttempts: 1 }).nextIndex, 0);
});

test("collect log memo carries the new metrics inside the existing 12 columns", () => {
  const memo = buildCollectLogMemo({
    stopReason: "max_runtime_reached",
    cardsScanned: 500,
    preSkippedTotal: 385,
    preSkippedByPlaceKey: 380,
    preSkippedByCardKey: 5,
    detailFetched: 115,
    addressMissing: 3,
    abortedQueues: 1,
    queueAttempts: 1,
  });

  assert.equal(
    memo,
    "max_runtime_reached; cards=500; preSkipped=385(place=380,card=5); detail=115; addressMissing=3; abortedQueues=1; queueAttempts=1",
  );
});

test("dry-run never writes the local queue file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowercrm-queue-"));
  const cwd = process.cwd();
  const queuePath = path.join(dir, "collect_queue.json");
  try {
    process.chdir(dir);

    const queue = loadOrCreateQueue({ persist: false });
    assert.equal(queue.items.length, 1727);
    assert.equal(fs.existsSync(queuePath), false);

    loadOrCreateQueue();
    assert.equal(fs.existsSync(queuePath), true);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withStubbedGoogle(handler, run) {
  const originalFetch = globalThis.fetch;
  const originalAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "test@example.com", private_key: privateKey });

  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    requests.push({ url: href, method: options.method || "GET" });
    if (href.startsWith("https://oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "test-token", expires_in: 3600 });
    }
    return jsonResponse(handler(href, options) ?? {});
  };

  return Promise.resolve(run(requests)).finally(() => {
    globalThis.fetch = originalFetch;
    if (originalAccount === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = originalAccount;
  });
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

test("readExistingCollectKeys returns duplicate keys, place keys and coverage in one pass", async () => {
  await withStubbedGoogle(
    (href) => {
      if (!href.includes("/values/")) return {};
      if (!href.includes(encodeURIComponent("기업 DB"))) return { values: [] };
      return {
        values: [
          ["부산건설", "건설회사", "", "부산", "부산 부산진구", "051-111-2222", "", "", "http://place.map.kakao.com/9813680"],
          ["경남병원", "병원", "", "경남", "경남 창원시", "055-111-2222", "", "", "https://place.map.kakao.com/8151154?from=map"],
          ["출처없는회사", "호텔", "", "울산", "울산 남구", "052-111-2222", "", "", ""],
          ["네이버출처회사", "호텔", "", "울산", "울산 남구", "052-999-2222", "", "", "https://openapi.naver.com/v1/search/local.json"],
          [],
        ],
      };
    },
    async () => {
      const { duplicateKeys, placeKeys, sourceUrlStats } = await readExistingCollectKeys("sheet-collect-keys");

      assert.equal(duplicateKeys.has(duplicateKey("부산건설", "051-111-2222")), true);
      assert.equal(duplicateKeys.size, 4);

      assert.deepEqual([...placeKeys].sort(), ["kakao:8151154", "kakao:9813680"]);

      // Coverage is measured, not assumed: a Naver source url counts as "has a url" but yields no place key.
      assert.deepEqual(sourceUrlStats, { dataRows: 4, withSourceUrl: 3, withPlaceKey: 2 });
    },
  );
});

test("dry-run reads the spreadsheet without issuing any write request", async () => {
  await withStubbedGoogle(
    () => ({ sheets: [], values: [] }),
    async (requests) => {
      await getTargetSpreadsheet({ readOnly: true, spreadsheetName: "dry-run-sheet" });

      const writes = requests.filter((request) => request.method && request.method !== "GET" && !request.url.includes("oauth2"));
      assert.deepEqual(writes, []);
    },
  );
});
