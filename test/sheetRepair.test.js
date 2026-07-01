import assert from "node:assert/strict";
import test from "node:test";

import { hasShiftedCellValues, isMisalignedLeadRow, repairMisalignedLeadRow } from "../src/sheetRepair.js";

test("detects rows shifted from A:M into I:U", () => {
  const shifted = [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "A 현대자동차 광장대리점",
    "자동차딜러",
    "자동차판매점",
    "서울",
    "서울 광진구",
    "02-458-7000",
    "",
    "",
    "https://place.map.kakao.com/8611249#review",
    "2026-07-01",
    "B",
    "신규",
    "system queue collect",
  ];

  assert.equal(isMisalignedLeadRow(shifted), true);
});

test("does not repair normal A:M lead rows", () => {
  const normal = [
    "현대자동차 광장대리점",
    "자동차딜러",
    "자동차판매점",
    "서울",
    "서울 광진구",
    "02-458-7000",
    "",
    "",
    "https://place.map.kakao.com/8611249#review",
    "2026-07-01",
    "B",
    "신규",
    "system queue collect",
  ];

  assert.equal(isMisalignedLeadRow(normal), false);
});

test("repairs shifted rows into A:M and clears old I:U cells", () => {
  const shifted = [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "K 신월동자동차매매시장",
    "자동차딜러",
    "중고차",
    "서울",
    "서울 양천구",
    "070-4535-8888",
    "",
    "",
    "https://place.map.kakao.com/19662636#review",
    "2026-07-01",
    "B",
    "신규",
    "system queue collect",
  ];

  assert.deepEqual(repairMisalignedLeadRow(shifted), [
    "신월동자동차매매시장",
    "자동차딜러",
    "중고차",
    "서울",
    "서울 양천구",
    "070-4535-8888",
    "",
    "",
    "https://place.map.kakao.com/19662636#review",
    "2026-07-01",
    "B",
    "신규",
    "system queue collect",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ]);
});

test("detects shifted rows even when Sheets API trims trailing empty cells", () => {
  const shiftedWithTrimmedTail = [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "A 현대자동차 광장대리점",
    "자동차딜러",
    "자동차판매점",
    "서울",
    "서울 광진구",
    "02-458-7000",
  ];

  assert.equal(isMisalignedLeadRow(shiftedWithTrimmedTail), true);
  assert.equal(hasShiftedCellValues(shiftedWithTrimmedTail), true);
  assert.deepEqual(repairMisalignedLeadRow(shiftedWithTrimmedTail), [
    "현대자동차 광장대리점",
    "자동차딜러",
    "자동차판매점",
    "서울",
    "서울 광진구",
    "02-458-7000",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ]);
});
