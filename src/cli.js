import { DEFAULT_INDUSTRIES, DEFAULT_REGIONS } from "./config.js";
import { LeadCollector } from "./collector.js";
import { loadEnv } from "./env.js";
import { saveLeadsToGoogleSheets } from "./googleSheets.js";
import { RunLogger } from "./logger.js";
import { buildSummaryReport, printSummaryReport } from "./report.js";

loadEnv();

const args = parseArgs(process.argv.slice(2));
const regions = csvArg(args.regions, DEFAULT_REGIONS);
const industries = csvArg(args.industries, DEFAULT_INDUSTRIES);
const perQuery = Number(args["per-query"] || 10);
const limit = Number(args.limit || 300);
const delayMinMs = Number(args["delay-min-ms"] || 3000);
const delayMaxMs = Number(args["delay-max-ms"] || 8000);
const extractEmails = !args["no-email"];
const logger = new RunLogger(args["log-dir"] || "logs");

try {
  logger.info("run_started", { regions, industries, perQuery, limit, delayMinMs, delayMaxMs, extractEmails });

  const collector = new LeadCollector({ extractEmails });
  const { leads, stats } = await collector.collectWithStats({
    regions,
    industries,
    perQuery,
    limit,
    delayMinMs,
    delayMaxMs,
    onDelay: (waitMs) => {
      logger.info("request_delay", { waitMs });
      console.log(`다음 요청까지 대기: ${(waitMs / 1000).toFixed(1)}초`);
    },
  });
  logger.info("collection_finished", { collected: leads.length });

  const result = await saveLeadsToGoogleSheets(leads);
  logger.info("google_sheets_saved", result);
  const report = buildSummaryReport(stats, result);
  logger.info("summary_report", report);

  console.log(`spreadsheetId=${result.spreadsheetId}`);
  console.log(`log=${logger.filePath}`);
  printSummaryReport(report);
} catch (error) {
  logger.error("run_failed", error);
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

function csvArg(value, fallback) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
