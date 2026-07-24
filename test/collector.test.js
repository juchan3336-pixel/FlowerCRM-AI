import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LeadCollector, duplicateKey, isRegionMatch } from "../src/collector.js";
import { randomInt } from "../src/delay.js";
import { COLLECT_SYSTEM_KEYS, ENRICH_SYSTEM_KEYS, SHEET_TABS } from "../src/config.js";
import { getTargetSpreadsheet, readExistingCollectKeys, readSystemState, writeSystemState } from "../src/googleSheets.js";
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
  collectKakaoMapDocuments,
  collectKakaoMapPageDocuments,
  createRuntimeAbort,
  getQueueRunStopReason,
  knownCardSkipReason,
  loadOrCreateQueue,
  normalizeKakaoHomepageUrl,
  normalizeQueueAttempts,
  normalizeQueueIndex,
  readKakaoMapDetail,
  resolveQueueAdvance,
  resolveQueueItemFailure,
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

test("collect paginates Kakao Map place results after place more", async () => {
  // Behavioural rather than source-string: drive the real loop and assert it opened "장소 더보기"
  // and walked to the next result page.
  const search = fakeKakaoSearchPage({ pages: [["1", "2"], ["3"]] });
  const collected = await collectKakaoMapDocuments(search.page, "경북 요양병원", { abort: NEVER_ABORT });

  assert.equal(search.calls.placeMoreClicks, 1, "장소 더보기 must be opened once");
  assert.equal(search.calls.nextPageClicks, 1, "the loop must page forward while cards remain");
  assert.deepEqual(collected.documents.map((document) => document.place_url), [
    "https://place.map.kakao.com/1",
    "https://place.map.kakao.com/2",
    "https://place.map.kakao.com/3",
  ]);
  assert.equal(collected.aborted, false);

  const source = fs.readFileSync(new URL("../src/queueCollect.js", import.meta.url), "utf8");
  assert.equal(source.includes("#info\\\\.search\\\\.place\\\\.more"), true);
  assert.equal(source.includes("#info\\\\.search\\\\.page\\\\.next"), true);
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
  assert.equal(source.includes("expandKakaoDetailSections(page, abort)"), true);
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

// Minimal Playwright stand-in: enough locator surface for the card loop, and it counts how many
// detail tabs were opened so an aborted run can be asserted to issue zero new detail requests.
function fakeKakaoPage({ cards, onNewPage = () => {} }) {
  const calls = { newPage: 0, gotos: [], clicks: 0 };

  const textLocator = (value) => ({
    first: () => textLocator(value),
    count: async () => (value ? 1 : 0),
    innerText: async () => value,
    getAttribute: async () => value,
    nth: () => textLocator(value),
    isVisible: async () => Boolean(value),
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {},
    elementHandle: async () => null,
  });

  const cardLocator = (card) => ({
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {
      calls.clicks += 1;
    },
    locator: (selector) => {
      if (selector.includes("place.map.kakao.com")) return textLocator(card.place_url);
      if (selector.includes("link_name")) return textLocator(card.place_name);
      if (selector.includes("phone")) return textLocator(card.phone || "");
      return textLocator("");
    },
  });

  const context = {
    newPage: async () => {
      calls.newPage += 1;
      onNewPage(calls);
      return {
        goto: async (url) => {
          calls.gotos.push(url);
        },
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        url: () => "https://place.map.kakao.com/detail",
        close: async () => {},
        locator: () => textLocator(""),
      };
    },
  };

  return {
    calls,
    page: {
      context: () => context,
      locator: () => ({
        count: async () => cards.length,
        nth: (index) => cardLocator(cards[index]),
      }),
    },
  };
}

const NEVER_ABORT = { exceeded: () => false };
const ALREADY_EXPIRED = { exceeded: () => true };

// Search-results stand-in for collectKakaoMapDocuments(). Every navigation-ish operation is
// counted separately so a test can prove which one did NOT start after the deadline.
function fakeKakaoSearchPage({ pages = [[]], onOperation = () => {} } = {}) {
  const calls = {
    waitForLoadState: 0,
    waitForTimeout: 0,
    cardCounts: 0,
    placeMoreClicks: 0,
    nextPageClicks: 0,
    detailPages: 0,
    detailCloses: 0,
    order: [],
  };
  let pageIndex = 0;

  const record = (name) => {
    calls[name] += 1;
    calls.order.push(name);
    onOperation(name, calls);
  };

  const control = (kind) => ({
    isVisible: async () => true,
    getAttribute: async () => "",
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {
      record(kind);
      if (kind === "nextPageClicks") pageIndex += 1;
    },
    elementHandle: async () => null,
  });

  const textLocator = (value) => ({
    first: () => textLocator(value),
    count: async () => (value ? 1 : 0),
    innerText: async () => value,
    getAttribute: async () => value,
    nth: () => textLocator(value),
    isVisible: async () => Boolean(value),
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {},
    elementHandle: async () => null,
    waitFor: async () => {},
  });

  const cardLocator = (id) => ({
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {},
    locator: (selector) => {
      if (selector.includes("place.map.kakao.com")) return textLocator(`https://place.map.kakao.com/${id}`);
      if (selector.includes("link_name")) return textLocator(`요양병원${id}`);
      if (selector.includes("phone")) return textLocator("054-000-0000");
      return textLocator("");
    },
  });

  const context = {
    newPage: async () => {
      record("detailPages");
      let currentUrl = "";
      return {
        goto: async (url) => {
          currentUrl = url;
        },
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        url: () => currentUrl,
        close: async () => record("detailCloses"),
        locator: () => textLocator(""),
      };
    },
  };

  const page = {
    context: () => context,
    waitForLoadState: async () => record("waitForLoadState"),
    waitForTimeout: async () => record("waitForTimeout"),
    locator: (selector) => {
      if (selector.includes("place\\.more")) {
        return { count: async () => 1, nth: () => control("placeMoreClicks") };
      }
      if (selector.includes("page\\.next") || selector.includes("page\\.no")) {
        const hasMore = pageIndex + 1 < pages.length;
        return { count: async () => (hasMore ? 1 : 0), nth: () => control("nextPageClicks") };
      }
      // Card list.
      const ids = pages[pageIndex] || [];
      return {
        first: () => textLocator(ids[0] ? `card-${ids[0]}` : ""),
        count: async () => {
          record("cardCounts");
          return ids.length;
        },
        nth: (index) => cardLocator(ids[index]),
      };
    },
  };

  return { page, calls };
}

test("abort after card parsing opens no detail page", async () => {
  const cards = [{ place_url: "https://place.map.kakao.com/1", place_name: "가나요양병원", phone: "054-111-2222" }];
  const { page, calls } = fakeKakaoPage({ cards });
  const documents = [];
  const scan = { cardsScanned: 0, preSkippedByPlaceKey: 0, preSkippedByCardKey: 0, detailFetched: 0 };

  // Deadline passes while the card is being parsed: first check false, every later check true.
  let checks = 0;
  const abort = { exceeded: () => checks++ > 0 };

  const aborted = await collectKakaoMapPageDocuments(page, "경북 요양병원", documents, new Set(), { abort, scan });

  assert.equal(aborted, true);
  assert.equal(calls.newPage, 0, "no detail tab may be created after the deadline");
  assert.equal(calls.clicks, 0, "no card click may be paid for after the deadline");
  assert.deepEqual(documents, []);
  assert.equal(scan.detailFetched, 0);
});

test("abort just before detail page creation opens no detail page", async () => {
  const cards = [{ place_url: "https://place.map.kakao.com/1", place_name: "가나요양병원", phone: "054-111-2222" }];
  const { page, calls } = fakeKakaoPage({ cards });
  const scan = { cardsScanned: 0, preSkippedByPlaceKey: 0, preSkippedByCardKey: 0, detailFetched: 0 };

  // Survive the loop entry, card parsing, dedup and click; expire at the readKakaoMapDetail gate.
  let checks = 0;
  const abort = { exceeded: () => ++checks > 4 };

  const aborted = await collectKakaoMapPageDocuments(page, "경북 요양병원", [], new Set(), { abort, scan });

  assert.equal(aborted, true);
  assert.equal(calls.newPage, 0, "readKakaoMapDetail must re-check before creating the tab");
  assert.deepEqual(calls.gotos, []);
  assert.equal(scan.cardsScanned, 1, "the card was still scanned");
  assert.equal(calls.clicks, 1, "the run reached the click, so the abort came from the detail gate");
  assert.equal(scan.detailFetched, 0);
});

test("a live deadline still fetches details and records them", async () => {
  const cards = [
    { place_url: "https://place.map.kakao.com/1", place_name: "가나요양병원", phone: "054-111-2222" },
    { place_url: "https://place.map.kakao.com/2", place_name: "다라요양병원", phone: "054-333-4444" },
  ];
  const { page, calls } = fakeKakaoPage({ cards });
  const documents = [];
  const scan = { cardsScanned: 0, preSkippedByPlaceKey: 0, preSkippedByCardKey: 0, detailFetched: 0 };

  const aborted = await collectKakaoMapPageDocuments(page, "경북 요양병원", documents, new Set(), { abort: NEVER_ABORT, scan });

  assert.equal(aborted, false);
  assert.equal(calls.newPage, 2);
  assert.equal(scan.detailFetched, 2);
  assert.equal(documents.length, 2);
});

test("a pre-skipped card costs no detail request even with time left", async () => {
  const cards = [{ place_url: "https://place.map.kakao.com/9813680", place_name: "A 가나요양병원", phone: "054-111-2222" }];
  const { page, calls } = fakeKakaoPage({ cards });
  const scan = { cardsScanned: 0, preSkippedByPlaceKey: 0, preSkippedByCardKey: 0, detailFetched: 0 };

  const aborted = await collectKakaoMapPageDocuments(page, "경북 요양병원", [], new Set(), {
    abort: NEVER_ABORT,
    skipContext: { existingPlaceKeys: new Set(["kakao:9813680"]), existingKeys: new Set(), runKeys: new Set() },
    scan,
  });

  assert.equal(aborted, false);
  assert.equal(calls.newPage, 0);
  assert.equal(scan.preSkippedByPlaceKey, 1);
  assert.equal(scan.detailFetched, 0);
});

test("readKakaoMapDetail creates no tab once the deadline has passed", async () => {
  let created = 0;
  const context = {
    newPage: async () => {
      created += 1;
      throw new Error("must not be reached");
    },
  };

  const detail = await readKakaoMapDetail(context, "https://place.map.kakao.com/1", { abort: ALREADY_EXPIRED });

  assert.equal(detail, null);
  assert.equal(created, 0);
});

test("deadline expiring as goto completes starts no load wait", async () => {
  let created = 0;
  let waited = 0;
  let timedOut = 0;
  let gotoDone = false;

  const context = {
    newPage: async () => {
      created += 1;
      return {
        goto: async () => {
          gotoDone = true;
        },
        waitForLoadState: async () => {
          waited += 1;
        },
        waitForTimeout: async () => {
          timedOut += 1;
        },
        url: () => "https://place.map.kakao.com/1",
        close: async () => {},
        locator: () => ({ first: () => ({ count: async () => 0 }) }),
      };
    },
  };

  // Expires the moment goto resolves.
  const detail = await readKakaoMapDetail(context, "https://place.map.kakao.com/1", { abort: { exceeded: () => gotoDone } });

  assert.equal(detail, null);
  assert.equal(created, 1, "the tab was created before the deadline passed");
  assert.equal(waited, 0, "waitForLoadState must not start after goto used up the budget");
  assert.equal(timedOut, 0, "the fixed wait must not start either");
});

test("deadline expiring after waitForLoadState starts no further wait or locator work", async () => {
  let waited = 0;
  let timedOut = 0;
  let locators = 0;

  const context = {
    newPage: async () => ({
      goto: async () => {},
      waitForLoadState: async () => {
        waited += 1;
      },
      waitForTimeout: async () => {
        timedOut += 1;
      },
      url: () => "https://place.map.kakao.com/1",
      close: async () => {},
      locator: () => {
        locators += 1;
        return { first: () => ({ count: async () => 0 }) };
      },
    }),
  };

  const detail = await readKakaoMapDetail(context, "https://place.map.kakao.com/1", { abort: { exceeded: () => waited > 0 } });

  assert.equal(detail, null);
  assert.equal(waited, 1);
  assert.equal(timedOut, 0, "the fixed wait must not start once the load wait exhausted the budget");
  assert.equal(locators, 0, "no detail locator may be read after the deadline");
});

test("deadline expiring after a result page starts no next-page click", async () => {
  // Two pages available; the deadline lands once the first page's only detail fetch has finished,
  // so the page is fully collected and the pagination click is the next thing that would start.
  let search;
  const abort = { exceeded: () => (search?.calls.detailCloses ?? 0) > 0 };
  search = fakeKakaoSearchPage({ pages: [["1"], ["2"]] });

  const collected = await collectKakaoMapDocuments(search.page, "경북 요양병원", { abort });

  assert.equal(collected.aborted, true);
  assert.equal(search.calls.nextPageClicks, 0, "paging forward must not start after the deadline");
  assert.equal(collected.documents.length, 1, "the page already collected is preserved");
});

test("deadline expiring after the next-page click starts no transition wait", async () => {
  const search = fakeKakaoSearchPage({ pages: [["1"], ["2"]] });
  // Expire the instant the pagination click lands.
  const abort = { exceeded: () => search.calls.nextPageClicks > 0 };

  const collected = await collectKakaoMapDocuments(search.page, "경북 요양병원", { abort });

  assert.equal(collected.aborted, true);
  assert.equal(search.calls.nextPageClicks, 1);
  const waitsAfterClick = search.calls.order.slice(search.calls.order.indexOf("nextPageClicks") + 1);
  assert.deepEqual(
    waitsAfterClick.filter((name) => name === "waitForLoadState" || name === "waitForTimeout"),
    [],
    "no settle wait may start after the click consumed the budget",
  );
  assert.equal(collected.documents.length, 1, "documents collected before the transition are kept");
});

test("an already expired deadline opens no search page work at all", async () => {
  const search = fakeKakaoSearchPage({ pages: [["1"], ["2"]] });

  const collected = await collectKakaoMapDocuments(search.page, "경북 요양병원", { abort: ALREADY_EXPIRED });

  assert.equal(collected.aborted, true);
  assert.deepEqual(collected.documents, []);
  assert.equal(search.calls.placeMoreClicks, 0);
  assert.equal(search.calls.nextPageClicks, 0);
  assert.equal(search.calls.detailPages, 0);
  assert.equal(search.calls.waitForLoadState, 0);
  assert.equal(search.calls.waitForTimeout, 0);
});

test("an aborted queue item is never reported as failed", () => {
  // Abort wins over every other signal, so failure_counts cannot grow from a runtime stop.
  assert.equal(resolveQueueItemFailure({ aborted: true, candidateCount: 0, providerErrors: 1, providerCount: 1 }), false);
  assert.equal(resolveQueueItemFailure({ aborted: true, candidateCount: 0, providerErrors: 0, providerCount: 1 }), false);

  // A genuine provider wipeout is still a failure.
  assert.equal(resolveQueueItemFailure({ aborted: false, candidateCount: 0, providerErrors: 1, providerCount: 1 }), true);

  // Partial results, or a provider that answered, are not failures.
  assert.equal(resolveQueueItemFailure({ aborted: false, candidateCount: 5, providerErrors: 1, providerCount: 1 }), false);
  assert.equal(resolveQueueItemFailure({ aborted: false, candidateCount: 0, providerErrors: 0, providerCount: 1 }), false);
  assert.equal(resolveQueueItemFailure({}), false);
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
  // The path is injected rather than reached via process.chdir(): mutating the process cwd from a
  // test leaks into every other file that reads a relative path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowercrm-queue-"));
  const queuePath = path.join(dir, "collect_queue.json");
  try {
    const queue = loadOrCreateQueue({ persist: false, queuePath });
    assert.equal(queue.items.length, 1727);
    assert.equal(fs.existsSync(queuePath), false);

    loadOrCreateQueue({ queuePath });
    assert.equal(fs.existsSync(queuePath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only lookup never creates a folder, spreadsheet, tab or header", async () => {
  const cases = [
    { name: "spreadsheet missing", files: { folder: "folder-1", spreadsheet: null } },
    { name: "folder missing", files: { folder: null, spreadsheet: null } },
  ];

  for (const { name, files } of cases) {
    await withStubbedGoogle(
      (href) => {
        if (!href.startsWith("https://www.googleapis.com/drive/v3/files")) return {};
        const isFolderQuery = decodeURIComponent(href).includes("application/vnd.google-apps.folder");
        const id = isFolderQuery ? files.folder : files.spreadsheet;
        return { files: id ? [{ id }] : [] };
      },
      async (requests) => {
        await assert.rejects(
          getTargetSpreadsheet({
            readOnly: true,
            folderId: "",
            spreadsheetId: "",
            spreadsheetName: `missing-sheet-${name}`,
            folderName: `missing-folder-${name}`,
          }),
          (error) => error.code === "dry_run_unconfigured",
          `${name} must fail read-only instead of creating anything`,
        );

        const mutations = requests.filter((request) => request.method && request.method !== "GET");
        assert.deepEqual(mutations, [], `${name} performed a mutating call`);
      },
    );
  }
});

test("read-only mode issues no mutation even when the target sheet is absent", async () => {
  await withStubbedGoogle(
    (href) => {
      // Every values read 404s, mimicking a spreadsheet without the expected tabs.
      if (href.includes("/values/")) return { __status: 404 };
      return {};
    },
    async (requests) => {
      const { spreadsheetId } = await getTargetSpreadsheet({ readOnly: true });
      const system = await readSystemState(spreadsheetId, { readOnly: true });
      const keys = await readExistingCollectKeys(spreadsheetId);

      assert.deepEqual(system, {});
      assert.equal(keys.duplicateKeys.size, 0);
      assert.equal(keys.placeKeys.size, 0);

      const mutations = requests.filter((request) => request.method && request.method !== "GET");
      assert.deepEqual(mutations, []);
    },
  );
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
    // The OAuth token POST is transport, not a Drive/Sheets mutation, so it is not recorded.
    if (href.startsWith("https://oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "test-token", expires_in: 3600 });
    }
    requests.push({ url: href, method: options.method || "GET" });
    return jsonResponse(handler(href, options) ?? {});
  };

  return Promise.resolve(run(requests)).finally(() => {
    globalThis.fetch = originalFetch;
    if (originalAccount === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = originalAccount;
  });
}

function jsonResponse(body) {
  const status = body?.__status ?? 200;
  const payload = body?.__status ? {} : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
    async json() {
      return payload;
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

// A stand-in SYSTEM tab that honours the exact ranges writeSystemState() targets, so an
// interleaved Collect/Enrich sequence can be replayed against real range arithmetic.
function fakeSystemSheet(initialRows) {
  const rows = initialRows.map((row) => [...row]);

  const rangeOf = (encoded) => decodeURIComponent(encoded.split("/values/")[1]?.split(/[:?]/)[0] || "");

  return {
    rows,
    toObject() {
      return Object.fromEntries(rows.filter((row) => row[0]).map((row) => [row[0], row[1]]));
    },
    handle(href, options) {
      // Spreadsheet metadata: report every tab as present so ensureSpreadsheetShape adds none.
      if (/\/spreadsheets\/[^/:?]+\?/.test(href) && !href.includes("/values")) {
        return { sheets: SHEET_TABS.map((title) => ({ properties: { sheetId: 1, title } })) };
      }
      if (href.includes("values:batchUpdate")) {
        for (const entry of JSON.parse(options.body).data) {
          const match = /^SYSTEM!([A-D])(\d+):[A-D]\d+$/.exec(entry.range);
          // Header syncs (row 1) and other tabs are irrelevant to SYSTEM key ownership.
          if (!match || Number(match[2]) < 2) continue;
          const startColumn = match[1].charCodeAt(0) - 65;
          const rowIndex = Number(match[2]) - 2;
          while (rows.length <= rowIndex) rows.push(["", "", "", ""]);
          entry.values[0].forEach((value, offset) => {
            rows[rowIndex][startColumn + offset] = value;
          });
        }
        return {};
      }
      if (href.includes("/values/") && rangeOf(href).startsWith("SYSTEM")) return { values: rows };
      return {};
    },
  };
}

test("collect and enrich SYSTEM writes do not revert each other", async () => {
  const sheet = fakeSystemSheet([
    ["current_queue_index", "1126", "t0", "seed"],
    ["enrich_current_row", "512", "t0", "seed"],
    ["total_runs", "41", "t0", "seed"],
  ]);

  await withStubbedGoogle(
    (href, options) => sheet.handle(href, options),
    async () => {
      const spreadsheetId = "sheet-system-concurrency";

      // 1-2. Both jobs read the same starting snapshot, as they do when their runs overlap.
      const collectSnapshot = await readSystemState(spreadsheetId);
      const enrichSnapshot = await readSystemState(spreadsheetId);
      assert.equal(collectSnapshot.current_queue_index, "1126");
      assert.equal(enrichSnapshot.enrich_current_row, "512");

      // 3. Collect advances its own keys.
      await writeSystemState(spreadsheetId, { current_queue_index: "1127", total_runs: "42" }, "collect");

      // 4. Enrich advances its own keys from its now-stale snapshot.
      await writeSystemState(spreadsheetId, { enrich_current_row: "640" }, "enrich");

      // 5. Both advances survive.
      const final = sheet.toObject();
      assert.equal(final.current_queue_index, "1127", "enrich must not revert the collect cursor");
      assert.equal(final.enrich_current_row, "640", "collect must not revert the enrich cursor");
      assert.equal(final.total_runs, "42");
    },
  );
});

test("SYSTEM writes touch only the passed keys and keep existing order", async () => {
  const sheet = fakeSystemSheet([
    ["current_queue_index", "1126", "t0", "seed"],
    ["enrich_current_row", "512", "t0", "seed"],
    ["failure_counts", "{}", "t0", "seed"],
  ]);

  await withStubbedGoogle(
    (href, options) => sheet.handle(href, options),
    async () => {
      const result = await writeSystemState("sheet-system-keys", { current_queue_index: "1200", current_queue_attempts: "1" }, "collect");

      assert.deepEqual(
        sheet.rows.map((row) => row[0]),
        ["current_queue_index", "enrich_current_row", "failure_counts", "current_queue_attempts"],
        "existing key order is preserved and a new key is appended",
      );
      assert.equal(sheet.rows[0][1], "1200");
      assert.equal(sheet.rows[1][1], "512", "an untouched key keeps its value");
      assert.equal(sheet.rows[1][2], "t0", "an untouched key keeps its timestamp");
      assert.equal(sheet.rows[2][1], "{}");
      assert.deepEqual(result.appended, ["current_queue_attempts"]);
    },
  );
});

test("collect and enrich own disjoint SYSTEM keys", () => {
  const overlap = COLLECT_SYSTEM_KEYS.filter((key) => ENRICH_SYSTEM_KEYS.includes(key));
  assert.deepEqual(overlap, [], "a shared key would let one job overwrite the other");

  // The documented lists must match what the code actually writes.
  const collectSource = fs.readFileSync(new URL("../src/queueCollect.js", import.meta.url), "utf8");
  const systemUpdatesBlock = collectSource.split("const systemUpdates = {")[1].split("};")[0];
  const writtenCollectKeys = [...systemUpdatesBlock.matchAll(/^\s{4}([a-z_]+):/gm)].map((match) => match[1]);
  assert.deepEqual([...writtenCollectKeys].sort(), [...COLLECT_SYSTEM_KEYS].sort());

  const enrichSource = fs.readFileSync(new URL("../src/enrich.js", import.meta.url), "utf8");
  const enrichBlock = enrichSource.split("sheets.writeSystemState(")[1].split("},")[0];
  const writtenEnrichKeys = [...enrichBlock.matchAll(/^\s{8}([a-z_]+):/gm)].map((match) => match[1]);
  assert.deepEqual([...writtenEnrichKeys].sort(), [...ENRICH_SYSTEM_KEYS].sort());
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
