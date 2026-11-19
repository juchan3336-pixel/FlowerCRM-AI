// 공공등록(e하늘) 기반 장례식장 확인 — 순수 판정과 서비스 계약.
import { beforeEach, describe, expect, it, vi } from "vitest"

import { parseOpsTask } from "@/lib/batch/ops-task"
import {
  EHANEUL_LIST_URL,
  ehaneulDetailUrl,
  evidenceFingerprint,
  judgeRegistryMatch,
  listAgeDays,
  parseEhaneulDetail,
  parseEhaneulList,
  parseRegistryVerifyStep,
  parseRoadAddress,
  placeFingerprint,
  REGISTRY_VERIFIED_BY,
  registryAuditKey,
  roadKey,
  sameRegion,
  type RegistryEvidence,
  type RegistryPlace,
} from "@/lib/batch/registry-verify"

vi.mock("server-only", () => ({}))

const PLACE_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_ID = "22222222-2222-4222-8222-222222222222"
const FACILITY = "1000000795"
const OTHER_FACILITY = "1000000796"
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
  listUpdatedDate: "2026-09-21",
}
// e하늘 상세 응답 모양 — 필요한 필드와, 읽지 않아야 하는 개인 필드를 함께 둔다.
function detailJson(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isSuccess: true,
    detail: { facilitycd: FACILITY, facilitygroupcd: "TBC0700001", fulladdress: EVIDENCE.fulladdress, telephone: EVIDENCE.telephone, mortuaycnt: 4, charnelabilitycnt: 6, updateUser: "someone", ...patch },
    facilityList: [{ facilitycd: FACILITY, companyname: "상세 쪽 이름" }],
  }
}
function listRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { facilitycd: FACILITY, facilitygroupcd: "TBC0700001", companyname: EVIDENCE.companyname, fulladdress: EVIDENCE.fulladdress, lastUpdateDate: "2026/09/21", ...patch }
}
function listJson(rows: Record<string, unknown>[] = [listRow(), listRow({ facilitycd: OTHER_FACILITY, companyname: "다른장례식장" })]): Record<string, unknown> {
  return { isSuccess: true, cnt: rows.length, list: rows }
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
    // 현행 목록에는 9자리 시설 번호도 있다.
    expect(parseRegistryVerifyStep({ ...STEP, facilitycd: "700002700" })).toMatchObject({ facilitycd: "700002700" })
    expect(parseRegistryVerifyStep({ ...STEP, expectedPlaceHash: "abc" })).toBeNull()
    expect(parseRegistryVerifyStep({ ...STEP, reason: " " })).toBeNull()
    expect(parseRegistryVerifyStep({ ...STEP, reason: "가".repeat(301) })).toBeNull()
  })

  const task = { id: "registry-pilot", expiresAt: "2026-11-18T00:00:00.000Z", actor: "ops:registry", inheritFreezeFrom: null }
  const stepFor = (index: number) => ({ ...STEP, placeId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`, facilitycd: String(1000000000 + index) })

  it("ops 작업은 공공등록 step을 작업당 10개까지 받는다", () => {
    expect(parseOpsTask({ ...task, steps: [STEP] })?.steps).toEqual([STEP])
    expect(parseOpsTask({ ...task, steps: Array.from({ length: 10 }, (_, index) => stepFor(index)) })).not.toBeNull()
    expect(parseOpsTask({ ...task, steps: Array.from({ length: 11 }, (_, index) => stepFor(index)) })).toBeNull()
  })

  it("같은 시설 번호나 같은 장소가 한 작업에 두 번 나오면 받지 않는다", () => {
    expect(parseOpsTask({ ...task, steps: [STEP, { ...STEP, placeId: OTHER_ID }] })).toBeNull()
    expect(parseOpsTask({ ...task, steps: [STEP, { ...STEP, facilitycd: OTHER_FACILITY }] })).toBeNull()
  })
})

describe("e하늘 응답 해석", () => {
  it("상세에서 필요한 필드만 꺼내고 개인 필드는 읽지 않는다", () => {
    const parsed = parseEhaneulDetail(detailJson(), FACILITY)
    expect(parsed).toEqual({ facilitycd: FACILITY, facilitygroupcd: "TBC0700001", fulladdress: EVIDENCE.fulladdress, telephone: EVIDENCE.telephone, mortuaycnt: 4 })
    expect(JSON.stringify(parsed)).not.toContain("someone")
  })

  it.each([
    ["실패 응답", { ...detailJson(), isSuccess: false }],
    ["다른 시설 번호", detailJson({ facilitycd: "1000000001" })],
    ["빈소 수 형식 오류", detailJson({ mortuaycnt: "많음" })],
    ["주소 없음", detailJson({ fulladdress: null })],
  ])("상세가 %s이면 근거 없음(fail-closed)", (_label, json) => {
    expect(parseEhaneulDetail(json, FACILITY)).toBeNull()
  })

  it("현행 목록 — 가격정보 수정일을 날짜로 읽는다(9자리 시설 번호 포함)", () => {
    expect(parseEhaneulList(listJson())?.get(FACILITY)).toEqual({ facilitycd: FACILITY, facilitygroupcd: "TBC0700001", companyname: EVIDENCE.companyname, listUpdatedDate: "2026-09-21" })
    expect(parseEhaneulList(listJson([listRow(), listRow({ facilitycd: "700002700" })]))?.has("700002700")).toBe(true)
  })

  it.each([
    ["전체 건수와 행 수가 다름(잘림)", { ...listJson(), cnt: 1083 }],
    ["실패 응답", { ...listJson(), isSuccess: false }],
    ["빈 목록", listJson([])],
    ["시설 번호 중복", listJson([listRow(), listRow()])],
    ["갱신일 형식 변경", listJson([listRow({ lastUpdateDate: "21-09-2026" })])],
    ["갱신일 없음", listJson([listRow({ lastUpdateDate: null })])],
  ])("목록이 %s이면 목록 없음(fail-closed)", (_label, json) => {
    expect(parseEhaneulList(json)).toBeNull()
  })

  it("경과 일수는 목록 조회 시각의 KST 날짜 기준이다", () => {
    expect(listAgeDays("2026-11-17", new Date("2026-11-16T15:30:00.000Z"))).toBe(0)
    expect(listAgeDays("2025-11-17", new Date("2026-11-17T03:00:00.000Z"))).toBe(365)
    expect(listAgeDays("2025-11-16", new Date("2026-11-17T03:00:00.000Z"))).toBe(366)
    expect(listAgeDays("2026-02-30", new Date("2026-11-17T03:00:00.000Z"))).toBeNull()
  })
})

describe("주소 분해·지역 대조", () => {
  it("시도·시군구·도로명·건물번호를 원문 위치 그대로 나눈다", () => {
    expect(parseRoadAddress(PLACE.address ?? "")).toMatchObject({ sido: "경기", sigungu: ["의정부시"], road: "평화로", number: "650", detail: "" })
    expect(parseRoadAddress("부산광역시 사하구 낙동대로 249번길 11")).toMatchObject({ sido: "부산", sigungu: ["사하구"], road: "낙동대로249번길", roadBase: "낙동대로", number: "11" })
    expect(roadKey("부산 사하구 낙동대로249번길 11 (괴정동)")).toBe("낙동대로249번길 11")
    expect(parseRoadAddress("경기 양주시 백석읍 평화로 650")).toMatchObject({ eupmyeon: "백석읍", road: "평화로" })
    expect(parseRoadAddress("세종특별자치시 한누리대로 2130")).toMatchObject({ sido: "세종", sigungu: [], road: "한누리대로" })
  })

  it("숫자가 든 도로명과 건물번호가 겹쳐도 꼬리를 원문 match 끝에서 자른다", () => {
    expect(parseRoadAddress("서울 중구 세종대로12길 12 12층")).toMatchObject({ road: "세종대로12길", number: "12", detail: "12층" })
    expect(parseRoadAddress("서울 중구 세종대로12길 12")).toMatchObject({ number: "12", detail: "" })
  })

  it.each([
    ["성남 분당구 vs 수정구", "경기 성남시 분당구 산성대로 100", "경기도 성남시 수정구 산성대로 100", false],
    ["구가 한쪽에만 있음", "경기 성남시 산성대로 100", "경기도 성남시 수정구 산성대로 100", false],
    ["포항 북구 vs 남구", "경북 포항시 북구 중앙로 100", "경상북도 포항시 남구 중앙로 100", false],
    ["창원 의창구 vs 성산구", "경남 창원시 의창구 원이대로 100", "경상남도 창원시 성산구 원이대로 100", false],
    ["다른 시", "경기 양주시 평화로 650", "경기도 의정부시 평화로 650", false],
    ["다른 읍면", "경기 양주시 백석읍 평화로 650", "경기도 양주시 광적면 평화로 650", false],
    ["같은 창원 성산구", "경남 창원시 성산구 원이대로 100", "경상남도 창원시 성산구 원이대로 100", true],
    ["약칭·정식 시도명", "강원 원주시 서원대로 100", "강원특별자치도 원주시 서원대로 100", true],
  ] as const)("%s → %s", (_label, left, right, same) => {
    expect(sameRegion(left, right)).toBe(same)
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
    ["하위 구 다름", { ...PLACE, address: "경기 성남시 분당구 산성대로 100" }, { ...EVIDENCE, fulladdress: "경기도 성남시 수정구 산성대로 100" }, "region-mismatch"],
    ["건물번호 다름", { ...PLACE, address: "경기 의정부시 평화로 652" }, EVIDENCE, "road-mismatch"],
    ["DB 상세 층", { ...PLACE, address: "경기 의정부시 평화로 650 지하1층 (지번) 의정부동 234-2" }, EVIDENCE, "address-detail"],
    ["DB 상세 101동", { ...PLACE, address: "경기 의정부시 평화로 650 101동" }, EVIDENCE, "address-detail"],
    ["DB 상세 신관", { ...PLACE, address: "경기 의정부시 평화로 650 신관" }, EVIDENCE, "address-detail"],
    ["DB 상세 B1", { ...PLACE, address: "경기 의정부시 평화로 650 B1" }, EVIDENCE, "address-detail"],
    ["DB 상세 2F", { ...PLACE, address: "경기 의정부시 평화로 650 2F" }, EVIDENCE, "address-detail"],
    ["DB 상세 건물명(보류)", { ...PLACE, address: "경기 의정부시 평화로 650 (의정부동, 추병원)" }, EVIDENCE, "address-detail"],
    ["주소만 같고 전화·이름 다름", { ...PLACE, name: "평화 장례식장", phone: "031-000-0000" }, EVIDENCE, "weak-match"],
    ["주소 없음", { ...PLACE, address: null }, EVIDENCE, "missing-address"],
  ] as const)("%s → %s", (_label, place, evidence, reason) => {
    expect(judgeRegistryMatch(place, evidence)).toEqual({ ok: false, reason })
  })

  it("법정동만 있는 괄호는 상세로 보지 않는다", () => {
    expect(judgeRegistryMatch({ ...PLACE, address: "경기 의정부시 평화로 650 (의정부동)" }, EVIDENCE)).toMatchObject({ ok: true })
  })

  it("공유 대표전화와 이름 포함만으로는(주소 다름) 통과하지 않는다", () => {
    expect(judgeRegistryMatch({ ...PLACE, address: "경기 의정부시 호국로 1000" }, EVIDENCE)).toEqual({ ok: false, reason: "road-mismatch" })
  })
})

// ── 서비스 (Supabase·fetch 대역) ──────────────────────────────
type Row = Record<string, unknown>
type Filter = { op: "eq" | "is" | "ilike" | "like"; column: string; value: unknown }
const tables: Record<string, Row[]> = {}
let insertError: { code: string; message: string } | null = null
let updateError: string | null = null
let beforeUpdate: ((table: string) => void) | null = null
const writes: { table: string; kind: string; patch: Row }[] = []

function columnValue(row: Row, column: string): unknown {
  const path = /^(\w+)->>(\w+)$/.exec(column)
  if (path === null) return row[column]
  const parent = row[path[1] ?? ""]
  const value = typeof parent === "object" && parent !== null ? (parent as Row)[path[2] ?? ""] : undefined
  return value === undefined || value === null ? null : typeof value === "string" ? value : JSON.stringify(value)
}
function likeRegex(pattern: string, flags: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, flags)
}
function matches(row: Row, filter: Filter): boolean {
  const value = columnValue(row, filter.column)
  if (filter.op === "ilike" || filter.op === "like") return typeof value === "string" && likeRegex(String(filter.value), filter.op === "ilike" ? "i" : "").test(value)
  return filter.op === "is" ? value === filter.value || (filter.value === null && value === undefined) : value === filter.value
}

function builder(table: string) {
  const filters: Filter[] = []
  let patch: Row | null = null
  let head = false
  const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => matches(row, f)))
  const run = () => {
    if (patch !== null) {
      if (updateError === table) return { data: null, error: { message: "update failed" } }
      beforeUpdate?.(table)
      const targets = rows()
      for (const row of targets) Object.assign(row, structuredClone(patch))
      writes.push({ table, kind: "update", patch })
      return { data: targets.map((row) => ({ ...row })), error: null }
    }
    return head ? { data: null, error: null, count: rows().length } : { data: rows().map((row) => structuredClone(row)), error: null }
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
    ilike: (column: string, value: unknown) => {
      filters.push({ op: "ilike", column, value })
      return api
    },
    like: (column: string, value: unknown) => {
      filters.push({ op: "like", column, value })
      return api
    },
    update: (next: Row) => {
      patch = next
      return api
    },
    insert: (row: Row) => {
      if (insertError !== null) return Promise.resolve({ error: insertError })
      if ((tables[table] ?? []).some((existing) => existing["key"] === row["key"])) return Promise.resolve({ error: { code: "23505", message: "duplicate" } })
      ;(tables[table] ??= []).push(structuredClone(row))
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

let detailBody: unknown = detailJson()
let listBody: unknown = listJson()
let fetchStatus = 200
let listStatus = 200
const fetchCalls: string[] = []
const fetchImpl = ((url: string) => {
  fetchCalls.push(url)
  const isList = url === EHANEUL_LIST_URL
  const status = isList ? listStatus : fetchStatus
  if (status === 0) return Promise.reject(new Error("network"))
  return Promise.resolve({ ok: status === 200, json: () => Promise.resolve(isList ? listBody : detailBody) })
}) as unknown as typeof fetch
let clock = new Date("2026-11-17T03:00:00.000Z")
const deps = { fetchImpl, now: () => clock }

beforeEach(() => {
  for (const key of Object.keys(tables)) Reflect.deleteProperty(tables, key)
  tables["places"] = [{ ...PLACE, verified_by: null, verified_at: null, verification_source_urls: null }]
  tables["ai_generations"] = []
  tables["batch_run_items"] = []
  tables["seo_pages"] = []
  tables["settings"] = []
  insertError = null
  updateError = null
  beforeUpdate = null
  writes.length = 0
  fetchCalls.length = 0
  detailBody = detailJson()
  listBody = listJson()
  fetchStatus = 200
  listStatus = 200
  clock = new Date("2026-11-17T03:00:00.000Z")
})

async function run(step: Record<string, unknown> = STEP) {
  const { runRegistryVerify } = await import("@/lib/batch/registry-verify-service")
  const parsed = parseRegistryVerifyStep(step)
  if (parsed === null) throw new Error("step")
  return runRegistryVerify(parsed, "ops:registry-pilot", deps)
}
const place = (): Row => tables["places"]?.[0] ?? {}
const audit = (placeId = PLACE_ID): Row | undefined => tables["settings"]?.find((row) => row["key"] === registryAuditKey(placeId))?.["value"] as Row | undefined
const placeWrites = () => writes.filter((write) => write.table === "places")

describe("공공등록 확인 서비스 — 기본 경로", () => {
  it("현행 목록과 상세를 정해진 주소에서 읽어 확인 상태·출처만 쓰고, 감사 의도 → 확정을 남긴다", async () => {
    expect(await run()).toEqual({ kind: "verified", matched: ["address", "phone", "name"], sourceUrl: ehaneulDetailUrl(FACILITY), resumed: false })
    expect(fetchCalls).toEqual([EHANEUL_LIST_URL, ehaneulDetailUrl(FACILITY)])
    expect(place()).toMatchObject({ official_verification_status: "verified", verified_by: REGISTRY_VERIFIED_BY, verified_at: clock.toISOString(), verification_source_urls: [ehaneulDetailUrl(FACILITY)] })
    expect(place()).toMatchObject({ name: PLACE.name, address: PLACE.address, phone: PLACE.phone })
    // 의도를 먼저 쓰고(insert) → 장소 → 확정(update)
    expect(writes.map((write) => `${write.table}:${write.kind}`)).toEqual(["settings:insert", "places:update", "settings:update"])
    expect(audit()).toMatchObject({
      state: "done",
      policy_version: "ehaneul-funeral-v2",
      tier: "public-registry",
      not_confirmed: ["current-operation", "wreath-policy"],
      list_date_meaning: "price-info-updated",
      place_id: PLACE_ID,
      facilitycd: FACILITY,
      evidence: EVIDENCE,
      matched: ["address", "phone", "name"],
      list_checked_at: clock.toISOString(),
      list_age_days: 57,
      after: { verified_at: clock.toISOString() },
    })
    expect(audit()?.["before"]).toMatchObject({ official_verification_status: null })
  })

  it("작업이 넘긴 목록을 쓰면 step에서 목록을 다시 받지 않는다", async () => {
    const { runRegistryVerify, loadEhaneulList } = await import("@/lib/batch/registry-verify-service")
    const shared = await loadEhaneulList(deps)
    fetchCalls.length = 0
    const parsed = parseRegistryVerifyStep(STEP)
    if (parsed === null) throw new Error("step")
    expect(await runRegistryVerify(parsed, "ops:registry-pilot", { ...deps, loadList: () => Promise.resolve(shared) })).toMatchObject({ kind: "verified" })
    expect(fetchCalls).toEqual([ehaneulDetailUrl(FACILITY)])
  })

  it("그 사이 장소가 바뀌었으면 근거를 읽지도 쓰지도 않는다", async () => {
    place()["phone"] = "031-999-9999"
    expect(await run()).toEqual({ kind: "blocked", reason: "place-changed" })
    expect(fetchCalls).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })

  it.each([
    ["빈소 수", () => {
      detailBody = detailJson({ mortuaycnt: 5 })
    }],
    ["목록 이름", () => {
      listBody = listJson([listRow({ companyname: "추병원장례식장(신)" })])
    }],
    ["가격정보 수정일", () => {
      listBody = listJson([listRow({ lastUpdateDate: "2026/10/01" })])
    }],
    ["목록·상세 그룹 불일치", () => {
      listBody = listJson([listRow({ facilitygroupcd: "TBC0700002" })])
    }],
  ])("다시 읽은 근거(%s)가 승인한 근거와 다르면 쓰지 않는다", async (_label, mutate) => {
    mutate()
    expect(await run()).toEqual({ kind: "blocked", reason: "evidence-changed" })
    expect(writes).toHaveLength(0)
  })

  it("현행 목록에 없으면 이 작업만 보류한다(폐업 단정 없음, 쓰기 없음)", async () => {
    listBody = listJson([listRow({ facilitycd: OTHER_FACILITY })])
    expect(await run()).toEqual({ kind: "blocked", reason: "not-in-current-list" })
    expect(writes).toHaveLength(0)
    expect(place()["official_verification_status"]).toBeNull()
  })

  it("가격정보 수정일이 목록 조회일 기준 365일을 넘으면 보류한다", async () => {
    const stale = { ...EVIDENCE, listUpdatedDate: "2025-11-16" }
    listBody = listJson([listRow({ lastUpdateDate: "2025/11/16" })])
    expect(await run({ ...STEP, expectedEvidenceHash: evidenceFingerprint(stale) })).toEqual({ kind: "blocked", reason: "registry-stale" })
    expect(writes).toHaveLength(0)
  })

  it.each([
    ["목록 네트워크 오류", () => {
      listStatus = 0
    }, "list"],
    ["목록 형식 변경(잘림)", () => {
      listBody = { ...listJson(), cnt: 9999 }
    }, "parse"],
    ["상세 네트워크 오류", () => {
      fetchStatus = 0
    }, "fetch"],
    ["상세 HTTP 오류", () => {
      fetchStatus = 500
    }, "fetch"],
    ["상세 형식 변경", () => {
      detailBody = { isSuccess: true, rows: [] }
    }, "parse"],
  ] as const)("%s이면 실패로 남기고 쓰지 않는다", async (_label, mutate, step) => {
    mutate()
    expect(await run()).toEqual({ kind: "failed", step })
    expect(writes).toHaveLength(0)
  })

  it("생성·배치·SEO 이력이 있으면 쓰지 않는다", async () => {
    tables["ai_generations"] = [{ id: "g1", place_id: PLACE_ID }]
    expect(await run()).toEqual({ kind: "blocked", reason: "has-pipeline-state" })
    expect(writes).toHaveLength(0)
  })

  it("갱신 조건이 맞지 않아 0행이면 성공으로 세지 않는다 — 다음 실행은 처음부터 다시 본다", async () => {
    beforeUpdate = (table) => {
      if (table === "places") place()["name"] = "추병원 장례식장 (변경)"
    }
    expect(await run()).toEqual({ kind: "blocked", reason: "write-conflict" })
    expect(place()["official_verification_status"]).toBeNull()
    expect(audit()?.["state"]).toBe("pending")
    beforeUpdate = null
    // 바뀐 이름으로는 지문이 달라 다시 실행해도 쓰지 않는다.
    expect(await run()).toEqual({ kind: "blocked", reason: "place-changed" })
  })

  it("갱신 오류는 실패로 보고하고, 같은 원본이면 다시 실행해 끝낸다", async () => {
    updateError = "places"
    expect(await run()).toEqual({ kind: "failed", step: "write" })
    expect(audit()?.["state"]).toBe("pending")
    updateError = null
    expect(await run()).toMatchObject({ kind: "verified", resumed: true })
    expect(audit()?.["state"]).toBe("done")
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

describe("공공등록 확인 서비스 — 같은 시설의 다른 행", () => {
  const twin = (patch: Row) => tables["places"]?.push({ id: OTHER_ID, name: "추병원장례식장", status: "draft", category: "funeral", official_verification_status: null, exclusion_reason: null, address: "경기 의정부시 평화로 650", ...patch })

  it.each([
    ["게시됨", { status: "published" }, "published-duplicate"],
    ["이미 확인된 draft", { official_verification_status: "verified" }, "verified-duplicate"],
    ["아직 후보인 본체 행", {}, "candidate-duplicate"],
  ] as const)("같은 시설 행이 %s이면 멈춘다", async (_label, patch, reason) => {
    twin(patch)
    expect(await run()).toEqual({ kind: "blocked", reason })
    expect(placeWrites()).toHaveLength(0)
    expect(place()["official_verification_status"]).toBeNull()
  })

  it("제외됐거나 부속 시설 이름인 같은 주소 행은 중복으로 보지 않는다", async () => {
    twin({ exclusion_reason: "중복" })
    tables["places"]?.push({ id: "33333333-3333-4333-8333-333333333333", name: "추병원 장례식장 주차장", status: "draft", category: "funeral", official_verification_status: null, exclusion_reason: null, address: "경기 의정부시 평화로 650" })
    expect(await run()).toMatchObject({ kind: "verified" })
  })

  it("다른 지역의 같은 도로명·번호는 같은 시설이 아니다", async () => {
    twin({ address: "경기 양주시 평화로 650" })
    expect(await run()).toMatchObject({ kind: "verified" })
  })

  it("다른 장소가 같은 시설 번호로 감사(의도 포함)를 남겼으면 멈춘다", async () => {
    tables["settings"]?.push({ key: registryAuditKey(OTHER_ID), value: { state: "pending", facilitycd: FACILITY } })
    expect(await run()).toEqual({ kind: "blocked", reason: "facility-claimed" })
    expect(placeWrites()).toHaveLength(0)
  })

  it("같은 시설의 두 행을 차례로 실행하면 두 번째는 확인되지 않는다", async () => {
    // 원본 재수집으로 같은 시설 행이 확인 뒤에 추가된 경우
    expect(await run()).toMatchObject({ kind: "verified" })
    const second: RegistryPlace = { ...PLACE, id: OTHER_ID, name: "추병원장례식장" }
    tables["places"]?.push({ ...second, verified_by: null, verified_at: null, verification_source_urls: null })
    const result = await run({ ...STEP, placeId: OTHER_ID, expectedPlaceHash: placeFingerprint(second) })
    expect(result).toEqual({ kind: "blocked", reason: "verified-duplicate" })
    expect(tables["places"]?.find((row) => row["id"] === OTHER_ID)?.["official_verification_status"]).toBeNull()
  })
})

describe("공공등록 확인 서비스 — 다시 실행(재개)", () => {
  async function verifiedWithoutFinalize(): Promise<string> {
    updateError = "settings"
    expect(await run()).toEqual({ kind: "failed", step: "audit" })
    updateError = null
    expect(place()["official_verification_status"]).toBe("verified")
    expect(audit()?.["state"]).toBe("pending")
    return String(place()["verified_at"])
  }

  it("확정에서 멈춘 뒤 다시 실행하면 장소에 기록된 실제 확인 시각으로 확정한다(재시도 시각 아님)", async () => {
    const firstAt = await verifiedWithoutFinalize()
    clock = new Date("2026-11-17T05:00:00.000Z")
    fetchCalls.length = 0
    expect(await run()).toMatchObject({ kind: "verified", resumed: true, matched: ["address", "phone", "name"] })
    expect(audit()).toMatchObject({ state: "done", after: { verified_at: firstAt }, resumed_finalize: true })
    expect(fetchCalls).toHaveLength(0)
    // 이미 확정 — 다시 실행해도 쓰지 않는다.
    const count = writes.length
    expect(await run()).toMatchObject({ kind: "verified", resumed: true })
    expect(writes).toHaveLength(count)
  })

  it.each([
    ["주소", { address: "경기 양주시 평화로 999" }, "place-changed"],
    ["이름", { name: "다른 장례식장" }, "place-changed"],
    ["전화", { phone: "031-000-0000" }, "place-changed"],
    ["업종", { category: "hotel" }, "not-funeral"],
    ["수동 제외", { exclusion_reason: "운영 확인 필요" }, "excluded"],
  ] as const)("확정 전 멈춘 뒤 %s이 바뀌면 성공으로 바꾸지 않는다", async (_label, patch, reason) => {
    await verifiedWithoutFinalize()
    Object.assign(place(), patch)
    expect(await run()).toEqual({ kind: "blocked", reason })
    expect(audit()?.["state"]).toBe("pending")
  })

  it.each([
    ["주소", { address: "경기 양주시 평화로 999" }, "place-changed"],
    ["업종", { category: "hotel" }, "not-funeral"],
    ["수동 제외", { exclusion_reason: "운영 확인 필요" }, "excluded"],
  ] as const)("확정 뒤에도 %s이 바뀌었으면 다시 실행을 성공으로 세지 않는다", async (_label, patch, reason) => {
    expect(await run()).toMatchObject({ kind: "verified" })
    Object.assign(place(), patch)
    fetchCalls.length = 0
    expect(await run()).toEqual({ kind: "blocked", reason })
    expect(fetchCalls).toHaveLength(0)
  })

  it("확정된 감사의 확인 시각과 장소의 확인 시각이 다르면 성공으로 세지 않는다", async () => {
    expect(await run()).toMatchObject({ kind: "verified" })
    place()["verified_at"] = "2026-12-01T00:00:00.000Z"
    expect(await run()).toEqual({ kind: "blocked", reason: "audit-mismatch" })
  })

  it.each([
    ["다른 시설 번호", { facilitycd: OTHER_FACILITY }],
    ["다른 근거 지문", { evidence_hash: "f".repeat(64) }],
    ["다른 장소 지문", { place_hash: "e".repeat(64) }],
    ["옛 정책 버전", { policy_version: "ehaneul-funeral-v1" }],
    ["상태 없음", { state: undefined }],
  ] as const)("이미 있는 감사가 이 step과 다른 원본(%s)이면 쓰지 않는다", async (_label, patch) => {
    expect(await run()).toMatchObject({ kind: "verified" })
    const stored = audit() ?? {}
    Object.assign(stored, patch)
    const count = writes.length
    expect(await run()).toEqual({ kind: "blocked", reason: "audit-mismatch" })
    expect(writes).toHaveLength(count)
  })

  it("요청한 지문이 바뀐 step으로 다시 실행하면 기존 감사와 맞지 않아 멈춘다", async () => {
    expect(await run()).toMatchObject({ kind: "verified" })
    const changed = { ...EVIDENCE, mortuaycnt: 5 }
    expect(await run({ ...STEP, expectedEvidenceHash: evidenceFingerprint(changed) })).toEqual({ kind: "blocked", reason: "audit-mismatch" })
  })

  it("이 경로의 확인 상태가 있는데 감사가 없으면 원본을 증명할 수 없어 복구하지 않는다", async () => {
    Object.assign(place(), { official_verification_status: "verified", verified_by: REGISTRY_VERIFIED_BY, verified_at: clock.toISOString(), verification_source_urls: [ehaneulDetailUrl(FACILITY)] })
    expect(await run()).toEqual({ kind: "blocked", reason: "audit-missing" })
    expect(writes).toHaveLength(0)
  })

  it("확정된 감사가 있는데 장소가 확인 전으로 되돌려졌으면 다시 쓰지 않는다", async () => {
    expect(await run()).toMatchObject({ kind: "verified" })
    Object.assign(place(), { official_verification_status: null, verified_by: null, verified_at: null, verification_source_urls: null })
    expect(await run()).toEqual({ kind: "blocked", reason: "audit-mismatch" })
  })

  it("의도 저장이 23505(동시에 같은 키)로 실패하면 충돌 행을 확인하지 않고 진행하지 않는다", async () => {
    insertError = { code: "23505", message: "duplicate" }
    expect(await run()).toEqual({ kind: "failed", step: "audit" })
    expect(placeWrites()).toHaveLength(0)
  })

  it("의도 저장이 실패하면 장소를 쓰지 않는다", async () => {
    insertError = { code: "XX000", message: "insert failed" }
    expect(await run()).toEqual({ kind: "failed", step: "audit" })
    expect(placeWrites()).toHaveLength(0)
    expect(place()["official_verification_status"]).toBeNull()
  })

  it("의도만 남기고 멈춘 뒤 다시 실행할 때 일치 판정이 실패하면 막는다(빈 일치로 성공시키지 않음)", async () => {
    updateError = "places"
    expect(await run()).toEqual({ kind: "failed", step: "write" })
    updateError = null
    // 상세의 주소가 바뀌면 근거 지문이 달라져 먼저 막힌다 — 일치 판정 실패를 성공으로 바꾸는 경로가 없다.
    detailBody = detailJson({ fulladdress: "경기도 의정부시 평화로 652" })
    expect(await run()).toEqual({ kind: "blocked", reason: "evidence-changed" })
    expect(place()["official_verification_status"]).toBeNull()
  })
})
