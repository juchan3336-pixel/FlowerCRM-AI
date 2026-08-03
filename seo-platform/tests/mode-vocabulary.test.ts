import { describe, expect, it } from "vitest"

import { evaluateGeneratedContent, type QualityEvaluationInput } from "@/lib/ai/content-quality"
import type { ContentMode } from "@/lib/ai/content-mode"
import {
  findForbiddenModeVocabulary,
  forbiddenVocabularyCode,
  isForbiddenVocabularyCode,
  MODE_VOCABULARY,
  parseForbiddenVocabularyCode,
} from "@/lib/ai/mode-vocabulary"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"
import { decideBatchCandidate } from "@/lib/batch/candidate-policy"
import { decideBatchItemOutcome } from "@/lib/batch/quality-policy"
import { formatBatchItemReason, formatQualityIssueCode } from "@/lib/batch/reason-labels"

const FAQ_A = { question: "행사 날짜에 맞춰 배송할 수 있나요?", answer: "주문 과정에서 도착 시점을 확인할 수 있습니다." }
const FAQ_B = { question: "행사장 반입 위치는 어떻게 확인하나요?", answer: "주문 과정에서 안내되는 정보를 참고하세요." }

function content(overrides: Partial<AiGeneratedSeoContent> = {}): AiGeneratedSeoContent {
  return {
    meta_title: "아이스퀘어호텔 행사·오픈 축하화환 배송",
    meta_description: "행사 일정에 맞춰 화환을 보내려면 주문 과정에서 반입 위치를 확인하세요.",
    description: "김해시 아이스퀘어호텔로 축하화환을 보내는 분을 위한 안내입니다. 반입 위치와 수령 담당자는 주문 과정에서 확인됩니다.",
    faq: [FAQ_A, FAQ_B],
    keywords: ["아이스퀘어호텔", "김해 축하화환", "아이스퀘어호텔 행사화환", "행사 날짜 화환 주문", "축하화환 배송"],
    internal_links: [],
    ...overrides,
  }
}

function find(mode: ContentMode, overrides: Partial<AiGeneratedSeoContent>, placeName = "아이스퀘어호텔", regionTokens: readonly (string | null)[] = ["경남", "김해시"]) {
  return findForbiddenModeVocabulary({ content: content(overrides), mode, placeName, regionTokens })
}

describe("모드별 금지 어휘 정책", () => {
  it("blocks funeral wording in celebration and corporate modes", () => {
    for (const mode of ["celebration", "corporate-celebration"] as const) {
      for (const term of ["근조", "조문", "빈소", "장례", "상주", "유가족", "부고", "고인", "발인"]) {
        expect(MODE_VOCABULARY[mode].forbiddenTerms).toContain(term)
      }
    }
  })

  it("blocks celebration wording in condolence mode", () => {
    for (const term of ["개업", "준공", "취임", "승진", "창립"]) {
      expect(MODE_VOCABULARY.condolence.forbiddenTerms).toContain(term)
    }
    expect(MODE_VOCABULARY.condolence.forbiddenPhrases).toContain("오픈 축하")
  })
})

describe("celebration 금지어 검출", () => {
  it("catches the term in every user-facing field", () => {
    expect(find("celebration", { meta_title: "아이스퀘어호텔 근조화환 주문 안내" })[0]).toMatchObject({ field: "meta_title", term: "근조" })
    expect(find("celebration", { description: "빈소 위치를 먼저 확인하세요." })[0]).toMatchObject({ field: "description", term: "빈소" })
    expect(find("celebration", { faq: [{ question: "조문 화환도 되나요?", answer: "확인 가능합니다." }, FAQ_B] })[0]).toMatchObject({
      field: "faq[0].question",
      term: "조문",
    })
    expect(find("celebration", { faq: [FAQ_A, { question: "수령 담당자는?", answer: "상주에게 문의하세요." }] })[0]).toMatchObject({
      field: "faq[1].answer",
      term: "상주",
    })
    expect(find("celebration", { keywords: ["아이스퀘어호텔", "김해 장례식장 화환"] })[0]).toMatchObject({ field: "keywords[1]", term: "장례식장" })
  })

  it("passes clean celebration content", () => {
    expect(find("celebration", {})).toEqual([])
  })
})

describe("corporate-celebration 금지어 검출", () => {
  const place = "KCC 울산공장"
  const region = ["울산", "동구"]

  it("catches funeral wording and allows corporate celebration wording", () => {
    expect(find("corporate-celebration", { meta_title: "KCC 울산공장 근조화환 안내" }, place, region)[0]).toMatchObject({ term: "근조" })
    expect(find("corporate-celebration", { description: "장례 절차와 무관합니다." }, place, region)[0]).toMatchObject({ term: "장례" })
    expect(find("corporate-celebration", { faq: [{ question: "유가족 확인이 필요한가요?", answer: "네." }, FAQ_B] }, place, region)[0]).toMatchObject({
      term: "유가족",
    })
    expect(find("corporate-celebration", { keywords: ["부고 화환"] }, place, region)[0]).toMatchObject({ field: "keywords[0]", term: "부고" })

    // 정상 기업 축하 표현은 통과
    expect(
      find(
        "corporate-celebration",
        {
          meta_title: "KCC 울산공장 개업·이전 축하화환 주문 안내",
          description: "준공식·창립 기념 행사에 맞춰 보내는 축하화환 안내입니다. 취임 축하도 같은 절차입니다.",
          keywords: ["울산 개업화환", "KCC 울산공장 준공화환"],
        },
        place,
        region,
      ),
    ).toEqual([])
  })
})

describe("condolence 금지어 검출", () => {
  const place = "남대구전문장례식장"
  const region = ["대구", "달서구"]
  const CONDOLENCE_FAQ_B = { question: "받는 분 정보는 어떻게 입력하나요?", answer: "주문 과정에서 안내됩니다." }
  const condolence = {
    meta_title: "남대구전문장례식장 근조화환 주문 안내",
    meta_description: "빈소명과 받는 분 정보를 확인한 뒤 주문하세요.",
    description: "남대구전문장례식장으로 근조화환을 보내는 분을 위한 안내입니다. 빈소 정보는 주문 과정에서 확인됩니다.",
    faq: [{ question: "빈소명을 모를 때 어떻게 확인하나요?", answer: "장례식장이나 관계자에게 문의하세요." }, CONDOLENCE_FAQ_B],
    keywords: ["남대구전문장례식장", "대구 근조화환"],
  }

  it("allows condolence wording and blocks celebration wording", () => {
    expect(find("condolence", condolence, place, region)).toEqual([])
    // 같은 자리에서 파생된 중복은 가장 구체적인 표현 하나만 남는다 — '개업 축하'를 잡았으면 '개업'은 따로 보고하지 않는다.
    const openingFindings = find("condolence", { ...condolence, meta_title: "남대구전문장례식장 개업 축하화환 안내" }, place, region).filter(
      (f) => f.field === "meta_title",
    )
    expect(openingFindings.map((f) => f.term)).toEqual(["개업 축하"])
    expect(find("condolence", { ...condolence, description: "준공 기념 행사 안내입니다." }, place, region)[0]).toMatchObject({ term: "준공" })
    expect(
      find("condolence", { ...condolence, faq: [{ question: "취임 축하도 되나요?", answer: "확인하세요." }, CONDOLENCE_FAQ_B] }, place, region).map((f) => f.term),
    ).toContain("취임 축하")
  })
})

describe("오탐 방지", () => {
  it("ignores the place's own name and region even when they contain a forbidden word", () => {
    // 경북 상주시의 행사장 — 지역명 '상주'가 금지어와 겹친다.
    expect(
      find("celebration", { description: "상주시 상주그랜드호텔에서 열리는 행사에 보내는 화환 안내입니다." }, "상주그랜드호텔", ["경북", "상주시"]),
    ).toEqual([])
    // 마스킹 후에도 남은 표현은 잡는다.
    expect(find("celebration", { description: "상주시 상주그랜드호텔 빈소로 보냅니다." }, "상주그랜드호텔", ["경북", "상주시"])[0]).toMatchObject({ term: "빈소" })
  })

  it("does not inspect link hrefs — only user-facing labels", () => {
    expect(find("celebration", { internal_links: [{ href: "/places/funeral-jangrye-hall", label: "행사 안내" }] })).toEqual([])
    expect(find("celebration", { internal_links: [{ href: "/places/x", label: "빈소 안내" }] })[0]).toMatchObject({ field: "internal_links[0].label", term: "빈소" })
  })

  it("skips empty fields and reports one finding per field/term", () => {
    const findings = find("celebration", { meta_title: "근조 근조 근조화환", meta_description: "" })
    expect(findings.filter((finding) => finding.field === "meta_title" && finding.term === "근조")).toHaveLength(1)
    expect(findings.some((finding) => finding.field === "meta_description")).toBe(false)
  })

  it("keeps only the most specific term when one contains another", () => {
    // '장례식장'과 '장례'가 같은 자리에서 동시에 보고되면 운영 화면에 같은 문제가 두 번 뜬다.
    expect(find("celebration", { meta_title: "아이스퀘어호텔 장례식장 화환 주문 정보" }).map((f) => f.term)).toEqual(["장례식장"])
    // 다른 위치에 따로 나온 '장례'는 그대로 잡는다.
    expect(find("celebration", { meta_title: "장례식장", description: "장례 절차 안내" }).map((f) => `${f.field}:${f.term}`)).toEqual([
      "meta_title:장례식장",
      "description:장례",
    ])
  })
})

describe("품질 판정에서 fail이 우선한다", () => {
  const base: Omit<QualityEvaluationInput, "content" | "mode"> = {
    placeName: "아이스퀘어호텔",
    regionTokens: ["경남", "김해시"],
    verifiedInternalPaths: new Set<string>(),
    recentPages: [],
  }

  it("marks the report as fail and emits a parseable code", () => {
    const report = evaluateGeneratedContent({ ...base, mode: "celebration", content: content({ meta_title: "아이스퀘어호텔 빈소 화환 주문 가이드" }) })
    expect(report.status).toBe("fail")
    const issue = report.issues.find((entry) => isForbiddenVocabularyCode(entry.code))
    expect(issue?.level).toBe("fail")
    expect(parseForbiddenVocabularyCode(issue?.code ?? "")).toEqual({ kind: "term", field: "meta_title", term: "빈소" })
  })

  it("stays fail even when other warn issues exist", () => {
    const report = evaluateGeneratedContent({
      ...base,
      mode: "celebration",
      content: content({ meta_title: "아이스퀘어호텔 빈소 안내", keywords: ["근조화환 주문", "장례식장 화환", "화환 주문 안내"] }),
    })
    expect(report.status).toBe("fail")
    expect(report.issues.some((entry) => entry.level === "warn")).toBe(true)
  })

  it("does not check vocabulary when the mode is unknown (구 레코드)", () => {
    const report = evaluateGeneratedContent({ ...base, mode: null, content: content({ meta_title: "아이스퀘어호텔 빈소 화환 주문 가이드" }) })
    expect(report.issues.some((entry) => isForbiddenVocabularyCode(entry.code))).toBe(false)
  })

  it("leaves clean condolence content passing", () => {
    const report = evaluateGeneratedContent({
      ...base,
      placeName: "남대구전문장례식장",
      regionTokens: ["대구", "달서구"],
      mode: "condolence",
      content: content({
        meta_title: "남대구전문장례식장 근조화환 주문 안내",
        meta_description: "빈소명과 받는 분 정보를 확인한 뒤 주문하세요.",
        description: "남대구전문장례식장으로 근조화환을 보내는 분을 위한 안내입니다. 빈소 정보는 주문 과정에서 확인됩니다.",
        faq: [
          { question: "빈소명을 모를 때 어떻게 확인하나요?", answer: "관계자에게 문의하세요." },
          { question: "받는 분 정보는 어떻게 입력하나요?", answer: "주문 과정에서 안내됩니다." },
        ],
        keywords: ["남대구전문장례식장", "대구 근조화환"],
      }),
    })
    expect(report.issues.filter((entry) => isForbiddenVocabularyCode(entry.code))).toEqual([])
  })
})

describe("Batch 판정: 검토 대기로 통과하지 않는다", () => {
  const vocabularyIssue = { level: "fail" as const, code: forbiddenVocabularyCode({ mode: "celebration", field: "meta_title", term: "빈소", kind: "term" }), message: "x" }

  it("routes forbidden vocabulary to a controlled retry, not needs-review", () => {
    expect(decideBatchItemOutcome({ status: "fail", issues: [vocabularyIssue] })).toEqual({ kind: "retry-vocabulary", reason: "forbidden-mode-vocabulary" })
  })

  it("prefers the vocabulary route over other fail codes", () => {
    const outcome = decideBatchItemOutcome({ status: "fail", issues: [vocabularyIssue, { level: "fail", code: "repeat:faq", message: "y" }] })
    expect(outcome).toEqual({ kind: "retry-vocabulary", reason: "forbidden-mode-vocabulary" })
  })

  it("keeps the existing repeat:faq retry untouched", () => {
    expect(decideBatchItemOutcome({ status: "fail", issues: [{ level: "fail", code: "repeat:faq", message: "y" }] })).toEqual({
      kind: "retry-faq",
      reason: "quality-fail-repeat-faq",
    })
  })
})

describe("운영 화면 표시", () => {
  it("explains which field and which word failed", () => {
    expect(formatQualityIssueCode(forbiddenVocabularyCode({ mode: "celebration", field: "meta_title", term: "빈소", kind: "term" }))).toBe(
      "제목에 업종과 맞지 않는 표현 '빈소'",
    )
    expect(formatQualityIssueCode(forbiddenVocabularyCode({ mode: "celebration", field: "faq[1].answer", term: "상주", kind: "term" }))).toBe(
      "FAQ 2 답변에 업종과 맞지 않는 표현 '상주'",
    )
    expect(formatQualityIssueCode(forbiddenVocabularyCode({ mode: "celebration", field: "keywords[3]", term: "근조", kind: "term" }))).toBe(
      "키워드 4에 업종과 맞지 않는 표현 '근조'",
    )
  })

  it("labels the item reasons for both the first block and the after-retry block", () => {
    expect(formatBatchItemReason("forbidden-mode-vocabulary")).toBe("업종에 맞지 않는 표현이 있어 적용·게시하지 않음")
    expect(formatBatchItemReason("forbidden-mode-vocabulary-after-retry")).toBe("복구 재시도 후에도 업종에 맞지 않는 표현이 남아 중단함")
  })
})

describe("후보 자격은 이 PR에서도 열리지 않는다", () => {
  it("still allows funeral only", () => {
    const place = { id: "p1", status: "draft" as const, slug: "x", official_verification_status: "verified" as const, exclusion_reason: null, category: "funeral" }
    const base = { place, generationCount: 0, seoPagePathExists: false, slugDuplicateCount: 0 }
    expect(decideBatchCandidate(base)).toEqual({ eligible: true })
    for (const category of ["호텔", "숙박/행사", "제조", "건설/부동산", "hospital", "자동차"]) {
      expect(decideBatchCandidate({ ...base, place: { ...place, category } })).toEqual({ eligible: false, reason: "category-unsupported" })
    }
  })
})
