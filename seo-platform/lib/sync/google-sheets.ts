import "server-only"

import { google } from "googleapis"

import { parseGoogleServiceAccountJson, type GoogleServiceAccount } from "./google-sheets-config"
import { valuesToSheetRows } from "./google-sheets-values"

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
  const auth = new google.auth.GoogleAuth({ credentials: config.credentials, scopes: [SHEETS_SCOPE] })
  const sheets = google.sheets({ version: "v4", auth })
  const range = `${quoteSheetName(config.sheetName)}!${config.range}`
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range })

  return { sheetName: config.sheetName, rows: valuesToSheetRows(response.data.values ?? []) }
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
