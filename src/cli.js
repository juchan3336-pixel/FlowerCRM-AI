import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnv } from "./env.js";
import { RunLogger } from "./logger.js";
import { NO_RESULT_CARDS_STOP_REASON, runQueuedCollect, sawNoResultCards } from "./queueCollect.js";

const DISCORD_COLLECT_SUMMARY_PATH = path.join("logs", "discord-collect-summary.json");
const DISCORD_COLLECT_ERROR_PATH = path.join("logs", "discord-collect-error.log");
const ERROR_EXCERPT_LIMIT = 2000;

export async function runCli(argv = process.argv.slice(2)) {
  loadEnv();
  const args = parseArgs(argv);
  const limit = Number(args.limit || 300);
  const delayMinMs = Number(args["delay-min-ms"] || 1000);
  const delayMaxMs = Number(args["delay-max-ms"] || 2500);
  const maxRuntimeMs = Number(args["max-runtime-ms"] || 20 * 60 * 1000);
  const maxQueueVisits = Number(args["max-queue-visits"] || 40);
  const dryRun = Boolean(args["dry-run"]);
  const debug = Boolean(args.debug);
  const logger = new RunLogger(args["log-dir"] || "logs");

  try {
    logger.info("queued_collect_started", { limit, delayMinMs, delayMaxMs, maxRuntimeMs, maxQueueVisits, dryRun, debug });
    const result = await runQueuedCollect({
      limit,
      delayMinMs,
      delayMaxMs,
      maxRuntimeMs,
      maxQueueVisits,
      dryRun,
      debug,
      logger,
      onDelay: (waitMs) => {
        console.log(`다음 요청까지 대기 ${(waitMs / 1000).toFixed(1)}초`);
      },
    });
    logger.info("queued_collect_finished", {
      inserted: result.saveResult.inserted,
      totalAttempts: result.report.totalAttempts,
      currentQueueIndex: result.report.currentQueueIndex,
      nextQueue: result.state.nextQueue,
      dryRun,
    });
    const outcome = resolveCollectOutcome(result);
    if (outcome.status === "FAILED") {
      logger.error("queued_collect_unhealthy", { message: outcome.message, error: outcome.errorMessage });
      writeErrorExcerpt(outcome.errorMessage);
      writeDiscordCollectSummary({
        status: "FAILED",
        message: outcome.message,
        errorMessage: outcome.errorMessage,
        queueVisits: result.report.queueVisits,
        stopReason: result.report.stopReason,
        currentQueue: result.report.currentQueue,
        nextQueue: result.state.nextQueue,
        runMs: result.report.runMs,
        logPath: logger.filePath,
        errorLogPath: DISCORD_COLLECT_ERROR_PATH,
      });
      console.error(`${outcome.message}: ${outcome.errorMessage}`);
      console.error(`log=${logger.filePath}`);
      process.exitCode = outcome.exitCode;
      return;
    }
    writeDiscordCollectSummary({
      status: "SUCCESS",
      inserted: result.saveResult.inserted,
      newAdded: result.saveResult.inserted,
      duplicateExcluded: result.report.duplicateExcluded,
      queueVisits: result.report.queueVisits,
      stopReason: result.report.stopReason,
      currentQueue: result.report.currentQueue,
      nextQueue: result.state.nextQueue,
      runMs: result.report.runMs,
      logPath: logger.filePath,
    });
    console.log(`log=${logger.filePath}`);
  } catch (error) {
    logger.error("queued_collect_failed", error);
    const errorMessage = messageFromError(error);
    writeErrorExcerpt(errorMessage);
    writeDiscordCollectSummary({
      status: "FAILED",
      message: "Collect workflow failed",
      errorMessage,
      logPath: logger.filePath,
      errorLogPath: DISCORD_COLLECT_ERROR_PATH,
    });
    console.error(errorMessage);
    console.error(`log=${logger.filePath}`);
    process.exitCode = 1;
  }
}

// A run can finish without throwing and still have collected nothing for a reason that needs a
// person: the provider refused us, or not a single result card was seen across a whole run. Both
// used to end green, which is how 94 refused runs (2026-10-21 to 11-10) went unnoticed.
export function resolveCollectOutcome(result = {}) {
  const report = result.report || {};
  if (report.stopReason === "provider_unavailable") {
    return {
      status: "FAILED",
      exitCode: 1,
      message: "Collect provider unavailable",
      errorMessage: result.providerUnavailable?.message || "the provider refused the request",
    };
  }
  const queueVisits = Number(report.queueVisits) || 0;
  // The run itself makes this call before it writes anything (resolveRunClosure); the counts are
  // read again here so a report that somehow lost the stop reason still cannot end green.
  if (report.stopReason === NO_RESULT_CARDS_STOP_REASON || sawNoResultCards(report)) {
    return {
      status: "FAILED",
      exitCode: 1,
      message: "Collect saw no result cards",
      errorMessage: `no result cards in ${queueVisits} queue visits - the provider may be serving a page the collector cannot read`,
    };
  }
  return { status: "SUCCESS", exitCode: 0, message: "", errorMessage: "" };
}

export function writeDiscordCollectSummary(summary) {
  fs.mkdirSync(path.dirname(DISCORD_COLLECT_SUMMARY_PATH), { recursive: true });
  fs.writeFileSync(DISCORD_COLLECT_SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export function writeErrorExcerpt(message) {
  fs.mkdirSync(path.dirname(DISCORD_COLLECT_ERROR_PATH), { recursive: true });
  fs.writeFileSync(DISCORD_COLLECT_ERROR_PATH, `${message.slice(0, ERROR_EXCERPT_LIMIT)}\n`, "utf8");
}

function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
