import fs from "node:fs";

import { loadEnv } from "./env.js";
import { enrichRunStatus, runEnrich } from "./enrich.js";
import { RunLogger } from "./logger.js";

const DISCORD_SUMMARY_PATH = "logs/discord-enrich-summary.json";

loadEnv();

const args = parseArgs(process.argv.slice(2));
const limit = Number(args.limit || 300);
const maxRuntimeMs = parseNonNegativeInteger(args["max-runtime-ms"], "--max-runtime-ms");
const maxRowRuntimeMs = parseOptionalNonNegativeInteger(
  args["max-row-runtime-ms"],
  process.env.ENRICH_ROW_MAX_RUNTIME_MS,
  "--max-row-runtime-ms",
);
const maxSearchQueries = parseOptionalNonNegativeInteger(
  args["max-search-queries"],
  process.env.ENRICH_MAX_SEARCH_QUERIES_PER_ROW,
  "--max-search-queries",
);
const maxResultPages = parseOptionalNonNegativeInteger(
  args["max-result-pages"],
  process.env.ENRICH_MAX_RESULT_PAGES_PER_ROW,
  "--max-result-pages",
);
const maxHomepagePages = parseOptionalNonNegativeInteger(
  args["max-homepage-pages"],
  process.env.ENRICH_MAX_HOMEPAGE_PAGES_PER_ROW,
  "--max-homepage-pages",
);
// Whole-job limit including sheet I/O. The workflow fixes an absolute instant in its first step
// (--job-deadline-at-ms, epoch ms) so setup time is not counted twice; --job-deadline-ms is the
// relative form for manual runs.
const jobDeadlineMs = parseOptionalNonNegativeInteger(args["job-deadline-ms"], process.env.ENRICH_JOB_DEADLINE_MS, "--job-deadline-ms");
const jobDeadlineAt = parseOptionalNonNegativeInteger(
  args["job-deadline-at-ms"],
  process.env.ENRICH_JOB_DEADLINE_AT_MS,
  "--job-deadline-at-ms",
);
const dryRun = Boolean(args["dry-run"]);
const debug = Boolean(args.debug);
const logger = new RunLogger(args["log-dir"] || "logs", "enrich");

try {
  const startRow = parseStartRow(args);
  logger.info("enrich_started", {
    limit,
    maxRuntimeMs,
    maxRowRuntimeMs,
    maxSearchQueries,
    maxResultPages,
    maxHomepagePages,
    dryRun,
    debug,
    startRow,
  });
  const summary = await runEnrich({
    limit,
    startRow,
    maxRuntimeMs,
    maxRowRuntimeMs,
    maxSearchQueries,
    maxResultPages,
    maxHomepagePages,
    jobDeadlineMs,
    jobDeadlineAt,
    dryRun,
    debug,
    logger,
  });
  logger.info("enrich_finished", summary);
  writeDiscordSummary({
    status: enrichRunStatus(summary).toUpperCase(),
    interruptedRow: summary.interruptedRow,
    hardTimeouts: summary.hardTimeouts,
    cleanupFailed: summary.cleanupFailed,
    processed: summary.processed,
    homepageFound: summary.homepageFound,
    emailFound: summary.emailFound,
    failed: summary.failed,
    startRow: summary.startRow,
    nextRow: summary.nextRow,
    providers: summary.searchProvidersUsed || [],
    searchProvidersUsed: summary.searchProvidersUsed || [],
    stopReason: summary.stopReason,
    runMs: summary.runMs,
    rowMsAvg: summary.rowMsAvg,
    rowMsMax: summary.rowMsMax,
    fastPathSucceeded: summary.fastPathSucceeded,
    fastPathAttempted: summary.fastPathAttempted,
    budgetStops: summary.budgetStops,
    budgetHits: summary.budgetHits,
    stopReasons: summary.stopReasons,
    logPath: logger.filePath,
  });
  console.log(
    [
      `processed=${summary.processed}`,
      `homepageFound=${summary.homepageFound}`,
      `emailFound=${summary.emailFound}`,
      `nextRow=${summary.nextRow}`,
      `failed=${summary.failed}`,
      `log=${logger.filePath}`,
    ].join(" "),
  );
} catch (error) {
  logger.error("enrich_failed", error);
  writeDiscordSummary({
    status: "FAILED",
    message: error.message,
    errorMessage: error.message,
    logPath: logger.filePath,
  });
  console.error(error.message);
  console.error(`log=${logger.filePath}`);
  process.exitCode = 1;
}

// The run is over and its summary is on disk. Work that was abandoned because it never settled
// (a stuck browser, a socket that never closes) can still hold the event loop open, which would
// keep the job alive until the workflow timeout — run #309 all over again. Give ordinary handles
// a moment to drain, then leave. Unref'd, so a clean run exits immediately and never waits here.
setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref();

function writeDiscordSummary(summary) {
  fs.mkdirSync("logs", { recursive: true });
  fs.writeFileSync(DISCORD_SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
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

function parseStartRow(args) {
  if (args["start-row"] === undefined) return args["from-start"] ? 2 : undefined;
  const row = Number(args["start-row"]);
  if (!Number.isInteger(row) || row < 2) {
    throw new Error("--start-row must be an integer greater than or equal to 2");
  }
  return row;
}

function parseNonNegativeInteger(value, flagName) {
  if (value === undefined) return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${flagName} must be a non-negative integer`);
  }
  return number;
}

// Returns undefined when neither the CLI flag nor the env var is set, so runEnrich's default
// budget applies. An explicit 0 disables the budget. Non-negative integers are honored as-is.
function parseOptionalNonNegativeInteger(flagValue, envValue, flagName) {
  const raw = flagValue !== undefined && flagValue !== true ? flagValue : envValue;
  if (raw === undefined || raw === "") return undefined;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${flagName} must be a non-negative integer`);
  }
  return number;
}
