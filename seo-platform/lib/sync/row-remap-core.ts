// 행번호 재매핑 계획·판정의 순수 계층.
//
// 시트에서 행이 삭제되면 places.source_row_number가 현재 시트보다 뒤로 밀린다.
// 여기서는 두 스냅샷을 받아 "어느 행을 몇 번으로 고쳐야 하는지"와 "고쳐도 되는지"만 계산한다.
// DB·네트워크·env를 건드리지 않으므로 관리자 Dry-run과 테스트가 그대로 쓴다.
//
// 매칭 근거는 source_key 하나다 — 행 번호가 이미 어긋난 상황이라 행 번호로는 맞출 수 없고,
// 회사명만으로는 동명이 갈린다. createSourceKey(회사명 + 전화 또는 주소)가 유일한 안정 식별자다.
import { createSourceKey } from "@/lib/domain/normalize"

// 2026-07-29 공백행 6개(131·132·307·308·320·321) 삭제로 예상되는 이동량.
// 실측이 다르면 시트 상황이 달라진 것이므로 FAIL로 판정하고 적용을 막는다.
export const EXPECTED_SHIFTS: Readonly<Record<string, number>> = { "0": 129, "-2": 174, "-4": 11, "-6": 14637 }
export const EXPECTED_MATCHED = 14_951

export type RemapSheetRow = {
  readonly rowNumber: number
  readonly name: string | undefined
  readonly address?: string | undefined
  readonly phone?: string | undefined
}

export type RemapPlaceRow = {
  readonly id: string
  readonly source_key: string
  readonly source_row_number: number
  readonly name: string
  readonly status?: string | undefined
}

export type RemapUpdate = {
  readonly place_id: string
  readonly from_row: number
  readonly to_row: number
}

// 아직 동기화되지 않은 신규 시트 행.
//
// 시트에만 있는 행이 전부 "기존 매핑 구간 뒤에 연속으로" 붙어 있다면 그건 정합성 오류가 아니라
// collector가 새로 수집한 데이터일 뿐이다 — 행번호 복구와는 무관하며 복구 계획에도 들어가지 않는다.
// 반대로 기존 구간 중간에 끼어 있거나 끊겨 있으면 대응 관계가 흔들린 것이므로 오류로 본다.
export type RemapPending = {
  readonly rows: number
  readonly startRow: number | null
  readonly endRow: number | null
  // 기존 매핑이 차지하는 마지막 행보다 전부 뒤에 있는가
  readonly afterMatchedRange: boolean
  // 신규 구간 자체가 끊김 없이 이어지는가
  readonly contiguous: boolean
}

// 화면·응답에 그대로 실어도 되는 요약. 회사명·주소·전화·source_key 원문을 담지 않는다.
export type RemapSummary = {
  readonly sheetRows: number
  readonly sheetLastRow: number | null
  readonly dbRows: number
  readonly maxSourceRowNumber: number | null
  readonly matched: number
  readonly unchanged: number
  readonly updateCount: number
  readonly unmatchedInSheet: number
  readonly unmatchedInDb: number
  readonly ambiguous: number
  readonly duplicateSourceKeys: number
  readonly duplicateTargetRows: number
  readonly shiftHistogram: Readonly<Record<string, number>>
  readonly expectedShifts: Readonly<Record<string, number>>
  readonly shiftMatchesExpectation: boolean
  readonly minBefore: number | null
  readonly maxBefore: number | null
  readonly minAfter: number | null
  readonly maxAfter: number | null
  readonly expectedContinuity: boolean
  readonly publishedInUpdates: number
  readonly pending: RemapPending
}

export type RemapReport = {
  readonly summary: RemapSummary
  // 적용 계획 — place_id와 행 번호만. 회사명·source_key는 담지 않는다 (화면·파일 어디로 가든 안전하게).
  readonly updates: readonly RemapUpdate[]
  // 문제가 있는 행은 "몇 번 행"만 남긴다. 어느 회사인지는 담지 않는다.
  readonly unmatchedInDbRows: readonly number[]
  readonly unmatchedInSheetRows: readonly number[]
  readonly ambiguousRows: readonly number[]
}

export function buildRemapReport(
  input: Readonly<{ sheetRows: readonly RemapSheetRow[]; places: readonly RemapPlaceRow[]; expectedShifts?: Readonly<Record<string, number>> }>,
): RemapReport {
  const expectedShifts = input.expectedShifts ?? EXPECTED_SHIFTS
  const sheetEntries = input.sheetRows
    .filter((row) => textOf(row.name) !== "")
    .map((row) => ({
      rowNumber: row.rowNumber,
      sourceKey: createSourceKey({ name: textOf(row.name), phone: textOf(row.phone), address: textOf(row.address) }),
    }))

  const sheetIndex = indexByKey(sheetEntries, (entry) => entry.sourceKey)
  const placeIndex = indexByKey(input.places, (place) => place.source_key)
  const duplicateSourceKeys = new Set([...sheetIndex.duplicates, ...placeIndex.duplicates])

  const updates: RemapUpdate[] = []
  const unmatchedInDbRows: number[] = []
  const ambiguousRows: number[] = []
  let unchanged = 0
  let publishedInUpdates = 0

  for (const place of input.places) {
    if (duplicateSourceKeys.has(place.source_key)) {
      ambiguousRows.push(place.source_row_number)
      continue
    }
    const sheetEntry = sheetIndex.byKey.get(place.source_key)
    if (sheetEntry === undefined) {
      unmatchedInDbRows.push(place.source_row_number)
      continue
    }
    if (sheetEntry.rowNumber === place.source_row_number) {
      unchanged += 1
      continue
    }
    updates.push({ place_id: place.id, from_row: place.source_row_number, to_row: sheetEntry.rowNumber })
    if (place.status === "published") {
      publishedInUpdates += 1
    }
  }

  // 시트에만 있는 행 = 아직 동기화되지 않은 신규 데이터. 재매핑 대상은 아니지만, 남아 있으면
  // 두 스냅샷 시점이 어긋났다는 뜻이라 적용을 막는다 (매칭 근거가 흔들린다).
  const unmatchedInSheetRows = sheetEntries.filter((entry) => !placeIndex.byKey.has(entry.sourceKey)).map((entry) => entry.rowNumber)

  const shiftHistogram: Record<string, number> = {}
  for (const update of updates) {
    const shift = String(update.to_row - update.from_row)
    shiftHistogram[shift] = (shiftHistogram[shift] ?? 0) + 1
  }
  // unchanged(이동 0)도 넣어야 예상표와 비교된다.
  shiftHistogram["0"] = (shiftHistogram["0"] ?? 0) + unchanged

  const targetRows = updates.map((update) => update.to_row)
  const beforeRows = input.places.map((place) => place.source_row_number).sort(ascending)
  const updateByPlace = new Map(updates.map((update) => [update.place_id, update.to_row]))
  const afterRows = input.places.map((place) => updateByPlace.get(place.id) ?? place.source_row_number).sort(ascending)

  // 기존 매핑이 차지하는 마지막 시트 행. 신규 데이터는 이 뒤에 붙어야 정상이다.
  const lastMatchedRow = afterRows.at(-1) ?? 1
  const pending = describePending(unmatchedInSheetRows, lastMatchedRow)

  return {
    summary: {
      sheetRows: sheetEntries.length,
      sheetLastRow: sheetEntries.at(-1)?.rowNumber ?? null,
      dbRows: input.places.length,
      maxSourceRowNumber: beforeRows.at(-1) ?? null,
      matched: updates.length + unchanged,
      unchanged,
      updateCount: updates.length,
      unmatchedInSheet: unmatchedInSheetRows.length,
      unmatchedInDb: unmatchedInDbRows.length,
      ambiguous: ambiguousRows.length,
      duplicateSourceKeys: duplicateSourceKeys.size,
      duplicateTargetRows: targetRows.length - new Set(targetRows).size,
      shiftHistogram,
      expectedShifts,
      shiftMatchesExpectation: sameHistogram(shiftHistogram, expectedShifts),
      minBefore: beforeRows[0] ?? null,
      maxBefore: beforeRows.at(-1) ?? null,
      minAfter: afterRows[0] ?? null,
      maxAfter: afterRows.at(-1) ?? null,
      expectedContinuity: afterRows.every((value, index) => index === 0 || value === (afterRows[index - 1] ?? 0) + 1),
      publishedInUpdates,
      pending,
    },
    updates,
    unmatchedInDbRows,
    unmatchedInSheetRows,
    ambiguousRows,
  }
}

// ── 판정 ─────────────────────────────────────────────────────────
// 실패 사유는 안전한 코드 문자열만 돌려준다 (원문·회사명·키를 담지 않는다).
export type RemapFailureCode =
  | "duplicate-source-key"
  | "duplicate-target-row"
  | "unmatched-in-sheet"
  | "unmatched-in-db"
  | "ambiguous-match"
  | "shift-histogram-mismatch"
  | "continuity-failed"
  | "matched-count-mismatch"

// PASS_WITH_PENDING_SYNC — 기존 데이터의 행번호 정합성은 정상이고, 아직 동기화되지 않은
// 신규 데이터만 시트 뒤쪽에 쌓여 있는 상태. 복구를 진행해도 되며 신규분은 복구 계획과 무관하다.
export type RemapVerdictKind = "PASS" | "PASS_WITH_PENDING_SYNC" | "FAIL"

export type RemapVerdict = {
  readonly verdict: RemapVerdictKind
  readonly failures: readonly RemapFailureCode[]
}

export function evaluateRemapReport(summary: RemapSummary, options?: Readonly<{ expectedMatched?: number | null }>): RemapVerdict {
  const failures: RemapFailureCode[] = []
  if (summary.duplicateSourceKeys > 0) failures.push("duplicate-source-key")
  if (summary.duplicateTargetRows > 0) failures.push("duplicate-target-row")
  if (summary.unmatchedInDb > 0) failures.push("unmatched-in-db")
  if (summary.ambiguous > 0) failures.push("ambiguous-match")
  if (!summary.shiftMatchesExpectation) failures.push("shift-histogram-mismatch")
  if (!summary.expectedContinuity) failures.push("continuity-failed")

  // 기본 불변식: DB의 모든 행이 시트에서 짝을 찾았는가. 고정 상수보다 이 관계가 더 오래 맞는다
  // (시트가 커져도 DB 행 수와 함께 움직이므로). 테스트는 expectedMatched로 고정값을 줄 수 있다.
  const expectedMatched = options?.expectedMatched === undefined ? summary.dbRows : options.expectedMatched
  if (expectedMatched !== null && summary.matched !== expectedMatched) failures.push("matched-count-mismatch")

  // 시트에만 있는 행은 두 가지 뜻이 될 수 있다 —
  //   (1) 아직 동기화되지 않은 신규 데이터: 기존 매핑 뒤에 연속으로 붙어 있다 → 정합성 오류 아님
  //   (2) 대응 관계가 흔들림: 기존 구간 중간에 끼었거나 끊겨 있다 → 오류
  // 전자를 FAIL로 묶으면 정상적인 backlog에서도 복구가 영원히 막힌다.
  const pendingIsNewData = summary.pending.rows === 0 || (summary.pending.afterMatchedRange && summary.pending.contiguous)
  if (!pendingIsNewData) failures.push("unmatched-in-sheet")

  if (failures.length > 0) {
    return { verdict: "FAIL", failures }
  }
  return { verdict: summary.pending.rows > 0 ? "PASS_WITH_PENDING_SYNC" : "PASS", failures: [] }
}

// 사용자 안내 — 안전 코드만 한글로 옮긴다.
export const REMAP_FAILURE_MESSAGES: Readonly<Record<RemapFailureCode, string>> = {
  "duplicate-source-key": "같은 식별자를 가진 행이 여러 개 있어 어느 행에 맞출지 정할 수 없습니다.",
  "duplicate-target-row": "두 행이 같은 행 번호를 가리킵니다.",
  "unmatched-in-sheet":
    "시트에만 있는 행이 기존 매핑 구간 중간에 끼어 있거나 끊겨 있습니다. 단순한 신규 데이터가 아니라 대응 관계가 흔들린 상태입니다.",
  "unmatched-in-db": "Supabase에만 있고 시트에서는 사라진 행이 있습니다. 원인을 확인해야 합니다.",
  "ambiguous-match": "식별자만으로 대응 관계를 확정할 수 없는 행이 있습니다.",
  "shift-histogram-mismatch": "행 이동량이 예상과 다릅니다. 시트에서 예상 외의 삭제·삽입이 있었을 수 있습니다.",
  "continuity-failed": "재매핑 후 행 번호가 연속이 되지 않습니다.",
  "matched-count-mismatch": "매칭된 행 수가 기준선과 다릅니다.",
}

// ── helpers ───────────────────────────────────────────────────────
function describePending(unmatchedRows: readonly number[], lastMatchedRow: number): RemapPending {
  if (unmatchedRows.length === 0) {
    return { rows: 0, startRow: null, endRow: null, afterMatchedRange: true, contiguous: true }
  }
  const sorted = [...unmatchedRows].sort(ascending)
  const startRow = sorted[0] ?? null
  const endRow = sorted.at(-1) ?? null
  return {
    rows: sorted.length,
    startRow,
    endRow,
    afterMatchedRange: startRow !== null && startRow > lastMatchedRow,
    contiguous: sorted.every((value, index) => index === 0 || value === (sorted[index - 1] ?? 0) + 1),
  }
}

function indexByKey<T>(rows: readonly T[], pick: (row: T) => string): { byKey: Map<string, T>; duplicates: Set<string> } {
  const byKey = new Map<string, T>()
  const duplicates = new Set<string>()
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

function sameHistogram(actual: Readonly<Record<string, number>>, expected: Readonly<Record<string, number>>): boolean {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)])
  for (const key of keys) {
    if ((actual[key] ?? 0) !== (expected[key] ?? 0)) {
      return false
    }
  }
  return true
}

function textOf(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

function ascending(a: number, b: number): number {
  return a - b
}
