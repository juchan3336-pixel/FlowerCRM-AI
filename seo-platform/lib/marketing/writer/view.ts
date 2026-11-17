// 광고 글쓰기 화면용 값 — 안내 문구, 결과의 복사용 문장, 저장된 주문 링크 읽기.
import type { MarketingWriterOutputRow } from "@/types/database"

import { getMarketingChannel, isMarketingChannelCode } from "../channel-policy"
import { getOrderDestination } from "../order-destination"
import type { OrderDestinationCode } from "../types"

import { WRITER_KIND_SPECS } from "./spec"
import type { WriterFailure } from "./service"

const FAILURE_MESSAGES: Readonly<Record<WriterFailure | "writer-missing" | "server", string>> = {
  "input-mode": "글 종류(근조·축하·기업 축하)를 골라 주세요.",
  "input-target": "만들 결과물을 골라 주세요.",
  "input-topic": "주제를 적어 주세요.",
  "input-too-long": "입력이 너무 깁니다. 지역 20자, 주제·강조할 점 200자, 상품명 40자, 구성·사양 300자 이내로 줄여 주세요.",
  "input-product-name": "상품 설명을 만들려면 상품명을 적어 주세요.",
  "input-destinations": "주문 링크를 붙일 곳을 골라 주세요.",
  "ai-disabled": "광고 AI가 꺼져 있습니다. Vercel 환경 변수 MARKETING_AI_PROVIDER=openai, OPENAI_API_KEY, OPENAI_MODEL을 확인해 주세요.",
  "ai-cost-too-high": "설정된 AI 모델은 글 한 편의 예상 비용이 허용 범위를 넘습니다. OPENAI_MODEL을 gpt-4.1-mini로 설정해 주세요.",
  duplicate: "같은 요청을 이미 받았습니다. 아래 최근 작성 목록에서 결과를 확인해 주세요.",
  "cap-daily-count": "오늘 만들 수 있는 AI 글 수(하루 30편, 캠페인 초안 포함)를 모두 썼습니다. 내일 다시 시도해 주세요.",
  "cap-daily-usd": "오늘의 AI 생성 예산(1달러)을 모두 썼습니다. 내일 다시 시도해 주세요.",
  "cap-monthly-usd": "이번 달 AI 생성 예산(10달러)을 모두 썼습니다.",
  "ai-unknown": "AI 응답을 받지 못했습니다. 요청이 처리됐는지 알 수 없어 자동으로 다시 시도하지 않았습니다. 잠시 뒤 다시 눌러 주세요.",
  "ai-failed": "AI가 규칙에 맞는 글을 만들지 못했습니다. 주제를 조금 바꿔 다시 시도해 주세요.",
  "save-failed": "글은 만들었지만 저장하지 못했습니다. 다시 시도해 주세요.",
  "writer-missing": "광고 글쓰기 테이블이 없습니다. migration 202611170001_marketing_writer.sql을 실행해 주세요.",
  server: "저장소에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
}

const NOTICE_MESSAGES: Readonly<Record<string, string>> = {
  "writer-done": "글을 만들었습니다. 내용을 확인하고 복사해 쓰세요.",
  "writer-warn": "글을 만들었지만 다듬을 곳이 남았습니다. 아래 안내를 보고 고쳐 쓰세요.",
  "writer-fail": "금지 규칙에 걸린 글이라 복사할 수 없습니다. 주제를 바꿔 다시 만들어 주세요.",
}

export function writerFailureMessage(code: string): string {
  return Object.hasOwn(FAILURE_MESSAGES, code) ? FAILURE_MESSAGES[code as keyof typeof FAILURE_MESSAGES] : FAILURE_MESSAGES.server
}

export function writerNoticeMessage(code: string): string | null {
  return Object.hasOwn(NOTICE_MESSAGES, code) ? (NOTICE_MESSAGES[code] ?? null) : null
}

export type WriterOrderLink = { readonly destination: OrderDestinationCode; readonly label: string; readonly url: string }

// 저장된 주문 링크를 읽는다 — 형식이 맞지 않는 항목은 버린다
export function writerOrderLinks(row: MarketingWriterOutputRow): readonly WriterOrderLink[] {
  if (!Array.isArray(row.order_links)) {
    return []
  }
  const links: WriterOrderLink[] = []
  for (const entry of row.order_links as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue
    }
    const record = entry as Readonly<Record<string, unknown>>
    const destination = record["destination"]
    const url = record["url"]
    if ((destination === "imweb" || destination === "smartstore") && typeof url === "string") {
      links.push({ destination, label: getOrderDestination(destination).label, url })
    }
  }
  return links
}

export function writerTargetLabel(row: MarketingWriterOutputRow): string {
  const kind = WRITER_KIND_SPECS[row.output_kind].label
  return row.channel_code !== null && row.output_kind === "sns" && isMarketingChannelCode(row.channel_code) ? `${kind} — ${getMarketingChannel(row.channel_code).label}` : kind
}

export function hashtagLine(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ")
}

// "전체 복사" — 게시 편집기에 그대로 붙여 넣을 순서. 상품 설명은 태그를 스토어의 태그 칸에 따로 넣으므로 본문만.
export function writerFullText(row: MarketingWriterOutputRow): string {
  if (row.output_kind === "product") {
    return `${row.title}\n\n${row.body}`
  }
  const parts = [row.title, row.body]
  const links = writerOrderLinks(row)
  if (links.length > 0) {
    parts.push(links.map((link) => `${link.label}에서 주문하기: ${link.url}`).join("\n"))
  }
  if (row.tags.length > 0) {
    parts.push(hashtagLine(row.tags))
  }
  return parts.join("\n\n")
}

// 직접 고쳐서 다시 검사한 결과 — 원본 기록은 바꾸지 않고, 고친 글을 같은 규칙으로 다시 검사해 통과하면 복사하게 한다(AI 비용 없음)
export type WriterRecheckState =
  | { readonly status: "idle" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "checked"
      readonly quality: "pass" | "warn" | "fail"
      readonly issues: readonly string[]
      readonly title: string
      readonly body: string
      readonly tags: readonly string[]
      readonly fullText: string
    }
