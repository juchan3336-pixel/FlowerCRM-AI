import { DATA_SHEET_TABS } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { getAccessToken } from "../src/googleAuth.js";
import { MISALIGNED_READ_END_COLUMN, hasShiftedCellValues, isMisalignedLeadRow, repairMisalignedLeadRow } from "../src/sheetRepair.js";

loadEnv();

const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const args = parseArgs(process.argv.slice(2));
const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
const apply = Boolean(args.apply);
const tabs = parseTabs(args.tabs || "기업 DB,신규기업");

if (!spreadsheetId) {
  throw new Error("GOOGLE_SPREADSHEET_ID가 필요합니다.");
}

for (const tab of tabs) {
  if (!DATA_SHEET_TABS.includes(tab)) {
    throw new Error(`지원하지 않는 데이터 시트입니다: ${tab}`);
  }
}

const summary = { apply, tabs: {}, totalCandidates: 0, totalUpdated: 0 };

for (const tab of tabs) {
  const rows = await readRows(tab);
  const repairs = [];
  const shiftedSamples = [];
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    if (!isMisalignedLeadRow(row)) {
      if (shiftedSamples.length < 5 && hasShiftedCellValues(row)) {
        shiftedSamples.push({ rowNumber, values: row.slice(8, 21) });
      }
      continue;
    }
    repairs.push({ rowNumber, values: repairMisalignedLeadRow(row) });
  }

  summary.tabs[tab] = { candidates: repairs.length, updated: 0, rows: repairs.map((repair) => repair.rowNumber), shiftedSamples };
  summary.totalCandidates += repairs.length;

  if (apply) {
    for (const repair of repairs) {
      await updateRow(tab, repair.rowNumber, repair.values);
      summary.tabs[tab].updated += 1;
      summary.totalUpdated += 1;
    }
  }
}

console.log(JSON.stringify(summary, null, 2));

async function readRows(tab) {
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${tab}!A2:${MISALIGNED_READ_END_COLUMN}`)}`, {
    query: { majorDimension: "ROWS" },
  });
  return response.values || [];
}

async function updateRow(tab, rowNumber, values) {
  const range = `${tab}!A${rowNumber}:${MISALIGNED_READ_END_COLUMN}${rowNumber}`;
  await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(range)}`, {
    method: "PUT",
    query: { valueInputOption: "RAW" },
    body: {
      range,
      majorDimension: "ROWS",
      values: [values],
    },
  });
}

async function sheetsFetch(path, { method = "GET", query = {}, body } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${SHEETS_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
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

function parseTabs(value) {
  return String(value)
    .split(",")
    .map((tab) => tab.trim())
    .filter(Boolean);
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

function encodeRange(range) {
  return encodeURIComponent(range).replaceAll("%21", "!");
}
