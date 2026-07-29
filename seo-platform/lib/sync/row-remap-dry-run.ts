import "server-only"

// 관리자 행번호 정합성 Dry-run — 읽기 전용.
//
// Google 자격증명은 Vercel 환경변수에만 있고, 이 코드가 서버에서만 실행되므로
// 브라우저·응답 어디로도 나가지 않는다. 시트도 Supabase도 읽기만 한다.
//
// 쓰기 경로를 아예 만들지 않는다: 여기서 부르는 것은 조회 함수 두 개와 순수 계산뿐이다
// (places UPDATE·Sheet 수정·sync_jobs/sync_runs/sync_errors 생성·동기화 실행 전부 없음).
import { readGoogleSheetRows } from "./google-sheets"
import { buildRemapReport, evaluateRemapReport, type RemapReport, type RemapVerdict } from "./row-remap-core"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"

const SHEET_TAB = "기업 DB"
const FIRST_DATA_ROW_NUMBER = 2
const PAGE_SIZE = 1000

export type RowRemapDryRunResult =
  | { readonly kind: "ok"; readonly report: RemapReport; readonly verdict: RemapVerdict }
  // 오류는 안전한 코드로만 돌려준다 — 원문·stack trace·자격증명을 절대 싣지 않는다.
  | { readonly kind: "failed"; readonly errorCode: "google-read-failed" | "supabase-read-failed" }

export async function runRowRemapDryRun(): Promise<RowRemapDryRunResult> {
  let sheetRows: readonly { rowNumber: number; name: string | undefined; address: string | undefined; phone: string | undefined }[]
  try {
    const sheet = await readGoogleSheetRows()
    // 시트 행 번호는 1행이 헤더이므로 인덱스 + 2다.
    sheetRows = sheet.rows.map((row, index) => ({
      rowNumber: index + FIRST_DATA_ROW_NUMBER,
      name: row["회사명"],
      address: row["주소"],
      phone: row["대표전화"],
    }))
  } catch {
    return { kind: "failed", errorCode: "google-read-failed" }
  }

  let places: readonly { id: string; source_key: string; source_row_number: number; name: string; status: string }[]
  try {
    places = await readAllPlaces()
  } catch {
    return { kind: "failed", errorCode: "supabase-read-failed" }
  }

  const report = buildRemapReport({ sheetRows, places })
  return { kind: "ok", report, verdict: evaluateRemapReport(report.summary) }
}

// PostgREST는 한 번에 1,000행까지만 준다 — 전량을 페이지로 읽는다.
async function readAllPlaces(): Promise<readonly { id: string; source_key: string; source_row_number: number; name: string; status: string }[]> {
  const client = createSupabaseServiceRoleClient()
  const rows: { id: string; source_key: string; source_row_number: number; name: string; status: string }[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from("places")
      .select("id, source_key, source_row_number, name, status")
      .eq("source_sheet_name", SHEET_TAB)
      .not("source_row_number", "is", null)
      .order("source_row_number", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error !== null) {
      throw new Error("supabase-read-failed")
    }
    if (data.length === 0) {
      break
    }
    for (const row of data) {
      rows.push({ id: row.id, source_key: row.source_key, source_row_number: row.source_row_number, name: row.name, status: row.status })
    }
    if (data.length < PAGE_SIZE) {
      break
    }
  }
  return rows
}
