import { describe, expect, it } from "vitest"

import {
  applyResolutionEdits,
  decideNeedsReviewResolution,
  isResolvableField,
  RESOLVABLE_FIELDS,
  toEditableValues,
  type NeedsReviewResolutionInput,
} from "@/lib/batch/needs-review-resolution"
import { canTransitionItem, claimableStatusesFor } from "@/lib/batch/state-machine"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"

const CONTENT: AiGeneratedSeoContent = {
  meta_title: "대구 북구 장례식장 화환 주문 — 예시 장례식장",
  meta_description: "예시 장례식장 근조화환 주문 안내입니다.",
  description: "예시 장례식장에 근조화환을 보내실 때 확인할 정보를 안내합니다.",
  faq: [
    { question: "화환 주문 전에 어떤 정보를 확인해야 하나요?", answer: "빈소명과 수령 장소를 확인합니다." },
    { question: "주소는 어떻게 확인하나요?", answer: "공식 안내에서 확인하실 수 있습니다." },
  ],
  keywords: ["예시 장례식장", "대구 근조화환"],
  internal_links: [],
}

const BASE: NeedsReviewResolutionInput = {
  confirmed: true,
  itemStatus: "needs_review",
  itemPlaceId: "place-1",
  itemGenerationIds: ["gen-1", null],
  generationId: "gen-1",
  generationPlaceId: "place-1",
  generationStatus: "preview",
  placeStatus: "draft",
  seoPageStatus: null,
}

describe("needs_review 해소 판정", () => {
  it("allows the apply path only when every precondition holds", () => {
    expect(decideNeedsReviewResolution(BASE)).toEqual({ allowed: true, mode: "apply" })
  })

  it("blocks without the explicit admin confirmation", () => {
    expect(decideNeedsReviewResolution({ ...BASE, confirmed: false })).toEqual({ allowed: false, blockedBy: "not-confirmed" })
  })

  it("blocks items that are no longer needs_review (재클릭·이미 처리된 항목)", () => {
    for (const itemStatus of ["ready", "warn_ready", "published", "processing", "failed"]) {
      expect(decideNeedsReviewResolution({ ...BASE, itemStatus })).toEqual({ allowed: false, blockedBy: "item-not-needs-review" })
    }
  })

  it("blocks mismatched generation / place combinations", () => {
    expect(decideNeedsReviewResolution({ ...BASE, generationPlaceId: "place-2" })).toEqual({ allowed: false, blockedBy: "generation-mismatch" })
    expect(decideNeedsReviewResolution({ ...BASE, generationId: "gen-other" })).toEqual({ allowed: false, blockedBy: "generation-mismatch" })
    // 이 item의 retry generation은 허용된다.
    expect(decideNeedsReviewResolution({ ...BASE, itemGenerationIds: ["gen-1", "gen-retry"], generationId: "gen-retry" })).toEqual({ allowed: true, mode: "apply" })
  })

  it("blocks published places and non-draft places", () => {
    expect(decideNeedsReviewResolution({ ...BASE, placeStatus: "published" })).toEqual({ allowed: false, blockedBy: "place-not-draft" })
    expect(decideNeedsReviewResolution({ ...BASE, placeStatus: "draft", seoPageStatus: "published" })).toEqual({ allowed: false, blockedBy: "already-published" })
  })

  it("resumes seo_page creation when apply already succeeded but the page is missing", () => {
    expect(decideNeedsReviewResolution({ ...BASE, generationStatus: "applied" })).toEqual({ allowed: true, mode: "resume-seo-page" })
    // seo_page가 이미 있으면 재개할 것이 없다 — 중복 생성 방지.
    expect(decideNeedsReviewResolution({ ...BASE, generationStatus: "applied", seoPageStatus: "ready" })).toEqual({ allowed: false, blockedBy: "generation-not-resolvable" })
    expect(decideNeedsReviewResolution({ ...BASE, generationStatus: "preview", seoPageStatus: "ready" })).toEqual({ allowed: false, blockedBy: "generation-not-resolvable" })
    expect(decideNeedsReviewResolution({ ...BASE, generationStatus: "rejected" })).toEqual({ allowed: false, blockedBy: "generation-not-resolvable" })
  })
})

describe("허용 필드 보정", () => {
  it("changes only the fields that were explicitly selected", () => {
    const result = applyResolutionEdits(CONTENT, { keywords: "예시 장례식장\n대구 북구 근조화환" })
    expect(result.kind).toBe("parsed")
    if (result.kind !== "parsed") return
    expect(result.changedFields).toEqual(["keywords"])
    expect(result.content.keywords).toEqual(["예시 장례식장", "대구 북구 근조화환"])
    // 선택하지 않은 필드는 원본 그대로.
    expect(result.content.meta_title).toBe(CONTENT.meta_title)
    expect(result.content.description).toBe(CONTENT.description)
    expect(result.content.faq).toEqual(CONTENT.faq)
    expect(result.before).toEqual({ keywords: CONTENT.keywords })
  })

  it("records no change when the submitted value equals the original", () => {
    const result = applyResolutionEdits(CONTENT, { title: CONTENT.meta_title, keywords: CONTENT.keywords.join("\n") })
    expect(result.kind === "parsed" && result.changedFields).toEqual([])
  })

  it("never touches fields outside the allowlist", () => {
    // 허용 목록 밖 키가 섞여 들어와도 무시된다 — 반복 대상은 RESOLVABLE_FIELDS뿐이다.
    const result = applyResolutionEdits(CONTENT, { body: "새 본문입니다.", provider: "openai", content_plan: "{}" } as Record<string, string>)
    expect(result.kind === "parsed" && result.changedFields).toEqual(["body"])
    expect(result.kind === "parsed" && Object.keys(result.content).sort()).toEqual(["description", "faq", "internal_links", "keywords", "meta_description", "meta_title"])
    expect(RESOLVABLE_FIELDS).toEqual(["title", "meta_description", "body", "faq", "keywords", "internal_links"])
    expect(isResolvableField("provider")).toBe(false)
    expect(isResolvableField("content_plan")).toBe(false)
    expect(isResolvableField("keywords")).toBe(true)
  })

  it("rejects malformed structured input instead of guessing", () => {
    expect(applyResolutionEdits(CONTENT, { faq: "질문만 있고 구분자 없음" })).toEqual({ kind: "invalid", field: "faq" })
    expect(applyResolutionEdits(CONTENT, { faq: "질문? | " })).toEqual({ kind: "invalid", field: "faq" })
    expect(applyResolutionEdits(CONTENT, { internal_links: "표시문구 | https://example.com" })).toEqual({ kind: "invalid", field: "internal_links" })
    expect(applyResolutionEdits(CONTENT, { title: "   " })).toEqual({ kind: "invalid", field: "title" })
    expect(applyResolutionEdits(CONTENT, { keywords: "\n\n" })).toEqual({ kind: "invalid", field: "keywords" })
  })

  it("round-trips content through the editable form values", () => {
    const values = toEditableValues(CONTENT)
    const result = applyResolutionEdits(CONTENT, values)
    expect(result.kind === "parsed" && result.changedFields).toEqual([])
    expect(values.faq).toBe("화환 주문 전에 어떤 정보를 확인해야 하나요? | 빈소명과 수령 장소를 확인합니다.\n주소는 어떻게 확인하나요? | 공식 안내에서 확인하실 수 있습니다.")
  })
})

describe("상태 머신 — 검토 해소 전이", () => {
  it("allows needs_review → processing but keeps it out of automatic claiming", () => {
    expect(canTransitionItem("needs_review", "processing")).toBe(true)
    // 자동 진행은 여전히 queued/interrupted만 집는다 — Batch 루프가 needs_review를 가져가지 않는다.
    expect(claimableStatusesFor("generate")).toEqual(["queued", "interrupted"])
    expect(claimableStatusesFor("publish")).toEqual(["ready", "warn_ready", "interrupted"])
  })

  it("keeps every other needs_review transition closed", () => {
    for (const to of ["ready", "warn_ready", "published", "failed", "skipped"] as const) {
      expect(canTransitionItem("needs_review", to)).toBe(false)
    }
    // processing에서 ready/needs_review로 되돌아가는 전이는 기존대로 열려 있다 (해소·복귀 경로).
    expect(canTransitionItem("processing", "ready")).toBe(true)
    expect(canTransitionItem("processing", "needs_review")).toBe(true)
  })
})
