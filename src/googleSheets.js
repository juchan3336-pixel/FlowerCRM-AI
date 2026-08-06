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
  REJECTED_PLACE_HEADERS,
  REJECTED_PLACE_SHEET_NAME,
  SHEET_HEADERS,
  SHEET_TABS,
  SYSTEM_HEADERS,
  SYSTEM_SHEET_NAME,
} from "./config.js";
import { duplicateKey } from "./collector.js";
import { getAccessToken } from "./googleAuth.js";
import { countBy } from "./report.js";
import { duplicateKeyFromRow, placeKeyFromRow, toSheetRows } from "./rows.js";

const DRIVE_URL = "https://www.googleapis.com/drive/v3";
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const ensuredSpreadsheets = new Set();
const GOOGLE_RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 40000];

export function googleRetryDelayMs(attempt) {
  return GOOGLE_RETRY_DELAYS_MS[attempt] ?? null;
}

export class DryRunUnconfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = "DryRunUnconfiguredError";
    this.code = "dry_run_unconfigured";
  }
}

export async function getTargetSpreadsheet(options = {}) {
  const folderName = options.folderName || process.env.GOOGLE_DRIVE_FOLDER_NAME || CRM_FOLDER_NAME;
  const spreadsheetName = options.spreadsheetName || process.env.GOOGLE_SPREADSHEET_NAME || CRM_SPREADSHEET_NAME;
  // ?? so a caller can pass "" to mean "nothing is preconfigured" and force the lookup path.
  const configuredFolderId = options.folderId ?? (process.env.GOOGLE_DRIVE_FOLDER_ID || CRM_FOLDER_ID);
  const configuredSpreadsheetId = options.spreadsheetId ?? (process.env.GOOGLE_SPREADSHEET_ID || CRM_SPREADSHEET_ID);

  // readOnly is lookup-only: it must never create a folder, a spreadsheet, a tab or a header row.
  // If the target cannot be found we stop rather than bring one into existence.
  if (options.readOnly) {
    const folderId = configuredFolderId || (await findFolderId(folderName));
    const spreadsheetId = configuredSpreadsheetId || (folderId ? await findSpreadsheetId(spreadsheetName, folderId) : "");

    if (!spreadsheetId) {
      throw new DryRunUnconfiguredError(
        `dry-run found no spreadsheet named "${spreadsheetName}"${folderId ? "" : ` and no folder named "${folderName}"`}. ` +
          "Set GOOGLE_SPREADSHEET_ID to run read-only against an existing sheet.",
      );
    }
    return { folderId, spreadsheetId, readOnly: true };
  }

  const folderId = configuredFolderId || (await findOrCreateFolder(folderName));
  const spreadsheetId = configuredSpreadsheetId || (await findOrCreateSpreadsheet(spreadsheetName, folderId));

  await ensureSpreadsheetShape(spreadsheetId);
  return { folderId, spreadsheetId, readOnly: false };
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
      sheetsApi: {
        append: 0,
        update: 0,
        total: 0,
      },
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
    sheetsApi: {
      append: 0,
      update: 2,
      total: 2,
    },
    industryCounts: countBy(newLeads, "industry"),
    gradeCounts: countBy(newLeads, "grade"),
  };
}

export async function readExistingCollectKeys(spreadsheetId) {
  const duplicateKeys = new Set();
  const placeKeys = new Set();
  const sourceUrlStats = { dataRows: 0, withSourceUrl: 0, withPlaceKey: 0 };

  for (const title of DATA_SHEET_TABS) {
    const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${title}!A2:M`)}`, {
      query: { majorDimension: "ROWS" },
      tolerate404: true,
    });
    for (const row of response.values || []) {
      if (!row.some(Boolean)) continue;
      sourceUrlStats.dataRows += 1;

      const key = duplicateKeyFromRow(row);
      if (key !== "|") duplicateKeys.add(key);

      if (String(row[8] ?? "").trim()) sourceUrlStats.withSourceUrl += 1;
      const placeKey = placeKeyFromRow(row);
      if (placeKey) {
        placeKeys.add(placeKey);
        sourceUrlStats.withPlaceKey += 1;
      }
    }
  }
  return { duplicateKeys, placeKeys, sourceUrlStats };
}

export async function readExistingDuplicateKeys(spreadsheetId) {
  const { duplicateKeys } = await readExistingCollectKeys(spreadsheetId);
  return duplicateKeys;
}

// Rejected-place memory, keyed by "<query>\t<place_key>". A place that a given query filtered out
// is skipped at the card stage on the next run of that same query, so its detail page is not
// re-opened. Scoped by query (which includes region+keyword) so the same place can still be
// collected under a different query it does match. Missing/empty tab -> empty set (no-op).
export async function readRejectedPlaceKeys(spreadsheetId, { readOnly = false } = {}) {
  if (!readOnly) await ensureSpreadsheetShape(spreadsheetId);
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${REJECTED_PLACE_SHEET_NAME}!A2:B`)}`, {
    query: { majorDimension: "ROWS" },
    tolerate404: true,
  });
  const rejected = new Set();
  for (const row of response.values || []) {
    const query = String(row?.[0] ?? "").trim();
    const placeKey = String(row?.[1] ?? "").trim();
    if (query && placeKey) rejected.add(rejectedPlaceCompositeKey(query, placeKey));
  }
  return rejected;
}

export function rejectedPlaceCompositeKey(query, placeKey) {
  return `${query}\t${placeKey}`;
}

export async function appendRejectedPlaces(spreadsheetId, entries) {
  const rows = (entries || [])
    .filter((entry) => entry && entry.query && entry.placeKey)
    .map((entry) => [entry.query, entry.placeKey, entry.reason || "", new Date().toISOString()]);
  if (rows.length === 0) return { appended: 0, appendCalls: 0 };
  await ensureSpreadsheetShape(spreadsheetId);
  const result = await appendRows(spreadsheetId, REJECTED_PLACE_SHEET_NAME, rows, "D");
  return { appended: rows.length, appendCalls: result.appendCalls || 0 };
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
  return appendRows(spreadsheetId, LOG_SHEET_NAME, [row], "L");
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

export async function readQueuedEnrichmentRows(spreadsheetId, { startRow = 2, limit = 300, readOnly = false } = {}) {
  // Blocker 6 — readOnly (dry-run) must not create or repair the sheet/tab/header. A missing tab
  // is tolerated by the read below and simply yields no candidates.
  if (!readOnly) await ensureSpreadsheetShape(spreadsheetId);
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${PRIMARY_DB_SHEET_NAME}!A2:M`)}`, {
    query: { majorDimension: "ROWS" },
    tolerate404: true,
  });
  const rows = response.values || [];
  if (rows.length === 0) {
    return { candidates: [], nextRow: 2, scanned: 0, skipped: 0, totalDataRows: 0 };
  }

  const startIndex = normalizeDataRowIndex(startRow, rows.length);
  const candidates = [];
  let scanned = 0;
  let skipped = 0;
  let index = startIndex;

  while (scanned < rows.length && (limit <= 0 || candidates.length < limit)) {
    const row = rows[index] || [];
    const rowNumber = index + 2;
    scanned += 1;

    if (!row.some(Boolean)) {
      skipped += 1;
    } else {
      const hasHomepage = Boolean(String(row[6] ?? "").trim());
      const hasEmail = Boolean(String(row[7] ?? "").trim());
      if (hasHomepage && hasEmail) {
        skipped += 1;
      } else {
        candidates.push({ rowNumber, row });
      }
    }

    index = (index + 1) % rows.length;
  }

  return {
    candidates,
    nextRow: index + 2,
    scanned,
    skipped,
    totalDataRows: rows.length,
  };
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

export async function batchUpdateEnrichRows(spreadsheetId, rowUpdates) {
  await ensureSpreadsheetShape(spreadsheetId);
  const data = [];
  for (const { rowNumber, updates } of rowUpdates || []) {
    if (!rowNumber || !updates) continue;
    if (Object.hasOwn(updates, "homepage")) {
      data.push({
        range: `${PRIMARY_DB_SHEET_NAME}!G${rowNumber}:G${rowNumber}`,
        majorDimension: "ROWS",
        values: [[updates.homepage || ""]],
      });
    }
    if (Object.hasOwn(updates, "email")) {
      data.push({
        range: `${PRIMARY_DB_SHEET_NAME}!H${rowNumber}:H${rowNumber}`,
        majorDimension: "ROWS",
        values: [[updates.email || ""]],
      });
    }
    if (Object.hasOwn(updates, "memo")) {
      data.push({
        range: `${PRIMARY_DB_SHEET_NAME}!M${rowNumber}:M${rowNumber}`,
        majorDimension: "ROWS",
        values: [[updates.memo || ""]],
      });
    }
  }
  if (data.length === 0) return { updated: 0, batchUpdate: 0 };
  await batchUpdateValues(spreadsheetId, data);
  return { updated: data.length, batchUpdate: 1 };
}

export async function appendEnrichLog(spreadsheetId, summary, status = "success", memo = "") {
  await ensureSpreadsheetShape(spreadsheetId);
  const row = [
    new Date().toISOString(),
    `enrich row ${summary.startRow ?? ""}`,
    `next row ${summary.nextRow ?? ""}`,
    summary.processed ?? 0,
    summary.homepageUpdated ?? 0,
    0,
    0,
    0,
    0,
    `${((summary.runMs ?? 0) / 1000).toFixed(1)}s`,
    status,
    memo ||
      [
        `providers=${(summary.searchProvidersUsed || []).join(", ")}`,
        `emailUpdated=${summary.emailUpdated ?? 0}`,
        `contactPages=${summary.contactPagesFound ?? 0}`,
        `failed=${summary.failed ?? 0}`,
        `failureCodes=${[...new Set(summary.failureCodes || [])].join(",")}`,
        `candidates=${(summary.candidateHighlights || []).join(" | ")}`,
        `details=${(summary.failureDetails || []).join(" | ")}`,
      ]
        .filter(
          (item) =>
            !item.endsWith("=") &&
            !item.endsWith("details=") &&
            !item.endsWith("candidates=") &&
            !item.endsWith("failureCodes="),
        )
        .join("; "),
  ];
  return appendRows(spreadsheetId, LOG_SHEET_NAME, [row], "L");
}

export async function readSystemState(spreadsheetId, { readOnly = false } = {}) {
  if (!readOnly) await ensureSpreadsheetShape(spreadsheetId);
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

// Writes only the keys the caller passed, each into its own row, so Collect and Enrich cannot
// revert one another. The previous version rewrote the whole A2:D range from a snapshot taken at
// the start of the run, which silently restored every key the other job had advanced meanwhile.
export async function writeSystemState(spreadsheetId, updates, memo = "collect state") {
  await ensureSpreadsheetShape(spreadsheetId);

  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(`${SYSTEM_SHEET_NAME}!A2:D`)}`, {
    query: { majorDimension: "ROWS" },
    tolerate404: true,
  });
  const rowNumberByKey = new Map();
  for (const [index, row] of (response.values || []).entries()) {
    const key = row?.[0];
    if (key && !rowNumberByKey.has(key)) rowNumberByKey.set(key, index + 2);
  }

  const now = new Date().toISOString();
  const data = [];
  const newRows = [];
  const appended = [];

  for (const [key, value] of Object.entries(updates || {})) {
    const rowNumber = rowNumberByKey.get(key);
    if (rowNumber === undefined) {
      // Never compute the next free row: two jobs reading the same empty SYSTEM would both pick
      // it and the second write would land on top of the first. Sheets' append picks the row
      // server-side, at write time.
      appended.push(key);
      newRows.push([key, String(value ?? ""), now, memo]);
    } else {
      // B:D only, so column A and every untouched row keep their value, timestamp and position.
      data.push({ range: `${SYSTEM_SHEET_NAME}!B${rowNumber}:D${rowNumber}`, majorDimension: "ROWS", values: [[String(value ?? ""), now, memo]] });
    }
  }

  if (data.length === 0 && newRows.length === 0) return { updated: 0, updates: 0, appended: [], appendCalls: 0 };

  if (data.length > 0) await batchUpdateValues(spreadsheetId, data);
  if (newRows.length > 0) await appendRows(spreadsheetId, SYSTEM_SHEET_NAME, newRows, "D");

  return {
    updated: data.length + newRows.length,
    updates: data.length > 0 ? 1 : 0,
    appendCalls: newRows.length > 0 ? 1 : 0,
    appended,
  };
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

export async function appendRows(spreadsheetId, sheetTitle, rows, endColumn = "M") {
  if (rows.length === 0) return { written: 0, updatedRange: null, appendCalls: 0 };
  const range = `${sheetTitle}!A:${endColumn}`;
  const response = await sheetsFetch(`/${spreadsheetId}/values/${encodeRange(range)}:append`, {
    method: "POST",
    query: {
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      includeValuesInResponse: "false",
    },
    body: {
      range,
      majorDimension: "ROWS",
      values: rows,
    },
  });
  return {
    written: response.updates?.updatedRows ?? rows.length,
    updatedRange: response.updates?.updatedRange || null,
    appendCalls: 1,
  };
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

async function findFolderId(name) {
  const existing = await driveList(
    `mimeType='application/vnd.google-apps.folder' and name='${escapeQuery(name)}' and trashed=false`,
  );
  return existing.files?.[0]?.id || "";
}

async function findSpreadsheetId(name, folderId) {
  const existing = await driveList(
    `mimeType='application/vnd.google-apps.spreadsheet' and name='${escapeQuery(name)}' and '${folderId}' in parents and trashed=false`,
  );
  return existing.files?.[0]?.id || "";
}

async function findOrCreateFolder(name) {
  const existingId = await findFolderId(name);
  if (existingId) return existingId;

  const folder = await driveFetch("/files", {
    method: "POST",
    body: { name, mimeType: "application/vnd.google-apps.folder" },
  });
  return folder.id;
}

async function findOrCreateSpreadsheet(name, folderId) {
  const existingId = await findSpreadsheetId(name, folderId);
  if (existingId) return existingId;

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
  if (ensuredSpreadsheets.has(spreadsheetId)) return;

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

  const headerUpdates = [];
  for (const title of SHEET_TABS) {
    const headers = headersForSheet(title);
    const endColumn =
      title === SYSTEM_SHEET_NAME ? "D" : title === LOG_SHEET_NAME ? "L" : title === REJECTED_PLACE_SHEET_NAME ? "D" : "M";
    headerUpdates.push({
      range: `${title}!A1:${endColumn}1`,
      majorDimension: "ROWS",
      values: [headers],
    });
  }
  await batchUpdateValues(spreadsheetId, headerUpdates);
  ensuredSpreadsheets.add(spreadsheetId);
}

function headersForSheet(title) {
  if (title === SYSTEM_SHEET_NAME) return SYSTEM_HEADERS;
  if (title === LOG_SHEET_NAME) return LOG_HEADERS;
  if (title === REJECTED_PLACE_SHEET_NAME) return REJECTED_PLACE_HEADERS;
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

async function batchUpdateValues(spreadsheetId, data) {
  if (data.length === 0) return;
  await sheetsFetch(`/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    query: { valueInputOption: "RAW" },
    body: {
      valueInputOption: "RAW",
      data,
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
  const bodyText = body === undefined ? undefined : JSON.stringify(body);

  for (let attempt = 0; attempt <= GOOGLE_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: bodyText,
    });

    if (tolerate404 && response.status === 404) return {};
    if (response.status === 429 && attempt < GOOGLE_RETRY_DELAYS_MS.length) {
      const waitMs = googleRetryDelayMs(attempt);
      console.warn(`Google API 429; retrying in ${(waitMs / 1000).toFixed(0)}s (${attempt + 1}/${GOOGLE_RETRY_DELAYS_MS.length})`);
      await sleep(waitMs);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Google API error: ${response.status} ${await response.text()}`);
    }
    return response.status === 204 ? {} : response.json();
  }
  throw new Error("Google API retry loop exhausted");
}

function escapeQuery(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function encodeRange(range) {
  return encodeURIComponent(range).replaceAll("%21", "!");
}

function normalizeDataRowIndex(startRow, totalDataRows) {
  const rowNumber = Number(startRow || 2);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) return 0;
  const index = rowNumber - 2;
  return index >= 0 && index < totalDataRows ? index : 0;
}

function formatQueue(queue) {
  if (!queue) return "";
  return [queue.id, queue.region, queue.category, queue.keyword].filter(Boolean).join(" / ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
