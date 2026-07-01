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
import { cleanText, displayPhone, normalizePhone, normalizeUrl } from "./normalize.js";
import { buildSummaryReport, printSummaryReport } from "./report.js";
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
  자동차딜러: [
    "자동차 딜러",
    "자동차매매",
    "수입차딜러",
    "중고차매매",
    "자동차전시장",
    "자동차영업소",
    "렌터카",
    "자동차 전시장",
    "자동차판매점",
    "수입차",
    "현대자동차 대리점",
    "기아 대리점",
    "BMW 전시장",
    "벤츠 전시장",
  ],
  금융기관: ["금융기관", "은행", "저축은행", "신협", "새마을금고", "증권사", "보험사"],
  프랜차이즈본사: ["프랜차이즈 본사", "가맹본부", "프랜차이즈본부", "체인본사"],
};

export async function runQueuedCollect({
  limit = 300,
  delayMinMs = 3000,
  delayMaxMs = 8000,
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
  let consecutiveNoCandidateQueues = 0;
  let noCandidateCategory = "";
  let consecutiveNoCandidateCombo = 0;
  let noCandidateComboKey = "";
  const queueVisitLimit = normalizePositiveInteger(maxQueueVisits, DEFAULT_MAX_QUEUE_VISITS);
  const runtimeLimitMs = normalizePositiveInteger(maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS);
  const browserState = createBrowserState();

  logQueue("Current Queue", queueIndex, currentItem);
  logger?.info("queue_start", { queueIndex, queueLength: queue.items.length, queue: currentItem, systemCurrentQueueIndex: system.current_queue_index });

  if (queue.items.length === 0) {
    stopReason = "Queue Empty";
    logger?.error("queue_empty", { reason: stopReason });
  }

  while (leads.length < limit && queue.items.length > 0) {
    if (isRuntimeExceeded(startedAt, runtimeLimitMs)) {
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
      continue;
    }

    logger?.info("queue_collect_start", { queueIndex, queue: currentItem, collectedSoFar: leads.length });
    const beforeAttempts = stats.totalAttempts;
    const beforeLeads = leads.length;
    const beforeDuplicates = stats.duplicateExcluded;
    const beforeMissingPhone = stats.missingPhoneExcluded;
    const beforeRegionMismatch = stats.regionMismatchExcluded;
    const beforeIndustryMismatch = stats.industryMismatchExcluded;
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
      startedAt,
      maxRuntimeMs: runtimeLimitMs,
      browserState,
      debug,
    });

    if (itemResult.failed) {
      failureCounts[currentItem.id] = (failureCounts[currentItem.id] || 0) + 1;
      logger?.error("queue_failed", { reason: "Queue Failed", queue: currentItem, failureCount: failureCounts[currentItem.id] });
      if (failureCounts[currentItem.id] >= 3) stats.failedKeywords += 1;
    } else {
      failureCounts[currentItem.id] = 0;
    }

    if (stats.totalAttempts === beforeAttempts) {
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
      logger?.info("already_completed_or_duplicate", { reason: "Already Completed", queueIndex, queue: currentItem, attempts: stats.totalAttempts - beforeAttempts });
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
        startedAt,
        maxRuntimeMs: runtimeLimitMs,
        browserState,
        debug,
        queryOverride: buildComboFallbackQueries(currentItem),
      });
      itemResult.candidateCount += fallbackResult.candidateCount;
      if (stats.totalAttempts > beforeAttempts) {
        consecutiveNoCandidateCombo = 0;
        noCandidateComboKey = "";
      }
    }

    const queueAttempts = stats.totalAttempts - beforeAttempts;
    const queuePassed = leads.length - beforeLeads;
    const queueDuplicates = stats.duplicateExcluded - beforeDuplicates;
    printStage("Kakao Candidate", queueAttempts);
    printStage("필터 통과", queuePassed + queueDuplicates);
    printFilterSummary({
      candidates: itemResult.candidateCount,
      passed: queuePassed + queueDuplicates,
      missingPhone: stats.missingPhoneExcluded - beforeMissingPhone,
      regionMismatch: stats.regionMismatchExcluded - beforeRegionMismatch,
      industryMismatch: stats.industryMismatchExcluded - beforeIndustryMismatch,
      duplicates: queueDuplicates,
    });
    printStage("신규 추가", queuePassed);
    printStage("중복 제외", queueDuplicates);

    queueIndex = nextQueueIndex(queue, queueIndex);
    if (consecutiveNoCandidateQueues >= MAX_CONSECUTIVE_NO_CANDIDATE_BY_CATEGORY) {
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

    if (leads.length < limit && isRuntimeExceeded(startedAt, runtimeLimitMs)) {
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
    else if (isRuntimeExceeded(startedAt, runtimeLimitMs)) stopReason = "max_runtime_reached";
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

  const status = dryRun ? "dry-run" : stopReason;
  if (!dryRun) {
    const systemWrite = await writeSystemState(spreadsheetId, systemUpdates, "FlowerCRM Collect queue state", system);
    sheetsApiStats.update += systemWrite.updates || 0;
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
      maxQueueVisits: queueVisitLimit,
      maxRuntimeMs: runtimeLimitMs,
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
    const logWrite = await appendCollectLog(spreadsheetId, state.lastRunReport, status, dryRun ? "dry-run only" : stopReason);
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
  startedAt,
  maxRuntimeMs,
  browserState,
  debug = false,
  queryOverride = null,
}) {
  const result = { failed: false, candidateCount: 0 };
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
        if (isRuntimeExceeded(startedAt, maxRuntimeMs)) break;
        if (requestCountRef.value > 0) {
          await randomDelay(delayMinMs, delayMaxMs, async (waitMs) => {
            logger?.info("request_delay", { waitMs, queueId: item.id, provider: provider.name, query });
            if (onDelay) await onDelay(waitMs);
          });
        }
        if (isRuntimeExceeded(startedAt, maxRuntimeMs)) break;
        requestCountRef.value += 1;

        let response;
        try {
          response = await searchCollectProvider(provider, query, browserState);
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
        if (queryCandidateCount > 0 || leads.length >= limit || isRuntimeExceeded(startedAt, maxRuntimeMs)) break;
      }
      if (result.candidateCount > 0 || leads.length >= limit || isRuntimeExceeded(startedAt, maxRuntimeMs)) break;
    }
    return { ...result, failed: result.candidateCount === 0 && providerErrors === providers.length };
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
    homepage: normalizeKakaoHomepageUrl(row.homepage_url || row.homepage || ""),
    email: "",
    sourceUrl: row.place_url || "",
    collectedAt: new Date().toISOString().slice(0, 10),
    grade: scoreIndustry(item.category, companyName),
    salesStatus: "신규",
    memo: "system queue collect",
  };
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

async function searchCollectProvider(provider, query, browserState) {
  if (provider.type === "kakao-api") {
    const response = await searchKakao(query, 1, PLAYWRIGHT_RESULT_LIMIT);
    return {
      ...response,
      provider: provider.name,
      label: provider.label,
    };
  }
  if (provider.type === "kakao-map") {
    return searchKakaoMapProvider(provider, query, browserState);
  }
  throw new Error(`Unsupported collect provider: ${provider.name}`);
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

async function searchKakaoMapProvider(provider, query, browserState) {
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForKakaoMapCards(page);
    const documents = await collectKakaoMapDocuments(page, query);
    return {
      provider: provider.name,
      label: provider.label,
      query,
      page: 1,
      size: PLAYWRIGHT_RESULT_LIMIT,
      status: 200,
      maskedUrl: url,
      documents,
      meta: { source: provider.name, browser: "playwright", mode: "locator-card-detail" },
      zeroReason: documents.length === 0 ? "kakao map card result 0" : "",
    };
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

const KAKAO_CARD_NAME_SELECTORS = ["a.link_name", ".tit_name .link_name", ".head_item .tit_name", "[data-id='name']"].join(", ");
const KAKAO_CARD_DETAIL_LINK_SELECTORS = ["a[href*='place.map.kakao.com']", "a.link_more", "a[data-id='moreview']"].join(", ");
const KAKAO_DETAIL_NAME_SELECTORS = ["h2.tit_location", ".tit_location", "h3.tit_subject", ".tit_subject", ".place_details .tit_name"].join(", ");
const KAKAO_DETAIL_ADDRESS_SELECTORS = [".txt_address", ".address_info .txt_address", ".location_detail .txt_location", "[class*='address']"].join(", ");
const KAKAO_DETAIL_PHONE_SELECTORS = ["a[href^='tel:']", ".txt_contact", ".phone", "[class*='phone']", "[class*='contact']"].join(", ");
const KAKAO_DETAIL_CATEGORY_SELECTORS = [".txt_location", ".location_present", ".txt_cate", ".category", "[class*='category']"].join(", ");
const KAKAO_DETAIL_HOMEPAGE_SELECTORS = [
  "a.link_homepage",
  "a[title*='홈페이지']",
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

async function collectKakaoMapDocuments(page, query) {
  const cards = page.locator(KAKAO_CARD_SELECTORS);
  const count = Math.min(await cards.count(), PLAYWRIGHT_RESULT_LIMIT);
  const documents = [];
  const seen = new Set();

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    const cardSummary = await readKakaoMapCard(card);
    const detailUrl = cardSummary.place_url;
    if (!detailUrl || seen.has(detailUrl)) continue;
    seen.add(detailUrl);

    await card.click({ timeout: 3000 }).catch(() => {});
    const detail = await readKakaoMapDetail(page.context(), detailUrl);
    documents.push({
      place_name: detail.place_name || cardSummary.place_name,
      category_name: detail.category_name || cardSummary.category_name || query,
      address_name: detail.address_name || cardSummary.address_name,
      road_address_name: detail.road_address_name || detail.address_name || cardSummary.address_name,
      phone: detail.phone || cardSummary.phone,
      homepage_url: detail.homepage_url || "",
      place_url: detail.place_url || detailUrl,
      query,
    });
  }

  return documents;
}

async function readKakaoMapCard(card) {
  const placeUrl = absoluteKakaoUrl(await firstLocatorAttribute(card, KAKAO_CARD_DETAIL_LINK_SELECTORS, "href"));
  return {
    place_name: await firstLocatorText(card, KAKAO_CARD_NAME_SELECTORS),
    category_name: await firstLocatorText(card, ".subcategory, .cate_name, [class*='category']"),
    address_name: await firstLocatorText(card, ".addr, .addr p, [data-id='address'], [class*='addr']"),
    phone: await firstLocatorText(card, ".phone, [data-id='phone'], [class*='phone']"),
    place_url: placeUrl,
  };
}

async function readKakaoMapDetail(context, detailUrl) {
  const page = await context.newPage();
  try {
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(700);
    const homepageHref = await firstLocatorAttribute(page, KAKAO_DETAIL_HOMEPAGE_SELECTORS, "href");
    return {
      place_name: await firstLocatorText(page, KAKAO_DETAIL_NAME_SELECTORS),
      category_name: await firstLocatorText(page, KAKAO_DETAIL_CATEGORY_SELECTORS),
      address_name: await firstLocatorText(page, KAKAO_DETAIL_ADDRESS_SELECTORS),
      road_address_name: await firstLocatorText(page, KAKAO_DETAIL_ADDRESS_SELECTORS),
      phone: normalizePhoneText(await firstLocatorAttribute(page, KAKAO_DETAIL_PHONE_SELECTORS, "href")) || (await firstLocatorText(page, KAKAO_DETAIL_PHONE_SELECTORS)),
      homepage_url: normalizeKakaoHomepageUrl(homepageHref, detailUrl),
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
  if (host.endsWith("kakao.com") || host.endsWith("kakaocdn.net")) return "";
  return normalizeUrl(url.toString());
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

export function buildKakaoQueries(item) {
  if (item.category === "병원" || item.industry === "병원") {
    return [
      `${item.region} 병원`,
      `${item.region} 의원`,
      `${item.region} 내과`,
      `${item.region} 정형외과`,
      `${item.region} 치과`,
      `${item.region} 한의원`,
    ];
  }
  return [
    [item.region, item.keyword],
    [item.region, item.industry || item.category],
    [item.region, item.industry || item.category, item.keyword],
  ]
    .map((parts) => parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((query, index, queries) => queries.indexOf(query) === index)
    .slice(0, MAX_QUERY_VARIANTS);
}

export function buildComboFallbackQueries(item) {
  const representativeKeyword = representativeKeywordFor(item.category);
  return [
    [item.region, item.industry || item.category],
    [item.region, representativeKeyword],
  ]
    .map((parts) => parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim())
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
  console.log(`후보 수 ${summary.candidates}`);
  console.log(`필터 통과 수 ${summary.passed}`);
  console.log(`전화번호 없음 ${summary.missingPhone}`);
  console.log(`지역 불일치 ${summary.regionMismatch}`);
  console.log(`업종 불일치 ${summary.industryMismatch}`);
  console.log(`중복 제외 ${summary.duplicates}`);
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
