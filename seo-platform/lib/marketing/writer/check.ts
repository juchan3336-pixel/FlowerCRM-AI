// 광고 글쓰기 결과 검사 — 두 갈래로 나눈다.
//
//   금지(fail)  — 내보내면 안 되는 글. 광고 금지 규칙(ad-quality: 가격·배송 약속·후기·근조/축하 혼입, 태그 포함),
//                 연락처·웹 주소, 근조 글의 이모지, 상품 설명에서 자료에 없는 사양. 남으면 화면에서 복사를 막는다.
//   문장(style) — 길이·문단·태그 개수, 반복·빈말 등. 한 번 다시 쓰게 하고, 남으면 알리기만 한다.
import type { ContentMode } from "@/lib/ai/content-mode"

import { evaluateAdCopy } from "../ad-quality"
import { WRITER_HARD_LIMITS } from "../repository"
import { checkDraftStyle, type StyleIssue } from "../ai/style-check"

import type { WriterCopy } from "./prompt"
import { WRITER_KIND_SPECS, type WriterOutputKind } from "./spec"

export type WriterCheckContext = {
  readonly mode: ContentMode
  readonly kind: WriterOutputKind
  readonly region: string | null
  // 상품 사양의 근거 — 사람이 확인해 입력한 상품명과 구성·사양만. 주제·강조할 점은 근거가 아니다
  // (주제에 '국화 포함 여부 확인'이라고 적었다고 국화가 확인된 사양이 되지 않는다)
  readonly productEvidence: string
}

export type WriterCheck = {
  readonly status: "pass" | "warn" | "fail"
  // 내보내면 안 되는 문제
  readonly blocking: readonly string[]
  // 다시 쓰게 할 문장 문제
  readonly style: readonly StyleIssue[]
}

// 연락처·웹 주소 — 주문 링크는 시스템이 따로 붙인다
const CONTACT_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "웹 주소", pattern: /https?:\/\/|www\.|\S\.(?:com|net|co\.kr|kr)(?![A-Za-z])/i },
  { label: "전화번호", pattern: /\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b|\b1[5-9]\d{2}[-.\s]?\d{4}\b/ },
  { label: "이메일", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
]

const EMOJI = /\p{Extended_Pictographic}/gu

// 상품 사양으로 읽히는 말 — 상품 설명에서 자료에 없으면 지어낸 것으로 본다
const SPEC_TERMS: readonly string[] = ["국화", "장미", "백합", "호접란", "거베라", "안개꽃", "카네이션", "리시안셔스", "해바라기", "카라", "원산지", "국내산", "수입산", "무료배송", "무료 배송", "택배"]
const SPEC_PATTERNS: readonly RegExp[] = [/\d+\s*단(?!계|체|위|지|어|락|순)/g, /\d+(?:\.\d+)?\s*(?:cm|센티|센치|미터|m)(?![a-z])/gi, /\d+\s*송이/g, /\d+\s*(?:종|가지)\s*(?:꽃|구성)/g]

function paragraphCount(body: string): number {
  return body.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0).length
}

function length(text: string): number {
  return Array.from(text).length
}

function compact(text: string): string {
  return text.replace(/\s+/g, "")
}

export function checkWriterCopy(copy: WriterCopy, context: WriterCheckContext): WriterCheck {
  const spec = WRITER_KIND_SPECS[context.kind]
  const fields = [copy.title, copy.body, copy.caption, ...copy.tags]
  const all = fields.join("\n")
  const blocking: string[] = []

  // 저장 상한을 넘는 글은 저장할 수 없다 — 형식 규칙과 별개로 막고 다시 쓰게 한다
  const hard = WRITER_HARD_LIMITS
  if (length(copy.title) > hard.title || length(copy.body) > hard.body || length(copy.caption) > hard.caption || copy.tags.length > hard.tags) {
    blocking.push(`글이 저장할 수 있는 길이를 넘었다(제목 ${String(hard.title)}자, 본문 ${String(hard.body)}자, caption ${String(hard.caption)}자, 태그 ${String(hard.tags)}개) — 형식 규칙의 길이로 다시 써라`)
  }

  const quality = evaluateAdCopy({
    mode: context.mode,
    copy: { title: copy.title, body: copy.body, ...(copy.caption.length > 0 ? { caption: copy.caption } : {}), tags: copy.tags },
    regionTokens: context.region === null ? [] : [context.region],
  })
  blocking.push(...quality.issues.filter((issue) => issue.level === "fail").map((issue) => issue.message))

  for (const { label, pattern } of CONTACT_PATTERNS) {
    if (pattern.test(all)) {
      blocking.push(`${label}를 쓰지 마라 — 주문 링크는 시스템이 따로 붙인다`)
    }
  }

  const emojis = all.match(EMOJI)?.length ?? 0
  if (context.mode === "condolence" && emojis > 0) {
    blocking.push("근조 글에 이모지를 쓰지 마라")
  }

  if (context.kind === "product") {
    const source = compact(context.productEvidence)
    const invented = new Set<string>()
    for (const term of SPEC_TERMS) {
      if (all.includes(term) && !source.includes(compact(term))) {
        invented.add(term)
      }
    }
    for (const pattern of SPEC_PATTERNS) {
      for (const match of all.match(pattern) ?? []) {
        if (!source.includes(compact(match))) {
          invented.add(match.trim())
        }
      }
    }
    if (invented.size > 0) {
      blocking.push(`자료에 없는 상품 사양을 지어냈다: ${[...invented].map((term) => `'${term}'`).join(", ")} — 확인된 구성·사양에 적힌 것만 써라`)
    }
  }

  const style: StyleIssue[] = []
  if (length(copy.title) > spec.titleMax) {
    style.push({ code: "writer:title-length", message: `제목을 ${String(spec.titleMax)}자 이내로 줄여라(현재 ${String(length(copy.title))}자)` })
  }
  const bodyLength = length(copy.body)
  if (bodyLength < spec.bodyMin || bodyLength > spec.bodyMax) {
    style.push({ code: "writer:body-length", message: `본문을 ${String(spec.bodyMin)}~${String(spec.bodyMax)}자로 맞춰라(현재 ${String(bodyLength)}자)` })
  }
  const paragraphs = paragraphCount(copy.body)
  if (paragraphs < spec.paragraphsMin || paragraphs > spec.paragraphsMax) {
    style.push({ code: "writer:paragraphs", message: `문단을 ${String(spec.paragraphsMin)}~${String(spec.paragraphsMax)}개로 나눠라(현재 ${String(paragraphs)}개, 문단 사이는 빈 줄)` })
  }
  if (copy.tags.length < spec.tagsMin || copy.tags.length > spec.tagsMax) {
    style.push({ code: "writer:tags", message: `태그를 ${String(spec.tagsMin)}~${String(spec.tagsMax)}개로 맞춰라(현재 ${String(copy.tags.length)}개)` })
  }
  if (length(copy.caption) > spec.captionMax) {
    style.push({ code: "writer:caption", message: spec.captionMax === 0 ? "caption은 빈 문자열로 둬라" : `caption을 ${String(spec.captionMax)}자 이내로 줄여라` })
  }
  if (/(^|\s)#[^\s#]/.test(copy.body)) {
    style.push({ code: "writer:hashtag-in-body", message: "본문에 해시태그(#)를 넣지 말고 tags에만 넣어라" })
  }
  if (context.mode !== "condolence" && emojis > 2) {
    style.push({ code: "writer:emoji", message: `이모지는 2개까지만 써라(현재 ${String(emojis)}개)` })
  }
  // 반복·빈말·당연한 설명·요약 마무리·예고 첫 문장·예시의 상호·지역 반복 — 캠페인 초안과 같은 문장 검사
  style.push(...checkDraftStyle(copy, { key: `writer-${context.kind}`, prompt: "", must: [], quotedExamples: 0 }, context.region))

  const status = blocking.length > 0 ? "fail" : quality.status === "warn" || style.length > 0 ? "warn" : "pass"
  return { status, blocking, style }
}
