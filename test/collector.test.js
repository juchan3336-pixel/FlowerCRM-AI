import assert from "node:assert/strict";
import test from "node:test";

import { LeadCollector, duplicateKey, isRegionMatch } from "../src/collector.js";
import { randomInt } from "../src/delay.js";
import { isIndustryMatch } from "../src/industryFilter.js";
import { companyKey, normalizePhone } from "../src/normalize.js";
import { buildSummaryReport, countBy } from "../src/report.js";
import { toSheetRows } from "../src/rows.js";
import { scoreIndustry } from "../src/scoring.js";
import { buildQueue, getQueueRunStopReason, normalizeQueueIndex } from "../src/queueCollect.js";

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

  assert.equal(queue.items.length, 638);
  assert.deepEqual(queue.regions, ["부산", "김해", "양산", "창원", "울산", "경남", "대구", "경북", "서울", "경기", "인천"]);
  assert.deepEqual(queue.categories, [
    "건설회사",
    "종합건설",
    "시행사",
    "병원",
    "법무법인",
    "세무법인",
    "회계법인",
    "호텔",
    "제조업",
    "자동차딜러",
    "금융기관",
    "프랜차이즈본사",
  ]);
  assert.equal(queue.items[0].query, "부산 건설회사");
  assert.equal(queue.items.at(-1).query, "인천 체인본사");
  assert.equal(normalizeQueueIndex("35", queue.items.length), 35);
  assert.equal(normalizeQueueIndex("9999", queue.items.length), 0);
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
