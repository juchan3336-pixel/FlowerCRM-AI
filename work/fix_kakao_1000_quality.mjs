import fs from "node:fs";
import path from "node:path";

const rowsPath = "outputs/kakao_1000_rows.json";
const statsPath = "outputs/kakao_1000_stats.json";
const chunkDir = "outputs/kakao_1000_chunks";
const badNames = new Set(["녹십자요양병원 장례식장", "녹십자요양병원 장례식장 사무실"]);
const replacements = [
  {
    회사명: "법무법인원율",
    업종: "법무법인",
    세부업종: "서비스,산업 > 법률,행정 > 변호사 > 법무법인",
    지역: "울산",
    주소: "울산 남구 법대로 91",
    대표전화: "052-266-9998",
    홈페이지: "",
    이메일: "",
    출처URL: "http://place.map.kakao.com/9813680",
    수집일: "2026-06-29",
    등급: "C",
    영업상태: "신규",
    메모: "1000건 수집 보정",
  },
  {
    회사명: "현대자동차 창원시청지점",
    업종: "자동차 딜러",
    세부업종: "교통,수송 > 자동차 > 자동차판매점 > 현대자동차",
    지역: "창원",
    주소: "경남 창원시 성산구 중앙대로 110",
    대표전화: "055-287-4100",
    홈페이지: "",
    이메일: "",
    출처URL: "http://place.map.kakao.com/8151154",
    수집일: "2026-06-29",
    등급: "B",
    영업상태: "신규",
    메모: "1000건 수집 보정",
  },
];

const rows = JSON.parse(fs.readFileSync(rowsPath, "utf8"));
const filtered = rows.filter((row) => !badNames.has(row["회사명"]));
filtered.push(...replacements);

if (filtered.length !== 1000) {
  throw new Error(`Expected 1000 rows after quality fix, got ${filtered.length}`);
}

const stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
stats.industryCounts["병원"] -= 2;
stats.industryCounts["법무법인"] += 1;
stats.industryCounts["자동차 딜러"] += 1;
stats.gradeCounts.A -= 2;
stats.gradeCounts.C += 1;
stats.gradeCounts.B += 1;
stats.qualityFixed = {
  removed: [...badNames],
  added: replacements.map((row) => row["회사명"]),
};

fs.writeFileSync(rowsPath, JSON.stringify(filtered, null, 2), "utf8");
fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");

fs.mkdirSync(chunkDir, { recursive: true });
for (const file of fs.readdirSync(chunkDir)) {
  if (file.endsWith(".json")) fs.rmSync(path.join(chunkDir, file));
}

const values = filtered.map((row) => [
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

console.log(JSON.stringify({ rows: filtered.length, stats }, null, 2));
