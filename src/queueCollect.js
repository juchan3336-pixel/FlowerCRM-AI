import fs from "node:fs";

import { randomDelay } from "./delay.js";
import {
  appendCollectLog,
  getTargetSpreadsheet,
  readExistingDuplicateKeys,
  readSystemState,
  saveLeadsToGoogleSheets,
  writeSystemState,
} from "./googleSheets.js";
import { isIndustryMatch } from "./industryFilter.js";
import { cleanText, displayPhone, normalizePhone } from "./normalize.js";
import { buildSummaryReport, printSummaryReport } from "./report.js";
import { normalizeIndustry, scoreIndustry } from "./scoring.js";

const QUEUE_PATH = "collect_queue.json";
const STATE_PATH = "collect_state.json";
const MAX_KAKAO_PAGE = 45;
const MAX_QUEUE_VISITS_FACTOR = 2;

const REGIONS = ["부산", "김해", "양산", "창원", "울산", "경남", "대구", "경북", "서울", "경기", "인천"];
const CATEGORIES = [
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
];

const KEYWORDS = {
  건설회사: ["건설회사", "건설업체", "건축회사", "토목회사", "전기공사", "설비공사"],
  종합건설: ["종합건설", "종합건설사", "건설업"],
  시행사: ["시행사", "부동산개발", "개발회사", "디벨로퍼"],
  병원: ["병원", "종합병원", "요양병원", "정형외과", "내과", "의원"],
  법무법인: ["법무법인", "변호사", "법률사무소"],
  세무법인: ["세무법인", "세무사", "세무사무소"],
  회계법인: ["회계법인", "회계사", "회계사무소"],
  호텔: ["호텔", "비즈니스호텔", "관광호텔", "리조트"],
  제조업: ["제조업", "제조업체", "공장", "기계제조", "금속제조", "식품제조", "화학제조"],
  자동차딜러: ["자동차 딜러", "자동차 전시장", "자동차판매점", "수입차", "현대자동차 대리점", "기아 대리점", "BMW 전시장", "벤츠 전시장"],
  금융기관: ["금융기관", "은행", "저축은행", "신협", "새마을금고", "증권사", "보험사"],
  프랜차이즈본사: ["프랜차이즈 본사", "가맹본부", "프랜차이즈본부", "체인본사"],
};

export async function runQueuedCollect({
  limit = 300,
  delayMinMs = 3000,
  delayMaxMs = 8000,
  dryRun = false,
  logger,
  onDelay = null,
} = {}) {
  if (!process.env.KAKAO_REST_API_KEY) {
    throw new Error("KAKAO_REST_API_KEY가 필요합니다.");
  }

  const startedAt = Date.now();
  console.log("Using Kakao Provider");
  logger?.info("provider_selected", { provider: "kakao", envKey: "KAKAO_REST_API_KEY" });

  const queue = loadOrCreateQueue();
  const { spreadsheetId } = await getTargetSpreadsheet();
  const system = await readSystemState(spreadsheetId);
  const existingKeys = await readExistingDuplicateKeys(spreadsheetId);
  const failureCounts = readFailureCounts(system);
  const runKeys = new Set();
  const leads = [];
  const stats = {
    totalAttempts: 0,
    duplicateExcluded: 0,
    missingPhoneExcluded: 0,
    regionMismatchExcluded: 0,
    industryMismatchExcluded: 0,
    failedKeywords: 0,
    queueVisits: 0,
    queueSkipped: 0,
    noCandidateQueues: 0,
  };

  let requestCount = 0;
  const startIndex = normalizeQueueIndex(system.current_queue_index, queue.items.length);
  let queueIndex = startIndex;
  let currentItem = queue.items[queueIndex];
  let stopReason = "";
  const maxQueueVisits = Math.max(queue.items.length * MAX_QUEUE_VISITS_FACTOR, 1);

  logQueue("Current Queue", queueIndex, currentItem);
  logger?.info("queue_start", { queueIndex, queueLength: queue.items.length, queue: currentItem, systemCurrentQueueIndex: system.current_queue_index });

  if (queue.items.length === 0) {
    stopReason = "Queue Empty";
    logger?.error("queue_empty", { reason: stopReason });
  }

  while (leads.length < limit && queue.items.length > 0 && stats.queueVisits < maxQueueVisits) {
    currentItem = queue.items[queueIndex];
    stats.queueVisits += 1;

    if (!currentItem) {
      stopReason = "Queue Empty";
      logger?.error("queue_missing_item", { queueIndex });
      break;
    }

    if (failureCounts[currentItem.id] >= 3) {
      stats.queueSkipped += 1;
      logger?.info("keyword_skip", { reason: "Keyword Skip", queueIndex, queue: currentItem, failureCount: failureCounts[currentItem.id] });
      queueIndex = nextQueueIndex(queue, queueIndex);
      continue;
    }

    logger?.info("queue_collect_start", { queueIndex, queue: currentItem, collectedSoFar: leads.length });
    const beforeAttempts = stats.totalAttempts;
    const beforeLeads = leads.length;
    const beforeDuplicates = stats.duplicateExcluded;
    const itemFailed = await collectQueueItem({
      item: currentItem,
      leads,
      stats,
      existingKeys,
      runKeys,
      limit,
      delayMinMs,
      delayMaxMs,
      requestCountRef: {
        get value() {
          return requestCount;
        },
        set value(next) {
          requestCount = next;
        },
      },
      logger,
      onDelay,
    });

    if (itemFailed) {
      failureCounts[currentItem.id] = (failureCounts[currentItem.id] || 0) + 1;
      logger?.error("queue_failed", { reason: "Queue Failed", queue: currentItem, failureCount: failureCounts[currentItem.id] });
      if (failureCounts[currentItem.id] >= 3) stats.failedKeywords += 1;
    } else {
      failureCounts[currentItem.id] = 0;
    }

    if (stats.totalAttempts === beforeAttempts) {
      stats.noCandidateQueues += 1;
      logger?.info("no_candidate", { reason: "No Candidate", queueIndex, queue: currentItem });
    } else if (leads.length === beforeLeads) {
      logger?.info("already_completed_or_duplicate", { reason: "Already Completed", queueIndex, queue: currentItem, attempts: stats.totalAttempts - beforeAttempts });
    }

    const queueAttempts = stats.totalAttempts - beforeAttempts;
    const queuePassed = leads.length - beforeLeads;
    const queueDuplicates = stats.duplicateExcluded - beforeDuplicates;
    printStage("Kakao Candidate", queueAttempts);
    printStage("필터 통과", queuePassed + queueDuplicates);
    printStage("신규 추가", queuePassed);
    printStage("중복 제외", queueDuplicates);

    queueIndex = nextQueueIndex(queue, queueIndex);
    logQueue("Next Queue", queueIndex, queue.items[queueIndex]);
  }

  if (!stopReason) {
    if (leads.length >= limit) stopReason = "Limit Reached";
    else if (stats.queueVisits >= maxQueueVisits) stopReason = "Queue Full Cycle Exhausted";
    else stopReason = "Completed";
  }

  const saveResult = dryRun
    ? {
        folderId: "",
        spreadsheetId,
        received: leads.length,
        inserted: leads.length,
        skipped: 0,
        industryCounts: {},
        gradeCounts: {},
      }
    : await saveLeadsToGoogleSheets(leads, { existingKeys });
  if (dryRun) {
    printStage("Google Sheets 저장 생략", "dry-run");
  } else {
    printStage("Google Sheets 저장 완료", saveResult.inserted);
  }
  if (!dryRun && saveResult.sheetWrites) {
    const primaryWrite = saveResult.sheetWrites["기업 DB"] || {};
    const newCompanyWrite = saveResult.sheetWrites["신규기업"] || {};
    console.log(`Google Sheets append 성공: ${saveResult.inserted}건`);
    console.log(`기업 DB append 성공: ${JSON.stringify(primaryWrite)}`);
    console.log(`신규기업 append 성공: ${JSON.stringify(newCompanyWrite)}`);
  }
  const report = buildSummaryReport(stats, saveResult);
  const nextItem = queue.items[queueIndex] || queue.items[0];
  const now = new Date().toISOString();
  const runMs = Date.now() - startedAt;

  const systemUpdates = {
    current_region: currentItem?.region || "",
    current_category: currentItem?.category || "",
    current_keyword: currentItem?.keyword || "",
    current_queue_index: String(queueIndex),
    total_runs: String(numberValue(system.total_runs) + 1),
    total_collected: String(numberValue(system.total_collected) + stats.totalAttempts),
    total_new_added: String(numberValue(system.total_new_added) + saveResult.inserted),
    total_duplicates: String(numberValue(system.total_duplicates) + report.duplicateExcluded),
    last_run_at: now,
    next_region: nextItem?.region || "",
    next_category: nextItem?.category || "",
    next_keyword: nextItem?.keyword || "",
    failure_counts: JSON.stringify(failureCounts),
  };

  const status = dryRun ? "dry-run" : saveResult.inserted > 0 ? "success" : "no-data";
  if (!dryRun) {
    await writeSystemState(spreadsheetId, systemUpdates, "FlowerCRM Collect queue state");
    printStage("SYSTEM 업데이트 완료", "");
  }

  const state = {
    version: 2,
    lastKeyword: systemUpdates.current_keyword,
    lastRegion: systemUpdates.current_region,
    lastRunAt: now,
    totalCollected: Number(systemUpdates.total_collected),
    totalInserted: Number(systemUpdates.total_new_added),
    totalDuplicateExcluded: Number(systemUpdates.total_duplicates),
    currentQueueIndex: queueIndex,
    nextQueue: summarizeQueueItem(nextItem),
    lastRunReport: {
      ...report,
      failedKeywords: stats.failedKeywords,
      queueVisits: stats.queueVisits,
      queueSkipped: stats.queueSkipped,
      noCandidateQueues: stats.noCandidateQueues,
      stopReason,
      runMs,
      currentQueueIndex: queueIndex,
      currentQueue: summarizeQueueItem(currentItem),
      nextQueue: summarizeQueueItem(nextItem),
    },
  };
  if (!dryRun) {
    saveState(state);
  }
  logger?.info("operational_report", state.lastRunReport);
  if (!dryRun) {
    await appendCollectLog(spreadsheetId, state.lastRunReport, status, dryRun ? "dry-run only" : stopReason);
    console.log("LOG 시트 기록 완료");
  }

  printOperationalReport(state.lastRunReport);
  printSummaryReport(report);

  return { leads, stats, saveResult, report: state.lastRunReport, queue, state };
}

export function loadOrCreateQueue() {
  const queue = buildQueue();
  if (!fs.existsSync(QUEUE_PATH)) {
    saveQueue(queue);
    return queue;
  }

  const existing = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  if (existing.version !== queue.version || existing.items?.length !== queue.items.length) {
    saveQueue(queue);
    return queue;
  }
  return existing;
}

export function buildQueue() {
  const items = [];
  let id = 1;
  for (const region of REGIONS) {
    for (const category of CATEGORIES) {
      for (const keyword of KEYWORDS[category] || [category]) {
        items.push({
          id: String(id).padStart(4, "0"),
          region,
          category,
          industry: normalizeIndustryName(category),
          keyword,
          query: `${region} ${keyword}`,
        });
        id += 1;
      }
    }
  }

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    regions: REGIONS,
    categories: CATEGORIES,
    items,
  };
}

async function collectQueueItem({
  item,
  leads,
  stats,
  existingKeys,
  runKeys,
  limit,
  delayMinMs,
  delayMaxMs,
  requestCountRef,
  logger,
  onDelay,
}) {
  try {
    for (let page = 1; page <= MAX_KAKAO_PAGE && leads.length < limit; page += 1) {
      if (requestCountRef.value > 0) {
        await randomDelay(delayMinMs, delayMaxMs, async (waitMs) => {
          logger?.info("request_delay", { waitMs, queueId: item.id, page });
          if (onDelay) await onDelay(waitMs);
        });
      }
      requestCountRef.value += 1;

      const documents = await searchKakao(item, page);
      logger?.info("kakao_response", { queueId: item.id, query: item.query, page, candidates: documents.length });
      if (documents.length === 0) break;

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
        if (leads.length >= limit) break;
      }
    }
    return false;
  } catch (error) {
    logger?.error("keyword_failed", { item, error: error.message });
    return true;
  }
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
  if (!isIndustryMatch(item.industry, detailIndustry, companyName)) {
    stats.industryMismatchExcluded += 1;
    return null;
  }

  return {
    companyName,
    industry: item.category,
    detailIndustry,
    region: item.region,
    address,
    phone,
    homepage: "",
    email: "",
    sourceUrl: row.place_url || "",
    collectedAt: new Date().toISOString().slice(0, 10),
    grade: scoreIndustry(item.category, companyName),
    salesStatus: "신규",
    memo: "system queue collect",
  };
}

async function searchKakao(item, page) {
  const params = new URLSearchParams({
    query: item.query,
    size: "15",
    page: String(page),
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

function readFailureCounts(system) {
  try {
    return system.failure_counts ? JSON.parse(system.failure_counts) : {};
  } catch {
    return {};
  }
}

export function normalizeQueueIndex(index, length) {
  if (!length) return 0;
  const value = Number(index || 0);
  return Number.isInteger(value) && value >= 0 && value < length ? value : 0;
}

function nextQueueIndex(queue, index) {
  if (queue.items.length === 0) return 0;
  return (index + 1) % queue.items.length;
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
  if (region === "경북") return address.includes("경북");
  if (region === "경기") return address.includes("경기");
  return address.includes(region);
}

function normalizeIndustryName(category) {
  if (category === "자동차딜러") return "자동차 딜러";
  return category;
}

function numberValue(value) {
  return Number(value || 0) || 0;
}

function summarizeQueueItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    region: item.region,
    category: item.category,
    keyword: item.keyword,
    query: item.query,
  };
}

function logQueue(label, index, item) {
  console.log("━━━━━━━━━━━━━━");
  console.log(label);
  console.log(`index ${index}`);
  console.log(formatQueueMultiline(item));
  console.log("━━━━━━━━━━━━━━");
}

function printStage(label, value) {
  console.log("━━━━━━━━━━━━━━");
  console.log(label);
  if (value !== "") console.log(value);
  console.log("━━━━━━━━━━━━━━");
}

function printOperationalReport(report) {
  console.log("");
  console.log("운영 큐 리포트");
  console.log("============");
  console.log(`현재 queue: ${formatQueue(report.currentQueue)}`);
  console.log(`다음 queue: ${formatQueue(report.nextQueue)}`);
  console.log(`queue 방문 수: ${report.queueVisits}`);
  console.log(`keyword skip 수: ${report.queueSkipped}`);
  console.log(`no candidate queue 수: ${report.noCandidateQueues}`);
  console.log(`종료 사유: ${report.stopReason}`);
  console.log(`실행 시간: ${(report.runMs / 1000).toFixed(1)}초`);
}

function formatQueue(item) {
  if (!item) return "없음";
  return `${item.id} / ${item.region} / ${item.category} / ${item.keyword}`;
}

function formatQueueMultiline(item) {
  if (!item) return "Queue Empty";
  return `${item.region}\n${item.category}\n${item.keyword}`;
}
