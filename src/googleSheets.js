import {
  CRM_FOLDER_ID,
  CRM_FOLDER_NAME,
  CRM_SPREADSHEET_ID,
  CRM_SPREADSHEET_NAME,
  DATA_SHEET_TABS,
  LOG_HEADERS,
  LOG_SHEET_NAME,
  NEW_COMPANY_SHEET_NAME,
  PRIMARY_DB_SHEET_NAME,
  SHEET_HEADERS,
  SHEET_TABS,
  SYSTEM_HEADERS,
  SYSTEM_SHEET_NAME,
} from "./config.js";
import { duplicateKey } from "./collector.js";
import { getAccessToken } from "./googleAuth.js";
import { countBy } from "./report.js";
import { duplicateKeyFromRow, toSheetRows } from "./rows.js";

const DRIVE_URL = "https://www.googleapis.com/drive/v3";
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";

export async function getTargetSpreadsheet(options = {}) {
  const folderName = options.folderName || process.env.GOOGLE_DRIVE_FOLDER_NAME || CRM_FOLDER_NAME;
  const spreadsheetName = options.spreadsheetName || process.env.GOOGLE_SPREADSHEET_NAME || CRM_SPREADSHEET_NAME;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || CRM_FOLDER_ID || (await findOrCreateFolder(folderName));
  const spreadsheetId =
    process.env.GOOGLE_SPREADSHEET_ID ||
    CRM_SPREADSHEET_ID ||
    (await findOrCreateSpreadsheet(spreadsheetName, folderId));

  await ensureSpreadsheetShape(spreadsheetId);
  return { folderId, spreadsheetId };
}

export async function saveLeadsToGoogleSheets(leads, options = {}) {
  const { folderId, spreadsheetId } = await getTargetSpreadsheet(options);
  const existingKeys = options.existingKeys || (await readExistingDuplicateKeys(spreadsheetId));
  const seen = new Set();
  const newLeads = [];

  for (const lead of leads) {
    const key = duplicateKey(lead.companyName, lead.phone);
    if (!key || key === "|" || existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    newLeads.push(lead);
  }

  if (newLeads.length === 0) {
    return {
      folderId,
      spreadsheetId,
      received: leads.length,
      inserted: 0,
      skipped: leads.length,
      industryCounts: {},
      gradeCounts: {},
    };
  }

  const rows = toSheetRows(newLeads, false);
  const primaryWrite = await writeRowsAtBottom(spreadsheetId, PRIMARY_DB_SHEET_NAME, rows);
  const newCompanyWrite = await writeRowsAtBottom(spreadsheetId, NEW_COMPANY_SHEET_NAME, rows);

  return {
    folderId,
    spreadsheetId,
    received: leads.length,
    inserted: newLeads.length,
    skipped: leads.length - newLeads.length,
    sheetWrites: {
      [PRIMARY_DB_SHEET_NAME]: primaryWrite,
      [NEW_COMPANY_SHEET_NAME]: newCompanyWrite,
    },
    industryCounts: countBy(newLeads, "industry"),
    gradeCounts: countBy(newLeads, "grade"),
  };
}

export async function readExistingDuplicateKeys(spreadsheetId) {
  const keys = new Set();
  for (const title of DATA_SHEET_TABS) {
    const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${title}!A2:M`)}`, {
      query: { majorDimension: "ROWS" },
      tolerate404: true,
    });
    for (const row of response.values || []) {
      const key = duplicateKeyFromRow(row);
      if (key !== "|") keys.add(key);
    }
  }
  return keys;
}

export async function appendCollectLog(spreadsheetId, report, status = "success", memo = "") {
  await ensureSpreadsheetShape(spreadsheetId);
  const row = [
    new Date().toISOString(),
    formatQueue(report.currentQueue),
    formatQueue(report.nextQueue),
    report.totalAttempts ?? 0,
    report.inserted ?? 0,
    report.duplicateExcluded ?? 0,
    report.missingPhoneExcluded ?? 0,
    report.regionMismatchExcluded ?? 0,
    report.industryMismatchExcluded ?? 0,
    `${((report.runMs ?? 0) / 1000).toFixed(1)}s`,
    status,
    memo || report.stopReason || "",
  ];
  await writeRowsAtBottom(spreadsheetId, LOG_SHEET_NAME, [row], "L");
}

export async function readRowsNeedingEnrichment(spreadsheetId, limit = 100) {
  await ensureSpreadsheetShape(spreadsheetId);
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${PRIMARY_DB_SHEET_NAME}!A2:M`)}`, {
    query: { majorDimension: "ROWS" },
    tolerate404: true,
  });
  const candidates = [];
  for (const [index, row] of (response.values || []).entries()) {
    if (!row.some(Boolean)) continue;
    const hasHomepage = Boolean(String(row[6] ?? "").trim());
    const hasEmail = Boolean(String(row[7] ?? "").trim());
    if (hasHomepage && hasEmail) continue;
    candidates.push({ rowNumber: index + 2, row });
    if (limit > 0 && candidates.length >= limit) break;
  }
  return candidates;
}

export async function updateEnrichRow(spreadsheetId, rowNumber, updates) {
  await ensureSpreadsheetShape(spreadsheetId);
  const writes = [];
  if (Object.hasOwn(updates, "homepage")) {
    writes.push(updateValues(spreadsheetId, `${PRIMARY_DB_SHEET_NAME}!G${rowNumber}:G${rowNumber}`, [[updates.homepage || ""]]));
  }
  if (Object.hasOwn(updates, "email")) {
    writes.push(updateValues(spreadsheetId, `${PRIMARY_DB_SHEET_NAME}!H${rowNumber}:H${rowNumber}`, [[updates.email || ""]]));
  }
  if (Object.hasOwn(updates, "memo")) {
    writes.push(updateValues(spreadsheetId, `${PRIMARY_DB_SHEET_NAME}!M${rowNumber}:M${rowNumber}`, [[updates.memo || ""]]));
  }
  await Promise.all(writes);
}

export async function appendEnrichLog(spreadsheetId, summary, status = "success", memo = "") {
  await ensureSpreadsheetShape(spreadsheetId);
  const row = [
    new Date().toISOString(),
    "enrich",
    "",
    summary.processed ?? 0,
    summary.homepageUpdated ?? 0,
    0,
    0,
    0,
    0,
    `${((summary.runMs ?? 0) / 1000).toFixed(1)}s`,
    status,
    memo ||
      `emailUpdated=${summary.emailUpdated ?? 0}; contactPages=${summary.contactPagesFound ?? 0}; failed=${summary.failed ?? 0}`,
  ];
  await writeRowsAtBottom(spreadsheetId, LOG_SHEET_NAME, [row], "L");
}

export async function readSystemState(spreadsheetId) {
  await ensureSpreadsheetShape(spreadsheetId);
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${SYSTEM_SHEET_NAME}!A2:D`)}`, {
    query: { majorDimension: "ROWS" },
    tolerate404: true,
  });
  const state = {};
  for (const row of response.values || []) {
    const key = row[0];
    if (!key) continue;
    state[key] = row[1] ?? "";
  }
  return state;
}

export async function writeSystemState(spreadsheetId, updates, memo = "collect state") {
  await ensureSpreadsheetShape(spreadsheetId);
  const existing = await readSystemState(spreadsheetId);
  const next = { ...existing, ...updates };
  const now = new Date().toISOString();
  const keys = Object.keys(next).sort();
  const rows = keys.map((key) => [key, String(next[key] ?? ""), now, memo]);
  const clearRange = `${SYSTEM_SHEET_NAME}!A2:D1000`;
  await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(clearRange)}:clear`, {
    method: "POST",
    body: {},
  });
  if (rows.length > 0) {
    await updateValues(spreadsheetId, `${SYSTEM_SHEET_NAME}!A2:D${rows.length + 1}`, rows);
  }
}

export async function writeRowsAtBottom(spreadsheetId, sheetTitle, rows, endColumn = "M") {
  if (rows.length === 0) return { written: 0, startRow: null, endRow: null };
  const lastRow = await findLastDataRow(spreadsheetId, sheetTitle);
  const firstStartRow = lastRow + 1;
  let lastEndRow = lastRow;
  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    const startRow = lastRow + 1 + index;
    const endRow = startRow + chunk.length - 1;
    await updateValues(spreadsheetId, `${sheetTitle}!A${startRow}:${endColumn}${endRow}`, chunk);
    lastEndRow = endRow;
  }
  return { written: rows.length, startRow: firstStartRow, endRow: lastEndRow };
}

async function findLastDataRow(spreadsheetId, sheetTitle) {
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${sheetTitle}!A:A`)}`, {
    query: { majorDimension: "COLUMNS" },
  });
  const column = response.values?.[0] || [];
  for (let index = column.length - 1; index >= 0; index -= 1) {
    if (column[index]) return index + 1;
  }
  return 1;
}

async function findOrCreateFolder(name) {
  const existing = await driveList(
    `mimeType='application/vnd.google-apps.folder' and name='${escapeQuery(name)}' and trashed=false`,
  );
  if (existing.files?.[0]) return existing.files[0].id;

  const folder = await driveFetch("/files", {
    method: "POST",
    body: { name, mimeType: "application/vnd.google-apps.folder" },
  });
  return folder.id;
}

async function findOrCreateSpreadsheet(name, folderId) {
  const existing = await driveList(
    `mimeType='application/vnd.google-apps.spreadsheet' and name='${escapeQuery(name)}' and '${folderId}' in parents and trashed=false`,
  );
  if (existing.files?.[0]) return existing.files[0].id;

  const spreadsheet = await sheetsFetch("", {
    method: "POST",
    body: {
      properties: { title: name },
      sheets: SHEET_TABS.map((title) => ({ properties: { title } })),
    },
  });

  await driveFetch(`/files/${spreadsheet.spreadsheetId}`, {
    method: "PATCH",
    query: { addParents: folderId, removeParents: "root", fields: "id, parents" },
    body: {},
  });
  return spreadsheet.spreadsheetId;
}

async function ensureSpreadsheetShape(spreadsheetId) {
  const spreadsheet = await sheetsFetch(`/${spreadsheetId}`, {
    query: { fields: "sheets.properties(sheetId,title)" },
  });
  const existingTitles = new Set(spreadsheet.sheets.map((sheet) => sheet.properties.title));
  const requests = [];

  for (const title of SHEET_TABS) {
    if (!existingTitles.has(title)) {
      requests.push({ addSheet: { properties: { title } } });
    }
  }

  if (requests.length > 0) {
    await sheetsFetch(`/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: { requests },
    });
  }

  for (const title of SHEET_TABS) {
    const headers = headersForSheet(title);
    const endColumn = title === SYSTEM_SHEET_NAME ? "D" : title === LOG_SHEET_NAME ? "L" : "M";
    await updateValues(spreadsheetId, `${title}!A1:${endColumn}1`, [headers]);
  }
}

function headersForSheet(title) {
  if (title === SYSTEM_SHEET_NAME) return SYSTEM_HEADERS;
  if (title === LOG_SHEET_NAME) return LOG_HEADERS;
  return SHEET_HEADERS;
}

async function updateValues(spreadsheetId, range, values) {
  await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(range)}`, {
    method: "PUT",
    query: { valueInputOption: "RAW" },
    body: {
      range,
      majorDimension: "ROWS",
      values,
    },
  });
}

async function driveList(q) {
  return driveFetch("/files", {
    query: { q, fields: "files(id,name,mimeType,parents)", spaces: "drive" },
  });
}

async function driveFetch(path, { method = "GET", query = {}, body } = {}) {
  return googleFetch(`${DRIVE_URL}${path}`, { method, query, body });
}

async function sheetsFetch(path, { method = "GET", query = {}, body, tolerate404 = false } = {}) {
  return googleFetch(`${SHEETS_URL}${path}`, { method, query, body, tolerate404 });
}

async function googleFetch(baseUrl, { method, query, body, tolerate404 = false }) {
  const token = await getAccessToken();
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
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

  if (tolerate404 && response.status === 404) return {};
  if (!response.ok) {
    throw new Error(`Google API error: ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? {} : response.json();
}

function escapeQuery(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function encodeRange(range) {
  return encodeURIComponent(range).replaceAll("%21", "!");
}

function formatQueue(queue) {
  if (!queue) return "";
  return [queue.id, queue.region, queue.category, queue.keyword].filter(Boolean).join(" / ");
}
