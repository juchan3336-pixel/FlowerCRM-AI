// places.source_row_number 재매핑 **적용** 도구.
//
//   node work/remap_source_row_numbers.mjs                       → 계획 요약만 출력 (dry-run, 쓰기 없음)
//   node work/remap_source_row_numbers.mjs --apply               → 실제 UPDATE (사용자 승인 후에만)
//   node work/remap_source_row_numbers.mjs --rollback            → 되돌리기 dry-run
//   node work/remap_source_row_numbers.mjs --rollback --apply    → 실제 되돌리기
//
//   기본 입력: outputs/source_row_remap_plan.json  (--plan <경로>로 변경 가능)
//
// 매칭·검증은 여기서 하지 않는다.
// 계획을 만드는 쪽은 관리자 화면의 "행번호 정합성 검사"(seo-platform/lib/sync/row-remap-core.ts)
// 하나뿐이다 — 판정 로직이 두 벌 있으면 어느 쪽을 믿어야 할지 알 수 없기 때문이다.
// 이 도구는 그 계획을 그대로 적용하는 실행기이며, 계획 파일의 검증 결과가 PASS일 때만 움직인다.
//
// 안전 계약
//  · 기본이 dry-run. --apply 없이는 어떤 쓰기도 하지 않는다.
//  · 계획의 verdict가 PASS가 아니면 --apply여도 실행하지 않는다.
//  · UPDATE 컬럼은 source_row_number 단 하나. published 장소도 이 컬럼만 바뀐다.
//  · 조건부 UPDATE(id 일치 AND 기존 source_row_number 일치). 어긋난 건은 건너뛰고 목록으로 보고한다.
//  · 적용 전 rollback 파일을 만들고, 적용 후 diff를 출력한다.

import fs from "node:fs"

import { loadEnv } from "../src/env.js"

loadEnv()

const APPLY = process.argv.includes("--apply")
const ROLLBACK = process.argv.includes("--rollback")
const PLAN_PATH = argValue("--plan") ?? "outputs/source_row_remap_plan.json"
const ROLLBACK_PATH = argValue("--rollback-file") ?? "outputs/source_row_remap_rollback.json"
const SHEET_TAB = "기업 DB"
const PAGE_SIZE = 1000
// 관리자 화면 판정 중 적용을 허용하는 값 (seo-platform/lib/sync/row-remap-core.ts의 RemapVerdictKind).
const ACCEPTED_VERDICTS = ["PASS", "PASS_WITH_PENDING_SYNC"]

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "")
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.")
}

if (ROLLBACK) {
  await runEntries(readEntries(ROLLBACK_PATH, "entries"), "rollback")
} else {
  const plan = readJson(PLAN_PATH)
  console.log(JSON.stringify({ planPath: PLAN_PATH, verdict: plan.verdict, failures: plan.failures ?? [], summary: plan.summary }, null, 2))

  // PASS_WITH_PENDING_SYNC는 "기존 데이터 정합성은 정상이고 신규 미동기화분만 뒤에 쌓였다"는 뜻이라
  // 복구를 막을 이유가 없다. 신규분은 애초에 계획(updates)에 들어가지 않는다.
  if (!ACCEPTED_VERDICTS.includes(plan.verdict)) {
    console.log(`FAIL: 계획의 검증 결과가 ${String(plan.verdict)} 입니다 — 관리자 화면에서 원인을 해소한 뒤 다시 검사하세요.`)
    process.exit(1)
  }
  const entries = readEntries(PLAN_PATH, "updates")

  // rollback을 먼저 만들어 둔다 (from/to를 뒤집어 저장). 적용 전에 존재해야 한다.
  const generatedAt = new Date().toISOString()
  fs.mkdirSync(dirOf(ROLLBACK_PATH), { recursive: true })
  fs.writeFileSync(
    ROLLBACK_PATH,
    JSON.stringify(
      { generatedAt, entries: entries.map((entry) => ({ ...entry, from_row: entry.to_row, to_row: entry.from_row, generated_at: generatedAt })) },
      null,
      2,
    ),
    "utf8",
  )
  console.log(`rollback : ${ROLLBACK_PATH}`)

  await runEntries(entries, "apply")
}

// ── 실행 ──────────────────────────────────────────────────────────
async function runEntries(entries, mode) {
  console.log(JSON.stringify({ mode, planned: entries.length, apply: APPLY }, null, 2))
  if (!APPLY) {
    console.log(`${mode} dry-run 종료 — 쓰기 없음. 실행하려면 --apply (사용자 승인 후).`)
    return
  }

  const before = await countPlaces()
  const result = await applyUpdates(entries)
  console.log(JSON.stringify(result, null, 2))
  if (result.skipped.length > 0) {
    console.log("주의: 조건 불일치로 건너뛴 행이 있습니다 — 계획과 실제 DB가 어긋났습니다.")
    console.log(JSON.stringify(result.skipped.slice(0, 20), null, 2))
  }

  const after = await readRowNumbers()
  console.log(
    JSON.stringify(
      {
        dbRowsBefore: before,
        dbRowsAfter: after.length,
        minAfter: after[0] ?? null,
        maxAfter: after.at(-1) ?? null,
        duplicatesAfter: after.length - new Set(after).size,
        contiguousAfter: after.every((value, index) => index === 0 || value === after[index - 1] + 1),
      },
      null,
      2,
    ),
  )
}

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

// ── helpers ───────────────────────────────────────────────────────
function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function readJson(path) {
  if (!fs.existsSync(path)) {
    throw new Error(`파일이 없습니다: ${path} — 관리자 화면 '행번호 정합성 검사' 결과를 저장해 주세요.`)
  }
  return JSON.parse(fs.readFileSync(path, "utf8"))
}

function readEntries(path, field) {
  const entries = readJson(path)[field]
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${path} 의 ${field} 가 비어 있습니다.`)
  }
  for (const entry of entries) {
    if (typeof entry.place_id !== "string" || !Number.isInteger(entry.from_row) || !Number.isInteger(entry.to_row)) {
      throw new Error(`${field} 항목 형식이 올바르지 않습니다 (place_id·from_row·to_row 필요).`)
    }
  }
  return entries
}

function dirOf(path) {
  const index = path.lastIndexOf("/")
  return index > 0 ? path.slice(0, index) : "."
}

async function countPlaces() {
  const response = await fetch(`${supabaseUrl}/rest/v1/places?source_sheet_name=eq.${encodeURIComponent(SHEET_TAB)}&select=id&limit=1`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, prefer: "count=exact" },
  })
  return response.headers.get("content-range")
}

async function readRowNumbers() {
  const rows = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/places?source_sheet_name=eq.${encodeURIComponent(SHEET_TAB)}` +
        `&select=source_row_number&order=source_row_number.asc&limit=${String(PAGE_SIZE)}&offset=${String(offset)}`,
      { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
    )
    const page = await response.json()
    if (!Array.isArray(page) || page.length === 0) break
    rows.push(...page.map((row) => row.source_row_number))
    if (page.length < PAGE_SIZE) break
  }
  return rows
}
