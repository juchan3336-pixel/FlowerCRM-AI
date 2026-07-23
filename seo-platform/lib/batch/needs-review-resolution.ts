// needs_review 해소 정책 (순수 계층) — 관리자가 검토·보정한 generation을 ready로 올릴 수 있는지 판정하고,
// 허용된 필드만 반영한 콘텐츠와 감사 기록을 만든다. DB 접근·부수효과는 서비스 계층(needs-review-service)이 담당한다.
import type { AiFaqItem, AiGeneratedSeoContent, AiInternalLink } from "@/lib/ai/types"

// v1 보정 허용 필드 — 이 목록에 없는 키는 어떤 경로로도 수정되지 않는다.
// provider/model/usage/estimated_cost/content_plan/audit/title_normalization 원본은 대상이 아니다.
export const RESOLVABLE_FIELDS = ["title", "meta_description", "body", "faq", "keywords", "internal_links"] as const

export type ResolvableField = (typeof RESOLVABLE_FIELDS)[number]

// 보정 필드 → 생성 콘텐츠 키 매핑 (UI 명칭과 저장 키가 다르다).
const FIELD_TO_CONTENT_KEY: Readonly<Record<ResolvableField, keyof AiGeneratedSeoContent>> = {
  title: "meta_title",
  meta_description: "meta_description",
  body: "description",
  faq: "faq",
  keywords: "keywords",
  internal_links: "internal_links",
}

export const RESOLVABLE_FIELD_LABELS: Readonly<Record<ResolvableField, string>> = {
  title: "SEO 제목",
  meta_description: "메타 설명",
  body: "본문",
  faq: "FAQ",
  keywords: "키워드",
  internal_links: "내부 링크",
}

export function isResolvableField(value: string): value is ResolvableField {
  return (RESOLVABLE_FIELDS as readonly string[]).includes(value)
}

export type ResolutionFieldEdits = Partial<Record<ResolvableField, string>>

export type ParsedEdits =
  | { readonly kind: "parsed"; readonly content: AiGeneratedSeoContent; readonly changedFields: readonly ResolvableField[]; readonly before: Partial<AiGeneratedSeoContent> }
  | { readonly kind: "invalid"; readonly field: ResolvableField }

// 명시적으로 선택된 필드만 반영한다. 값이 원본과 같으면 변경으로 세지 않는다.
export function applyResolutionEdits(content: AiGeneratedSeoContent, edits: ResolutionFieldEdits): ParsedEdits {
  const next: Record<string, unknown> = { ...content }
  const before: Record<string, unknown> = {}
  const changedFields: ResolvableField[] = []

  for (const field of RESOLVABLE_FIELDS) {
    const raw = edits[field]
    if (raw === undefined) {
      continue
    }
    const parsed = parseFieldValue(field, raw)
    if (parsed === null) {
      return { kind: "invalid", field }
    }
    const key = FIELD_TO_CONTENT_KEY[field]
    if (JSON.stringify(parsed) === JSON.stringify(content[key])) {
      continue
    }
    before[key] = content[key]
    next[key] = parsed
    changedFields.push(field)
  }

  return { kind: "parsed", content: next as unknown as AiGeneratedSeoContent, changedFields, before }
}

// 줄 기반 입력 파서 — 관리자 폼이 원시 JSON을 다루지 않도록 한다. 형식 오류는 null(=차단).
function parseFieldValue(field: ResolvableField, raw: string): string | readonly string[] | readonly AiFaqItem[] | readonly AiInternalLink[] | null {
  const text = raw.replace(/\r\n/g, "\n").trim()
  switch (field) {
    case "title":
    case "meta_description":
    case "body": {
      return text.length === 0 ? null : text
    }
    case "keywords": {
      const keywords = splitLines(text)
      return keywords.length === 0 ? null : keywords
    }
    case "faq": {
      const items: AiFaqItem[] = []
      for (const line of splitLines(text)) {
        const separator = line.indexOf("|")
        if (separator <= 0) {
          return null
        }
        const question = line.slice(0, separator).trim()
        const answer = line.slice(separator + 1).trim()
        if (question.length === 0 || answer.length === 0) {
          return null
        }
        items.push({ question, answer })
      }
      return items.length === 0 ? null : items
    }
    case "internal_links": {
      const links: AiInternalLink[] = []
      for (const line of splitLines(text)) {
        const separator = line.indexOf("|")
        if (separator <= 0) {
          return null
        }
        const label = line.slice(0, separator).trim()
        const href = line.slice(separator + 1).trim()
        if (label.length === 0 || !href.startsWith("/")) {
          return null
        }
        links.push({ label, href })
      }
      return links
    }
  }
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// 생성 콘텐츠 → 폼 표시·편집용 문자열 (parseFieldValue의 역방향).
export function toEditableValues(content: AiGeneratedSeoContent): Record<ResolvableField, string> {
  return {
    title: content.meta_title,
    meta_description: content.meta_description,
    body: content.description,
    faq: content.faq.map((entry) => `${entry.question} | ${entry.answer}`).join("\n"),
    keywords: [...content.keywords].join("\n"),
    internal_links: content.internal_links.map((link) => `${link.label} | ${link.href}`).join("\n"),
  }
}

// 해소 판정 — 하나라도 어긋나면 상태를 바꾸지 않고 차단 사유를 돌려준다.
export type NeedsReviewResolutionBlock =
  | "not-confirmed"
  | "item-not-needs-review"
  | "generation-mismatch"
  | "generation-not-resolvable"
  | "place-not-draft"
  | "already-published"
  | "invalid-field-format"

export type NeedsReviewResolutionDecision =
  | { readonly allowed: true; readonly mode: "apply" | "resume-seo-page" }
  | { readonly allowed: false; readonly blockedBy: NeedsReviewResolutionBlock }

export type NeedsReviewResolutionInput = {
  readonly confirmed: boolean
  readonly itemStatus: string
  readonly itemPlaceId: string
  readonly itemGenerationIds: readonly (string | null)[]
  readonly generationId: string
  readonly generationPlaceId: string
  readonly generationStatus: string
  readonly placeStatus: string
  readonly seoPageStatus: string | null
}

export function decideNeedsReviewResolution(input: NeedsReviewResolutionInput): NeedsReviewResolutionDecision {
  if (!input.confirmed) {
    return { allowed: false, blockedBy: "not-confirmed" }
  }
  if (input.itemStatus !== "needs_review") {
    return { allowed: false, blockedBy: "item-not-needs-review" }
  }
  if (input.generationPlaceId !== input.itemPlaceId || !input.itemGenerationIds.includes(input.generationId)) {
    return { allowed: false, blockedBy: "generation-mismatch" }
  }
  if (input.placeStatus !== "draft") {
    return { allowed: false, blockedBy: "place-not-draft" }
  }
  if (input.seoPageStatus === "published") {
    return { allowed: false, blockedBy: "already-published" }
  }
  if (input.generationStatus === "preview") {
    // 이미 seo_page가 있으면 apply 대상이 아니다 — 정상 경로에서는 발생하지 않는다.
    return input.seoPageStatus === null ? { allowed: true, mode: "apply" } : { allowed: false, blockedBy: "generation-not-resolvable" }
  }
  // 재개 경로: apply는 끝났지만 seo_page 생성 직전에 중단된 부분 상태를 이어서 해소한다.
  if (input.generationStatus === "applied" && input.seoPageStatus === null) {
    return { allowed: true, mode: "resume-seo-page" }
  }
  return { allowed: false, blockedBy: "generation-not-resolvable" }
}

// generation output에 남기는 수동 보정 감사 기록 — 원본 필드는 before에 보존한다.
export type ManualReviewAudit = {
  readonly resolved_by: string
  readonly changed_fields: readonly ResolvableField[]
  readonly before: Partial<AiGeneratedSeoContent>
}

export function buildManualReviewAudit(input: Readonly<{ resolvedBy: string; changedFields: readonly ResolvableField[]; before: Partial<AiGeneratedSeoContent> }>): ManualReviewAudit {
  return { resolved_by: input.resolvedBy, changed_fields: input.changedFields, before: input.before }
}
