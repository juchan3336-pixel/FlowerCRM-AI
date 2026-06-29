import fs from "node:fs";

import { loadEnv } from "../src/env.js";
import { getAccessToken } from "../src/googleAuth.js";

loadEnv();

const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
const sourcePath = process.argv[2] || "outputs/kakao_1000_rows.json";
const tabs = ["기업 DB", "신규기업"];
const duplicateTabs = ["기업 DB", "신규기업", "영업대상", "거래기업", "제외기업"];
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";

if (!spreadsheetId) throw new Error("GOOGLE_SPREADSHEET_ID is required");

const sourceRows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const existingKeys = await readExistingKeys();
const seen = new Set();
const values = [];

for (const row of sourceRows) {
  const key = duplicateKey(row["회사명"], row["대표전화"]);
  if (!key || existingKeys.has(key) || seen.has(key)) continue;
  seen.add(key);
  values.push(toValues(row));
}

for (const tab of tabs) {
  await writeAtBottom(tab, values);
}

const report = {
  sourcePath,
  sourceRows: sourceRows.length,
  appended: values.length,
  skipped: sourceRows.length - values.length,
  tabs,
};

fs.mkdirSync("logs", { recursive: true });
fs.writeFileSync(`logs/google_sheets_write_${Date.now()}.json`, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));

async function writeAtBottom(tab, rows) {
  if (rows.length === 0) return;
  const lastRow = await findLastDataRow(tab);
  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    const startRow = lastRow + 1 + index;
    const endRow = startRow + chunk.length - 1;
    await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${tab}!A${startRow}:M${endRow}`)}`, {
      method: "PUT",
      query: { valueInputOption: "RAW" },
      body: { majorDimension: "ROWS", values: chunk },
    });
    console.log(`${tab}: ${Math.min(index + 100, rows.length)}/${rows.length}`);
  }
}

async function findLastDataRow(tab) {
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${tab}!A:A`)}`, {
    query: { majorDimension: "COLUMNS" },
  });
  const column = response.values?.[0] || [];
  for (let index = column.length - 1; index >= 0; index -= 1) {
    if (column[index]) return index + 1;
  }
  return 1;
}

async function readExistingKeys() {
  const keys = new Set();
  for (const tab of duplicateTabs) {
    const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${tab}!A2:F`)}`, {
      query: { majorDimension: "ROWS" },
    });
    for (const row of response.values || []) {
      const key = duplicateKey(row[0], row[5]);
      if (key) keys.add(key);
    }
  }
  return keys;
}

async function sheetsFetch(path, { method = "GET", query = {}, body } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${SHEETS_URL}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Google Sheets API error: ${response.status} ${await response.text()}`);
  return response.status === 204 ? {} : response.json();
}

function toValues(row) {
  return [
    row["회사명"] || "",
    row["업종"] || "",
    row["세부업종"] || "",
    row["지역"] || "",
    row["주소"] || "",
    row["대표전화"] || "",
    row["홈페이지"] || "",
    row["이메일"] || "",
    row["출처URL"] || "",
    row["수집일"] || "",
    row["등급"] || "",
    row["영업상태"] || "",
    row["메모"] || "",
  ];
}

function duplicateKey(companyName, phone) {
  const name = normalizeCompany(companyName);
  const digits = String(phone || "").replace(/\D/g, "");
  return name && digits ? `${name}|${digits}` : "";
}

function normalizeCompany(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, "")
    .trim();
}

function encodeRange(range) {
  return encodeURIComponent(range).replaceAll("%21", "!");
}
