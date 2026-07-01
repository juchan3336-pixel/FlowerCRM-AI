import fs from "node:fs";

import { loadEnv } from "./env.js";
import { testKakaoQuery } from "./queueCollect.js";

const DISCORD_SUMMARY_PATH = "logs/discord-kakao-summary.json";

loadEnv();

const args = parseArgs(process.argv.slice(2));
const region = args.region || "";
const keyword = args.keyword || "";

try {
  const response = await testKakaoQuery({
    region,
    keyword,
    page: Number(args.page || 1),
    size: Number(args.size || 15),
  });
  writeDiscordSummary({
    status: "SUCCESS",
    region,
    keyword,
    query: response.query,
    statusCode: response.status,
    documents: response.documents,
    documentCount: response.documents.length,
    zeroReason: response.zeroReason || "",
  });
} catch (error) {
  writeDiscordSummary({
    status: "FAILED",
    message: error.message,
    errorMessage: error.message,
  });
  console.error(error.message);
  process.exitCode = 1;
}

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
