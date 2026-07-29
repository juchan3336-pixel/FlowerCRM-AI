// Google Sheets 행 삭제·이동 후 places.source_row_number 재매핑.
//
//   node work/remap_source_row_numbers.mjs            → dry-run (기본, 쓰기 없음)
//   node work/remap_source_row_numbers.mjs --apply    → 실제 UPDATE (사용자 승인 후에만)
//   node work/remap_source_row_numbers.mjs --rollback → outputs/…rollback.json으로 되돌리기
//
// 왜 필요한가 — 증분 동기화의 시작점은 places의 max(source_row_number) 다음 행이다.
// 시트에서 행이 삭제되면 그 기록이 현재 시트보다 뒤로 밀려 커서가 시트 끝을 앞지르고,
// 그 뒤에 붙는 신규 행이 커서에 닿을 때까지 통째로 건너뛰어진다.
// 2026-07-29 공백행 6개(131·132·307·308·320·321) 삭제로 정확히 그 상태가 됐다.
//
// 안전 계약
//  · 기본이 dry-run. --apply 없이는 어떤 쓰기도 하지 않는다.
//  · source_key 1:1 매칭된 행만 대상. 다중 매칭·미매칭은 전부 제외하고 목록으로 남긴다.
//  · UPDATE 컬럼은 source_row_number 단 하나. published 장소도 이 컬럼만 바뀐다.
//  · 조건부 UPDATE(id 일치 AND 기존 source_row_number 일치). 한 건이라도 조건이 어긋나면 제외 보고한다.
//  · 적용 전 plan과 rollback을 파일로 남기고, 적용 후 diff를 출력한다.
//  · 시트는 읽기만 한다.

import fs from "node:fs"

import { loadEnv } from "../src/env.js"
import { getAccessToken } from "../src/googleAuth.js"
import { createSourceKey } from "./source-key.mjs"

loadEnv()

const APPLY = process.argv.includes("--apply")
const ROLLBACK = process.argv.includes("--rollback")
const SHEET_TAB = "기업 DB"
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets"
const OUT_DIR = "outputs"
const PLAN_PATH = `${OUT_DIR}/source_row_remap_plan.json`
const ROLLBACK_PATH = `${OUT_DIR}/source_row_remap_rollback.json`
const FIRST_DATA_ROW = 2
const PAGE_SIZE = 1000

// 2026-07-29 공백행 6개 삭제로 예상되는 이동량. 실측이 다르면 FAIL로 보고하고 적용을 막는다.
// 시트 상황이 달라졌다면(추가 삭제·삽입) 이 표를 갱신하고 사용자 재승인을 받아야 한다.
const EXPECTED_SHIFTS = { 0: 129, "-2": 174, "-4": 11, "-6": 14637 }

const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID
const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "")
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!spreadsheetId || !supabaseUrl || !serviceKey) {
  throw new Error("GOOGLE_SPREADSHEET_ID / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.")
}

if (ROLLBACK) {
  await runRollback()
  process.exit(0)
}

// ── 1) 스냅샷 (양쪽 다 읽기 전용) ──────────────────────────────────
// 시트는 A:F만 읽는다 — source_key 계산에 회사명(A)·주소(E)·대표전화(F)만 필요하다.
const sheetValues = await readSheet(`${SHEET_TAB}!A${FIRST_DATA_ROW}:F`)
const sheetEntries = sheetValues
  .map((row, index) => ({
    rowNumber: index + FIRST_DATA_ROW,
    name: text(row[0]),
    address: text(row[4]),
    phone: text(row[5]),
  }))
  .filter((entry) => entry.name !== "")
  .map((entry) => ({ ...entry, sourceKey: createSourceKey(entry) }))

const places = await readAllPlaces()

// ── 2) 인덱스와 중복 검출 ─────────────────────────────────────────
const { byKey: sheetByKey, duplicates: sheetDuplicateKeys } = indexByKey(sheetEntries, (entry) => entry.sourceKey)
const { byKey: placeByKey, duplicates: placeDuplicateKeys } = indexByKey(places, (place) => place.source_key)
const duplicateSourceKeys = [...new Set([...sheetDuplicateKeys, ...placeDuplicateKeys])]

// ── 3) 매칭·분류 ──────────────────────────────────────────────────
const updates = []
const unchanged = []
const unmatchedInDb = [] // Supabase에만 있음 = 시트에서 사라진 행
const ambiguous = [] // 어느 한쪽이라도 source_key 중복 → 어느 행에 맞출지 결정 불가

for (const place of places) {
  const key = place.source_key
  if (sheetDuplicateKeys.has(key) || placeDuplicateKeys.has(key)) {
    ambiguous.push({ place_id: place.id, source_key: key, from_row: place.source_row_number, company_name: place.name })
    continue
  }
  const sheetEntry = sheetByKey.get(key)
  if (sheetEntry === undefined) {
    unmatchedInDb.push({ place_id: place.id, source_key: key, from_row: place.source_row_number, company_name: place.name })
    continue
  }
  if (sheetEntry.rowNumber === place.source_row_number) {
    unchanged.push(place.id)
    continue
  }
  updates.push({
    place_id: place.id,
    source_key: key,
    from_row: place.source_row_number,
    to_row: sheetEntry.rowNumber,
    company_name: place.name,
    status: place.status,
  })
}

// 시트에만 있는 행 = 아직 동기화되지 않은 신규 데이터. 재매핑 대상이 아니지만, 남아 있으면
// 시트/DB 스냅샷 시점이 어긋났다는 뜻이라 적용을 막는다 (매칭 근거가 흔들림).
const unmatchedInSheet = sheetEntries
  .filter((entry) => !placeByKey.has(entry.sourceKey))
  .map((entry) => ({ row_number: entry.rowNumber, company_name: entry.name }))

// ── 4) 검증 지표 ──────────────────────────────────────────────────
const shiftHistogram = {}
for (const update of updates) {
  const shift = update.to_row - update.from_row
  shiftHistogram[shift] = (shiftHistogram[shift] ?? 0) + 1
}
// unchanged(이동 0)도 히스토그램에 넣어야 예상표와 비교된다.
shiftHistogram[0] = (shiftHistogram[0] ?? 0) + unchanged.length

const targetRows = updates.map((update) => update.to_row)
const duplicateTargetRows = targetRows.length - new Set(targetRows).size

const beforeRows = places.map((place) => place.source_row_number).sort((a, b) => a - b)
const afterRows = places
  .map((place) => updates.find((update) => update.place_id === place.id)?.to_row ?? place.source_row_number)
  .sort((a, b) => a - b)
const expectedContinuity = afterRows.every((value, index) => index === 0 || value === afterRows[index - 1] + 1)

const shiftMatchesExpectation = Object.keys(EXPECTED_SHIFTS).every((shift) => (shiftHistogram[shift] ?? 0) === EXPECTED_SHIFTS[shift]) &&
  Object.keys(shiftHistogram).every((shift) => EXPECTED_SHIFTS[shift] !== undefined)

const generatedAt = new Date().toISOString()
const summary = {
  generatedAt,
  apply: APPLY,
  sheetRows: sheetEntries.length,
  sheetLastRow: sheetEntries.at(-1)?.rowNumber ?? null,
  dbRows: places.length,
  matched: updates.length + unchanged.length,
  unchanged: unchanged.length,
  updateCount: updates.length,
  unmatchedInSheet: unmatchedInSheet.length,
  unmatchedInDb: unmatchedInDb.length,
  ambiguous: ambiguous.length,
  duplicateSourceKeys: duplicateSourceKeys.length,
  duplicateTargetRows,
  shiftHistogram,
  expectedShifts: EXPECTED_SHIFTS,
  shiftMatchesExpectation,
  minBefore: beforeRows[0] ?? null,
  maxBefore: beforeRows.at(-1) ?? null,
  minAfter: afterRows[0] ?? null,
  maxAfter: afterRows.at(-1) ?? null,
  expectedContinuity,
  publishedInUpdates: updates.filter((update) => update.status === "published").length,
}
console.log(JSON.stringify(summary, null, 2))

// ── 5) plan · rollback 저장 (dry-run에서도 항상) ──────────────────
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(PLAN_PATH, JSON.stringify({ summary, updates, unmatchedInDb, unmatchedInSheet, ambiguous }, null, 2), "utf8")
// rollback은 to→from을 뒤집어 둔다. --rollback이 이 파일만 보고 되돌린다.
fs.writeFileSync(
  ROLLBACK_PATH,
  JSON.stringify(
    {
      generatedAt,
      entries: updates.map((update) => ({
        place_id: update.place_id,
        source_key: update.source_key,
        from_row: update.to_row,
        to_row: update.from_row,
        company_name: update.company_name,
        generated_at: generatedAt,
      })),
    },
    null,
    2,
  ),
  "utf8",
)
console.log(`plan     : ${PLAN_PATH}`)
console.log(`rollback : ${ROLLBACK_PATH}`)

// ── 6) 적용 차단 조건 ─────────────────────────────────────────────
const blockers = []
if (duplicateSourceKeys.length > 0) blockers.push(`source_key 중복 ${duplicateSourceKeys.length}건`)
if (duplicateTargetRows > 0) blockers.push(`새 행 번호 충돌 ${duplicateTargetRows}건`)
if (unmatchedInSheet.length > 0) blockers.push(`시트에만 있는 행 ${unmatchedInSheet.length}건 (미동기화 신규 데이터)`)
if (unmatchedInDb.length > 0) blockers.push(`Supabase에만 있는 행 ${unmatchedInDb.length}건 (시트에서 사라짐)`)
if (ambiguous.length > 0) blockers.push(`판정 불가 ${ambiguous.length}건`)
if (!shiftMatchesExpectation) blockers.push("이동량이 예상표와 다름 — 사용자 재승인 필요")
if (!expectedContinuity) blockers.push("재매핑 후 행 번호가 연속이 아님")

if (blockers.length > 0) {
  console.log("FAIL:", blockers.join(" / "))
  console.log("→ 원인 확인 후 재실행. 자동 진행하지 않습니다.")
  process.exit(1)
}
console.log("PASS: 적용 가능 조건 충족")

if (!APPLY) {
  console.log("dry-run 종료 — 쓰기 없음. 적용하려면 --apply (사용자 승인 후).")
  process.exit(0)
}

// ── 7) 적용 ───────────────────────────────────────────────────────
const applied = await applyUpdates(updates)
console.log(JSON.stringify(applied, null, 2))
if (applied.skipped.length > 0) {
  console.log("주의: 조건 불일치로 건너뛴 행이 있습니다 — plan과 실제 DB가 어긋났습니다. 아래 목록 확인 후 재실행하세요.")
  console.log(JSON.stringify(applied.skipped.slice(0, 20), null, 2))
}

// ── 8) 적용 후 diff ───────────────────────────────────────────────
const after = await readAllPlaces()
const afterNumbers = after.map((place) => place.source_row_number).sort((a, b) => a - b)
console.log(
  JSON.stringify(
    {
      dbRowsAfter: after.length,
      minAfter: afterNumbers[0],
      maxAfter: afterNumbers.at(-1),
      duplicatesAfter: afterNumbers.length - new Set(afterNumbers).size,
      contiguousAfter: afterNumbers.every((value, index) => index === 0 || value === afterNumbers[index - 1] + 1),
    },
    null,
    2,
  ),
)

// ── rollback ──────────────────────────────────────────────────────
async function runRollback() {
  if (!fs.existsSync(ROLLBACK_PATH)) {
    throw new Error(`rollback 파일이 없습니다: ${ROLLBACK_PATH}`)
  }
  const { entries } = JSON.parse(fs.readFileSync(ROLLBACK_PATH, "utf8"))
  console.log(JSON.stringify({ rollbackEntries: entries.length, apply: APPLY }, null, 2))
  if (!APPLY) {
    console.log("rollback dry-run 종료 — 쓰기 없음. 실행하려면 --rollback --apply.")
    return
  }
  const applied = await applyUpdates(entries)
  console.log(JSON.stringify(applied, null, 2))
}

// ── helpers ───────────────────────────────────────────────────────
// 조건부 UPDATE — id 일치 AND 기존 source_row_number 일치일 때만. 갱신 컬럼은 source_row_number 하나.
async function applyUpdates(entries) {
  let updated = 0
  const skipped = []
  for (const entry of entries) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/places?id=eq.${entry.place_id}&source_row_number=eq.${String(entry.from_row)}&select=id`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: JSON.stringify({ source_row_number: entry.to_row }),
      },
    )
    const rows = await response.json()
    if (Array.isArray(rows) && rows.length === 1) {
      updated += 1
    } else {
      skipped.push({ place_id: entry.place_id, from_row: entry.from_row, to_row: entry.to_row, status: response.status })
    }
  }
  return { planned: entries.length, updated, skippedCount: skipped.length, skipped }
}

function indexByKey(rows, pick) {
  const byKey = new Map()
  const duplicates = new Set()
  for (const row of rows) {
    const key = pick(row)
    if (byKey.has(key)) {
      duplicates.add(key)
      continue
    }
    byKey.set(key, row)
  }
  return { byKey, duplicates }
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

async function readSheet(range) {
  const token = await getAccessToken()
  const response = await fetch(`${SHEETS_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(`Sheets 읽기 실패: ${String(response.status)}`)
  }
  const json = await response.json()
  return json.values ?? []
}

async function readAllPlaces() {
  const rows = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/places?source_sheet_name=eq.${encodeURIComponent(SHEET_TAB)}` +
        `&select=id,source_key,source_row_number,name,status&order=source_row_number.asc&limit=${String(PAGE_SIZE)}&offset=${String(offset)}`,
      { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
    )
    const page = await response.json()
    if (!Array.isArray(page) || page.length === 0) break
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return rows
}
