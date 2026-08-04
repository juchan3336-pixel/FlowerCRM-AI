import { describe, expect, it } from "vitest"

import { evaluateGeneratedContent, scanBannedExpressions, type QualityEvaluationInput } from "@/lib/ai/content-quality"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"
import { formatQualityIssueCode, parseBannedCode } from "@/lib/batch/reason-labels"

// 2026-08-03 라마다 Dry-run run-1 실제 응답 그대로 — 가격·요금·금액이 한 글자도 없는데
// 예전 규칙이 `, 원`(쉼표 + 공백 + '원하는'의 첫 음절)을 금액으로 잡아 fail이 났다.
const RAMADA_RUN1: AiGeneratedSeoContent = {
  meta_title: "거제시 호텔·행사장 축하화환 보내는 방법",
  meta_description: "라마다스위츠 거제호텔 축하화환 주문 시 행사장 수령 위치와 리본 문구 작성법 안내.",
  description:
    "거제시 라마다스위츠 거제호텔로 축하화환을 보내실 때는 행사장 내 수령 위치를 반드시 확인하세요. 주소는 경남 거제시 일운면 거제대로 2631이며, 주문 과정에서 행사 날짜와 리본 문구 작성 방법을 확인할 수 있습니다.",
  faq: [
    {
      question: "행사 날짜에 맞춰 화환이 도착하도록 주문 시점을 어떻게 확인하나요?",
      answer: "화환 주문 과정에서 행사 날짜에 맞춰 도착하는 시점을 확인할 수 있으니, 주문 시 꼭 해당 정보를 참고하세요.",
    },
    {
      question: "리본 문구는 어떻게 작성하면 되나요?",
      answer: "주문 과정에서 리본 문구 작성란이 제공되며, 원하는 문구를 직접 입력하여 작성할 수 있습니다.",
    },
  ],
  keywords: ["라마다스위츠 거제호텔", "거제 축하화환", "라마다스위츠 거제호텔 행사화환", "행사 날짜 화환 주문", "거제 오픈 축하화환"],
  internal_links: [],
}

function content(overrides: Partial<AiGeneratedSeoContent> = {}): AiGeneratedSeoContent {
  return { ...RAMADA_RUN1, ...overrides }
}

function priceCodes(value: AiGeneratedSeoContent): readonly string[] {
  return scanBannedExpressions(value)
    .map((issue) => issue.code)
    .filter((code) => code.startsWith("banned:price:"))
}

describe("라마다 run-1 오탐 회귀", () => {
  it("passes the exact content that failed with banned:price", () => {
    expect(scanBannedExpressions(RAMADA_RUN1)).toEqual([])
  })

  it("still passes when evaluated as a whole celebration report", () => {
    const input: QualityEvaluationInput = {
      content: RAMADA_RUN1,
      placeName: "라마다스위츠 거제호텔",
      regionTokens: ["경남", "거제시"],
      mode: "celebration",
      verifiedInternalPaths: new Set<string>(),
      recentPages: [],
    }
    const report = evaluateGeneratedContent(input)
    expect(report.issues.filter((issue) => issue.code.startsWith("banned:"))).toEqual([])
    expect(report.status).not.toBe("fail")
  })
})

describe("실제 가격 표현은 계속 차단한다", () => {
  it.each([
    ["43,000원", "화환은 43,000원입니다."],
    ["43000원", "화환은 43000원입니다."],
    ["5만원", "5만원부터 시작합니다."],
    ["3만 원부터", "3만 원부터 주문할 수 있습니다."],
    ["가격", "가격은 주문 과정에서 확인하세요."],
    ["배송비", "배송비 별도입니다."],
    ["무료", "무료 배송으로 보내드립니다."],
    ["할인", "할인 가격으로 준비했습니다."],
    ["최저가", "최저가로 주문할 수 있습니다."],
    ["금액", "금액은 주문 시 확인됩니다."],
    ["요금", "요금 안내는 주문 과정에서 확인하세요."],
    ["비용", "비용은 별도로 안내됩니다."],
  ])("blocks %s", (_label, description) => {
    expect(priceCodes(content({ description }))).not.toEqual([])
  })
})

describe("정상 문구는 허용한다", () => {
  it.each([
    ["주문 시 확인", "주문 시 확인할 수 있습니다."],
    ["주문 시점", "주문 시점을 확인하세요."],
    ["도착 시점", "도착 시점은 주문 과정에서 확인됩니다."],
    ["원하는 리본 문구", "원하는 리본 문구를 입력할 수 있습니다."],
    ["쉼표 뒤 원하는", "작성란이 제공되며, 원하는 문구를 입력하세요."],
    ["지원 절차", "반입 지원 절차는 주문 과정에서 안내됩니다."],
    ["행사 시 수령", "행사 시 수령 위치를 확인하세요."],
    ["숫자 도로명주소", "주소는 경남 거제시 일운면 거제대로 2631입니다."],
    ["쉼표 뒤 숫자 주소", "주소는 경남 거제시 일운면 거제대로 2631이며, 확인이 필요합니다."],
  ])("allows %s", (_label, description) => {
    expect(priceCodes(content({ description }))).toEqual([])
  })
})

describe("finding 상세", () => {
  it("records rule, field and matched text in the code", () => {
    const codes = priceCodes(content({ description: "화환은 43,000원입니다." }))
    expect(codes).toEqual(["banned:price:description:43,000원"])
    expect(parseBannedCode(codes[0] ?? "")).toEqual({ rule: "price", field: "description", matched: "43,000원" })
  })

  it("points at the exact field, not the whole document", () => {
    const codes = priceCodes(
      content({ faq: [{ question: "가격이 궁금합니다.", answer: "주문 과정에서 확인됩니다." }, RAMADA_RUN1.faq[1] ?? { question: "q", answer: "a" }] }),
    )
    expect(codes).toEqual(["banned:price:faq[0].question:가격"])
  })

  it("does not repeat the same finding for one field", () => {
    expect(priceCodes(content({ description: "가격 가격 가격" }))).toHaveLength(1)
  })

  it("reads as a human sentence in the admin UI", () => {
    expect(formatQualityIssueCode("banned:price:faq[0].answer:43,000원")).toBe("FAQ 1 답변에 '43,000원' — 가격·요금 표현 금지")
    // 규칙만 있는 구 코드도 그대로 읽힌다.
    expect(formatQualityIssueCode("banned:delivery-guarantee")).toBe("배송 가능 여부를 확정적으로 표현함")
  })
})
