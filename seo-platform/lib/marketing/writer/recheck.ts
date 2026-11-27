// 광고 글쓰기 결과를 사람이 고쳐 다시 검사 — AI 호출·DB 쓰기 없음, 원본 기록 불변.
// 서버 액션(recheckWriterAction)은 관리자 확인과 원본 조회만 하고 판정은 여기서 한다.
import type { MarketingWriterOutputRow } from "@/types/database"

import { writerHardLimitViolation } from "../repository"

import { checkWriterCopy } from "./check"
import { normalizeTags } from "./prompt"
import { productEvidenceOf } from "./service"
import { writerFullText, type WriterRecheckState } from "./view"

export type WriterEdit = {
  readonly title: string
  readonly body: string
  // 띄어쓰기·쉼표로 구분한 태그 입력
  readonly tags: string
  // 한 줄 요약 — 고치거나 비울 수 있다(원본의 금지 표현 때문에 재검사가 계속 막히지 않게)
  readonly caption: string
}

export function recheckWriterOutput(row: MarketingWriterOutputRow, edit: WriterEdit): WriterRecheckState {
  const title = edit.title.trim()
  const body = edit.body.replaceAll("\r\n", "\n").trim()
  const tags = normalizeTags(edit.tags.split(/[\s,]+/))
  const caption = edit.caption.trim()
  if (title.length === 0 || body.length === 0) {
    return { status: "error", message: "제목과 본문을 비우지 말아 주세요." }
  }
  if (writerHardLimitViolation({ region: row.region, topic: row.topic, productName: row.product_name, productSpecs: row.product_specs, title, body, tags, caption }) !== null) {
    return { status: "error", message: "글이 너무 깁니다. 제목 200자, 본문 4,000자, 한 줄 요약 200자, 태그 10개 이내로 줄여 주세요." }
  }
  const check = checkWriterCopy({ title, body, tags, caption }, { mode: row.mode, kind: row.output_kind, channel: row.channel_code, region: row.region, productEvidence: productEvidenceOf(row.product_name, row.product_specs) })
  return {
    status: "checked",
    quality: check.status,
    issues: [...check.blocking, ...check.style.map((issue) => issue.message)],
    title,
    body,
    tags,
    caption,
    fullText: writerFullText({ ...row, title, body, tags, caption: caption.length > 0 ? caption : null }),
  }
}
