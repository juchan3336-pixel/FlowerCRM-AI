// 운영 작업(ops task) — 관리자 세션 없이, 미리 고정한 대상에만 한 번 실행하는 검토 해소·콘텐츠 보정.
//
// 관리자 화면의 "검토 해소"·본문 보정은 로그인 세션이 있어야 한다. 무인 캠페인의 결과를 사람이 읽고
// 고칠 때 쓸 수 있도록, 같은 서버 코어(resolveNeedsReviewItem·correctReadyContent)를 이미 인증된
// batch pump 안에서 호출한다. 임의 수정 endpoint를 여는 것이 아니다:
//   - 무엇을 할지는 settings.ops_task JSON에 대상 ID·예상 해시·바꿀 필드까지 고정돼 있어야 한다
//   - 작업 ID당 정확히 한 번만 실행된다 (결과 행 INSERT가 claim — 이미 있으면 실행하지 않는다)
//   - 만료 시각이 지나면 실행하지 않는다
// 이 파일은 순수 해석만 한다.
import type { ResolvableField } from "./needs-review-resolution"

// ready 보정으로 바꿀 수 있는 필드 — 문장 필드만. FAQ·키워드·내부 링크는 선택 계층(회피·감사)과 묶여 있어 제외한다.
export const READY_CORRECTION_FIELDS = ["title", "body", "meta_description"] as const satisfies readonly ResolvableField[]
export type ReadyCorrectionField = (typeof READY_CORRECTION_FIELDS)[number]
export type ReadyCorrectionEdits = Partial<Record<ReadyCorrectionField, string>>

export const OPS_TASK_SETTING_KEY = "ops_task"
export const OPS_TASK_MAX_STEPS = 10

export function opsTaskResultKey(taskId: string): string {
  return `ops_task_result:${taskId}`
}

export type OpsTaskStep =
  | { readonly kind: "resolve-needs-review"; readonly itemId: string; readonly generationId: string }
  | { readonly kind: "correct-ready"; readonly placeId: string; readonly generationId: string; readonly expectedContentHash: string; readonly edits: ReadyCorrectionEdits; readonly reason: string }

export type OpsTask = {
  readonly id: string
  readonly expiresAt: string
  // 감사 기록에 남는 주체 — 사용자 이메일을 가장하지 않는다.
  readonly actor: string
  // 중단된 작업이 남긴 게시 금지(publish_freeze)를 넘겨받아 실행할 때 그 작업 ID. 새 작업이면 null.
  // 키 자체는 반드시 있어야 한다 — 빠뜨린 설정을 "넘겨받지 않음"으로 조용히 해석하지 않는다.
  readonly inheritFreezeFrom: string | null
  readonly steps: readonly OpsTaskStep[]
}

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,49}$/
const ACTOR_PATTERN = /^ops:[a-z0-9][a-z0-9-]{1,39}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/

// 엄격 해석 — 한 항목이라도 어긋나면 작업 없음(null). 일부 step만 골라 실행하지 않는다.
export function parseOpsTask(value: unknown): OpsTask | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, expiresAt, actor, steps, inheritFreezeFrom } = value
  if (typeof id !== "string" || !TASK_ID_PATTERN.test(id)) {
    return null
  }
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
    return null
  }
  if (typeof actor !== "string" || !ACTOR_PATTERN.test(actor)) {
    return null
  }
  if (inheritFreezeFrom !== null && (typeof inheritFreezeFrom !== "string" || !TASK_ID_PATTERN.test(inheritFreezeFrom) || inheritFreezeFrom === id)) {
    return null
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > OPS_TASK_MAX_STEPS) {
    return null
  }
  const parsed: OpsTaskStep[] = []
  for (const raw of steps) {
    const step = parseStep(raw)
    if (step === null) {
      return null
    }
    parsed.push(step)
  }
  return { id, expiresAt, actor, inheritFreezeFrom, steps: parsed }
}

function parseStep(raw: unknown): OpsTaskStep | null {
  if (!isRecord(raw)) {
    return null
  }
  if (raw["kind"] === "resolve-needs-review") {
    const { itemId, generationId } = raw
    return isUuid(itemId) && isUuid(generationId) ? { kind: "resolve-needs-review", itemId, generationId } : null
  }
  if (raw["kind"] === "correct-ready") {
    const { placeId, generationId, expectedContentHash, edits, reason } = raw
    if (!isUuid(placeId) || !isUuid(generationId) || typeof expectedContentHash !== "string" || !SHA256_PATTERN.test(expectedContentHash)) {
      return null
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      return null
    }
    if (!isRecord(edits)) {
      return null
    }
    const keys = Object.keys(edits)
    if (keys.length === 0 || !keys.every((key) => (READY_CORRECTION_FIELDS as readonly string[]).includes(key))) {
      return null
    }
    const parsedEdits: Record<string, string> = {}
    for (const key of keys) {
      const text = edits[key]
      if (typeof text !== "string" || text.trim().length === 0) {
        return null
      }
      parsedEdits[key] = text
    }
    return { kind: "correct-ready", placeId, generationId, expectedContentHash, edits: parsedEdits, reason }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

export function isOpsTaskExpired(task: OpsTask, nowIso: string): boolean {
  return Date.parse(nowIso) >= Date.parse(task.expiresAt)
}
