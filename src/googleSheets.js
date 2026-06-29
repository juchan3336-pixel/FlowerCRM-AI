import {
  CRM_FOLDER_ID,
  CRM_FOLDER_NAME,
  CRM_SPREADSHEET_ID,
  CRM_SPREADSHEET_NAME,
  NEW_COMPANY_SHEET_NAME,
  PRIMARY_DB_SHEET_NAME,
  SHEET_HEADERS,
  SHEET_TABS,
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
  await writeRowsAtBottom(spreadsheetId, PRIMARY_DB_SHEET_NAME, rows);
  await writeRowsAtBottom(spreadsheetId, NEW_COMPANY_SHEET_NAME, rows);

  return {
    folderId,
    spreadsheetId,
    received: leads.length,
    inserted: newLeads.length,
    skipped: leads.length - newLeads.length,
    industryCounts: countBy(newLeads, "industry"),
    gradeCounts: countBy(newLeads, "grade"),
  };
}

export async function readExistingDuplicateKeys(spreadsheetId) {
  const keys = new Set();
  for (const title of SHEET_TABS) {
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

export async function writeRowsAtBottom(spreadsheetId, sheetTitle, rows) {
  if (rows.length === 0) return;
  const lastRow = await findLastDataRow(spreadsheetId, sheetTitle);
  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    const startRow = lastRow + 1 + index;
    const endRow = startRow + chunk.length - 1;
    await updateValues(spreadsheetId, `${sheetTitle}!A${startRow}:M${endRow}`, chunk);
  }
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
    await updateValues(spreadsheetId, `${title}!A1:M1`, [SHEET_HEADERS]);
  }
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
