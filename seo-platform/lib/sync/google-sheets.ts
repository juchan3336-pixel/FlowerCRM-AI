import "server-only"

import { google } from "googleapis"

import { parseGoogleServiceAccountJson, type GoogleServiceAccount } from "./google-sheets-config"
import { parseColumnBounds, valuesToSheetRows } from "./google-sheets-values"

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly" as const
const DEFAULT_SHEET_NAME = "기업 DB" as const
const DEFAULT_SHEET_RANGE = "A:M" as const

export type GoogleSheetsSyncEnvironment = {
  readonly GOOGLE_SERVICE_ACCOUNT_JSON: string | undefined
  readonly GOOGLE_SPREADSHEET_ID: string | undefined
  readonly GOOGLE_SHEET_NAME: string | undefined
  readonly GOOGLE_SHEET_RANGE: string | undefined
}

export type GoogleSheetRows = {
  readonly sheetName: string
  readonly rows: readonly Record<string, string | undefined>[]
}

export async function readGoogleSheetRows(env: GoogleSheetsSyncEnvironment = getGoogleSheetsEnvironment()): Promise<GoogleSheetRows> {
  const config = parseGoogleSheetsConfig(env)
  const sheets = createSheetsClient(config)
  const range = `${quoteSheetName(config.sheetName)}!${config.range}`
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range })

  return { sheetName: config.sheetName, rows: valuesToSheetRows(response.data.values ?? []) }
}

// ── 증분 동기화용 부분 조회 ──────────────────────────────────────
// 자동 연속 동기화는 tick마다 전체 시트를 다시 내려받지 않는다.
// 50건 처리에 1만~수만 행 payload를 매번 받으면 API·메모리·실행시간이 전체 행 수에 비례해 커진다.
// 대신 (1) 마지막 데이터 행 번호는 첫 열만, (2) 실제 행 payload는 필요한 50행 구간만 읽는다.

export const FIRST_DATA_ROW_NUMBER = 2

export type GoogleSheetRangeRows = {
  readonly sheetName: string
  readonly startRow: number
  readonly rows: readonly Record<string, string | undefined>[]
}

// 마지막 데이터 행 번호 — 첫 열 하나만 읽는다 (A:M 13열 대신 A:A 1열).
// 행 payload(주소·전화·메모…)를 내려받지 않으므로 응답 크기가 열 수만큼 줄고, 파싱 대상도 없다.
// 빈 시트(데이터 0행)면 헤더 행 번호 1을 돌려준다.
export async function readGoogleSheetLastRow(env: GoogleSheetsSyncEnvironment = getGoogleSheetsEnvironment()): Promise<Readonly<{ sheetName: string; lastRow: number }>> {
  const config = parseGoogleSheetsConfig(env)
  const sheets = createSheetsClient(config)
  const bounds = parseColumnBounds(config.range)
  const range = `${quoteSheetName(config.sheetName)}!${bounds.first}1:${bounds.first}`
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range, majorDimension: "COLUMNS" })
  // COLUMNS 방향이라 values[0]이 첫 열 전체다. 길이 = 헤더 포함 채워진 행 수.
  const column = response.data.values?.[0] ?? []
  return { sheetName: config.sheetName, lastRow: Math.max(1, column.length) }
}

// 지정한 행 구간만 읽는다. 헤더는 별도 range로 함께 요청해 batchGet 1회로 끝낸다
// (헤더가 있어야 열 이름 → 값 매핑이 되고, 구간 조회 결과에는 헤더가 포함되지 않는다).
export async function readGoogleSheetRange(
  input: Readonly<{ startRow: number; limit: number }>,
  env: GoogleSheetsSyncEnvironment = getGoogleSheetsEnvironment(),
): Promise<GoogleSheetRangeRows> {
  const config = parseGoogleSheetsConfig(env)
  const startRow = Math.max(FIRST_DATA_ROW_NUMBER, Math.trunc(input.startRow))
  const limit = Math.max(0, Math.trunc(input.limit))
  if (limit === 0) {
    return { sheetName: config.sheetName, startRow, rows: [] }
  }

  const sheets = createSheetsClient(config)
  const bounds = parseColumnBounds(config.range)
  const quoted = quoteSheetName(config.sheetName)
  const headerRange = `${quoted}!${bounds.first}1:${bounds.last}1`
  const dataRange = `${quoted}!${bounds.first}${String(startRow)}:${bounds.last}${String(startRow + limit - 1)}`

  const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: config.spreadsheetId, ranges: [headerRange, dataRange] })
  const [headerResult, dataResult] = response.data.valueRanges ?? []
  const headerRow = headerResult?.values?.[0] ?? []
  const dataRows = dataResult?.values ?? []
  if (headerRow.length === 0) {
    return { sheetName: config.sheetName, startRow, rows: [] }
  }

  return { sheetName: config.sheetName, startRow, rows: valuesToSheetRows([headerRow, ...dataRows]) }
}

function createSheetsClient(config: GoogleSheetsConfig) {
  const auth = new google.auth.GoogleAuth({ credentials: config.credentials, scopes: [SHEETS_SCOPE] })
  return google.sheets({ version: "v4", auth })
}

function parseGoogleSheetsConfig(env: GoogleSheetsSyncEnvironment): GoogleSheetsConfig {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON === undefined || env.GOOGLE_SPREADSHEET_ID === undefined) {
    throw new MissingGoogleSheetsEnvError()
  }

  return {
    credentials: parseGoogleServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON),
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    sheetName: env.GOOGLE_SHEET_NAME ?? DEFAULT_SHEET_NAME,
    range: env.GOOGLE_SHEET_RANGE ?? DEFAULT_SHEET_RANGE,
  }
}

function quoteSheetName(sheetName: string): string {
  return `'${sheetName.replaceAll("'", "''")}'`
}

function getGoogleSheetsEnvironment(): GoogleSheetsSyncEnvironment {
  return {
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env["GOOGLE_SERVICE_ACCOUNT_JSON"],
    GOOGLE_SPREADSHEET_ID: process.env["GOOGLE_SPREADSHEET_ID"],
    GOOGLE_SHEET_NAME: process.env["GOOGLE_SHEET_NAME"],
    GOOGLE_SHEET_RANGE: process.env["GOOGLE_SHEET_RANGE"],
  }
}

type GoogleSheetsConfig = {
  readonly credentials: GoogleServiceAccount
  readonly spreadsheetId: string
  readonly sheetName: string
  readonly range: string
}

export class MissingGoogleSheetsEnvError extends Error {
  readonly name = "MissingGoogleSheetsEnvError"

  constructor() {
    super("Google Sheets sync environment variables are required")
  }
}
