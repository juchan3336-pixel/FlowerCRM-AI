import assert from "node:assert/strict";
import test from "node:test";

import {
  columnLetter,
  lastDataRow,
  planDriftRepair,
  planRejectedMove,
  planTrim,
  workbookCells,
} from "../src/sheetMaintenance.js";

// A lead row as the data tabs hold it: A 회사명 ... F 대표전화 ... I 출처URL (Kakao place key).
function lead(name, placeId) {
  return [name, "업종", "세부", "울산", "주소", `052-000-${String(placeId).padStart(4, "0")}`, "", "", `https://place.map.kakao.com/${placeId}`, "", "", "", ""];
}

// rows[index] is sheet row index + 2.
function sheetRows(entries) {
  return entries.map((entry) => (entry ? lead(...entry) : []));
}

test("column letters follow the Sheets A..Z, AA.. scheme", () => {
  assert.equal(columnLetter(1), "A");
  assert.equal(columnLetter(4), "D");
  assert.equal(columnLetter(26), "Z");
  assert.equal(columnLetter(27), "AA");
  assert.equal(columnLetter(31), "AE");
  assert.throws(() => columnLetter(0));
});

test("workbook cells count every tab's full grid, empty or not", () => {
  const { tabs, total } = workbookCells([
    { properties: { sheetId: 1, title: "기업 DB", gridProperties: { rowCount: 144000, columnCount: 31 } } },
    { properties: { sheetId: 2, title: "제외플레이스", gridProperties: { rowCount: 56327, columnCount: 26 } } },
  ]);
  assert.equal(tabs[0].cells, 4_464_000);
  assert.equal(tabs[1].cells, 1_464_502);
  assert.equal(total, 5_928_502);
});

test("last data row ignores trailing empty rows", () => {
  assert.equal(lastDataRow([["a"], [], [""], ["b"], [], [" "]]), 5);
  assert.equal(lastDataRow([]), 1);
});

test("drift repair copies the block only when it is exactly the rows 신규기업 is missing", () => {
  // 기업 DB rows 2..7: row 4 and 5 never reached 신규기업.
  const primaryRows = sheetRows([["A", 1], ["B", 2], ["C", 3], ["D", 4], ["E", 5], ["F", 6]]);
  const newCompanyRows = sheetRows([["A", 1], ["B", 2], ["E", 5], ["F", 6], null, null]);

  const plan = planDriftRepair({ primaryRows, newCompanyRows, startRow: 4, endRow: 5 });
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.rows.map((row) => row[0]), ["C", "D"]);
  assert.equal(plan.rows[0].length, 13);
  assert.equal(plan.writeStartRow, 6, "right below 신규기업's last data row");
  assert.equal(plan.writeEndRow, 7);
});

test("drift repair refuses a shifted block and does not repeat itself", () => {
  const primaryRows = sheetRows([["A", 1], ["B", 2], ["C", 3], ["D", 4], ["E", 5], ["F", 6]]);
  const newCompanyRows = sheetRows([["A", 1], ["B", 2], ["E", 5], ["F", 6]]);

  // Off by one: row 3 (B) is already in 신규기업.
  const shifted = planDriftRepair({ primaryRows, newCompanyRows, startRow: 3, endRow: 4 });
  assert.equal(shifted.status, "blocked");
  assert.equal(shifted.problems.some((problem) => problem.startsWith("already-in-new-company")), true);

  // Block ends before the gap does: the row after it (D) is not in 신규기업 either.
  const short = planDriftRepair({ primaryRows, newCompanyRows, startRow: 4, endRow: 4 });
  assert.equal(short.status, "blocked");
  assert.deepEqual(short.problems, ["row-after-block-not-in-new-company"]);

  // After the copy landed, a second run is a no-op rather than a duplicate write.
  const repaired = sheetRows([["A", 1], ["B", 2], ["E", 5], ["F", 6], ["C", 3], ["D", 4]]);
  const again = planDriftRepair({ primaryRows, newCompanyRows: repaired, startRow: 4, endRow: 5 });
  assert.equal(again.status, "already-applied");
  assert.deepEqual(again.rows, []);

  assert.equal(planDriftRepair({ primaryRows, newCompanyRows, startRow: 5, endRow: 4 }).status, "blocked");
});

test("trim keeps a buffer below the data and checks everything under the data is empty", () => {
  const plan = planTrim({ title: "신규기업", sheetId: 7, rowCount: 144370, columnCount: 26, lastRow: 63446, buffer: 1000 });
  assert.equal(plan.action, "delete-rows");
  assert.equal(plan.keepRows, 64446);
  assert.equal(plan.rowsRemoved, 79924);
  assert.equal(plan.cellsFreed, 79924 * 26);
  assert.equal(plan.startIndex, 64446);
  assert.equal(plan.endIndex, 144370);
  assert.equal(plan.emptyCheckRange, "신규기업!A63447:Z144370");

  assert.equal(planTrim({ title: "기업 DB", sheetId: 1, rowCount: 64000, columnCount: 31, lastRow: 63446, buffer: 1000 }).action, "none");
});

test("main 제외플레이스 is deleted only when its copy holds every record", () => {
  const copyTab = { sheetId: 9, title: "제외플레이스", rowCount: 56327, columnCount: 26 };
  const primaryKeys = ["q1\tkakao:1", "q1\tkakao:2", "q2\tkakao:1"];

  const ready = planRejectedMove({ primaryKeys, copyKeys: [...primaryKeys, "q3\tkakao:9"], copyTab });
  assert.equal(ready.status, "ready");
  assert.equal(ready.trimColumns.startIndex, 4);
  assert.equal(ready.trimColumns.endIndex, 26);
  assert.equal(ready.trimColumns.cellsFreed, 22 * 56327);
  assert.equal(ready.trimColumns.emptyCheckRange, "제외플레이스!E1:Z56327");

  const partial = planRejectedMove({ primaryKeys, copyKeys: primaryKeys.slice(0, 2), copyTab });
  assert.equal(partial.status, "blocked");
  assert.deepEqual(partial.problems, ["copy-missing-keys:1"]);

  assert.equal(planRejectedMove({ primaryKeys, copyKeys: primaryKeys, copyTab: null }).status, "blocked");
  assert.equal(planRejectedMove({ primaryKeys: null, copyKeys: primaryKeys, copyTab }).status, "primary-tab-gone");
  assert.equal(planRejectedMove({ primaryKeys, copyKeys: primaryKeys, copyTab: { ...copyTab, columnCount: 4 } }).trimColumns, null);
});
