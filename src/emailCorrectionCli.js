// Clears audited operator emails from the 기업 DB tab. Dry run unless --live is given.
//   node src/emailCorrectionCli.js --manifest corrections/<file>.json [--live]
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { loadEnv } from "./env.js";
import { getTargetSpreadsheet, readDbRow, writeDbCells } from "./googleSheets.js";
import { runCorrections } from "./emailCorrection.js";
import { maskConsoleOutput } from "./publicLog.js";

export async function main(argv = process.argv.slice(2)) {
  loadEnv();
  // The Actions log is public: addresses are printed with their domain only.
  const restoreConsole = maskConsoleOutput();
  try {
    return await correct(argv);
  } finally {
    restoreConsole();
  }
}

async function correct(argv) {
  const manifestPath = argv[argv.indexOf("--manifest") + 1];
  if (!argv.includes("--manifest") || !manifestPath) throw new Error("--manifest <file> is required");
  const live = argv.includes("--live");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // Lookup only, live or not: the live lookup would also repair the workbook's tabs and header
  // rows, which is a write this tool has no business making. The only write is the H/M batch.
  const { spreadsheetId } = await getTargetSpreadsheet({ readOnly: true });
  console.log(`manifest=${manifestPath} audit=${manifest.audit} entries=${(manifest.entries || []).length} mode=${live ? "live" : "dry-run"}`);
  const result = await runCorrections({
    sheets: { readDbRow, writeDbCells },
    spreadsheetId,
    manifest,
    dryRun: !live,
    log: (kind, item) => console.log(`${kind} ${JSON.stringify(item)}`),
  });
  console.log(`status=${result.status} planned=${result.actions.length} skipped=${result.skipped.length} problems=${result.problems.length} written=${result.written}`);
  if (result.status === "aborted" || result.status === "written_with_problems") process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
