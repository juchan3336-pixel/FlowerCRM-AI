import { loadEnv } from "./env.js";
import { RunLogger } from "./logger.js";
import { runQueuedCollect } from "./queueCollect.js";

loadEnv();

const args = parseArgs(process.argv.slice(2));
const limit = Number(args.limit || 300);
const delayMinMs = Number(args["delay-min-ms"] || 3000);
const delayMaxMs = Number(args["delay-max-ms"] || 8000);
const maxRuntimeMs = Number(args["max-runtime-ms"] || 20 * 60 * 1000);
const maxQueueVisits = Number(args["max-queue-visits"] || 40);
const dryRun = Boolean(args["dry-run"]);
const logger = new RunLogger(args["log-dir"] || "logs");

try {
  logger.info("queued_collect_started", { limit, delayMinMs, delayMaxMs, maxRuntimeMs, maxQueueVisits, dryRun });
  const result = await runQueuedCollect({
    limit,
    delayMinMs,
    delayMaxMs,
    maxRuntimeMs,
    maxQueueVisits,
    dryRun,
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
  console.log(`log=${logger.filePath}`);
} catch (error) {
  logger.error("queued_collect_failed", error);
  console.error(error.message);
  console.error(`log=${logger.filePath}`);
  process.exitCode = 1;
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
