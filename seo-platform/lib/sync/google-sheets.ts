import "server-only"

import { google } from "googleapis"

import { parseGoogleServiceAccountJson, type GoogleServiceAccount } from "./google-sheets-config"
import { lastRowFromKeyColumns, nextColumnLetter, parseColumnBounds, valuesToSheetRows } from "./google-sheets-values"

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
// 대신 (1) 마지막 데이터 행 번호는 필수 기준 열 2개만, (2) 실제 행 payload는 필요한 50행 구간만 읽는다.

export const FIRST_DATA_ROW_NUMBER = 2

export type GoogleSheetRangeRows = {
  readonly sheetName: string
  readonly startRow: number
  readonly rows: readonly Record<string, string | undefined>[]
}

// 마지막 데이터 행 번호 — 필수 열 2개만 읽는다 (A:M 13열 대신 A:B 2열).
// 행 payload(주소·전화·메모…)를 내려받지 않으므로 응답 크기가 열 수만큼 줄고, 파싱 대상도 없다.
//
// 왜 첫 열 하나가 아니라 둘인가 —
// values API는 범위 안의 "마지막 값이 있는 셀"까지만 돌려주므로, 시트 끝 행의 A열이 비어 있고
// B열 이후에만 값이 있으면 A열만 읽었을 때 마지막 행을 실제보다 작게 계산한다.
// 기준 열은 SheetRowSchema가 필수(min(1))로 요구하는 두 열 = A 회사명, B 업종이며,
// 유효한 데이터 행은 둘 다 반드시 채워져 있다. 둘의 길이 중 큰 값을 쓴다.
//
// 2026-07-29 운영 데이터 검증: places 14,951행 + 결손 6행(131·132·307·308·320·321) = 14,957
//   = 데이터 행 위치 2..14,958 전량. 결손 6행은 전부 완전 공백 행(source_payload={})이고,
//   "A열만 비고 B:M에 값이 있는 행"은 0건, 마지막 500행 결손도 0건이었다.
// 그래도 collector가 공백 행을 기록한 전례가 있어 기준 열을 하나 더 둔다.
//
// 설령 과소 계산되더라도 커서(current_row)는 계산된 마지막 행을 넘어 전진하지 않으므로
// 행을 영구히 건너뛰지 않는다 — 다음 확인에서 그대로 따라잡는다 (지연될 뿐 유실 없음).
//
// 빈 시트(데이터 0행)면 헤더 행 번호 1을 돌려준다.
export async function readGoogleSheetLastRow(env: GoogleSheetsSyncEnvironment = getGoogleSheetsEnvironment()): Promise<Readonly<{ sheetName: string; lastRow: number }>> {
  const config = parseGoogleSheetsConfig(env)
  const sheets = createSheetsClient(config)
  const bounds = parseColumnBounds(config.range)
  const secondColumn = nextColumnLetter(bounds.first)
  const range = `${quoteSheetName(config.sheetName)}!${bounds.first}1:${secondColumn}`
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range, majorDimension: "COLUMNS" })
  // COLUMNS 방향이라 values[i]가 i번째 열 전체다. 길이 = 헤더 포함 채워진 행 수.
  return { sheetName: config.sheetName, lastRow: lastRowFromKeyColumns(response.data.values ?? []) }
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
