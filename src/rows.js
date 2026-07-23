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

const KAKAO_PLACE_HOST = "place.map.kakao.com";

// Parsed, never pattern-matched: a substring search would accept the host anywhere in the string,
// so a redirect such as https://example.com/?target=https://place.map.kakao.com/123 would be read
// as that place and wrongly skip a different company's detail page.
export function kakaoPlaceKeyFromUrl(value = "") {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.hostname.toLowerCase() !== KAKAO_PLACE_HOST) return "";

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1 || !/^\d+$/.test(segments[0])) return "";
  return `kakao:${segments[0]}`;
}

export function placeKeyFromRow(row) {
  return kakaoPlaceKeyFromUrl(row?.[8] ?? "");
}
