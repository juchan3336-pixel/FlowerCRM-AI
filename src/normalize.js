export function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePhone(value = "") {
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 8 ? digits : "";
}

export function displayPhone(value = "") {
  const digits = normalizePhone(value);
  if (!digits) return "";

  if (digits.startsWith("02")) {
    if (digits.length === 9) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
    if (digits.length === 10) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  return cleanText(value);
}

export function normalizeUrl(value = "") {
  const raw = cleanText(value);
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.hostname ? url.toString() : "";
  } catch {
    return "";
  }
}

export function companyKey(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\s+/g, "");
}
