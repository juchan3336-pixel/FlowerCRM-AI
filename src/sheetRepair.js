import { cleanKakaoPlaceName } from "./queueCollect.js";

export const MISALIGNED_READ_END_COLUMN = "U";

const LEAD_COLUMN_COUNT = 13;
const SHIFTED_START_INDEX = 8;

export function isMisalignedLeadRow(row) {
  const leadingCells = Array.from({ length: SHIFTED_START_INDEX }, (_, index) => row[index]);
  if (!leadingCells.every(isBlankCell)) return false;

  const shiftedCells = row.slice(SHIFTED_START_INDEX, SHIFTED_START_INDEX + LEAD_COLUMN_COUNT);
  if (shiftedCells.length < LEAD_COLUMN_COUNT) return false;
  const [companyName, industry, detailIndustry, region, address, phone] = shiftedCells;
  return [companyName, industry, detailIndustry, region, address, phone].every((value) => !isBlankCell(value));
}

export function repairMisalignedLeadRow(row) {
  const shiftedCells = row.slice(SHIFTED_START_INDEX, SHIFTED_START_INDEX + LEAD_COLUMN_COUNT);
  const repairedLead = [...shiftedCells];
  repairedLead[0] = cleanKakaoPlaceName(repairedLead[0]);
  return [...repairedLead, ...Array.from({ length: SHIFTED_START_INDEX }, () => "")];
}

function isBlankCell(value) {
  return String(value ?? "").trim() === "";
}
