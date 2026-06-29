import fs from "node:fs";

import { DEFAULT_INDUSTRIES } from "./config.js";
import { randomDelay } from "./delay.js";
import { getTargetSpreadsheet, readExistingDuplicateKeys, saveLeadsToGoogleSheets } from "./googleSheets.js";
import { isIndustryMatch } from "./industryFilter.js";
import { cleanText, displayPhone, normalizePhone } from "./normalize.js";
import { buildSummaryReport, printSummaryReport } from "./report.js";
import { normalizeIndustry, scoreIndustry } from "./scoring.js";

const QUEUE_PATH = "collect_queue.json";
const STATE_PATH = "collect_state.json";
const REGIONS = ["부산", "김해", "양산", "창원", "울산", "경남"];
const INDUSTRIES = ["건설회사", "종합건설", "병원", "법무법인", "세무법인", "회계법인", "호텔", "제조업", "자동차딜러"];
const MAX_KAKAO_PAGE = 45;

const KEYWORDS = {
  건설회사: ["건설회사", "건설업체", "건축회사", "토목회사", "전기공사", "설비공사"],
  종합건설: ["종합건설", "종합건설사", "건설업"],
  병원: ["병원", "종합병원", "요양병원", "정형외과", "내과", "의원"],
  법무법인: ["법무법인", "변호사", "법률사무소"],
  세무법인: ["세무법인", "세무사", "세무사무소"],
  회계법인: ["회계법인", "회계사", "회계사무소"],
  호텔: ["호텔", "비즈니스호텔", "관광호텔", "리조트"],
  제조업: ["제조업", "제조업체", "공장", "기계제조", "금속제조", "식품제조", "화학제조"],
  자동차딜러: ["자동차 딜러", "자동차 전시장", "자동차판매점", "수입차", "현대자동차 대리점", "기아 대리점", "BMW 전시장", "벤츠 전시장"],
};

export async function runQueuedCollect({
  limit = 300,
  delayMinMs = 3000,
  delayMaxMs = 8000,
  logger,
  onDelay = null,
} = {}) {
  if (!process.env.KAKAO_REST_API_KEY) {
    throw new Error("KAKAO_REST_API_KEY가 필요합니다.");
  }

  const queue = loadOrCreateQueue();
  const state = loadOrCreateState();
  const { spreadsheetId } = await getTargetSpreadsheet();
  const existingKeys = await readExistingDuplicateKeys(spreadsheetId);
  const runKeys = new Set();
  const leads = [];
  const stats = {
    totalAttempts: 0,
    duplicateExcluded: 0,
    missingPhoneExcluded: 0,
    regionMismatchExcluded: 0,
    industryMismatchExcluded: 0,
    failedKeywords: 0,
  };

  let requestCount = 0;
  let queueIndex = normalizeQueueIndex(queue.currentIndex, queue.items.length);
  const startedIndex = queueIndex;

  while (leads.length < limit && queueHasOpenItems(queue)) {
    const item = queue.items[queueIndex];
    if (!item || item.status === "done" || item.status === "skipped") {
      queueIndex = nextQueueIndex(queue, queueIndex);
      continue;
    }

    if (requestCount > 0) {
      await randomDelay(delayMinMs, delayMaxMs, async (waitMs) => {
        logger?.info("request_delay", { waitMs, queueIndex, itemId: item.id });
        if (onDelay) await onDelay(waitMs);
      });
    }
    requestCount += 1;

    state.lastKeyword = item.keyword;
    state.lastRegion = item.region;
    state.lastRunAt = new Date().toISOString();

    try {
      const documents = await searchKakao(item);
      item.failureCount = 0;
      item.lastRunAt = state.lastRunAt;
      item.attempts += 1;

      if (documents.length === 0 || item.page >= MAX_KAKAO_PAGE) {
        item.status = "done";
        queueIndex = nextQueueIndex(queue, queueIndex);
      } else {
        item.page += 1;
      }

      for (const row of documents) {
        stats.totalAttempts += 1;
        const lead = makeLead(row, item, stats);
        if (!lead) continue;

        const key = duplicateKey(lead.companyName, lead.phone);
        if (existingKeys.has(key) || runKeys.has(key)) {
          stats.duplicateExcluded += 1;
          continue;
        }

        runKeys.add(key);
        leads.push(lead);
        item.collected += 1;
        if (leads.length >= limit) break;
      }
    } catch (error) {
      item.failureCount += 1;
      item.lastError = error.message;
      item.lastRunAt = new Date().toISOString();
      logger?.error("keyword_failed", { item, error: error.message });

      if (item.failureCount >= 3) {
        item.status = "skipped";
        stats.failedKeywords += 1;
        queueIndex = nextQueueIndex(queue, queueIndex);
      }
    }

    queue.currentIndex = queueIndex;
    saveQueue(queue);
    saveState(state);

    if (queueIndex === startedIndex && requestCount > queue.items.length * 2 && leads.length === 0) {
      break;
    }
  }

  const saveResult = await saveLeadsToGoogleSheets(leads, { existingKeys });
  const report = buildSummaryReport(stats, saveResult);
  state.totalCollected += stats.totalAttempts;
  state.totalInserted += saveResult.inserted;
  state.totalDuplicateExcluded += report.duplicateExcluded;
  state.lastRunAt = new Date().toISOString();
  state.currentQueueIndex = queue.currentIndex;
  state.nextQueue = summarizeQueueItem(queue.items[queue.currentIndex]);
  state.lastRunReport = {
    ...report,
    failedKeywords: stats.failedKeywords,
    currentQueueIndex: queue.currentIndex,
    currentQueue: summarizeQueueItem(queue.items[queue.currentIndex]),
    nextQueue: summarizeQueueItem(queue.items[queue.currentIndex]),
  };
  saveQueue(queue);
  saveState(state);

  printOperationalReport(state.lastRunReport);
  printSummaryReport(report);

  return { leads, stats, saveResult, report: state.lastRunReport, queue, state };
}

export function loadOrCreateQueue() {
  if (fs.existsSync(QUEUE_PATH)) {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  }

  const items = [];
  let id = 1;
  for (const region of REGIONS) {
    for (const industry of INDUSTRIES) {
      for (const keyword of KEYWORDS[industry] || [industry]) {
        items.push({
          id: String(id).padStart(4, "0"),
          region,
          industry,
          keyword,
          query: `${region} ${keyword}`,
          page: 1,
          status: "pending",
          failureCount: 0,
          attempts: 0,
          collected: 0,
          lastRunAt: "",
          lastError: "",
        });
        id += 1;
      }
    }
  }

  const queue = {
    version: 1,
    currentIndex: 0,
    generatedAt: new Date().toISOString(),
    regions: REGIONS,
    industries: INDUSTRIES,
    items,
  };
  saveQueue(queue);
  return queue;
}

export function loadOrCreateState() {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  }

  const state = {
    version: 1,
    lastKeyword: "",
    lastRegion: "",
    lastRunAt: "",
    totalCollected: 0,
    totalInserted: 0,
    totalDuplicateExcluded: 0,
    currentQueueIndex: 0,
    nextQueue: null,
    lastRunReport: null,
  };
  saveState(state);
  return state;
}

function makeLead(row, item, stats) {
  const companyName = cleanText(row.place_name);
  const phone = displayPhone(row.phone);
  if (!companyName || !normalizePhone(phone)) {
    stats.missingPhoneExcluded += 1;
    return null;
  }

  const address = cleanText(row.road_address_name || row.address_name);
  if (!isRegionMatch(item.region, address)) {
    stats.regionMismatchExcluded += 1;
    return null;
  }

  const detailIndustry = normalizeIndustry(item.industry, cleanText(row.category_name));
  if (!isIndustryMatch(normalizeIndustryName(item.industry), detailIndustry, companyName)) {
    stats.industryMismatchExcluded += 1;
    return null;
  }

  return {
    companyName,
    industry: item.industry,
    detailIndustry,
    region: item.region,
    address,
    phone,
    homepage: "",
    email: "",
    sourceUrl: row.place_url || "",
    collectedAt: new Date().toISOString().slice(0, 10),
    grade: scoreIndustry(item.industry, companyName),
    salesStatus: "신규",
    memo: "queue collect",
  };
}

async function searchKakao(item) {
  const params = new URLSearchParams({
    query: item.query,
    size: "15",
    page: String(item.page),
  });
  const response = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${params}`, {
    headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
  });
  if (!response.ok) {
    throw new Error(`Kakao API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.documents || [];
}

function queueHasOpenItems(queue) {
  return queue.items.some((item) => item.status !== "done" && item.status !== "skipped");
}

function nextQueueIndex(queue, index) {
  if (queue.items.length === 0) return 0;
  return (index + 1) % queue.items.length;
}

function normalizeQueueIndex(index, length) {
  if (!length) return 0;
  const value = Number(index || 0);
  return value >= 0 && value < length ? value : 0;
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function duplicateKey(companyName, phone) {
  return `${String(companyName || "")
    .toLowerCase()
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\s+/g, "")}|${normalizePhone(phone)}`;
}

function isRegionMatch(region, address = "") {
  if (!address) return true;
  if (region === "경남") return address.includes("경남");
  return address.includes(region);
}

function normalizeIndustryName(industry) {
  if (industry === "자동차딜러") return "자동차 딜러";
  if (industry === "제조업") return "제조업";
  return DEFAULT_INDUSTRIES.includes(industry) ? industry : industry;
}

function summarizeQueueItem(item) {
  if (!item) return null;
  return {
    index: undefined,
    id: item.id,
    region: item.region,
    industry: item.industry,
    keyword: item.keyword,
    page: item.page,
    status: item.status,
  };
}

function printOperationalReport(report) {
  console.log("");
  console.log("운영 큐 리포트");
  console.log("============");
  console.log(`실패 skip 키워드 수: ${report.failedKeywords}`);
  console.log(`현재 큐 위치: ${report.currentQueueIndex}`);
  console.log(`현재 큐: ${formatQueue(report.currentQueue)}`);
  console.log(`다음 실행 예정 큐: ${formatQueue(report.nextQueue)}`);
}

function formatQueue(item) {
  if (!item) return "없음";
  return `${item.id} / ${item.region} / ${item.industry} / ${item.keyword} / page ${item.page} / ${item.status}`;
}
