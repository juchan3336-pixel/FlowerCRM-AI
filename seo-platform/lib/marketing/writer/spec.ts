// 광고 글쓰기 도구 — 결과물 종류별 규칙과 입력 검증.
//
// 관리자 화면 "광고 글쓰기"는 캠페인·검수·배포 작업 없이 글 한 편을 만들어 사람이 복사해 쓰게 한다.
// 결과물마다 길이·문단·태그 기준과 출력 상한이 다르다. 한 요청 = 한 결과물.
// 자유 입력(주제·강조할 점·사양)은 서버에서 길이와 문자를 제한한다 — 생성 요청 크기와 비용 상한의 전제다.
import type { ContentMode } from "@/lib/ai/content-mode"
import type { MarketingWriterOutputKind } from "@/types/database"

import { getMarketingChannel } from "../channel-policy"
import type { MarketingChannelCode, OrderDestinationCode } from "../types"

export type WriterOutputKind = MarketingWriterOutputKind

export type WriterKindSpec = {
  readonly kind: WriterOutputKind
  readonly label: string
  // 생성 요청에 넣는 형식 규칙
  readonly formatRules: readonly string[]
  readonly titleMax: number
  readonly bodyMin: number
  readonly bodyMax: number
  readonly paragraphsMin: number
  readonly paragraphsMax: number
  readonly tagsMin: number
  readonly tagsMax: number
  readonly captionMax: number
  // 이 결과물의 응답 상한(토큰) — 최악 비용 계산의 근거
  readonly maxOutputTokens: number
}

export const WRITER_KIND_SPECS: Readonly<Record<WriterOutputKind, WriterKindSpec>> = {
  blog: {
    kind: "blog",
    label: "네이버 블로그 글",
    formatRules: [
      "제목은 40자 이내. 본문은 500~900자, 4~6개 문단, 문단 사이는 빈 줄 하나.",
      "마크다운 기호(#, *, -)를 쓰지 않는다. 항목을 나열할 때는 '첫째,' '둘째,'처럼 쓴다.",
      "tags는 블로그 태그 3~8개. caption은 한 줄 요약 40자 이내.",
    ],
    titleMax: 40,
    bodyMin: 500,
    bodyMax: 900,
    paragraphsMin: 4,
    paragraphsMax: 6,
    tagsMin: 3,
    tagsMax: 8,
    captionMax: 40,
    maxOutputTokens: 1400,
  },
  sns: {
    kind: "sns",
    label: "SNS·카페 글",
    formatRules: [
      "title은 첫 줄로 쓰는 짧은 제목 30자 이내. 본문은 150~300자, 2~3개 문단, 문단 사이는 빈 줄 하나.",
      "본문에 해시태그(#)를 넣지 않는다. 해시태그는 tags에 3~6개만 넣는다.",
      "후기·체험담처럼 꾸미지 않는다(손님이 쓴 글처럼 보이게 쓰지 않는다). 업체가 쓰는 안내 글임이 드러나게 쓴다.",
      "caption은 빈 문자열로 둔다.",
    ],
    titleMax: 30,
    bodyMin: 150,
    bodyMax: 300,
    paragraphsMin: 2,
    paragraphsMax: 3,
    tagsMin: 3,
    tagsMax: 6,
    captionMax: 0,
    maxOutputTokens: 700,
  },
  product: {
    kind: "product",
    label: "스마트스토어 상품 설명",
    formatRules: [
      "title은 상품 상세 첫 줄에 쓰는 소개 문구 40자 이내. 본문은 300~600자, 3~5개 문단, 문단 사이는 빈 줄 하나.",
      "본문에는 이 상품을 어떤 자리에 보내는지, 리본 문구 예시(작은따옴표), 주문할 때 적을 정보를 쓴다.",
      "상품명과 '확인된 구성·사양'에 적힌 것만 상품 정보로 쓴다. 꽃 종류·크기·높이·단수·원산지·구성품·배송 조건은 자료에 없으면 쓰지 않는다.",
      "tags는 상품 태그 3~8개. caption은 빈 문자열로 둔다.",
    ],
    titleMax: 40,
    bodyMin: 300,
    bodyMax: 600,
    paragraphsMin: 3,
    paragraphsMax: 5,
    tagsMin: 3,
    tagsMax: 8,
    captionMax: 0,
    maxOutputTokens: 1100,
  },
}

// SNS·카페 글을 올릴 수 있는 채널 — 카페는 허가된 홍보 게시판만(channel-policy). 블로그는 naver_blog 고정, 상품 설명은 채널 없음.
// 많이 쓰는 SNS(인스타그램·스레드·페이스북)를 앞에 둔다.
export const WRITER_SNS_CHANNELS: readonly MarketingChannelCode[] = ["instagram", "threads", "facebook_page", "naver_cafe", "kakao_channel", "daangn_biz", "naver_place"]

// 채널마다 태그 개수가 다른 경우 — 스레드는 게시물 하나에 주제 태그를 1개만 붙일 수 있다
export const WRITER_CHANNEL_TAG_LIMITS: Readonly<Partial<Record<MarketingChannelCode, { readonly min: number; readonly max: number }>>> = {
  threads: { min: 1, max: 1 },
}

// 채널별 태그 상한은 플랫폼 규칙이다 — 넘기면 금지(복사 차단)로 본다
export function writerTagCapIsPlatformRule(channel: MarketingChannelCode | null): boolean {
  return channel !== null && WRITER_CHANNEL_TAG_LIMITS[channel] !== undefined
}

export function writerTagLimits(kind: WriterOutputKind, channel: MarketingChannelCode | null): { readonly min: number; readonly max: number } {
  const override = channel === null ? undefined : WRITER_CHANNEL_TAG_LIMITS[channel]
  return override ?? { min: WRITER_KIND_SPECS[kind].tagsMin, max: WRITER_KIND_SPECS[kind].tagsMax }
}

// 화면의 "결과물" 선택지 — 값은 "종류:채널"
export type WriterTarget = { readonly kind: WriterOutputKind; readonly channel: MarketingChannelCode | null }

export function listWriterTargets(): readonly { readonly value: string; readonly label: string; readonly target: WriterTarget }[] {
  return [
    { value: "blog:naver_blog", label: "네이버 블로그 글", target: { kind: "blog", channel: "naver_blog" } },
    ...WRITER_SNS_CHANNELS.map((channel) => ({ value: `sns:${channel}`, label: `${channel === "naver_cafe" ? "카페 글" : "SNS 글"} — ${getMarketingChannel(channel).label}`, target: { kind: "sns" as const, channel } })),
    { value: "product:", label: "스마트스토어 상품 설명", target: { kind: "product", channel: null } },
  ]
}

export function parseWriterTarget(value: string): WriterTarget | null {
  return listWriterTargets().find((option) => option.value === value)?.target ?? null
}

// 입력 길이 상한(글자)
export const WRITER_INPUT_LIMITS = { region: 20, topic: 200, emphasis: 200, productName: 40, productSpecs: 300 } as const

export type WriterDestinationChoice = "both" | OrderDestinationCode

export type WriterRawInput = {
  readonly mode: string
  readonly target: string
  readonly region: string
  readonly topic: string
  readonly emphasis: string
  readonly productName: string
  readonly productSpecs: string
  readonly destinations: string
}

export type WriterInput = {
  readonly mode: ContentMode
  readonly kind: WriterOutputKind
  readonly channel: MarketingChannelCode | null
  readonly region: string | null
  readonly topic: string
  readonly emphasis: string | null
  readonly productName: string | null
  readonly productSpecs: string | null
  // 주문 링크를 붙일 목적지 — 상품 설명은 스토어 안에 쓰므로 없다
  readonly destinations: readonly OrderDestinationCode[]
}

export type WriterInputError = "input-mode" | "input-target" | "input-topic" | "input-too-long" | "input-product-name" | "input-destinations"

const MODES: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]

// 제어 문자와 꺾쇠(<, >)를 지운다 — 생성 요청 안의 자료 구분 표시를 흉내 낼 수 없게 한다. 여러 줄 입력은 사양 칸만 허용.
export function sanitizeWriterText(value: string, multiline = false): string {
  const cleaned = Array.from(value.normalize("NFC").replace(/[<>]/g, ""))
    .map((char) => {
      const code = char.charCodeAt(0)
      const control = code < 0x20 || code === 0x7f
      return control && !(multiline && char === "\n") ? " " : char
    })
    .join("")
  const lines = cleaned.split("\n").map((line) => line.replace(/\s+/g, " ").trim())
  return (multiline ? lines.filter((line) => line.length > 0).join("\n") : lines.join(" ")).trim()
}

function within(value: string, max: number): boolean {
  return Array.from(value).length <= max
}

export function validateWriterInput(raw: WriterRawInput): { readonly ok: true; readonly input: WriterInput } | { readonly ok: false; readonly reason: WriterInputError } {
  const mode = MODES.find((candidate) => candidate === raw.mode)
  if (mode === undefined) {
    return { ok: false, reason: "input-mode" }
  }
  const target = parseWriterTarget(raw.target)
  if (target === null) {
    return { ok: false, reason: "input-target" }
  }
  const region = sanitizeWriterText(raw.region)
  const topic = sanitizeWriterText(raw.topic)
  const emphasis = sanitizeWriterText(raw.emphasis)
  const productName = sanitizeWriterText(raw.productName)
  const productSpecs = sanitizeWriterText(raw.productSpecs, true)
  if (topic.length === 0) {
    return { ok: false, reason: "input-topic" }
  }
  const limits = WRITER_INPUT_LIMITS
  if (!within(region, limits.region) || !within(topic, limits.topic) || !within(emphasis, limits.emphasis) || !within(productName, limits.productName) || !within(productSpecs, limits.productSpecs)) {
    return { ok: false, reason: "input-too-long" }
  }
  if (target.kind === "product" && productName.length === 0) {
    return { ok: false, reason: "input-product-name" }
  }
  let destinations: readonly OrderDestinationCode[] = []
  if (target.kind !== "product") {
    if (raw.destinations === "both") {
      destinations = ["smartstore", "imweb"]
    } else if (raw.destinations === "imweb" || raw.destinations === "smartstore") {
      destinations = [raw.destinations]
    } else {
      return { ok: false, reason: "input-destinations" }
    }
  }
  return {
    ok: true,
    input: {
      mode,
      kind: target.kind,
      channel: target.channel,
      region: region.length > 0 ? region : null,
      topic,
      emphasis: emphasis.length > 0 ? emphasis : null,
      // 상품 정보는 상품 설명에만 쓴다 — 다른 결과물에 섞여 들어가 사실처럼 쓰이지 않게 한다
      productName: target.kind === "product" ? productName : null,
      productSpecs: target.kind === "product" && productSpecs.length > 0 ? productSpecs : null,
      destinations,
    },
  }
}
