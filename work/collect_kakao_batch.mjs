import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_INDUSTRIES, DEFAULT_REGIONS } from "../src/config.js";
import { isIndustryMatch } from "../src/industryFilter.js";
import { normalizePhone } from "../src/normalize.js";
import { scoreIndustry } from "../src/scoring.js";

const target = Number(process.argv[2] || 1000);
const delayMinSeconds = Number(process.argv[3] || 3);
const delayMaxSeconds = Number(process.argv[4] || 8);
const runName = process.argv[5] || `kakao_${target}`;
const outputPath = `outputs/${runName}_rows.json`;
const statsPath = `outputs/${runName}_stats.json`;
const chunkDir = `outputs/${runName}_chunks`;
const today = new Date().toISOString().slice(0, 10);

const industryQueries = {
  "\uac74\uc124\ud68c\uc0ac": ["\uac74\uc124\ud68c\uc0ac", "\uac74\uc124\uc5c5\uccb4", "\uac74\ucd95\ud68c\uc0ac", "\ud1a0\ubaa9\ud68c\uc0ac", "\uc804\uae30\uacf5\uc0ac", "\uc124\ube44\uacf5\uc0ac"],
  "\uc2dc\ud589\uc0ac": ["\uc2dc\ud589\uc0ac", "\ubd80\ub3d9\uc0b0\uac1c\ubc1c", "\uac1c\ubc1c\ud68c\uc0ac", "\ub514\ubca8\ub85c\ud37c"],
  "\uc885\ud569\uac74\uc124": ["\uc885\ud569\uac74\uc124", "\uac74\uc124\uc5c5", "\uc885\ud569\uac74\uc124\uc0ac"],
  "\ubcd1\uc6d0": ["\ubcd1\uc6d0", "\uc885\ud569\ubcd1\uc6d0", "\uc694\uc591\ubcd1\uc6d0", "\uc815\ud615\uc678\uacfc", "\ub0b4\uacfc", "\uc758\uc6d0"],
  "\uc81c\uc870\uc5c5\uccb4": ["\uc81c\uc870\uc5c5\uccb4", "\uc81c\uc870", "\uacf5\uc7a5", "\uae30\uacc4\uc81c\uc870", "\uae08\uc18d\uc81c\uc870", "\uc2dd\ud488\uc81c\uc870", "\ud654\ud559\uc81c\uc870"],
  "\ubc95\ubb34\ubc95\uc778": ["\ubc95\ubb34\ubc95\uc778", "\ubcc0\ud638\uc0ac", "\ubc95\ub960\uc0ac\ubb34\uc18c"],
  "\uc138\ubb34\ubc95\uc778": ["\uc138\ubb34\ubc95\uc778", "\uc138\ubb34\uc0ac", "\uc138\ubb34\uc0ac\ubb34\uc18c"],
  "\ud68c\uacc4\ubc95\uc778": ["\ud68c\uacc4\ubc95\uc778", "\ud68c\uacc4\uc0ac", "\ud68c\uacc4\uc0ac\ubb34\uc18c"],
  "\uc790\ub3d9\ucc28 \ub51c\ub7ec": ["\uc790\ub3d9\ucc28 \ub51c\ub7ec", "\uc790\ub3d9\ucc28 \uc804\uc2dc\uc7a5", "\uc218\uc785\ucc28", "\ud604\ub300\uc790\ub3d9\ucc28 \ub300\ub9ac\uc810", "\uae30\uc544 \ub300\ub9ac\uc810", "BMW \uc804\uc2dc\uc7a5", "\ubca4\uce20 \uc804\uc2dc\uc7a5"],
  "\ud638\ud154": ["\ud638\ud154", "\ube44\uc988\ub2c8\uc2a4\ud638\ud154", "\uad00\uad11\ud638\ud154", "\ub9ac\uc870\ud2b8"],
};

const stats = {
  totalAttempts: 0,
  inserted: 0,
  duplicateExcluded: 0,
  missingPhoneExcluded: 0,
  regionMismatchExcluded: 0,
  industryMismatchExcluded: 0,
  requestCount: 0,
  delaySecondsTotal: 0,
  industryCounts: {},
  gradeCounts: {},
};

if (!process.env.KAKAO_REST_API_KEY) {
  throw new Error("KAKAO_REST_API_KEY is required");
}

const seen = loadExistingKeys();
const rows = [];
let firstRequest = true;

for (const querySpec of buildQueries()) {
  for (let page = 1; page <= 3; page += 1) {
    if (rows.length >= target) break;
    if (!firstRequest) {
      const seconds = randomInt(delayMinSeconds, delayMaxSeconds);
      stats.delaySecondsTotal += seconds;
      console.log(`대기 ${seconds}초... 현재 ${rows.length}/${target}`);
      await sleep(seconds * 1000);
    }
    firstRequest = false;

    stats.requestCount += 1;
    const params = new URLSearchParams({ query: querySpec.query, size: "15", page: String(page) });
    const response = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${params}`, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
    });
    if (!response.ok) {
      console.log(`요청 실패: ${querySpec.query} page=${page} status=${response.status}`);
      continue;
    }

    const data = await response.json();
    const documents = data.documents || [];
    for (const item of documents) {
      stats.totalAttempts += 1;
      const phone = item.phone || "";
      if (normalizePhone(phone).length < 8) {
        stats.missingPhoneExcluded += 1;
        continue;
      }

      const address = item.road_address_name || item.address_name || "";
      if (address && !address.includes(querySpec.region)) {
        stats.regionMismatchExcluded += 1;
        continue;
      }

      const name = item.place_name || "";
      const detail = item.category_name || "";
      if (!isIndustryMatch(querySpec.industry, detail, name)) {
        stats.industryMismatchExcluded += 1;
        continue;
      }

      const key = leadKey(name, phone);
      if (seen.has(key)) {
        stats.duplicateExcluded += 1;
        continue;
      }
      seen.add(key);

      const grade = scoreIndustry(querySpec.industry, name);
      rows.push({
        "\ud68c\uc0ac\uba85": name,
        "\uc5c5\uc885": querySpec.industry,
        "\uc138\ubd80\uc5c5\uc885": detail,
        "\uc9c0\uc5ed": querySpec.region,
        "\uc8fc\uc18c": address,
        "\ub300\ud45c\uc804\ud654": phone,
        "\ud648\ud398\uc774\uc9c0": "",
        "\uc774\uba54\uc77c": "",
        "\ucd9c\ucc98URL": item.place_url || "",
        "\uc218\uc9d1\uc77c": today,
        "\ub4f1\uae09": grade,
        "\uc601\uc5c5\uc0c1\ud0dc": "\uc2e0\uaddc",
        "\uba54\ubaa8": `${target}\uac74 \uc218\uc9d1`,
      });
      stats.inserted += 1;
      stats.industryCounts[querySpec.industry] = (stats.industryCounts[querySpec.industry] || 0) + 1;
      stats.gradeCounts[grade] = (stats.gradeCounts[grade] || 0) + 1;

      if (rows.length % 50 === 0 || rows.length >= target) writeOutputs();
      if (rows.length >= target) break;
    }

    if (documents.length === 0) break;
  }
  if (rows.length >= target) break;
}

writeOutputs();
console.log(JSON.stringify({ collected: rows.length, ...stats, outputPath, statsPath, chunkDir }, null, 2));

function buildQueries() {
  const specs = [];
  for (const region of DEFAULT_REGIONS) {
    for (const industry of DEFAULT_INDUSTRIES) {
      for (const keyword of industryQueries[industry] || [industry]) {
        specs.push({ region, industry, query: `${region} ${keyword}` });
      }
    }
  }
  return specs;
}

function loadExistingKeys() {
  const keys = new Set();
  for (const file of fs.readdirSync("outputs", { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith("_rows.json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join("outputs", file.name), "utf8"));
      if (!Array.isArray(data)) continue;
      for (const row of data) {
        keys.add(leadKey(row["회사명"], row["대표전화"]));
      }
    } catch {
      // Ignore partial or unrelated files.
    }
  }
  return keys;
}

function writeOutputs() {
  fs.mkdirSync("outputs", { recursive: true });
  fs.mkdirSync(chunkDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(rows, null, 2), "utf8");
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");

  const values = rows.map((row) => [
    row["회사명"],
    row["업종"],
    row["세부업종"],
    row["지역"],
    row["주소"],
    row["대표전화"],
    row["홈페이지"],
    row["이메일"],
    row["출처URL"],
    row["수집일"],
    row["등급"],
    row["영업상태"],
    row["메모"],
  ]);
  for (let index = 0; index < values.length; index += 100) {
    const chunkNumber = String(index / 100 + 1).padStart(2, "0");
    fs.writeFileSync(path.join(chunkDir, `chunk_${chunkNumber}.json`), JSON.stringify(values.slice(index, index + 100), null, 2), "utf8");
  }
}

function leadKey(name, phone) {
  return `${String(name || "").trim().toLowerCase()}|${normalizePhone(phone)}`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
