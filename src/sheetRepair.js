import { cleanKakaoPlaceName } from "./queueCollect.js";

export const MISALIGNED_READ_END_COLUMN = "U";

const LEAD_COLUMN_COUNT = 13;
const SHIFTED_START_INDEX = 8;

export function isMisalignedLeadRow(row) {
  const leadingCells = Array.from({ length: SHIFTED_START_INDEX }, (_, index) => row[index]);
  if (!leadingCells.every(isBlankCell)) return false;

  const shiftedCells = readShiftedLeadCells(row);
  const [companyName, industry, detailIndustry, region, address, phone] = shiftedCells;
  return [companyName, industry, detailIndustry, region, address, phone].every((value) => !isBlankCell(value));
}

export function repairMisalignedLeadRow(row) {
  const shiftedCells = readShiftedLeadCells(row);
  const repairedLead = [...shiftedCells];
  repairedLead[0] = cleanKakaoPlaceName(repairedLead[0]);
  return [...repairedLead, ...Array.from({ length: SHIFTED_START_INDEX }, () => "")];
}

export function hasShiftedCellValues(row) {
  const leadingCells = Array.from({ length: SHIFTED_START_INDEX }, (_, index) => row[index]);
  if (!leadingCells.every(isBlankCell)) return false;
  return readShiftedLeadCells(row).some((value) => !isBlankCell(value));
}

function readShiftedLeadCells(row) {
  return Array.from({ length: LEAD_COLUMN_COUNT }, (_, index) => row[SHIFTED_START_INDEX + index] ?? "");
}

function isBlankCell(value) {
  return String(value ?? "").trim() === "";
}
