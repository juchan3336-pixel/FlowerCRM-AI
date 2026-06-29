import { SHEET_HEADERS } from "./config.js";

export function toSheetRows(leads, includeHeader = true) {
  const rows = leads.map((lead) => [
    lead.companyName,
    lead.industry,
    lead.detailIndustry,
    lead.region,
    lead.address,
    lead.phone,
    lead.homepage,
    lead.email,
    lead.sourceUrl,
    lead.collectedAt,
    lead.grade,
    lead.salesStatus,
    lead.memo,
  ]);
  return includeHeader ? [SHEET_HEADERS, ...rows] : rows;
}

export function duplicateKeyFromRow(row) {
  const companyName = String(row[0] ?? "")
    .toLowerCase()
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\s+/g, "");
  const phone = String(row[5] ?? "").replace(/\D/g, "");
  return `${companyName}|${phone}`;
}
