import { duplicateKeyFromRow, placeKeyFromRow } from "./rows.js";

// Pure planning for the one-off workbook cleanup in work/sheet_cell_maintenance.mjs.
//
// Google caps a spreadsheet at 10,000,000 cells, counted as rowCount x columnCount of every tab
// whether the cells hold anything or not. The cleanup therefore only ever removes grid, never data:
// every step is refused unless the cells it removes are verified empty or verified copied elsewhere.
// Rows passed around here are Sheets `values` arrays read from row 2, so index 0 is sheet row 2.

export const GOOGLE_CELL_LIMIT = 10_000_000;
const LEAD_COLUMN_COUNT = 13;

export function columnLetter(columnNumber) {
  let n = Number(columnNumber);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid column number: ${columnNumber}`);
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export function workbookCells(sheets) {
  const tabs = (sheets || []).map((sheet) => {
    const { sheetId, title, gridProperties = {} } = sheet.properties || {};
    const rowCount = gridProperties.rowCount || 0;
    const columnCount = gridProperties.columnCount || 0;
    return { sheetId, title, rowCount, columnCount, cells: rowCount * columnCount };
  });
  return { tabs, total: tabs.reduce((sum, tab) => sum + tab.cells, 0) };
}

export function hasValue(row) {
  return Array.isArray(row) && row.some((cell) => String(cell ?? "").trim() !== "");
}

// Sheet row number of the last row that holds anything (1 = only the header is left).
export function lastDataRow(rowsFromRow2) {
  for (let index = rowsFromRow2.length - 1; index >= 0; index -= 1) {
    if (hasValue(rowsFromRow2[index])) return index + 2;
  }
  return 1;
}

// The Kakao place key from 출처URL identifies a lead exactly; name+phone is the fallback.
export function rowIdentity(row) {
  return placeKeyFromRow(row) || duplicateKeyFromRow(row);
}

// 2026-08-27 runs #761/#762 wrote rows into 기업 DB but died before 신규기업, so a block of 기업 DB
// rows never reached 신규기업 (and never will: collect dedups against every data tab). Copy exactly
// that block to the bottom of 신규기업, but only when the block is provably the missing one: every
// row in it is absent from 신규기업, and the rows right before and after it are present there.
export function planDriftRepair({ primaryRows, newCompanyRows, startRow, endRow }) {
  const problems = [];
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || startRow < 3 || endRow < startRow) {
    return { status: "blocked", problems: ["invalid-range"], rows: [] };
  }

  const rowAt = (rows, rowNumber) => rows[rowNumber - 2];
  const newCompanyIds = new Set(newCompanyRows.filter(hasValue).map(rowIdentity));

  const rows = [];
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    const row = rowAt(primaryRows, rowNumber);
    if (!hasValue(row)) {
      problems.push(`empty-source-row:${rowNumber}`);
      continue;
    }
    rows.push(Array.from({ length: LEAD_COLUMN_COUNT }, (_, index) => row[index] ?? ""));
  }

  const alreadyPresent = rows.filter((row) => newCompanyIds.has(rowIdentity(row))).length;
  const writeStartRow = lastDataRow(newCompanyRows) + 1;
  const base = { rows, writeStartRow, writeEndRow: writeStartRow + rows.length - 1, alreadyPresent };

  if (problems.length === 0 && rows.length > 0 && alreadyPresent === rows.length) {
    return { ...base, status: "already-applied", problems: [], rows: [], writeEndRow: writeStartRow - 1 };
  }
  if (alreadyPresent > 0) problems.push(`already-in-new-company:${alreadyPresent}`);

  const before = rowAt(primaryRows, startRow - 1);
  if (!hasValue(before) || !newCompanyIds.has(rowIdentity(before))) problems.push("row-before-block-not-in-new-company");
  const after = rowAt(primaryRows, endRow + 1);
  if (hasValue(after) && !newCompanyIds.has(rowIdentity(after))) problems.push("row-after-block-not-in-new-company");

  return { ...base, status: problems.length === 0 ? "ready" : "blocked", problems };
}

// Trailing empty rows are pure grid. Keep `buffer` spare rows below the data; collect grows the grid
// again on demand (ensureRowCapacity).
export function planTrim({ title, sheetId, rowCount, columnCount, lastRow, buffer }) {
  const keepRows = lastRow + buffer;
  if (rowCount <= keepRows) return { title, action: "none", rowCount, keepRows, rowsRemoved: 0, cellsFreed: 0 };
  return {
    title,
    sheetId,
    action: "delete-rows",
    rowCount,
    keepRows,
    rowsRemoved: rowCount - keepRows,
    cellsFreed: (rowCount - keepRows) * columnCount,
    // Everything below the data must be empty, not just the rows being removed.
    emptyCheckRange: `${title}!A${lastRow + 1}:${columnLetter(columnCount)}${rowCount}`,
    // deleteDimension indexes are 0-based and endIndex-exclusive.
    startIndex: keepRows,
    endIndex: rowCount,
  };
}

// The main 제외플레이스 tab may only be deleted once its copy in the separate spreadsheet holds every
// (query, place_key) it has.
export function planRejectedMove({ primaryKeys, copyKeys, copyTab, usedColumns = 4 }) {
  if (!copyTab) return { status: "blocked", problems: ["copy-tab-missing"] };
  const copySet = new Set(copyKeys);
  const missing = primaryKeys === null ? 0 : primaryKeys.filter((key) => !copySet.has(key)).length;
  const extraColumns = Math.max(0, copyTab.columnCount - usedColumns);
  const trimColumns =
    extraColumns > 0
      ? {
          sheetId: copyTab.sheetId,
          startIndex: usedColumns,
          endIndex: copyTab.columnCount,
          cellsFreed: extraColumns * copyTab.rowCount,
          emptyCheckRange: `${copyTab.title}!${columnLetter(usedColumns + 1)}1:${columnLetter(copyTab.columnCount)}${copyTab.rowCount}`,
        }
      : null;

  if (primaryKeys === null) return { status: "primary-tab-gone", problems: [], missing: 0, trimColumns };
  if (missing > 0) return { status: "blocked", problems: [`copy-missing-keys:${missing}`], missing, trimColumns };
  return { status: "ready", problems: [], missing: 0, trimColumns };
}
