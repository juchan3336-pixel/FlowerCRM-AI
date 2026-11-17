// 공공등록(e하늘) 기반 장례식장 확인 — 순수 판정과 서비스 계약.
import { beforeEach, describe, expect, it, vi } from "vitest"

import { parseOpsTask } from "@/lib/batch/ops-task"
import {
  ehaneulDetailUrl,
  evidenceFingerprint,
  judgeRegistryMatch,
  parseEhaneulDetail,
  parseRegistryVerifyStep,
  placeFingerprint,
  REGISTRY_VERIFIED_BY,
  registryAuditKey,
  type RegistryEvidence,
  type RegistryPlace,
} from "@/lib/batch/registry-verify"

vi.mock("server-only", () => ({}))

const PLACE_ID = "11111111-1111-4111-8111-111111111111"
const FACILITY = "1000000795"
const PLACE: RegistryPlace = {
  id: PLACE_ID,
  name: "추병원 장례식장",
  status: "draft",
  category: "funeral",
  official_verification_status: null,
  exclusion_reason: null,
  address: "경기 의정부시 평화로 650 (지번) 의정부동 234-2",
  phone: "031-870-1004",
}
const EVIDENCE: RegistryEvidence = {
  facilitycd: FACILITY,
  facilitygroupcd: "TBC0700001",
  companyname: "추병원장례식장",
  fulladdress: "경기도 의정부시 평화로 650 (의정부동)",
  telephone: "031-870-1004",
  mortuaycnt: 4,
}
// e하늘 상세 응답 모양 — 필요한 필드와, 읽지 않아야 하는 개인 필드를 함께 둔다.
function detailJson(patch: Record<string, unknown> = {}, listPatch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isSuccess: true,
    detail: { facilitycd: FACILITY, facilitygroupcd: "TBC0700001", fulladdress: EVIDENCE.fulladdress, telephone: EVIDENCE.telephone, mortuaycnt: 4, charnelabilitycnt: 6, updateUser: "someone", ...patch },
    facilityList: [{ facilitycd: FACILITY, companyname: EVIDENCE.companyname, ...listPatch }],
  }
}

const STEP = {
  kind: "registry-verify",
  placeId: PLACE_ID,
  facilitycd: FACILITY,
  expectedPlaceHash: placeFingerprint(PLACE),
  expectedEvidenceHash: evidenceFingerprint(EVIDENCE),
  reason: "e하늘 목록·상세와 도로명·전화·이름 일치 (파일럿)",
} as const

describe("설정 해석", () => {
  it("정해진 키·형식만 받는다", () => {
    expect(parseRegistryVerifyStep(STEP)).toEqual(STEP)
    expect(parseRegistryVerifyStep({ ...STEP, matched: true })).toBeNull()
    expect(parseRegistryVerifyStep({ ...STEP, sourceUrl: "https://evil.example" })).toBeNull()
    expect(parseRegistryVerifyStep({ ...STEP, facilitycd: "12345" })).toBeNull()
    expect(parseRegistryVerifyStep({ ...STEP, expectedPlaceHash: "abc" })).toBeNull()
    expect(parseRegistryVerifyStep({ ...STEP, reason: " " })).toBeNull()
    expect(parseRegistryVerifyStep({ ...STEP, reason: "가".repeat(301) })).toBeNull()
  })

  it("ops 작업은 공공등록 step을 작업당 10개까지 받는다", () => {
    const task = { id: "registry-pilot", expiresAt: "2026-11-18T00:00:00.000Z", actor: "ops:registry", inheritFreezeFrom: null }
    expect(parseOpsTask({ ...task, steps: [STEP] })?.steps).toEqual([STEP])
    expect(parseOpsTask({ ...task, steps: Array.from({ length: 10 }, () => STEP) })).not.toBeNull()
    expect(parseOpsTask({ ...task, steps: Array.from({ length: 11 }, () => STEP) })).toBeNull()
  })
})

describe("e하늘 상세 해석", () => {
  it("필요한 필드만 꺼내고 개인 필드는 읽지 않는다", () => {
    const parsed = parseEhaneulDetail(detailJson(), FACILITY)
    expect(parsed).toEqual(EVIDENCE)
    expect(JSON.stringify(parsed)).not.toContain("someone")
  })

  it.each([
    ["실패 응답", { ...detailJson(), isSuccess: false }],
    ["다른 시설 번호", detailJson({ facilitycd: "1000000001" })],
    ["목록에 시설 없음", { ...detailJson(), facilityList: [] }],
    ["빈소 수 형식 오류", detailJson({ mortuaycnt: "많음" })],
    ["주소 없음", detailJson({ fulladdress: null })],
  ])("%s이면 근거 없음(fail-closed)", (_label, json) => {
    expect(parseEhaneulDetail(json, FACILITY)).toBeNull()
  })
})

describe("본체 일치 판정", () => {
  it("시도·시군구 + 도로명·번호 + 전화·이름이 맞으면 통과", () => {
    expect(judgeRegistryMatch(PLACE, EVIDENCE)).toEqual({ ok: true, matched: ["address", "phone", "name"] })
  })

  it.each([
    ["장례식장 그룹 아님", PLACE, { ...EVIDENCE, facilitygroupcd: "TBC0700002" }, "not-funeral-group"],
    ["빈소 0", PLACE, { ...EVIDENCE, mortuaycnt: 0 }, "no-rooms"],
    ["부속 시설 행", { ...PLACE, name: "추병원 장례식장 주차장" }, EVIDENCE, "sub-facility-name"],
    ["다른 지역의 같은 도로명", { ...PLACE, address: "경기 양주시 평화로 650" }, EVIDENCE, "region-mismatch"],
    ["건물번호 다름", { ...PLACE, address: "경기 의정부시 평화로 652" }, EVIDENCE, "road-mismatch"],
    ["DB 상세 층", { ...PLACE, address: "경기 의정부시 평화로 650 지하1층 (지번) 의정부동 234-2" }, EVIDENCE, "address-detail"],
    ["주소만 같고 전화·이름 다름", { ...PLACE, name: "평화 장례식장", phone: "031-000-0000" }, EVIDENCE, "weak-match"],
    ["주소 없음", { ...PLACE, address: null }, EVIDENCE, "missing-address"],
  ] as const)("%s → %s", (_label, place, evidence, reason) => {
    expect(judgeRegistryMatch(place, evidence)).toEqual({ ok: false, reason })
  })

  it("공유 대표전화와 이름 포함만으로는(주소 다름) 통과하지 않는다", () => {
    expect(judgeRegistryMatch({ ...PLACE, address: "경기 의정부시 호국로 1000" }, EVIDENCE)).toEqual({ ok: false, reason: "road-mismatch" })
  })
})

// ── 서비스 (Supabase·fetch 대역) ──────────────────────────────
type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
let insertError: { code: string; message: string } | null = null
let updateError = false
let beforeUpdate: (() => void) | null = null
const writes: { table: string; kind: string; patch: Row }[] = []

function builder(table: string) {
  const filters: { op: "eq" | "is"; column: string; value: unknown }[] = []
  let patch: Row | null = null
  let head = false
  const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => row[f.column] === f.value))
  const run = () => {
    if (patch !== null) {
      if (updateError) return { data: null, error: { message: "update failed" } }
      beforeUpdate?.()
      beforeUpdate = null
      const targets = rows()
      for (const row of targets) Object.assign(row, patch)
      writes.push({ table, kind: "update", patch })
      return { data: targets, error: null }
    }
    return head ? { data: null, error: null, count: rows().length } : { data: rows().map((row) => ({ ...row })), error: null }
  }
  const api = {
    select: (_columns?: string, options?: { head?: boolean }) => {
      head = options?.head === true
      return api
    },
    eq: (column: string, value: unknown) => {
      filters.push({ op: "eq", column, value })
      return api
    },
    is: (column: string, value: unknown) => {
      filters.push({ op: "is", column, value })
      return api
    },
    update: (next: Row) => {
      patch = next
      return api
    },
    insert: (row: Row) => {
      if (insertError !== null) return Promise.resolve({ error: insertError })
      if ((tables[table] ?? []).some((existing) => existing["key"] === row["key"])) return Promise.resolve({ error: { code: "23505", message: "duplicate" } })
      ;(tables[table] ??= []).push({ ...row })
      writes.push({ table, kind: "insert", patch: row })
      return Promise.resolve({ error: null })
    },
    maybeSingle: () => {
      const result = run()
      return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error })
    },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(run()).then(resolve),
  }
  return api
}
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => builder(table) }) }))

let fetchBody: unknown = detailJson()
let fetchStatus = 200
const fetchCalls: string[] = []
const fetchImpl = ((url: string) => {
  fetchCalls.push(url)
  if (fetchStatus === 0) return Promise.reject(new Error("network"))
  return Promise.resolve({ ok: fetchStatus === 200, json: () => Promise.resolve(fetchBody) })
}) as unknown as typeof fetch
const NOW = new Date("2026-11-17T03:00:00.000Z")
const deps = { fetchImpl, now: () => NOW }

beforeEach(() => {
  for (const key of Object.keys(tables)) Reflect.deleteProperty(tables, key)
  tables["places"] = [{ ...PLACE, verified_by: null, verification_source_urls: null }]
  tables["ai_generations"] = []
  tables["batch_run_items"] = []
  tables["seo_pages"] = []
  tables["settings"] = []
  insertError = null
  updateError = false
  beforeUpdate = null
  writes.length = 0
  fetchCalls.length = 0
  fetchBody = detailJson()
  fetchStatus = 200
})

async function run(step: Record<string, unknown> = STEP) {
  const { runRegistryVerify } = await import("@/lib/batch/registry-verify-service")
  const parsed = parseRegistryVerifyStep(step)
  if (parsed === null) throw new Error("step")
  return runRegistryVerify(parsed, "ops:registry-pilot", deps)
}
const place = (): Row => tables["places"]?.[0] ?? {}

describe("공공등록 확인 서비스", () => {
  it("근거를 정해진 주소에서 읽어 확인 상태·출처만 쓰고 감사 기록을 남긴다", async () => {
    expect(await run()).toEqual({ kind: "verified", matched: ["address", "phone", "name"], sourceUrl: ehaneulDetailUrl(FACILITY), resumed: false })
    expect(fetchCalls).toEqual([ehaneulDetailUrl(FACILITY)])
    expect(place()).toMatchObject({ official_verification_status: "verified", verified_by: REGISTRY_VERIFIED_BY, verified_at: NOW.toISOString(), verification_source_urls: [ehaneulDetailUrl(FACILITY)] })
    // 수집 원문은 그대로
    expect(place()).toMatchObject({ name: PLACE.name, address: PLACE.address, phone: PLACE.phone })
    const audit = tables["settings"]?.find((row) => row["key"] === registryAuditKey(PLACE_ID))?.["value"] as Row
    expect(audit).toMatchObject({ policy_version: "ehaneul-funeral-v1", tier: "public-registry", not_confirmed: ["current-operation", "wreath-policy"], facilitycd: FACILITY, matched: ["address", "phone", "name"] })
    expect(audit["before"]).toMatchObject({ official_verification_status: null })
  })

  it("그 사이 장소가 바뀌었으면 근거를 읽지도 쓰지도 않는다", async () => {
    place()["phone"] = "031-999-9999"
    expect(await run()).toEqual({ kind: "blocked", reason: "place-changed" })
    expect(fetchCalls).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })

  it("다시 읽은 근거가 승인한 근거와 다르면 쓰지 않는다", async () => {
    fetchBody = detailJson({ mortuaycnt: 5 })
    expect(await run()).toEqual({ kind: "blocked", reason: "evidence-changed" })
    expect(writes).toHaveLength(0)
  })

  it.each([
    ["네트워크 오류", 0, "fetch"],
    ["HTTP 오류", 500, "fetch"],
  ] as const)("근거를 읽지 못하면(%s) 실패로 남기고 쓰지 않는다", async (_label, status, step) => {
    fetchStatus = status
    expect(await run()).toEqual({ kind: "failed", step })
    expect(writes).toHaveLength(0)
  })

  it("응답 형식이 바뀌었으면 실패로 남기고 쓰지 않는다", async () => {
    fetchBody = { isSuccess: true, rows: [] }
    expect(await run()).toEqual({ kind: "failed", step: "parse" })
    expect(writes).toHaveLength(0)
  })

  it("생성·배치·SEO 이력이 있으면 쓰지 않는다", async () => {
    tables["ai_generations"] = [{ id: "g1", place_id: PLACE_ID }]
    expect(await run()).toEqual({ kind: "blocked", reason: "has-pipeline-state" })
    expect(writes).toHaveLength(0)
  })

  it("같은 시설이 이미 공개돼 있으면 중복으로 멈춘다", async () => {
    tables["places"]?.push({ id: "22222222-2222-4222-8222-222222222222", name: "추병원장례식장(구관)", status: "published", category: "funeral", address: "경기 의정부시 평화로 650" })
    expect(await run()).toEqual({ kind: "blocked", reason: "published-duplicate" })
    expect(place()["official_verification_status"]).toBeNull()
  })

  it("갱신 조건이 맞지 않아 0행이면 성공으로 세지 않는다", async () => {
    // 대상 확인 뒤 갱신 직전에 다른 경로가 이름을 바꾼 상황 — 갱신 필터(이름 일치)에 걸려 0행.
    beforeUpdate = () => {
      place()["name"] = "추병원 장례식장 (변경)"
    }
    expect(await run()).toEqual({ kind: "blocked", reason: "write-conflict" })
    expect(place()["official_verification_status"]).toBeNull()
    expect(tables["settings"]).toHaveLength(0)
  })

  it("갱신 오류는 실패로 보고하고 감사를 남기지 않는다", async () => {
    updateError = true
    expect(await run()).toEqual({ kind: "failed", step: "write" })
    expect(tables["settings"]).toHaveLength(0)
  })

  it("확인은 됐는데 감사를 못 남겼으면 실패로 보고하고, 다시 실행하면 감사만 마저 남긴다", async () => {
    insertError = { code: "XX000", message: "insert failed" }
    expect(await run()).toEqual({ kind: "failed", step: "audit" })
    expect(place()["official_verification_status"]).toBe("verified")
    insertError = null
    fetchCalls.length = 0

    expect(await run()).toMatchObject({ kind: "verified", resumed: true })
    expect(fetchCalls).toHaveLength(1)
    expect(tables["settings"]?.filter((row) => row["key"] === registryAuditKey(PLACE_ID))).toHaveLength(1)
    // 세 번째 실행은 아무것도 다시 쓰지 않는다.
    const before = writes.length
    expect(await run()).toMatchObject({ kind: "verified", resumed: true })
    expect(writes).toHaveLength(before)
  })

  it("다른 근거로 이미 확인된 장소는 덮어쓰지 않는다", async () => {
    Object.assign(place(), { official_verification_status: "verified", verified_by: "auto-verify", verification_source_urls: ["http://example.test/"] })
    expect(await run()).toEqual({ kind: "blocked", reason: "already-verified-other" })
    expect(writes).toHaveLength(0)
  })

  it("추모·봉안 시설 이름이면 확인하지 않는다", async () => {
    Object.assign(place(), { name: "하늘추모공원 봉안당" })
    const step = { ...STEP, expectedPlaceHash: placeFingerprint({ ...PLACE, name: "하늘추모공원 봉안당" }) }
    expect(await run(step)).toEqual({ kind: "blocked", reason: "facility-name-blocked" })
    expect(fetchCalls).toHaveLength(0)
  })
})
