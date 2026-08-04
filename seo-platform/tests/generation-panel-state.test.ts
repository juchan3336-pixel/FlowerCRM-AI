import { describe, expect, it } from "vitest"

import { resolveGenerationQualityPanelState, type AdminPlaceGenerationView } from "@/lib/admin/place-detail"

function makeGeneration(overrides: Partial<AdminPlaceGenerationView>): AdminPlaceGenerationView {
  return {
    id: "gen-id",
    status: "preview",
    model: "gpt-4.1-mini",
    provider: "openai",
    usage: null,
    estimatedCost: null,
    errorCode: null,
    errorDetail: null,
    createdAt: "2026-07-21 15:00",
    appliedAt: null,
    output: null,
    quality: { status: "pass", issues: [] },
    titleNormalization: null,
    retry: null,
    ...overrides,
  }
}

const FAIL_QUALITY = { status: "fail", issues: [{ level: "fail", code: "repeat:faq", message: "FAQ 질문 2개가 모두 기존 페이지와 동일" }] } as const

// 13호점 실측 이력: [복구 재시도 applied PASS (최신), 최초 preview FAIL] — 이력은 최신순.
const RECOVERED_HISTORY: readonly AdminPlaceGenerationView[] = [
  makeGeneration({ id: "gen-retry", status: "applied", appliedAt: "2026-07-21 17:44", retry: { of: "gen-original", reason: "quality-fail-repeat-faq" } }),
  makeGeneration({ id: "gen-original", quality: FAIL_QUALITY }),
]

describe("품질 패널 상태 — 현재 적용 generation 기준", () => {
  it("shows the recovered PASS state after a retry is applied (13호점 게시 후 화면 버그 재현)", () => {
    // Given / When: 게시 완료된 13호점 이력.
    const state = resolveGenerationQualityPanelState({ generations: RECOVERED_HISTORY, isPublished: true })

    // Then: 패널은 적용된 복구 generation의 PASS를 표시하고, 복구 완료 배지·보조 문구가 붙으며, 재시도 버튼은 없다.
    expect(state?.generation.id).toBe("gen-retry")
    expect(state?.quality.status).toBe("pass")
    expect(state?.recovered).toBe(true)
    expect(state?.recoveryNote).toBe("최초 생성은 FAQ 중복으로 차단됐으며, 복구 generation이 적용되었습니다.")
    expect(state?.showRetryButton).toBe(false)
  })

  it("hides the retry button even before publish once the retry generation exists", () => {
    // Given: 복구 재시도가 적용됐지만 아직 게시 전(ready 단계).
    const state = resolveGenerationQualityPanelState({ generations: RECOVERED_HISTORY, isPublished: false })
    expect(state?.showRetryButton).toBe(false)
    expect(state?.recovered).toBe(true)
  })

  it("shows the retry button only for a current FAIL preview that is not itself a retry", () => {
    // Given: 최초 FAIL preview만 있는 미게시 장소.
    const state = resolveGenerationQualityPanelState({
      generations: [makeGeneration({ id: "gen-fail", quality: FAIL_QUALITY })],
      isPublished: false,
    })
    expect(state?.showRetryButton).toBe(true)
    expect(state?.quality.status).toBe("fail")
    expect(state?.recovered).toBe(false)
  })

  it("never shows the retry button on a published place", () => {
    const state = resolveGenerationQualityPanelState({
      generations: [makeGeneration({ id: "gen-fail", quality: FAIL_QUALITY })],
      isPublished: true,
    })
    expect(state?.showRetryButton).toBe(false)
  })

  it("never shows the retry button when the FAIL preview is itself a retry (재시도 1회 소진)", () => {
    const state = resolveGenerationQualityPanelState({
      generations: [
        makeGeneration({ id: "gen-retry-fail", quality: FAIL_QUALITY, retry: { of: "gen-original", reason: "quality-fail-repeat-faq" } }),
        makeGeneration({ id: "gen-original", quality: FAIL_QUALITY }),
      ],
      isPublished: false,
    })
    expect(state?.generation.id).toBe("gen-retry-fail")
    expect(state?.showRetryButton).toBe(false)
  })

  it("hides the retry button when a batch retry was consumed without producing a generation (대구병원)", () => {
    // Given: 2026-07-23 대구병원 상태 — FAIL preview 1건뿐이고, 재시도는 Batch item에만 흔적이 남았다.
    const generations = [makeGeneration({ id: "67b3fd0d", quality: FAIL_QUALITY })]
    // 흔적이 없다면(수정 전 동작) 시간 경과 뒤 버튼이 다시 열린다 — 회귀 감시용 대조군.
    expect(resolveGenerationQualityPanelState({ generations, isPublished: false })?.showRetryButton).toBe(true)

    // When: Batch 소진 흔적을 함께 판정하면
    const state = resolveGenerationQualityPanelState({
      generations,
      isPublished: false,
      batchRetryConsumption: [{ generationId: "67b3fd0d", retryGenerationId: null, lastErrorCode: "recent-preview", lastErrorMessage: "복구 재시도 실패: recent-preview" }],
    })

    // Then: 버튼은 닫힌 채로 유지된다 (서버 액션 guard와 동일 판정).
    expect(state?.showRetryButton).toBe(false)
    expect(state?.quality.status).toBe("fail")
  })

  it("hides the retry button when the retry left only a failed generation record", () => {
    // 재시도가 provider 오류로 끝나 failed 레코드만 남은 경우 — 이력에 retry.of가 있으므로 소진 1회.
    const state = resolveGenerationQualityPanelState({
      generations: [
        makeGeneration({ id: "gen-retry-failed", status: "failed", quality: null, retry: { of: "gen-original", reason: "quality-fail-repeat-faq" } }),
        makeGeneration({ id: "gen-original", quality: FAIL_QUALITY }),
      ],
      isPublished: false,
    })
    expect(state?.generation.id).toBe("gen-original")
    expect(state?.showRetryButton).toBe(false)
  })

  it("still allows the first retry when a batch item failed for a non-retry reason", () => {
    // 일반 생성 실패로 끝난 item은 복구 재시도를 쓰지 않았다 — 1회는 남아 있어야 한다.
    const state = resolveGenerationQualityPanelState({
      generations: [makeGeneration({ id: "gen-fail", quality: FAIL_QUALITY })],
      isPublished: false,
      batchRetryConsumption: [{ generationId: "gen-fail", retryGenerationId: null, lastErrorCode: "warn-other", lastErrorMessage: "자동 ready 조건 미충족 — 사용자 확인 필요" }],
    })
    expect(state?.showRetryButton).toBe(true)
  })

  it("shows a plain applied PASS without recovery markers when there was no retry", () => {
    const state = resolveGenerationQualityPanelState({
      generations: [makeGeneration({ id: "gen-normal", status: "applied", appliedAt: "2026-07-21 12:00" })],
      isPublished: true,
    })
    expect(state?.recovered).toBe(false)
    expect(state?.recoveryNote).toBeNull()
    expect(state?.showRetryButton).toBe(false)
  })

  it("uses a generic recovery note for non-faq fail reasons", () => {
    const state = resolveGenerationQualityPanelState({
      generations: [makeGeneration({ id: "gen-retry", status: "applied", retry: { of: "gen-original", reason: "quality-fail-repeat-first-sentence" } })],
      isPublished: true,
    })
    expect(state?.recoveryNote).toBe("최초 생성은 품질 검사 FAIL로 차단됐으며, 복구 generation이 적용되었습니다.")
  })

  it("skips transport-failed records and returns null without quality", () => {
    // failed 레코드는 건너뛰고 다음 preview를 현재 상태로 본다.
    const skipped = resolveGenerationQualityPanelState({
      generations: [
        makeGeneration({ id: "gen-transport-fail", status: "failed", quality: null }),
        makeGeneration({ id: "gen-preview", quality: FAIL_QUALITY }),
      ],
      isPublished: false,
    })
    expect(skipped?.generation.id).toBe("gen-preview")
    // 품질 성적표가 없으면 패널 없음 (구 generation 호환).
    expect(resolveGenerationQualityPanelState({ generations: [makeGeneration({ quality: null })], isPublished: false })).toBeNull()
    expect(resolveGenerationQualityPanelState({ generations: [], isPublished: false })).toBeNull()
  })
})
