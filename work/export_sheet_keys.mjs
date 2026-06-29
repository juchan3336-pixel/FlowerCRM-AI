import fs from "node:fs";

import { loadEnv } from "../src/env.js";
import { getAccessToken } from "../src/googleAuth.js";

loadEnv();

const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
const tabs = ["기업 DB", "신규기업", "영업대상", "거래기업", "제외기업"];
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";

const rows = [];
const seen = new Set();

for (const tab of tabs) {
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${tab}!A2:F`)}`, {
    query: { majorDimension: "ROWS" },
  });
  for (const row of response.values || []) {
    const companyName = row[0] || "";
    const phone = row[5] || "";
    const key = `${companyName}|${phone}`;
    if (!companyName || !phone || seen.has(key)) continue;
    seen.add(key);
    rows.push({ 회사명: companyName, 대표전화: phone });
  }
}

fs.writeFileSync("outputs/google_sheet_existing_rows.json", JSON.stringify(rows, null, 2), "utf8");
console.log(JSON.stringify({ rows: rows.length }, null, 2));

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

function encodeRange(range) {
  return encodeURIComponent(range).replaceAll("%21", "!");
}
