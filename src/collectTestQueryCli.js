import { loadEnv } from "./env.js";
import { testKakaoQuery } from "./queueCollect.js";

loadEnv();

const args = parseArgs(process.argv.slice(2));

try {
  await testKakaoQuery({
    region: args.region || "",
    keyword: args.keyword || "",
    page: Number(args.page || 1),
    size: Number(args.size || 15),
  });
} catch (error) {
  console.error(error.message);
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
