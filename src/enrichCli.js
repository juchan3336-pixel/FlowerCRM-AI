import { loadEnv } from "./env.js";
import { runEnrich } from "./enrich.js";
import { RunLogger } from "./logger.js";

loadEnv();

const args = parseArgs(process.argv.slice(2));
const limit = Number(args.limit || 300);
const dryRun = Boolean(args["dry-run"]);
const debug = Boolean(args.debug);
const logger = new RunLogger(args["log-dir"] || "logs", "enrich");

try {
  logger.info("enrich_started", { limit, dryRun, debug });
  const summary = await runEnrich({ limit, dryRun, debug, logger });
  logger.info("enrich_finished", summary);
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
