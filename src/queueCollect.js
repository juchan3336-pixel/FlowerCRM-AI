import fs from "node:fs";

import { randomDelay } from "./delay.js";
import {
  appendCollectLog,
  getTargetSpreadsheet,
  readExistingCollectKeys,
  readSystemState,
  saveLeadsToGoogleSheets,
  writeSystemState,
} from "./googleSheets.js";
import { isIndustryMatch } from "./industryFilter.js";
import { cleanText, displayPhone, normalizePhone, normalizeUrl } from "./normalize.js";
import { buildSummaryReport, printSummaryReport } from "./report.js";
import { kakaoPlaceKeyFromUrl } from "./rows.js";
import { normalizeIndustry, scoreIndustry } from "./scoring.js";

const QUEUE_PATH = "collect_queue.json";
const STATE_PATH = "collect_state.json";
const MAX_KAKAO_PAGE = 45;
const DEFAULT_MAX_RUNTIME_MS = 20 * 60 * 1000;
const DEFAULT_MAX_QUEUE_VISITS = 40;
const MAX_QUERY_VARIANTS = 3;
const MAX_CONSECUTIVE_NO_CANDIDATE_BY_CATEGORY = 10;
const MAX_CONSECUTIVE_NO_CANDIDATE_BY_COMBO = 5;
const PLAYWRIGHT_RESULT_LIMIT = 15;

const REGIONS = ["부산", "김해", "양산", "창원", "울산", "경남", "대구", "경북", "서울", "경기", "인천"];
const CATEGORIES = [
  "건설회사",
  "종합건설",
  "전기설비공사",
  "인테리어건축사",
  "시행사",
  "부동산개발",
  "병원",
  "요양병원",
  "의원",
  "동물병원",
  "장례식장",
  "법무법인",
  "법률사무소",
  "세무법인",
  "세무사무소",
  "회계법인",
  "회계사무소",
  "호텔",
  "리조트펜션",
  "웨딩홀",
  "제조업",
  "제조공장",
  "기계금속제조",
  "식품제조",
  "자동차딜러",
  "자동차판매점",
  "중고차매매",
  "수입차전시장",
  "렌터카",
  "카셰어링",
  "자동차정비",
  "금융기관",
  "보험대리점",
  "증권자산관리",
  "프랜차이즈본사",
  "음식프랜차이즈",
];

const CATEGORY_GROUPS = {
  건설회사: "건설/부동산",
  종합건설: "건설/부동산",
  전기설비공사: "건설/부동산",
  인테리어건축사: "건설/부동산",
  시행사: "건설/부동산",
  부동산개발: "건설/부동산",
  병원: "의료",
  요양병원: "의료",
  의원: "의료",
  동물병원: "의료",
  장례식장: "행사/의전",
  법무법인: "전문서비스",
  법률사무소: "전문서비스",
  세무법인: "전문서비스",
  세무사무소: "전문서비스",
  회계법인: "전문서비스",
  회계사무소: "전문서비스",
  호텔: "숙박/행사",
  리조트펜션: "숙박/행사",
  웨딩홀: "숙박/행사",
  제조업: "제조",
  제조공장: "제조",
  기계금속제조: "제조",
  식품제조: "제조",
  자동차딜러: "자동차",
  자동차판매점: "자동차",
  중고차매매: "자동차",
  수입차전시장: "자동차",
  렌터카: "자동차",
  카셰어링: "자동차",
  자동차정비: "자동차",
  금융기관: "금융",
  보험대리점: "금융",
  증권자산관리: "금융",
  프랜차이즈본사: "프랜차이즈",
  음식프랜차이즈: "프랜차이즈",
};

const KEYWORDS = {
  건설회사: ["건설회사", "건설업체", "건축회사", "토목회사", "전기공사", "설비공사"],
  종합건설: ["종합건설", "종합건설사", "건설업"],
  전기설비공사: ["전기공사", "설비공사", "소방설비", "기계설비"],
  인테리어건축사: ["인테리어", "건축사사무소", "설계사무소", "건축설계"],
  시행사: ["시행사", "부동산개발", "개발회사", "디벨로퍼"],
  부동산개발: ["부동산개발", "개발회사", "디벨로퍼", "부동산 시행"],
  병원: ["병원", "종합병원", "요양병원", "정형외과", "내과", "의원"],
  요양병원: ["요양병원", "재활병원", "노인병원"],
  의원: ["의원", "내과", "정형외과", "치과", "한의원"],
  동물병원: ["동물병원", "반려동물병원", "애견병원"],
  장례식장: ["장례식장", "장례문화원", "추모공원", "상조"],
  법무법인: ["법무법인", "변호사", "법률사무소"],
  법률사무소: ["법률사무소", "변호사사무실", "변호사"],
  세무법인: ["세무법인", "세무사", "세무사무소"],
  세무사무소: ["세무사무소", "세무사", "세무회계"],
  회계법인: ["회계법인", "회계사", "회계사무소"],
  회계사무소: ["회계사무소", "회계사", "공인회계사"],
  호텔: ["호텔", "비즈니스호텔", "관광호텔", "리조트"],
  리조트펜션: ["리조트", "펜션", "풀빌라", "관광숙박"],
  웨딩홀: ["웨딩홀", "예식장", "컨벤션웨딩", "웨딩컨벤션"],
  제조업: ["제조업", "제조업체", "공장", "기계제조", "금속제조", "식품제조", "화학제조"],
  제조공장: ["제조공장", "생산공장", "공장"],
  기계금속제조: ["기계제조", "금속제조", "산업기계", "금속가공"],
  식품제조: ["식품제조", "식품공장", "HACCP", "식품회사"],
  자동차딜러: [
    "자동차 딜러",
    "자동차매매",
    "수입차딜러",
    "중고차매매",
    "자동차전시장",
    "자동차영업소",
    "자동차 전시장",
    "자동차판매점",
    "수입차",
    "현대자동차 대리점",
    "기아 대리점",
    "BMW 전시장",
    "벤츠 전시장",
  ],
  자동차판매점: ["자동차판매점", "자동차영업소", "자동차대리점", "자동차 전시장"],
  중고차매매: ["중고차매매", "중고차상사", "자동차매매단지", "중고차 딜러"],
  수입차전시장: ["수입차전시장", "수입차딜러", "BMW 전시장", "벤츠 전시장", "아우디 전시장"],
  렌터카: ["렌터카", "렌트카", "렌터카지점", "렌터카 픽업존", "SK렌터카", "롯데렌터카"],
  카셰어링: ["카셰어링", "쏘카존", "그린카존", "G car zone"],
  자동차정비: ["자동차정비", "카센터", "자동차공업사", "수입차정비"],
  금융기관: ["금융기관", "은행", "저축은행", "신협", "새마을금고", "증권사", "보험사"],
  보험대리점: ["보험대리점", "GA보험", "보험설계", "보험대리"],
  증권자산관리: ["증권사", "자산관리", "투자자문", "자산운용"],
  프랜차이즈본사: ["프랜차이즈 본사", "가맹본부", "프랜차이즈본부", "체인본사"],
  음식프랜차이즈: ["외식프랜차이즈", "치킨본사", "카페프랜차이즈", "푸드프랜차이즈"],
};

export async function runQueuedCollect({
  limit = 300,
  delayMinMs = 1000,
  delayMaxMs = 2500,
  maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
  maxQueueVisits = DEFAULT_MAX_QUEUE_VISITS,
  dryRun = false,
  debug = false,
  logger,
  onDelay = null,
} = {}) {
  const startedAt = Date.now();
  console.log("Using Playwright Providers");
  console.log("Provider order: Kakao Map Cards");
  logger?.info("provider_selected", { provider: "playwright", order: ["kakao-map"] });

  const queue = loadOrCreateQueue({ persist: !dryRun });
  const { spreadsheetId } = await getTargetSpreadsheet({ readOnly: dryRun });
  const system = await readSystemState(spreadsheetId, { readOnly: dryRun });
  const { duplicateKeys: existingKeys, placeKeys: existingPlaceKeys, sourceUrlStats } =
    await readExistingCollectKeys(spreadsheetId);
  printSourceUrlCoverage(sourceUrlStats);
  logger?.info("existing_key_coverage", { ...sourceUrlStats, duplicateKeys: existingKeys.size, placeKeys: existingPlaceKeys.size });
  const failureCounts = readFailureCounts(system);
  const runKeys = new Set();
  const leads = [];
  const stats = {
    totalAttempts: 0,
    cardsScanned: 0,
    preSkippedByPlaceKey: 0,
    preSkippedByCardKey: 0,
    detailFetched: 0,
    duplicateExcluded: 0,
    missingPhoneExcluded: 0,
    addressMissing: 0,
    regionMismatchExcluded: 0,
    industryMismatchExcluded: 0,
    failedKeywords: 0,
    queueVisits: 0,
    queueSkipped: 0,
    noCandidateQueues: 0,
    abortedQueues: 0,
  };

  let requestCount = 0;
  const startIndex = normalizeQueueIndex(system.current_queue_index, queue.items.length);
  let queueIndex = startIndex;
  let queueAttemptCount = normalizeQueueAttempts(system.current_queue_attempts);
  let currentItem = queue.items[queueIndex];
  let stopReason = "";
  let consecutiveNoCandidateQueues = 0;
  let noCandidateCategory = "";
  let consecutiveNoCandidateCombo = 0;
  let noCandidateComboKey = "";
  const queueVisitLimit = normalizePositiveInteger(maxQueueVisits, DEFAULT_MAX_QUEUE_VISITS);
  const runtimeLimitMs = normalizePositiveInteger(maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS);
  const abort = createRuntimeAbort(startedAt, runtimeLimitMs);
  const skipContext = { existingKeys, existingPlaceKeys, runKeys };
  const browserState = createBrowserState();

  logQueue("Current Queue", queueIndex, currentItem);
  logger?.info("queue_start", { queueIndex, queueLength: queue.items.length, queue: currentItem, systemCurrentQueueIndex: system.current_queue_index });

  if (queue.items.length === 0) {
    stopReason = "Queue Empty";
    logger?.error("queue_empty", { reason: stopReason });
  }

  while (leads.length < limit && queue.items.length > 0) {
    if (abort.exceeded()) {
      stopReason = "max_runtime_reached";
      logger?.info("max_runtime_reached", { queueIndex, queueVisits: stats.queueVisits, maxRuntimeMs: runtimeLimitMs });
      break;
    }

    if (stats.queueVisits >= queueVisitLimit) {
      stopReason = "max_queue_visited";
      logger?.info("max_queue_visited", { queueIndex, queueVisits: stats.queueVisits, maxQueueVisits: queueVisitLimit });
      break;
    }

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
      queueAttemptCount = 0;
      continue;
    }

    logger?.info("queue_collect_start", { queueIndex, queue: currentItem, collectedSoFar: leads.length, attempt: queueAttemptCount + 1 });
    const beforeAttempts = stats.totalAttempts;
    const beforeScanned = stats.cardsScanned;
    const beforeLeads = leads.length;
    const beforeDuplicates = stats.duplicateExcluded;
    const beforeMissingPhone = stats.missingPhoneExcluded;
    const beforeRegionMismatch = stats.regionMismatchExcluded;
    const beforeIndustryMismatch = stats.industryMismatchExcluded;
    const beforePreSkipped = stats.preSkippedByPlaceKey + stats.preSkippedByCardKey;
    const beforeDetailFetched = stats.detailFetched;
    const itemResult = await collectQueueItem({
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
      abort,
      skipContext,
      browserState,
      debug,
    });

    if (itemResult.aborted) stats.abortedQueues += 1;

    if (itemResult.failed) {
      failureCounts[currentItem.id] = (failureCounts[currentItem.id] || 0) + 1;
      logger?.error("queue_failed", { reason: "Queue Failed", queue: currentItem, failureCount: failureCounts[currentItem.id] });
      if (failureCounts[currentItem.id] >= 3) stats.failedKeywords += 1;
    } else {
      failureCounts[currentItem.id] = 0;
    }

    if (stats.cardsScanned === beforeScanned) {
      stats.noCandidateQueues += 1;
      if (noCandidateCategory !== currentItem.category) {
        noCandidateCategory = currentItem.category;
        consecutiveNoCandidateQueues = 0;
      }
      consecutiveNoCandidateQueues += 1;
      const comboKey = `${currentItem.region}|${currentItem.category}`;
      if (noCandidateComboKey !== comboKey) {
        noCandidateComboKey = comboKey;
        consecutiveNoCandidateCombo = 0;
      }
      consecutiveNoCandidateCombo += 1;
      logger?.info("no_candidate", { reason: "No Candidate", queueIndex, queue: currentItem });
    } else if (leads.length === beforeLeads) {
      consecutiveNoCandidateQueues = 0;
      noCandidateCategory = "";
      consecutiveNoCandidateCombo = 0;
      noCandidateComboKey = "";
      logger?.info("already_completed_or_duplicate", {
        reason: "Already Completed",
        queueIndex,
        queue: currentItem,
        attempts: stats.totalAttempts - beforeAttempts,
        cardsScanned: stats.cardsScanned - beforeScanned,
        preSkipped: stats.preSkippedByPlaceKey + stats.preSkippedByCardKey - beforePreSkipped,
      });
    } else {
      consecutiveNoCandidateQueues = 0;
      noCandidateCategory = "";
      consecutiveNoCandidateCombo = 0;
      noCandidateComboKey = "";
    }

    if (consecutiveNoCandidateCombo >= MAX_CONSECUTIVE_NO_CANDIDATE_BY_COMBO && leads.length < limit) {
      printStage("Combo Fallback", `${currentItem.region} / ${currentItem.category}`);
      const fallbackResult = await collectQueueItem({
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
        abort,
        skipContext,
        browserState,
        debug,
        queryOverride: buildComboFallbackQueries(currentItem),
      });
      itemResult.candidateCount += fallbackResult.candidateCount;
      if (fallbackResult.aborted) itemResult.aborted = true;
      if (stats.cardsScanned > beforeScanned) {
        consecutiveNoCandidateCombo = 0;
        noCandidateComboKey = "";
      }
    }

    const queueAttempts = stats.totalAttempts - beforeAttempts;
    const queueScanned = stats.cardsScanned - beforeScanned;
    const queuePreSkipped = stats.preSkippedByPlaceKey + stats.preSkippedByCardKey - beforePreSkipped;
    const queueDetailFetched = stats.detailFetched - beforeDetailFetched;
    const queuePassed = leads.length - beforeLeads;
    const queueDuplicates = stats.duplicateExcluded - beforeDuplicates;
    printStage("Kakao Candidate", queueAttempts);
    printStage("필터 통과", queuePassed + queueDuplicates);
    printFilterSummary({
      cardsScanned: queueScanned,
      preSkipped: queuePreSkipped,
      detailFetched: queueDetailFetched,
      candidates: itemResult.candidateCount,
      passed: queuePassed + queueDuplicates,
      missingPhone: stats.missingPhoneExcluded - beforeMissingPhone,
      regionMismatch: stats.regionMismatchExcluded - beforeRegionMismatch,
      industryMismatch: stats.industryMismatchExcluded - beforeIndustryMismatch,
      duplicates: queueDuplicates,
    });
    printStage("신규 추가", queuePassed);
    printStage("중복 제외", queueDuplicates);
    logger?.info("queue_collect_finished", {
      queueIndex,
      queue: currentItem,
      completed: !itemResult.aborted,
      aborted: Boolean(itemResult.aborted),
      cardsScanned: queueScanned,
      preSkipped: queuePreSkipped,
      detailFetched: queueDetailFetched,
      candidates: itemResult.candidateCount,
      duplicateExcluded: queueDuplicates,
      inserted: queuePassed,
    });

    const advance = resolveQueueAdvance({
      queue,
      queueIndex,
      completed: !itemResult.aborted,
      attempts: queueAttemptCount,
    });
    queueAttemptCount = advance.attempts;
    if (!advance.advanced) {
      logger?.info("queue_incomplete_retry", {
        reason: "max_runtime_reached during collection",
        queueIndex,
        queue: currentItem,
        attempts: queueAttemptCount,
      });
      printStage("Queue Incomplete", `${formatQueue(summarizeQueueItem(currentItem))} (attempt ${queueAttemptCount})`);
    }
    queueIndex = advance.nextIndex;
    if (advance.advanced && consecutiveNoCandidateQueues >= MAX_CONSECUTIVE_NO_CANDIDATE_BY_CATEGORY) {
      const skippedFrom = queueIndex;
      queueIndex = nextCategoryQueueIndex(queue, queueIndex, currentItem.category);
      consecutiveNoCandidateQueues = 0;
      noCandidateCategory = "";
      logger?.info("category_skip_after_no_candidate", {
        reason: "no candidate queue threshold reached",
        threshold: MAX_CONSECUTIVE_NO_CANDIDATE_BY_CATEGORY,
        category: currentItem.category,
        fromQueueIndex: skippedFrom,
        nextQueueIndex: queueIndex,
        nextQueue: queue.items[queueIndex],
      });
      printStage("No Candidate Category Skip", `${currentItem.category} -> index ${queueIndex}`);
    }
    logQueue("Next Queue", queueIndex, queue.items[queueIndex]);

    if (leads.length < limit && abort.exceeded()) {
      stopReason = "max_runtime_reached";
      logger?.info("max_runtime_reached", { queueIndex, queueVisits: stats.queueVisits, maxRuntimeMs: runtimeLimitMs });
    } else if (stats.queueVisits >= queueVisitLimit && leads.length < limit) {
      stopReason = "max_queue_visited";
      logger?.info("max_queue_visited", { queueIndex, queueVisits: stats.queueVisits, maxQueueVisits: queueVisitLimit });
    }
  }

  await closeBrowserState(browserState);

  if (!stopReason) {
    if (leads.length >= limit) stopReason = "limit_reached";
    else if (stats.queueVisits >= queueVisitLimit) stopReason = "max_queue_visited";
    else if (abort.exceeded()) stopReason = "max_runtime_reached";
    else stopReason = "Completed";
  }

  const saveResult = dryRun
    ? {
        folderId: "",
        spreadsheetId,
        received: leads.length,
        inserted: leads.length,
        skipped: 0,
        sheetsApi: { append: 0, update: 0, total: 0 },
        industryCounts: {},
        gradeCounts: {},
      }
    : await saveLeadsToGoogleSheets(leads, { existingKeys });
  const sheetsApiStats = {
    append: saveResult.sheetsApi?.append || 0,
    update: saveResult.sheetsApi?.update || 0,
  };
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
  const resumeItem = queue.items[queueIndex] || queue.items[0];
  const upcomingItem = queue.items.length > 0 ? queue.items[nextQueueIndex(queue, queueIndex)] : null;
  const now = new Date().toISOString();
  const runMs = Date.now() - startedAt;

  // current_* describes the queue that current_queue_index points at, so the next run resumes
  // exactly where these fields say. The queue this run just processed is recorded in the LOG
  // "현재큐" column via report.currentQueue.
  const systemUpdates = {
    current_region: resumeItem?.region || "",
    current_category: resumeItem?.category || "",
    current_keyword: resumeItem?.keyword || "",
    current_queue_index: String(queueIndex),
    current_queue_attempts: String(queueAttemptCount),
    total_runs: String(numberValue(system.total_runs) + 1),
    total_collected: String(numberValue(system.total_collected) + stats.totalAttempts),
    total_new_added: String(numberValue(system.total_new_added) + saveResult.inserted),
    total_duplicates: String(numberValue(system.total_duplicates) + report.duplicateExcluded),
    last_run_at: now,
    next_region: upcomingItem?.region || "",
    next_category: upcomingItem?.category || "",
    next_keyword: upcomingItem?.keyword || "",
    failure_counts: JSON.stringify(failureCounts),
  };

  const status = dryRun ? "dry-run" : stopReason;
  if (!dryRun) {
    const systemWrite = await writeSystemState(spreadsheetId, systemUpdates, "FlowerCRM Collect queue state");
    sheetsApiStats.update += systemWrite.updates || 0;
    printStage("SYSTEM 업데이트 완료", "");
  }

  const state = {
    version: 2,
    lastKeyword: currentItem?.keyword || "",
    lastRegion: currentItem?.region || "",
    lastRunAt: now,
    totalCollected: Number(systemUpdates.total_collected),
    totalInserted: Number(systemUpdates.total_new_added),
    totalDuplicateExcluded: Number(systemUpdates.total_duplicates),
    currentQueueIndex: queueIndex,
    nextQueue: summarizeQueueItem(resumeItem),
    lastRunReport: {
      ...report,
      cardsScanned: stats.cardsScanned,
      preSkippedByPlaceKey: stats.preSkippedByPlaceKey,
      preSkippedByCardKey: stats.preSkippedByCardKey,
      preSkippedTotal: stats.preSkippedByPlaceKey + stats.preSkippedByCardKey,
      detailFetched: stats.detailFetched,
      addressMissing: stats.addressMissing,
      failedKeywords: stats.failedKeywords,
      queueVisits: stats.queueVisits,
      queueSkipped: stats.queueSkipped,
      noCandidateQueues: stats.noCandidateQueues,
      abortedQueues: stats.abortedQueues,
      queueAttempts: queueAttemptCount,
      stopReason,
      maxQueueVisits: queueVisitLimit,
      maxRuntimeMs: runtimeLimitMs,
      runMs,
      currentQueueIndex: queueIndex,
      currentQueue: summarizeQueueItem(currentItem),
      nextQueue: summarizeQueueItem(resumeItem),
    },
  };
  if (!dryRun) {
    saveState(state);
  }
  logger?.info("operational_report", state.lastRunReport);
  if (!dryRun) {
    const logWrite = await appendCollectLog(spreadsheetId, state.lastRunReport, status, buildCollectLogMemo(state.lastRunReport));
    sheetsApiStats.append += logWrite.appendCalls || 0;
    console.log("LOG 시트 기록 완료");
  }
  sheetsApiStats.total = sheetsApiStats.append + sheetsApiStats.update;
  printSheetsApiSummary(sheetsApiStats);
  printStopSummary(state.lastRunReport);

  printOperationalReport(state.lastRunReport);
  printSummaryReport(report);

  return { leads, stats, saveResult, report: state.lastRunReport, queue, state };
}

export function buildCollectLogMemo(report = {}) {
  return [
    report.stopReason || "",
    `cards=${report.cardsScanned ?? 0}`,
    `preSkipped=${report.preSkippedTotal ?? 0}(place=${report.preSkippedByPlaceKey ?? 0},card=${report.preSkippedByCardKey ?? 0})`,
    `detail=${report.detailFetched ?? 0}`,
    `addressMissing=${report.addressMissing ?? 0}`,
    `abortedQueues=${report.abortedQueues ?? 0}`,
    `queueAttempts=${report.queueAttempts ?? 0}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function loadOrCreateQueue({ persist = true, queuePath = QUEUE_PATH } = {}) {
  const queue = buildQueue();
  if (!fs.existsSync(queuePath)) {
    if (persist) saveQueue(queue, queuePath);
    return queue;
  }

  const existing = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  if (existing.version !== queue.version || existing.items?.length !== queue.items.length) {
    if (persist) saveQueue(queue, queuePath);
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
          group: CATEGORY_GROUPS[category] || category,
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
  abort,
  skipContext,
  browserState,
  debug = false,
  queryOverride = null,
}) {
  const result = { failed: false, aborted: false, candidateCount: 0 };
  let providerErrors = 0;
  try {
    const queries = queryOverride || buildKakaoQueries(item);
    const providers = buildCollectProviders();
    printKakaoQueryPlan(queries);
    logger?.info("collect_query_plan", { queueId: item.id, providers: providers.map((provider) => provider.name), queries });
    for (const provider of providers) {
      console.log(`Using ${provider.label}`);
      logger?.info("collect_provider_start", { provider: provider.name, queueId: item.id });
      for (const query of queries) {
        let queryCandidateCount = 0;
        if (abort.exceeded()) {
          result.aborted = true;
          break;
        }
        if (requestCountRef.value > 0) {
          await randomDelay(delayMinMs, delayMaxMs, async (waitMs) => {
            logger?.info("request_delay", { waitMs, queueId: item.id, provider: provider.name, query });
            if (onDelay) await onDelay(waitMs);
          });
        }
        if (abort.exceeded()) {
          result.aborted = true;
          break;
        }
        requestCountRef.value += 1;

        let response;
        try {
          response = await searchCollectProvider(provider, query, browserState, { abort, skipContext });
        } catch (error) {
          providerErrors += 1;
          logger?.info("collect_provider_failed", {
            provider: provider.name,
            query,
            error: error.message,
            reason: error.reason || "provider error",
            url: error.maskedUrl || "",
          });
          printProviderError(provider, query, error);
          break;
        }
        if (response.aborted) result.aborted = true;
        const scan = response.scan || { cardsScanned: 0, preSkippedByPlaceKey: 0, preSkippedByCardKey: 0, detailFetched: 0 };
        stats.cardsScanned += scan.cardsScanned;
        stats.preSkippedByPlaceKey += scan.preSkippedByPlaceKey;
        stats.preSkippedByCardKey += scan.preSkippedByCardKey;
        stats.detailFetched += scan.detailFetched;
        queryCandidateCount += response.documents.length;
        result.candidateCount += response.documents.length;
        logger?.info("collect_provider_response", {
          queueId: item.id,
          provider: provider.name,
          query,
          url: response.maskedUrl,
          status: response.status,
          documentsLength: response.documents.length,
          meta: response.meta,
          zeroReason: response.documents.length === 0 ? response.zeroReason : "",
        });
        printProviderResponse(response);
        if (debug) printCandidateDebug(response.documents);

        const queryBefore = {
          duplicates: stats.duplicateExcluded,
          missingPhone: stats.missingPhoneExcluded,
          regionMismatch: stats.regionMismatchExcluded,
          industryMismatch: stats.industryMismatchExcluded,
          addressMissing: stats.addressMissing,
          leads: leads.length,
        };
        for (const row of response.documents) {
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

        const queryMetrics = {
          queueId: item.id,
          query,
          cardsScanned: scan.cardsScanned,
          preSkippedByPlaceKey: scan.preSkippedByPlaceKey,
          preSkippedByCardKey: scan.preSkippedByCardKey,
          detailFetched: scan.detailFetched,
          candidates: response.documents.length,
          missingPhoneExcluded: stats.missingPhoneExcluded - queryBefore.missingPhone,
          addressMissing: stats.addressMissing - queryBefore.addressMissing,
          regionMismatchExcluded: stats.regionMismatchExcluded - queryBefore.regionMismatch,
          industryMismatchExcluded: stats.industryMismatchExcluded - queryBefore.industryMismatch,
          duplicateExcluded: stats.duplicateExcluded - queryBefore.duplicates,
          inserted: leads.length - queryBefore.leads,
          aborted: Boolean(response.aborted),
        };
        logger?.info("collect_query_metrics", queryMetrics);
        printQueryMetrics(queryMetrics);

        if (queryCandidateCount > 0 || leads.length >= limit || abort.exceeded()) break;
      }
      if (result.candidateCount > 0 || leads.length >= limit || abort.exceeded()) break;
    }
    if (abort.exceeded()) result.aborted = true;
    return {
      ...result,
      failed: resolveQueueItemFailure({
        aborted: result.aborted,
        candidateCount: result.candidateCount,
        providerErrors,
        providerCount: providers.length,
      }),
    };
  } catch (error) {
    logger?.error("keyword_failed", {
      item,
      error: error.message,
      reason: error.reason || "API 오류",
      status: error.status || "",
      url: error.maskedUrl || "",
      errorBody: error.errorBody || "",
    });
    printKakaoError(error);
    return { ...result, failed: true };
  }
}

function makeLead(row, item, stats) {
  const companyName = cleanKakaoPlaceName(row.place_name);
  const phone = displayPhone(row.phone);
  if (!companyName || !normalizePhone(phone)) {
    stats.missingPhoneExcluded += 1;
    return null;
  }

  const address = cleanText(row.road_address_name || row.address_name);
  // Measured only. A missing address keeps the current pass-through behaviour on purpose; the
  // exclusion policy is decided after the dry-run reports how often extraction actually fails.
  if (!address) stats.addressMissing += 1;
  if (!isRegionMatch(item.region, address)) {
    stats.regionMismatchExcluded += 1;
    return null;
  }

  const sourceIndustry = normalizeIndustry(item.industry, cleanText(row.category_name));
  const detailIndustry = [item.category, sourceIndustry].filter(Boolean).join(" / ");
  if (!isIndustryMatch(item.industry, detailIndustry, companyName)) {
    stats.industryMismatchExcluded += 1;
    return null;
  }

  return {
    companyName,
    industry: item.group || item.category,
    detailIndustry,
    region: item.region,
    address,
    phone,
    homepage: normalizeKakaoHomepageUrl(row.homepage_url || row.homepage || ""),
    email: "",
    sourceUrl: row.place_url || "",
    collectedAt: new Date().toISOString().slice(0, 10),
    grade: scoreIndustry(`${item.group || item.category} ${item.category}`, companyName),
    salesStatus: "신규",
    memo: "system queue collect",
  };
}

export function cleanKakaoPlaceName(value = "") {
  return cleanText(value).replace(/^[A-Z]\s+/, "");
}

async function searchKakao(query, page, size = 15) {
  if (!query) {
    const error = new Error("Kakao query generation error");
    error.reason = "query 생성 오류";
    throw error;
  }
  const params = new URLSearchParams({
    query,
    size: String(size),
    page: String(page),
  });
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?${params}`;
  const maskedUrl = maskKakaoUrl(url);
  const response = await fetch(url, {
    headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
  });
  const status = response.status;
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Kakao API error: ${response.status}`);
    error.reason = "API 오류";
    error.status = status;
    error.maskedUrl = maskedUrl;
    error.errorBody = text;
    throw error;
  }
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    error.reason = "response parsing 오류";
    error.status = status;
    error.maskedUrl = maskedUrl;
    error.errorBody = text;
    throw error;
  }
  const documents = Array.isArray(data.documents) ? data.documents : [];
  return {
    query,
    page,
    size,
    status,
    maskedUrl,
    documents,
    meta: data.meta || {},
    zeroReason: documents.length === 0 ? "API 응답 0" : "",
  };
}

export function buildCollectProviders() {
  const providers = [
    {
      name: "kakao-map",
      label: "Playwright Kakao Map Cards",
      type: "kakao-map",
      url: (query) => `https://map.kakao.com/?q=${encodeURIComponent(query)}`,
    },
  ];
  if (process.env.USE_KAKAO_API_PROVIDER === "true" && process.env.KAKAO_REST_API_KEY) {
    providers.push({ name: "kakao-api", label: "Optional Kakao API", type: "kakao-api" });
  }
  return providers;
}

async function searchCollectProvider(provider, query, browserState, { abort, skipContext } = {}) {
  if (provider.type === "kakao-api") {
    const response = await searchKakao(query, 1, PLAYWRIGHT_RESULT_LIMIT);
    return {
      ...response,
      provider: provider.name,
      label: provider.label,
      aborted: false,
      scan: createScanStats(response.documents.length, response.documents.length),
    };
  }
  if (provider.type === "kakao-map") {
    return searchKakaoMapProvider(provider, query, browserState, { abort, skipContext });
  }
  throw new Error(`Unsupported collect provider: ${provider.name}`);
}

export function createRuntimeAbort(startedAt, maxRuntimeMs, now = Date.now) {
  return {
    exceeded: () => isRuntimeExceeded(startedAt, maxRuntimeMs, now()),
  };
}

// An aborted item is a normal partial stop, never a keyword failure. Counting it as failed would
// grow failure_counts and permanently skip a healthy queue after three runs.
export function resolveQueueItemFailure({ aborted = false, candidateCount = 0, providerErrors = 0, providerCount = 0 } = {}) {
  if (aborted) return false;
  return candidateCount === 0 && providerCount > 0 && providerErrors === providerCount;
}

function createScanStats(cardsScanned = 0, detailFetched = 0) {
  return { cardsScanned, preSkippedByPlaceKey: 0, preSkippedByCardKey: 0, detailFetched };
}

export function cardDuplicateKey(cardSummary = {}) {
  const companyName = cleanKakaoPlaceName(cardSummary.place_name || "");
  const phone = displayPhone(cardSummary.phone || "");
  if (!companyName || !normalizePhone(phone)) return "";
  return duplicateKey(companyName, phone);
}

// Only an exact match against something already stored skips the detail page. Anything unknown,
// or any card without a phone number, still opens the detail page exactly like before.
export function knownCardSkipReason(cardSummary = {}, { existingKeys, existingPlaceKeys, runKeys } = {}) {
  const placeKey = kakaoPlaceKeyFromUrl(cardSummary.place_url || "");
  if (placeKey && existingPlaceKeys?.has(placeKey)) return "place_key";

  const cardKey = cardDuplicateKey(cardSummary);
  if (cardKey && (existingKeys?.has(cardKey) || runKeys?.has(cardKey))) return "card_key";

  return "";
}

function createBrowserState() {
  return { browser: null };
}

async function closeBrowserState(browserState) {
  if (browserState?.browser) {
    await browserState.browser.close();
    browserState.browser = null;
  }
}

async function getBrowser(browserState) {
  if (browserState.browser) return browserState.browser;
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("Playwright is not installed. Run npm install and npx playwright install chromium.");
  }
  browserState.browser = await chromium.launch({ headless: true });
  return browserState.browser;
}

async function searchKakaoMapProvider(provider, query, browserState, { abort, skipContext } = {}) {
  const browser = await getBrowser(browserState);
  const url = provider.url(query);
  let context;
  try {
    context = await browser.newContext({
      locale: "ko-KR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    });
    const page = await context.newPage();
    if (abort?.exceeded()) {
      return buildKakaoMapResponse(provider, query, url, [], createScanStats(), true);
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForKakaoMapCards(page);
    const collected = await collectKakaoMapDocuments(page, query, { abort, skipContext });
    return buildKakaoMapResponse(provider, query, url, collected.documents, collected.scan, collected.aborted);
  } catch (error) {
    error.reason = `${provider.name} locator error`;
    error.maskedUrl = url;
    throw error;
  } finally {
    if (context) {
      await context.close();
    }
  }
}

const KAKAO_CARD_SELECTORS = [
  "#info\\.search\\.place\\.list > li",
  "ul.placelist > li",
  "li.PlaceItem",
  ".PlaceItem",
].join(", ");

const KAKAO_PLACE_MORE_SELECTORS = ["#info\\.search\\.place\\.more", "a:has-text('장소 더보기')", "button:has-text('장소 더보기')"].join(", ");
const KAKAO_CARD_NAME_SELECTORS = ["a.link_name", ".tit_name .link_name", ".head_item .tit_name", "[data-id='name']"].join(", ");
const KAKAO_CARD_DETAIL_LINK_SELECTORS = ["a[href*='place.map.kakao.com']", "a.link_more", "a[data-id='moreview']"].join(", ");
const KAKAO_CARD_HOMEPAGE_SELECTORS = [
  "a.homepage",
  "a[data-id='homepage']",
  "a[title*='홈페이지']",
  "a[aria-label*='홈페이지']",
  "a[href^='http']:has-text('홈페이지')",
].join(", ");
const KAKAO_DETAIL_NAME_SELECTORS = ["h2.tit_location", ".tit_location", "h3.tit_subject", ".tit_subject", ".place_details .tit_name"].join(", ");
const KAKAO_DETAIL_ADDRESS_SELECTORS = [".txt_address", ".address_info .txt_address", ".location_detail .txt_location", ".detail_info .txt_detail", ".row_detail .txt_detail"].join(", ");
const KAKAO_DETAIL_PHONE_SELECTORS = ["a[href^='tel:']", ".txt_contact", ".phone", "[class*='phone']", "[class*='contact']"].join(", ");
const KAKAO_DETAIL_CATEGORY_SELECTORS = [".txt_location", ".location_present", ".txt_cate", ".category", "[class*='category']"].join(", ");
const KAKAO_DETAIL_HOMEPAGE_SELECTORS = [
  "a.link_homepage",
  "a.link_url",
  "a[href*='url=']",
  "a[href*='target=']",
  "a[title*='홈페이지']",
  "a[aria-label*='홈페이지']",
  "a[data-id*='homepage']",
  "a[data-id*='website']",
  "a:has-text('홈페이지')",
  "a[href^='http']:has-text('사이트')",
  "a[href^='http']:has-text('웹사이트')",
].join(", ");

async function waitForKakaoMapCards(page) {
  await page.waitForLoadState("domcontentloaded");
  await page
    .locator(KAKAO_CARD_SELECTORS)
    .first()
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(async () => {
      await page.waitForTimeout(1500);
    });
}

function buildKakaoMapResponse(provider, query, url, documents, scan, aborted) {
  return {
    provider: provider.name,
    label: provider.label,
    query,
    page: 1,
    size: PLAYWRIGHT_RESULT_LIMIT,
    status: 200,
    maskedUrl: url,
    documents,
    scan,
    aborted: Boolean(aborted),
    meta: { source: provider.name, browser: "playwright", mode: "locator-card-detail" },
    zeroReason: documents.length === 0 ? (aborted ? "max_runtime_reached" : "kakao map card result 0") : "",
  };
}

async function collectKakaoMapDocuments(page, query, { abort, skipContext } = {}) {
  const documents = [];
  const seen = new Set();
  const scan = createScanStats();
  let aborted = false;

  await openKakaoPlaceMore(page);

  for (let pageNumber = 1; pageNumber <= MAX_KAKAO_PAGE; pageNumber += 1) {
    if (abort?.exceeded()) {
      aborted = true;
      break;
    }
    await waitForKakaoMapCards(page);
    const pageAborted = await collectKakaoMapPageDocuments(page, query, documents, seen, { abort, skipContext, scan });
    if (pageAborted) {
      aborted = true;
      break;
    }
    if (!(await goToNextKakaoResultPage(page, pageNumber))) break;
  }

  return { documents, scan, aborted };
}

// Returns true when the runtime cap stopped this page. Every checkpoint below guards the same
// rule: once the deadline has passed, no *new* detail request may start. A request already in
// flight is allowed to finish, which is the only overrun the cap can produce.
export async function collectKakaoMapPageDocuments(page, query, documents, seen, { abort, skipContext, scan } = {}) {
  const cards = page.locator(KAKAO_CARD_SELECTORS);
  const count = Math.min(await cards.count(), PLAYWRIGHT_RESULT_LIMIT);

  for (let index = 0; index < count; index += 1) {
    if (abort?.exceeded()) return true;

    const card = cards.nth(index);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    const cardSummary = await readKakaoMapCard(card);
    if (abort?.exceeded()) return true;

    const detailUrl = cardSummary.place_url;
    if (!detailUrl || seen.has(detailUrl)) continue;
    seen.add(detailUrl);
    if (scan) scan.cardsScanned += 1;

    const skipReason = knownCardSkipReason(cardSummary, skipContext || {});
    if (skipReason) {
      if (scan && skipReason === "place_key") scan.preSkippedByPlaceKey += 1;
      if (scan && skipReason === "card_key") scan.preSkippedByCardKey += 1;
      continue;
    }

    // After the dedup decision and before the click, so an expired deadline never pays for the
    // card interaction that only exists to open the detail panel.
    if (abort?.exceeded()) return true;

    await card.click({ timeout: 3000 }).catch(() => {});
    if (abort?.exceeded()) return true;

    const detail = await readKakaoMapDetail(page.context(), detailUrl, { abort });
    if (!detail) return true;
    if (scan) scan.detailFetched += 1;
    documents.push({
      place_name: detail.place_name || cardSummary.place_name,
      category_name: detail.category_name || cardSummary.category_name || query,
      address_name: detail.address_name || cardSummary.address_name,
      road_address_name: detail.road_address_name || detail.address_name || cardSummary.address_name,
      phone: detail.phone || cardSummary.phone,
      homepage_url: detail.homepage_url || cardSummary.homepage_url || "",
      place_url: detail.place_url || detailUrl,
      query,
    });
  }
  return false;
}

async function openKakaoPlaceMore(page) {
  const opened = await clickKakaoVisibleControl(page, KAKAO_PLACE_MORE_SELECTORS);
  if (!opened) return false;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

async function goToNextKakaoResultPage(page, currentPageNumber) {
  const nextPageNumber = currentPageNumber + 1;
  const nextPageSlot = ((nextPageNumber - 1) % 5) + 1;
  const selector = nextPageSlot === 1 ? "#info\\.search\\.page\\.next" : `#info\\.search\\.page\\.no${nextPageSlot}`;
  const clicked = await clickKakaoVisibleControl(page, selector);
  if (!clicked) return false;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

async function clickKakaoVisibleControl(page, selector) {
  const controls = page.locator(selector);
  const count = await controls.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const className = cleanText(await control.getAttribute("class", { timeout: 1000 }).catch(() => ""));
    if (/disabled|disable|off|hide/i.test(className)) continue;
    await control.scrollIntoViewIfNeeded().catch(() => {});
    const clicked = await control.click({ timeout: 3000 }).then(
      () => true,
      () => false,
    );
    if (!clicked && !(await clickKakaoControlInPage(page, control))) continue;
    return true;
  }
  return false;
}

async function clickKakaoControlInPage(page, control) {
  const element = await control.elementHandle({ timeout: 1000 }).catch(() => null);
  if (!element) return false;
  return page
    .evaluate((node) => {
      node.click();
      return true;
    }, element)
    .then(
      () => true,
      () => false,
    )
    .finally(async () => {
      await element.dispose().catch(() => {});
    });
}

async function readKakaoMapCard(card) {
  const placeUrl = absoluteKakaoUrl(await firstLocatorAttribute(card, KAKAO_CARD_DETAIL_LINK_SELECTORS, "href"));
  return {
    place_name: await firstLocatorText(card, KAKAO_CARD_NAME_SELECTORS),
    category_name: await firstLocatorText(card, ".subcategory, .cate_name, [class*='category']"),
    address_name: await firstLocatorText(card, ".addr, .addr p, [data-id='address'], [class*='addr']"),
    phone: await firstLocatorText(card, ".phone, [data-id='phone'], [class*='phone']"),
    homepage_url: await firstNormalizedKakaoHomepageUrl(card, KAKAO_CARD_HOMEPAGE_SELECTORS, placeUrl),
    place_url: placeUrl,
  };
}

// Returns null when the runtime cap expired. The tab is only created once the deadline has been
// re-checked, so an expired run issues zero new detail requests.
export async function readKakaoMapDetail(context, detailUrl, { abort } = {}) {
  if (abort?.exceeded()) return null;

  const page = await context.newPage();
  try {
    if (abort?.exceeded()) return null;
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForLoadState("domcontentloaded");

    if (abort?.exceeded()) return null;
    await page.waitForTimeout(700);
    if (abort?.exceeded()) return null;

    await expandKakaoDetailSections(page);
    if (abort?.exceeded()) return null;

    const place_name = await firstLocatorText(page, KAKAO_DETAIL_NAME_SELECTORS);
    if (abort?.exceeded()) return null;
    const category_name = await firstLocatorText(page, KAKAO_DETAIL_CATEGORY_SELECTORS);
    if (abort?.exceeded()) return null;
    const address_name = await firstLocatorText(page, KAKAO_DETAIL_ADDRESS_SELECTORS);
    if (abort?.exceeded()) return null;
    const phone =
      normalizePhoneText(await firstLocatorAttribute(page, KAKAO_DETAIL_PHONE_SELECTORS, "href")) ||
      (await firstLocatorText(page, KAKAO_DETAIL_PHONE_SELECTORS));
    if (abort?.exceeded()) return null;
    const homepage_url = await firstNormalizedKakaoHomepageUrl(page, KAKAO_DETAIL_HOMEPAGE_SELECTORS, detailUrl);

    return {
      place_name,
      category_name,
      address_name,
      road_address_name: address_name,
      phone,
      homepage_url,
      place_url: page.url() || detailUrl,
    };
  } finally {
    await page.close();
  }
}

async function firstLocatorText(scope, selector) {
  const locator = scope.locator(selector).first();
  if ((await locator.count().catch(() => 0)) === 0) return "";
  return cleanText(await locator.innerText({ timeout: 2000 }).catch(() => ""));
}

async function firstLocatorAttribute(scope, selector, attribute) {
  const locator = scope.locator(selector).first();
  if ((await locator.count().catch(() => 0)) === 0) return "";
  return cleanText(await locator.getAttribute(attribute, { timeout: 2000 }).catch(() => ""));
}

async function firstNormalizedKakaoHomepageUrl(scope, selector, baseUrl) {
  const links = scope.locator(selector);
  const count = await links.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const href = await links.nth(index).getAttribute("href", { timeout: 1000 }).catch(() => "");
    const normalized = normalizeKakaoHomepageUrl(href, baseUrl);
    if (normalized) return normalized;
  }
  return "";
}

async function expandKakaoDetailSections(page) {
  const buttons = page.locator("button[aria-expanded='false']:has-text('펼치기'), button[aria-expanded='false']:has-text('더보기')");
  const count = await buttons.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 1000 }).catch(() => {});
  }
}

function absoluteKakaoUrl(value = "") {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    return new URL(raw, "https://place.map.kakao.com").toString();
  } catch {
    return "";
  }
}

function normalizePhoneText(value = "") {
  return cleanText(value).replace(/^tel:/i, "");
}

export function normalizeKakaoHomepageUrl(value = "", baseUrl = "https://place.map.kakao.com") {
  const raw = cleanText(value);
  if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw) || /^tel:/i.test(raw)) return "";
  let url;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    return normalizeUrl(raw);
  }
  const host = url.hostname.toLowerCase();
  const redirected = extractKakaoExternalUrl(url);
  if (redirected) return redirected;
  if (host.endsWith("kakao.com") || host.endsWith("kakaocdn.net")) return "";
  return normalizeUrl(url.toString());
}

function extractKakaoExternalUrl(url) {
  const host = url.hostname.toLowerCase();
  if (!host.endsWith("kakao.com") && !host.endsWith("kakaocdn.net")) return "";
  for (const key of ["url", "target", "href", "link", "u"]) {
    const value = url.searchParams.get(key);
    const normalized = normalizeUrl(value || "");
    if (!normalized) continue;
    const normalizedHost = new URL(normalized).hostname.toLowerCase();
    if (!normalizedHost.endsWith("kakao.com") && !normalizedHost.endsWith("kakaocdn.net")) return normalized;
  }
  return "";
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

export function getQueueRunStopReason({
  leadsCount = 0,
  limit = 300,
  queueVisits = 0,
  maxQueueVisits = DEFAULT_MAX_QUEUE_VISITS,
  startedAt = Date.now(),
  now = Date.now(),
  maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
} = {}) {
  if (leadsCount >= limit) return "limit_reached";
  if (queueVisits >= normalizePositiveInteger(maxQueueVisits, DEFAULT_MAX_QUEUE_VISITS)) return "max_queue_visited";
  if (isRuntimeExceeded(startedAt, normalizePositiveInteger(maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS), now)) return "max_runtime_reached";
  return "";
}

export function normalizeQueueAttempts(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

// A queue cut short by the runtime cap keeps its index so the next run retries it instead of
// silently skipping it. attempts is recorded for observability only - nothing acts on it, so a
// queue that never finishes will retry indefinitely until a stall policy is agreed separately.
export function resolveQueueAdvance({ queue, queueIndex, completed, attempts = 0 }) {
  if (completed) {
    return { nextIndex: nextQueueIndex(queue, queueIndex), attempts: 0, advanced: true };
  }
  return { nextIndex: queueIndex, attempts: normalizeQueueAttempts(attempts) + 1, advanced: false };
}

function nextQueueIndex(queue, index) {
  if (queue.items.length === 0) return 0;
  return (index + 1) % queue.items.length;
}

function nextCategoryQueueIndex(queue, index, category) {
  if (queue.items.length === 0) return 0;
  let next = normalizeQueueIndex(index, queue.items.length);
  for (let visited = 0; visited < queue.items.length; visited += 1) {
    if (queue.items[next]?.category !== category) return next;
    next = nextQueueIndex(queue, next);
  }
  return normalizeQueueIndex(index, queue.items.length);
}

// Every variant keeps the queue keyword. Broadening to the parent category is deliberately not a
// variant: it made a "요양병원" queue search "병원" and collapsed six distinct queues into one.
export function buildKakaoQueries(item) {
  const keyword = item.keyword || item.industry || item.category;
  const qualifier = item.industry || item.category;

  return [[item.region, keyword], [item.region, qualifier, keyword]]
    .map(composeQuery)
    .filter(Boolean)
    .filter((query, index, queries) => queries.indexOf(query) === index)
    .slice(0, MAX_QUERY_VARIANTS);
}

// Repeating a token ("경북 병원 병원") only narrows the search by accident, so identical parts
// collapse. The keyword itself is never dropped.
function composeQuery(parts) {
  return [...new Set(parts.filter(Boolean))].join(" ").replace(/\s+/g, " ").trim();
}

// The fallback widens the qualifier, never the subject: dropping item.keyword here is what turned
// a 요양병원 queue into a plain "경북 병원" search and collapsed six distinct queues into one.
export function buildComboFallbackQueries(item) {
  const keyword = item.keyword || item.industry || item.category;
  const representativeKeyword = representativeKeywordFor(item.category);
  return [
    [item.region, item.industry || item.category, keyword],
    [item.region, representativeKeyword, keyword],
  ]
    .map(composeQuery)
    .filter(Boolean)
    .filter((query, index, queries) => queries.indexOf(query) === index);
}

export async function testKakaoQuery({ region = "", keyword = "", page = 1, size = 15 } = {}) {
  if (!process.env.KAKAO_REST_API_KEY) {
    throw new Error("KAKAO_REST_API_KEY가 필요합니다.");
  }
  const query = [region, keyword].filter(Boolean).join(" ").trim();
  const response = await searchKakao(query, page, size);
  printKakaoResponse(response);
  for (const [index, document] of response.documents.slice(0, Number(size) || 15).entries()) {
    console.log(
      [
        `${index + 1}. ${cleanText(document.place_name)}`,
        cleanText(document.category_name),
        cleanText(document.phone),
        cleanText(document.road_address_name || document.address_name),
        document.place_url || "",
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
  return response;
}

function saveQueue(queue, queuePath = QUEUE_PATH) {
  fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
}

function saveState(state, statePath = STATE_PATH) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
  if (category === "기계금속제조") return "기계 금속 제조";
  if (category === "렌터카") return "렌터카";
  if (category === "카셰어링") return "카셰어링";
  return category;
}

function representativeKeywordFor(category) {
  const keywords = KEYWORDS[category] || [category];
  return keywords[0] || category;
}

function numberValue(value) {
  return Number(value || 0) || 0;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function isRuntimeExceeded(startedAt, maxRuntimeMs, now = Date.now()) {
  return now - startedAt >= maxRuntimeMs;
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

function printKakaoQueryPlan(queries) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Kakao Query Plan");
  queries.forEach((query, index) => console.log(`query${index + 1} = ${query}`));
  console.log("━━━━━━━━━━━━━━");
}

function printKakaoResponse({ query, page, size, status, maskedUrl, documents, meta, zeroReason }) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Kakao Request");
  console.log(`query ${query}`);
  console.log(`page ${page}`);
  console.log(`size ${size}`);
  console.log(`url ${maskedUrl}`);
  console.log(`status ${status}`);
  console.log(`documents length ${documents.length}`);
  console.log(`meta ${JSON.stringify(meta || {})}`);
  if (zeroReason) console.log(`zero reason ${zeroReason}`);
  console.log("━━━━━━━━━━━━━━");
}

function printProviderResponse({ provider, label, query, status, maskedUrl, documents, meta, zeroReason }) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Provider Request");
  console.log(`provider ${label || provider}`);
  console.log(`query ${query}`);
  console.log(`url ${maskedUrl}`);
  console.log(`status ${status}`);
  console.log(`documents length ${documents.length}`);
  console.log(`meta ${JSON.stringify(meta || {})}`);
  if (zeroReason) console.log(`zero reason ${zeroReason}`);
  console.log("━━━━━━━━━━━━━━");
}

function printCandidateDebug(documents) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Candidate Debug");
  for (const [index, document] of documents.slice(0, PLAYWRIGHT_RESULT_LIMIT).entries()) {
    console.log(
      [
        `${index + 1}. ${cleanText(document.place_name)}`,
        cleanText(document.category_name),
        cleanText(document.phone),
        cleanText(document.place_url),
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
  if (documents.length === 0) console.log("no candidates");
  console.log("━━━━━━━━━━━━━━");
}

function printProviderError(provider, query, error) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Provider Error");
  console.log(`provider ${provider.label || provider.name}`);
  console.log(`query ${query}`);
  console.log(`reason ${error.reason || "provider error"}`);
  if (error.maskedUrl) console.log(`url ${error.maskedUrl}`);
  console.log(`error ${error.message}`);
  console.log("━━━━━━━━━━━━━━");
}

function printKakaoError(error) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Kakao Error");
  console.log(`reason ${error.reason || "API 오류"}`);
  if (error.maskedUrl) console.log(`url ${error.maskedUrl}`);
  if (error.status) console.log(`status ${error.status}`);
  if (error.errorBody) console.log(`error body ${error.errorBody}`);
  console.log("━━━━━━━━━━━━━━");
}

function printFilterSummary(summary) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Filter Summary");
  console.log(`카드 스캔 수 ${summary.cardsScanned}`);
  console.log(`사전 중복 스킵 ${summary.preSkipped}`);
  console.log(`상세 조회 수 ${summary.detailFetched}`);
  console.log(`후보 수 ${summary.candidates}`);
  console.log(`필터 통과 수 ${summary.passed}`);
  console.log(`전화번호 없음 ${summary.missingPhone}`);
  console.log(`지역 불일치 ${summary.regionMismatch}`);
  console.log(`업종 불일치 ${summary.industryMismatch}`);
  console.log(`중복 제외 ${summary.duplicates}`);
  console.log("━━━━━━━━━━━━━━");
}

function printQueryMetrics(metrics) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Query Metrics");
  console.log(`query ${metrics.query}`);
  console.log(`카드 스캔 ${metrics.cardsScanned}`);
  console.log(`사전 중복 스킵 ${metrics.preSkippedByPlaceKey + metrics.preSkippedByCardKey} (출처URL ${metrics.preSkippedByPlaceKey} / 회사명+전화 ${metrics.preSkippedByCardKey})`);
  console.log(`상세 조회 ${metrics.detailFetched}`);
  console.log(`후보 ${metrics.candidates}`);
  console.log(`주소 없음 ${metrics.addressMissing}`);
  console.log(`최종 중복 제외 ${metrics.duplicateExcluded}`);
  console.log(`신규 ${metrics.inserted}`);
  console.log(`중단 ${metrics.aborted ? "max_runtime_reached" : "none"}`);
  console.log("━━━━━━━━━━━━━━");
}

function printSourceUrlCoverage(stats = {}) {
  const dataRows = stats.dataRows || 0;
  const rate = (value) => (dataRows > 0 ? `${((value / dataRows) * 100).toFixed(1)}%` : "n/a");
  console.log("━━━━━━━━━━━━━━");
  console.log("Existing Key Coverage");
  console.log(`기존 데이터 행 ${dataRows}`);
  console.log(`출처URL 보유 ${stats.withSourceUrl || 0} (${rate(stats.withSourceUrl || 0)})`);
  console.log(`Kakao place key 추출 ${stats.withPlaceKey || 0} (${rate(stats.withPlaceKey || 0)})`);
  console.log("━━━━━━━━━━━━━━");
}

function printSheetsApiSummary(stats) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Sheets API");
  console.log(`append ${stats.append || 0}회`);
  console.log(`update ${stats.update || 0}회`);
  console.log(`total ${stats.total || 0}회`);
  console.log("━━━━━━━━━━━━━━");
}

function printStopSummary(report) {
  console.log("━━━━━━━━━━━━━━");
  console.log("Collect Stop Summary");
  console.log(`방문한 queue 수 ${report.queueVisits}`);
  console.log(`카드 스캔 수 ${report.cardsScanned ?? 0}`);
  console.log(`사전 중복 스킵 수 ${report.preSkippedTotal ?? 0}`);
  console.log(`상세 조회 수 ${report.detailFetched ?? 0}`);
  console.log(`신규 추가 수 ${report.inserted}`);
  console.log(`중복 제외 수 ${report.duplicateExcluded}`);
  console.log(`종료 사유 ${report.stopReason}`);
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
  console.log(`runtime 중단 queue 수: ${report.abortedQueues ?? 0}`);
  console.log(`현재 queue 재시도 횟수: ${report.queueAttempts ?? 0}`);
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

function maskKakaoUrl(url) {
  return String(url).replace(/([?&](?:query|page|size)=)([^&]*)/g, (_, prefix, value) => `${prefix}${value}`);
}
