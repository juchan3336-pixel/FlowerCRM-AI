// 행번호 재매핑 계획·판정 회귀 방어.
// 관리자 Dry-run과 적용 도구가 같은 계획을 쓰므로, 여기서 틀리면 엉뚱한 행 번호를 쓰게 된다.
// Google Sheets·Supabase는 전부 입력 배열로 대체한다 (실제 호출 0건).
import { describe, expect, it } from "vitest"

import { createSourceKey } from "@/lib/domain/normalize"
import {
  buildRemapReport,
  evaluateRemapReport,
  EXPECTED_SHIFTS,
  REMAP_FAILURE_MESSAGES,
  type RemapPlaceRow,
  type RemapSheetRow,
  type RemapVerdictKind,
} from "@/lib/sync/row-remap-core"

// 2026-07-29 실제 삭제된 공백행. 이 행들은 원래부터 Supabase에 없었다.
const DELETED_ROWS = [131, 132, 307, 308, 320, 321]
const shiftOf = (row: number): number => DELETED_ROWS.filter((deleted) => deleted < row).length

function company(index: number): Readonly<{ name: string; phone: string; address: string }> {
  return { name: `장소${String(index)}`, phone: `053-0000-${String(index).padStart(4, "0")}`, address: `주소 ${String(index)}` }
}

// 삭제 전 행 번호(2..lastOldRow, 공백행 제외)를 가진 places와, 삭제 후로 당겨진 시트를 만든다.
function scenario(lastOldRow: number, pendingCount = 0): { sheetRows: RemapSheetRow[]; places: RemapPlaceRow[]; lastMatchedRow: number } {
  const oldRows = []
  for (let row = 2; row <= lastOldRow; row += 1) {
    if (!DELETED_ROWS.includes(row)) {
      oldRows.push(row)
    }
  }
  const places = oldRows.map((row) => ({
    id: `place-${String(row)}`,
    source_key: createSourceKey(company(row)),
    source_row_number: row,
    name: company(row).name,
    status: "draft",
  }))
  const sheetRows: RemapSheetRow[] = oldRows.map((row) => ({ rowNumber: row - shiftOf(row), ...company(row) }))
  // 아직 동기화되지 않은 신규 행 — 기존 매핑이 끝난 다음 행부터 연속으로 붙인다.
  const lastMatchedRow = sheetRows.at(-1)?.rowNumber ?? 1
  for (let index = 0; index < pendingCount; index += 1) {
    sheetRows.push({ rowNumber: lastMatchedRow + 1 + index, ...company(100_000 + index) })
  }
  return { sheetRows, places, lastMatchedRow }
}

describe("재매핑 계획", () => {
  it("삭제 경계별 이동량을 정확히 계산한다", () => {
    const { sheetRows, places } = scenario(400)
    const { summary } = buildRemapReport({ sheetRows, places })

    // old 2~130은 이동 0, 133~306은 -2, 309~319는 -4, 322~400은 -6.
    expect(summary.shiftHistogram["0"]).toBe(129)
    expect(summary.shiftHistogram["-2"]).toBe(174)
    expect(summary.shiftHistogram["-4"]).toBe(11)
    expect(summary.shiftHistogram["-6"]).toBe(400 - 322 + 1)
  })

  it("재매핑 후 행 번호가 연속이고 중복이 없다", () => {
    const { sheetRows, places } = scenario(400)
    const { summary } = buildRemapReport({ sheetRows, places })
    expect(summary.expectedContinuity).toBe(true)
    expect(summary.duplicateTargetRows).toBe(0)
    expect(summary.minAfter).toBe(2)
    expect(summary.maxAfter).toBe(400 - 6)
  })

  it("이미 맞는 행은 unchanged로 분류하고 갱신 대상에서 뺀다", () => {
    const { sheetRows, places } = scenario(400)
    const { summary, updates } = buildRemapReport({ sheetRows, places })
    expect(summary.unchanged).toBe(129)
    expect(summary.updateCount).toBe(places.length - 129)
    expect(updates.every((update) => update.from_row !== update.to_row)).toBe(true)
  })

  it("계획에는 place_id와 행 번호만 담고 회사명·source_key는 담지 않는다", () => {
    const { sheetRows, places } = scenario(400)
    const { updates } = buildRemapReport({ sheetRows, places })
    for (const update of updates.slice(0, 5)) {
      expect(Object.keys(update).sort()).toEqual(["from_row", "place_id", "to_row"])
    }
  })

  it("published 장소가 갱신 대상에 몇 건인지 센다", () => {
    const { sheetRows, places } = scenario(400)
    const withPublished = places.map((place, index) => (index < 3 ? { ...place, status: "published" } : place))
    const { summary } = buildRemapReport({ sheetRows, places: withPublished })
    // 앞 3건은 old 2·3·4라 이동 0 → 갱신 대상이 아니다.
    expect(summary.publishedInUpdates).toBe(0)
    const lastPublished = places.map((place, index) => (index >= places.length - 3 ? { ...place, status: "published" } : place))
    expect(buildRemapReport({ sheetRows, places: lastPublished }).summary.publishedInUpdates).toBe(3)
  })

  it("문제 행은 회사명 없이 행 번호만 남긴다", () => {
    const { sheetRows, places } = scenario(400)
    const report = buildRemapReport({ sheetRows: sheetRows.slice(0, -1), places })
    expect(report.unmatchedInDbRows.every((row) => typeof row === "number")).toBe(true)
    expect(JSON.stringify(report.unmatchedInDbRows)).not.toMatch(/장소|주소|053-/)
  })
})

describe("판정", () => {
  const passSummary = {
    sheetRows: 14_951,
    sheetLastRow: 14_952,
    dbRows: 14_951,
    maxSourceRowNumber: 14_958,
    matched: 14_951,
    unchanged: 129,
    updateCount: 14_822,
    unmatchedInSheet: 0,
    unmatchedInDb: 0,
    ambiguous: 0,
    duplicateSourceKeys: 0,
    duplicateTargetRows: 0,
    shiftHistogram: EXPECTED_SHIFTS,
    expectedShifts: EXPECTED_SHIFTS,
    shiftMatchesExpectation: true,
    minBefore: 2,
    maxBefore: 14_958,
    minAfter: 2,
    maxAfter: 14_952,
    expectedContinuity: true,
    publishedInUpdates: 29,
    pending: { rows: 0, startRow: null, endRow: null, afterMatchedRange: true, contiguous: true },
  } as const

  it("기준선을 모두 만족하면 PASS다", () => {
    expect(evaluateRemapReport(passSummary)).toEqual({ verdict: "PASS", failures: [] })
  })

  it("Supabase에만 있는 행이 있으면 FAIL이다", () => {
    expect(evaluateRemapReport({ ...passSummary, unmatchedInDb: 1, matched: passSummary.matched - 1 }).failures).toContain("unmatched-in-db")
  })

  it("시트에만 있는 행이 기존 구간 중간에 끼면 FAIL이다", () => {
    const middle = { ...passSummary, unmatchedInSheet: 3, pending: { rows: 3, startRow: 500, endRow: 502, afterMatchedRange: false, contiguous: true } }
    expect(evaluateRemapReport(middle).verdict).toBe("FAIL")
    expect(evaluateRemapReport(middle).failures).toContain("unmatched-in-sheet")
  })

  it("신규 구간이 끊겨 있으면 FAIL이다", () => {
    const broken = { ...passSummary, unmatchedInSheet: 3, pending: { rows: 3, startRow: 14_953, endRow: 20_549, afterMatchedRange: true, contiguous: false } }
    expect(evaluateRemapReport(broken).verdict).toBe("FAIL")
    expect(evaluateRemapReport(broken).failures).toContain("unmatched-in-sheet")
  })

  it("ambiguous·중복이 있으면 FAIL이다", () => {
    expect(evaluateRemapReport({ ...passSummary, ambiguous: 2 }).failures).toContain("ambiguous-match")
    expect(evaluateRemapReport({ ...passSummary, duplicateSourceKeys: 1 }).failures).toContain("duplicate-source-key")
    expect(evaluateRemapReport({ ...passSummary, duplicateTargetRows: 1 }).failures).toContain("duplicate-target-row")
  })

  it("histogram이 예상과 다르면 FAIL이다", () => {
    expect(evaluateRemapReport({ ...passSummary, shiftMatchesExpectation: false }).failures).toContain("shift-histogram-mismatch")
  })

  it("연속성이 깨지면 FAIL이다", () => {
    expect(evaluateRemapReport({ ...passSummary, expectedContinuity: false }).failures).toContain("continuity-failed")
  })

  it("matched 수가 기준선과 다르면 FAIL이다", () => {
    expect(evaluateRemapReport({ ...passSummary, matched: 14_900 }).failures).toContain("matched-count-mismatch")
  })

  it("실패 사유는 전부 안전한 한글 안내가 있고 원문·키를 담지 않는다", () => {
    for (const [code, message] of Object.entries(REMAP_FAILURE_MESSAGES)) {
      expect(message.length, code).toBeGreaterThan(0)
      expect(message).not.toMatch(/token|secret|Bearer|service_role|GOOGLE_|private key|at\s+\w+\s+\(/i)
    }
  })

  it("실측 시트가 짧아 매칭이 모자라면 FAIL로 잡힌다", () => {
    // 시트 마지막 행 하나가 사라진 상황.
    const { sheetRows, places } = scenario(400)
    const report = buildRemapReport({ sheetRows: sheetRows.slice(0, -1), places })
    const verdict = evaluateRemapReport(report.summary, { expectedMatched: places.length })
    expect(verdict.verdict).toBe("FAIL")
    expect(verdict.failures).toContain("unmatched-in-db")
  })
})

describe("source_key 매칭", () => {
  it("행 번호가 아니라 source_key로 대응시킨다", () => {
    // 시트 순서를 뒤집어도 같은 결과가 나와야 한다.
    const { sheetRows, places } = scenario(200)
    const straight = buildRemapReport({ sheetRows, places })
    const reversed = buildRemapReport({ sheetRows: [...sheetRows].reverse(), places })
    expect(reversed.summary.updateCount).toBe(straight.summary.updateCount)
    expect(reversed.summary.shiftHistogram).toEqual(straight.summary.shiftHistogram)
  })

  it("양쪽 어디든 source_key가 겹치면 그 행은 ambiguous로 빼고 갱신하지 않는다", () => {
    const { sheetRows, places } = scenario(200)
    const first = places[0]
    if (first === undefined) {
      throw new Error("expected at least one place")
    }
    const duplicated = [...places, { ...first, id: "place-dup" }]
    const report = buildRemapReport({ sheetRows, places: duplicated })
    expect(report.summary.ambiguous).toBe(2)
    expect(report.summary.duplicateSourceKeys).toBe(1)
    expect(report.updates.some((update) => update.place_id === "place-dup")).toBe(false)
  })

  it("회사명이 빈 시트 행은 데이터 행으로 세지 않는다", () => {
    const { sheetRows, places } = scenario(50)
    const withBlank = [...sheetRows, { rowNumber: 999, name: "  ", address: "", phone: "" }]
    expect(buildRemapReport({ sheetRows: withBlank, places }).summary.sheetRows).toBe(sheetRows.length)
  })
})

// 2026-07-29 Production 실측: 시트 20,548행 / Supabase 14,951행 / 신규 미동기화 5,597건.
// 기존 데이터의 정합성은 정상이고 신규분만 뒤에 쌓인 상태 — 이걸 FAIL로 묶으면 복구가 영원히 막힌다.
describe("신규 미동기화 데이터와 실제 불일치 분리", () => {
  it("실측값이 PASS_WITH_PENDING_SYNC로 판정된다", () => {
    const { sheetRows, places } = scenario(14_958, 5_597)
    const { summary } = buildRemapReport({ sheetRows, places })

    expect(summary.sheetRows).toBe(20_548)
    expect(summary.sheetLastRow).toBe(20_549)
    expect(summary.dbRows).toBe(14_951)
    expect(summary.maxSourceRowNumber).toBe(14_958)
    expect(summary.matched).toBe(14_951)
    expect(summary.updateCount).toBe(14_822)
    expect(summary.pending.rows).toBe(5_597)
    expect(summary.pending.startRow).toBe(14_953)
    expect(summary.pending.endRow).toBe(20_549)

    expect(evaluateRemapReport(summary)).toEqual({ verdict: "PASS_WITH_PENDING_SYNC", failures: [] })
  })

  it("복구 계획에는 기존 매칭 행만 담기고 신규 5,597건은 들어가지 않는다", () => {
    const { sheetRows, places, lastMatchedRow } = scenario(14_958, 5_597)
    const { updates, summary } = buildRemapReport({ sheetRows, places })

    expect(updates).toHaveLength(14_822)
    expect(summary.updateCount).toBe(14_822)
    // 갱신 목표 행이 전부 기존 매핑 구간 안에 있다 — 신규 구간(14,953~)을 건드리지 않는다.
    expect(updates.every((update) => update.to_row <= lastMatchedRow)).toBe(true)
    expect(updates.some((update) => update.to_row >= 14_953)).toBe(false)
    // place_id는 전부 기존 DB 행이다.
    const placeIds = new Set(places.map((place) => place.id))
    expect(updates.every((update) => placeIds.has(update.place_id))).toBe(true)
  })

  it("신규 데이터가 없으면 그대로 PASS다", () => {
    const { sheetRows, places } = scenario(14_958, 0)
    const { summary } = buildRemapReport({ sheetRows, places })
    expect(summary.pending.rows).toBe(0)
    expect(evaluateRemapReport(summary)).toEqual({ verdict: "PASS", failures: [] })
  })

  it("신규 구간이 기존 매핑 중간에 끼면 FAIL이다", () => {
    const { sheetRows, places } = scenario(400, 0)
    // 기존 매핑 구간 한복판에 시트에만 있는 행을 끼워 넣는다.
    const intruded = [...sheetRows, { rowNumber: 200, name: "끼어든회사", phone: "053-9999-0001", address: "주소 X" }]
    const { summary } = buildRemapReport({ sheetRows: intruded, places })
    expect(summary.pending.afterMatchedRange).toBe(false)
    expect(evaluateRemapReport(summary).verdict).toBe("FAIL")
    expect(evaluateRemapReport(summary).failures).toContain("unmatched-in-sheet")
  })

  it("신규 구간이 끊겨 있으면 FAIL이다", () => {
    const { sheetRows, places, lastMatchedRow } = scenario(400, 3)
    // 신규 구간 뒤쪽에 한 칸 띄우고 행을 하나 더 붙인다.
    const broken = [...sheetRows, { rowNumber: lastMatchedRow + 10, name: "끊긴회사", phone: "053-9999-0002", address: "주소 Y" }]
    const { summary } = buildRemapReport({ sheetRows: broken, places })
    expect(summary.pending.afterMatchedRange).toBe(true)
    expect(summary.pending.contiguous).toBe(false)
    expect(evaluateRemapReport(summary).verdict).toBe("FAIL")
    expect(evaluateRemapReport(summary).failures).toContain("unmatched-in-sheet")
  })

  it("신규 데이터가 있어도 실제 오류가 섞이면 FAIL이다", () => {
    const { sheetRows, places } = scenario(14_958, 5_597)
    // Supabase에만 있는 행을 만든다 (시트에서 대응 행 제거).
    const missing = sheetRows.filter((row) => row.rowNumber !== 5_000)
    const { summary } = buildRemapReport({ sheetRows: missing, places })
    const verdict = evaluateRemapReport(summary)
    expect(verdict.verdict).toBe("FAIL")
    expect(verdict.failures).toContain("unmatched-in-db")
  })
})

// 복구보다 동기화를 먼저 하면 커서가 신규 구간 시작을 앞질러 그 사이 행이 유실된다.
// 시트가 기록된 최대 행보다 커진 뒤로는 행번호 축소 감지가 걸리지 않으므로 화면 경고가 유일한 방어다.
describe("복구 순서 위험 수치", () => {
  it("복구 전 동기화 시 건너뛰는 행 수를 계산할 수 있다", () => {
    const { sheetRows, places } = scenario(14_958, 5_597)
    const { summary } = buildRemapReport({ sheetRows, places })

    // 동기화 시작점은 기록된 최대 행 + 1 = 14,959. 신규 구간은 14,953부터다.
    const cursorIfSyncedNow = (summary.maxSourceRowNumber ?? 0) + 1
    const skipped = cursorIfSyncedNow - (summary.pending.startRow ?? 0)
    expect(cursorIfSyncedNow).toBe(14_959)
    expect(summary.pending.startRow).toBe(14_953)
    expect(skipped).toBe(6)
  })

  it("복구 후에는 커서와 신규 구간 시작이 맞아 건너뛰는 행이 없다", () => {
    const { sheetRows, places } = scenario(14_958, 5_597)
    const { summary, updates } = buildRemapReport({ sheetRows, places })

    // 복구를 적용하면 최대 행이 기존 매핑의 끝(14,952)이 된다.
    const maxAfterRepair = Math.max(...places.map((place) => updates.find((update) => update.place_id === place.id)?.to_row ?? place.source_row_number))
    expect(maxAfterRepair).toBe(14_952)
    expect(maxAfterRepair + 1).toBe(summary.pending.startRow)
  })
})

// 적용 도구(work/remap_source_row_numbers.mjs)는 관리자 화면 판정을 그대로 신뢰한다.
// 판정 종류가 늘었는데 도구를 함께 고치지 않으면 정상 계획이 거부된다 (2026-07-29 실제 발생).
describe("적용 도구가 받아들이는 판정", () => {
  it("PASS와 PASS_WITH_PENDING_SYNC를 모두 허용한다", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(new URL("../../work/remap_source_row_numbers.mjs", import.meta.url), "utf8")
    const accepted = /const ACCEPTED_VERDICTS = \[([^\]]*)\]/.exec(source)?.[1] ?? ""
    expect(accepted).toContain('"PASS"')
    expect(accepted).toContain('"PASS_WITH_PENDING_SYNC"')
    // FAIL은 절대 통과시키지 않는다.
    expect(accepted).not.toContain('"FAIL"')
    expect(source).toContain("if (!ACCEPTED_VERDICTS.includes(plan.verdict))")
  })

  it("허용 목록이 코드의 판정 종류를 모두 덮지는 않는다 (FAIL 제외)", () => {
    const kinds: RemapVerdictKind[] = ["PASS", "PASS_WITH_PENDING_SYNC", "FAIL"]
    expect(kinds).toHaveLength(3)
  })
})
