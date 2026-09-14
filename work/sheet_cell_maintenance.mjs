import {
  NEW_COMPANY_SHEET_NAME,
  PRIMARY_DB_SHEET_NAME,
  REJECTED_PLACE_HEADERS,
  REJECTED_PLACE_SHEET_NAME,
} from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { getAccessToken } from "../src/googleAuth.js";
import { rejectedPlaceCompositeKey } from "../src/googleSheets.js";
import {
  GOOGLE_CELL_LIMIT,
  lastDataRow,
  planDriftRepair,
  planRejectedMove,
  planTrim,
  workbookCells,
} from "../src/sheetMaintenance.js";

// One-off cleanup for the 2026-09-12 "above the limit of 10000000 cells" collect failures.
// Dry-run by default; pass --apply to change anything. Every mutation is gated on its own check.
//   1. 제외플레이스: verify the copy in REJECTED_PLACE_SPREADSHEET_ID, trim its unused columns,
//      then delete the tab from the main spreadsheet.
//   2. Copy the 기업 DB rows that never reached 신규기업 (runs #761/#762) to the bottom of 신규기업.
//   3. Delete trailing empty rows from 기업 DB and 신규기업, keeping a buffer.

loadEnv();

const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const args = parseArgs(process.argv.slice(2));
const apply = Boolean(args.apply);
const mainId = process.env.GOOGLE_SPREADSHEET_ID;
const copyId = String(process.env.REJECTED_PLACE_SPREADSHEET_ID || "").trim();
const driftStart = Number(args["drift-start"] ?? 44371);
const driftEnd = Number(args["drift-end"] ?? 44639);
const trimBuffer = Number(args["trim-buffer"] ?? 1000);

if (!mainId) throw new Error("GOOGLE_SPREADSHEET_ID가 필요합니다.");
if (!Number.isInteger(trimBuffer) || trimBuffer < 0) throw new Error(`trim-buffer가 올바르지 않습니다: ${args["trim-buffer"]}`);

const summary = { apply, blocked: [] };
section(`시트 셀 정리 ${apply ? "(실제 적용)" : "(점검만 — 변경 없음)"}`);
console.log(`서비스 계정: ${serviceAccountEmail()}`);
console.log(`메인 스프레드시트: ${mainId}`);
console.log(`제외플레이스 스프레드시트: ${copyId || "(미설정)"}`);

let mainInventory = await inventory(mainId);
summary.cellsBefore = mainInventory.total;
printInventory("메인 스프레드시트 (정리 전)", mainInventory);

// 1. 제외플레이스 이동
section("1. 제외플레이스 이동 확인");
if (!copyId) {
  console.log("건너뜀: REJECTED_PLACE_SPREADSHEET_ID가 비어 있습니다.");
  summary.rejectedMove = { status: "skipped" };
} else {
  let copyInventory = null;
  try {
    copyInventory = await inventory(copyId);
  } catch (error) {
    console.log(`새 스프레드시트를 열 수 없습니다 — 서비스 계정(${serviceAccountEmail()})이 편집자로 공유됐는지 확인하세요.`);
    console.log(String(error.message).slice(0, 300));
    summary.rejectedMove = { status: "blocked", problems: ["copy-spreadsheet-unreadable"] };
    summary.blocked.push("rejectedMove");
  }

  if (copyInventory) {
    printInventory("새 스프레드시트", copyInventory);
    const copyTab = copyInventory.tabs.find((tab) => tab.title === REJECTED_PLACE_SHEET_NAME) || null;
    const primaryTab = mainInventory.tabs.find((tab) => tab.title === REJECTED_PLACE_SHEET_NAME) || null;
    const copyKeys = copyTab ? await readRejectedKeys(copyId) : [];
    const primaryKeys = primaryTab ? await readRejectedKeys(mainId) : null;
    const plan = planRejectedMove({ primaryKeys, copyKeys, copyTab, usedColumns: REJECTED_PLACE_HEADERS.length });

    if (!copyTab) {
      const titles = copyInventory.tabs.map((tab) => tab.title).join(", ");
      console.log(`새 스프레드시트에 "${REJECTED_PLACE_SHEET_NAME}" 탭이 없습니다. 현재 탭: ${titles}`);
    } else {
      const primaryCount = primaryKeys === null ? "(탭 없음)" : fmt(primaryKeys.length);
      console.log(`메인 기록 ${primaryCount}건 / 새 시트 기록 ${fmt(copyKeys.length)}건 / 새 시트에 없는 기록 ${fmt(plan.missing ?? 0)}건`);
    }

    if (plan.trimColumns && copyTab) {
      const empty = await rangeIsEmpty(copyId, plan.trimColumns.emptyCheckRange);
      console.log(
        `새 시트 빈 열 정리: ${plan.trimColumns.emptyCheckRange} (${empty ? "비어 있음" : "값 있음 — 건너뜀"}) → ${fmt(plan.trimColumns.cellsFreed)}셀`,
      );
      if (apply && empty) {
        await batchUpdate(copyId, [
          deleteDimension(plan.trimColumns.sheetId, "COLUMNS", plan.trimColumns.startIndex, plan.trimColumns.endIndex),
        ]);
        console.log("  → 삭제 완료");
      }
    }

    if (plan.status === "ready") {
      console.log(`메인 "${REJECTED_PLACE_SHEET_NAME}" 탭 삭제 가능 → ${fmt(primaryTab.cells)}셀 회수`);
      if (apply) {
        await batchUpdate(mainId, [{ deleteSheet: { sheetId: primaryTab.sheetId } }]);
        console.log("  → 삭제 완료");
      }
    } else if (plan.status === "primary-tab-gone") {
      console.log("메인에는 이미 탭이 없습니다.");
    } else {
      console.log(`메인 탭 삭제 보류: ${plan.problems.join(", ")}`);
      summary.blocked.push("rejectedMove");
    }
    summary.rejectedMove = { status: plan.status, problems: plan.problems, missing: plan.missing };
  }
}

// 2. 어긋난 행 복구
section(`2. ${PRIMARY_DB_SHEET_NAME} → ${NEW_COMPANY_SHEET_NAME} 누락 행 복구`);
const primaryRows = await readRows(mainId, PRIMARY_DB_SHEET_NAME);
let newCompanyRows = await readRows(mainId, NEW_COMPANY_SHEET_NAME);
const drift = planDriftRepair({ primaryRows, newCompanyRows, startRow: driftStart, endRow: driftEnd });
console.log(`대상: ${PRIMARY_DB_SHEET_NAME} ${driftStart}~${driftEnd}행 (${driftEnd - driftStart + 1}행)`);
console.log(
  `마지막 데이터 행: ${PRIMARY_DB_SHEET_NAME} ${fmt(lastDataRow(primaryRows))} / ${NEW_COMPANY_SHEET_NAME} ${fmt(lastDataRow(newCompanyRows))}`,
);
console.log(
  `상태: ${drift.status}${drift.problems.length ? ` (${drift.problems.join(", ")})` : ""}, 신규기업에 이미 있는 행 ${drift.alreadyPresent ?? 0}건`,
);
if (drift.status === "ready") {
  console.log(`쓰기 위치: ${NEW_COMPANY_SHEET_NAME} A${drift.writeStartRow}:M${drift.writeEndRow}`);
  if (apply) {
    const newCompanyTab = mainInventory.tabs.find((tab) => tab.title === NEW_COMPANY_SHEET_NAME);
    if (newCompanyTab.rowCount < drift.writeEndRow) {
      throw new Error(`${NEW_COMPANY_SHEET_NAME} 격자가 부족합니다 (${newCompanyTab.rowCount} < ${drift.writeEndRow})`);
    }
    await putValues(mainId, `${NEW_COMPANY_SHEET_NAME}!A${drift.writeStartRow}:M${drift.writeEndRow}`, drift.rows);
    console.log(`  → ${drift.rows.length}행 기록 완료`);
    newCompanyRows = await readRows(mainId, NEW_COMPANY_SHEET_NAME);
  }
} else if (drift.status === "blocked") {
  summary.blocked.push("driftRepair");
}
summary.driftRepair = { status: drift.status, problems: drift.problems, rows: drift.rows.length };

// 3. 빈 행 정리
section("3. 데이터 탭 빈 행 정리");
if (apply) mainInventory = await inventory(mainId);
// In a dry run 신규기업 has not received the repaired rows yet, so plan against where it will end.
const projectedNewCompanyLast = !apply && drift.status === "ready" ? drift.writeEndRow : lastDataRow(newCompanyRows);
const lastRows = { [PRIMARY_DB_SHEET_NAME]: lastDataRow(primaryRows), [NEW_COMPANY_SHEET_NAME]: projectedNewCompanyLast };
summary.trim = {};
for (const title of [PRIMARY_DB_SHEET_NAME, NEW_COMPANY_SHEET_NAME]) {
  const tab = mainInventory.tabs.find((candidate) => candidate.title === title);
  const plan = planTrim({ ...tab, lastRow: lastRows[title], buffer: trimBuffer });
  if (plan.action === "none") {
    console.log(`${title}: 정리할 빈 행 없음 (격자 ${fmt(tab.rowCount)}행, 데이터 ${fmt(lastRows[title])}행)`);
    summary.trim[title] = { action: "none" };
    continue;
  }
  const empty = await rangeIsEmpty(mainId, plan.emptyCheckRange);
  console.log(
    `${title}: 데이터 ${fmt(lastRows[title])}행 / 격자 ${fmt(tab.rowCount)}행 → ${fmt(plan.keepRows)}행 유지, ${fmt(plan.rowsRemoved)}행 삭제 (${fmt(plan.cellsFreed)}셀) — 아래쪽 ${empty ? "비어 있음" : "값 있음, 보류"}`,
  );
  if (!empty) {
    summary.blocked.push(`trim:${title}`);
    summary.trim[title] = { action: "blocked" };
    continue;
  }
  if (apply) {
    await batchUpdate(mainId, [deleteDimension(plan.sheetId, "ROWS", plan.startIndex, plan.endIndex)]);
    console.log("  → 삭제 완료");
  }
  summary.trim[title] = { action: apply ? "deleted" : "would-delete", rowsRemoved: plan.rowsRemoved, cellsFreed: plan.cellsFreed };
}

section("결과");
if (apply) {
  mainInventory = await inventory(mainId);
  printInventory("메인 스프레드시트 (정리 후)", mainInventory);
}
summary.cellsAfter = apply ? mainInventory.total : null;
console.log(`메인 셀: ${fmt(summary.cellsBefore)}${apply ? ` → ${fmt(summary.cellsAfter)}` : ""} / 상한 ${fmt(GOOGLE_CELL_LIMIT)}`);
console.log(`보류된 단계: ${summary.blocked.length ? summary.blocked.join(", ") : "없음"}`);
console.log(JSON.stringify(summary, null, 2));
if (summary.blocked.length > 0) process.exitCode = 1;

async function inventory(spreadsheetId) {
  const response = await sheetsFetch(`/${spreadsheetId}`, {
    query: { fields: "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))" },
  });
  return workbookCells(response.sheets);
}

async function readRows(spreadsheetId, title) {
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${title}!A2:M`)}`, {
    query: { majorDimension: "ROWS" },
  });
  return response.values || [];
}

async function readRejectedKeys(spreadsheetId) {
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${REJECTED_PLACE_SHEET_NAME}!A2:B`)}`, {
    query: { majorDimension: "ROWS" },
  });
  return (response.values || [])
    .map((row) => [String(row?.[0] ?? "").trim(), String(row?.[1] ?? "").trim()])
    .filter(([query, placeKey]) => query && placeKey)
    .map(([query, placeKey]) => rejectedPlaceCompositeKey(query, placeKey));
}

async function rangeIsEmpty(spreadsheetId, range) {
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(range)}`, {
    query: { majorDimension: "ROWS" },
  });
  return !(response.values || []).some((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
}

async function putValues(spreadsheetId, range, values) {
  await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(range)}`, {
    method: "PUT",
    query: { valueInputOption: "RAW" },
    body: { range, majorDimension: "ROWS", values },
  });
}

async function batchUpdate(spreadsheetId, requests) {
  await sheetsFetch(`/${spreadsheetId}:batchUpdate`, { method: "POST", body: { requests } });
}

function deleteDimension(sheetId, dimension, startIndex, endIndex) {
  return { deleteDimension: { range: { sheetId, dimension, startIndex, endIndex } } };
}

async function sheetsFetch(path, { method = "GET", query = {}, body } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${SHEETS_URL}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Google Sheets API error: ${response.status} ${await response.text()}`);
  return response.status === 204 ? {} : response.json();
}

function serviceAccountEmail() {
  try {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}").client_email || "(확인 불가)";
  } catch {
    return "(확인 불가)";
  }
}

function printInventory(label, { tabs, total }) {
  console.log(`${label}: 총 ${fmt(total)}셀`);
  for (const tab of tabs) {
    console.log(`  - ${tab.title}: ${fmt(tab.rowCount)}행 × ${tab.columnCount}열 = ${fmt(tab.cells)}셀`);
  }
}

function section(title) {
  console.log("━━━━━━━━━━━━━━");
  console.log(title);
}

function fmt(value) {
  return Number(value).toLocaleString("en-US");
}

function encodeRange(range) {
  return encodeURIComponent(range).replaceAll("%21", "!");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
