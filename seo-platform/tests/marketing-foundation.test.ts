import { describe, expect, it } from "vitest"

import type { ContentMode } from "@/lib/ai/content-mode"
import { scanBannedExpressions } from "@/lib/ai/content-quality"
import { findForbiddenModeVocabulary } from "@/lib/ai/mode-vocabulary"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"
import { evaluateAdCopy } from "@/lib/marketing/ad-quality"
import { approveVariant, computeVariantApprovalHash, confirmManualPost, isVariantApprovalValid } from "@/lib/marketing/approval"
import { getMarketingChannel, isMarketingChannelCode, listMarketingChannels } from "@/lib/marketing/channel-policy"
import { canTransitionDistribution, isPostedStatus, isTerminalDistributionStatus } from "@/lib/marketing/distribution-state"
import { buildSampleVariant, SAMPLE_AD_COPY } from "@/lib/marketing/fixtures"
import { checkDestinationUrl, DestinationUrlError, getOrderDestination, listOrderDestinations, resolveOrderDestination } from "@/lib/marketing/order-destination"
import { buildTrackedOrderUrl, TrackingCodeError, trackingKindFor } from "@/lib/marketing/tracking-url"
import type { OrderDestinationCode } from "@/lib/marketing/types"

const MODES: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]
const DESTINATIONS: readonly OrderDestinationCode[] = ["imweb", "smartstore"]
const SMARTSTORE_HOME = "https://smartstore.naver.com/free77888"
const IMWEB_HOME = "https://팔도플라워.com"

describe("주문 목적지", () => {
  it("자사몰과 스마트스토어 두 곳을 제공한다", () => {
    expect(listOrderDestinations().map((destination) => destination.code)).toEqual(["imweb", "smartstore"])
    expect(getOrderDestination("imweb").baseUrl).toBe(IMWEB_HOME)
    expect(getOrderDestination("smartstore").baseUrl).toBe(SMARTSTORE_HOME)
  })

  it("네이버 계열 채널은 스마트스토어, 그 외는 자사몰이 기본이다", () => {
    for (const channel of listMarketingChannels()) {
      const expected = channel.code.startsWith("naver_") ? "smartstore" : "imweb"
      expect(channel.defaultDestination, channel.code).toBe(expected)
    }
  })

  it("운영자가 기본값 대신 다른 목적지를 고를 수 있다", () => {
    const byDefault = resolveOrderDestination({ channel: "naver_blog", mode: "condolence" })
    expect(byDefault).toMatchObject({ url: SMARTSTORE_HOME, target: "store-home", selection: "default" })

    const overridden = resolveOrderDestination({ channel: "naver_blog", mode: "condolence", override: "imweb" })
    expect(overridden).toMatchObject({ url: IMWEB_HOME, target: "store-home", selection: "override" })
  })

  it("승인된 상품 URL이 있으면 그 모드에만 쓰고, 없으면 스토어 홈으로 보낸다", () => {
    const productUrls = { smartstore: { condolence: `${SMARTSTORE_HOME}/products/123` } }
    expect(resolveOrderDestination({ channel: "naver_blog", mode: "condolence", productUrls })).toMatchObject({ url: `${SMARTSTORE_HOME}/products/123`, target: "product" })
    expect(resolveOrderDestination({ channel: "naver_blog", mode: "celebration", productUrls })).toMatchObject({ url: SMARTSTORE_HOME, target: "store-home" })
  })

  it("허용 범위 밖 상품 URL은 거부한다", () => {
    const productUrls = { smartstore: { condolence: "https://smartstore.naver.com/other-seller/products/1" } }
    expect(() => resolveOrderDestination({ channel: "naver_blog", mode: "condolence", productUrls })).toThrow(DestinationUrlError)
  })

  it.each([
    ["imweb", IMWEB_HOME, true],
    ["imweb", "https://www.팔도플라워.com/shop?idx=3", true],
    ["imweb", "https://xn--hq1bo4e93ri3lbmc.com/shop", true],
    ["imweb", "http://팔도플라워.com", false],
    ["imweb", "https://팔도플라워.com.evil.example/shop", false],
    ["imweb", "https://user:pw@팔도플라워.com", false],
    ["imweb", "https://팔도플라워.com:8443", false],
    ["imweb", SMARTSTORE_HOME, false],
    ["smartstore", SMARTSTORE_HOME, true],
    ["smartstore", `${SMARTSTORE_HOME}/products/987`, true],
    ["smartstore", "https://smartstore.naver.com/free778889", false],
    ["smartstore", "https://smartstore.naver.com/", false],
    ["smartstore", "https://m.smartstore.naver.com/free77888", false],
    ["smartstore", "not a url", false],
  ] as const)("%s 목적지 URL 검사: %s → %s", (code, url, ok) => {
    expect(checkDestinationUrl(code, url).ok).toBe(ok)
  })
})

describe("추적 주문 링크", () => {
  it("자사몰은 UTM 네 개를 붙이고 한글 도메인을 그대로 둔다", () => {
    const tracked = buildTrackedOrderUrl({ channel: "instagram", destination: "imweb", baseUrl: IMWEB_HOME, campaignCode: "wedding-ribbon-01", variantCode: "v2" })
    expect(tracked.trackingKind).toBe("utm")
    expect(tracked.url).toBe("https://팔도플라워.com?utm_source=instagram&utm_medium=organic_social&utm_campaign=wedding-ribbon-01&utm_content=v2")
  })

  it("스마트스토어는 nt 파라미터만 붙이고 UTM은 붙이지 않는다", () => {
    const tracked = buildTrackedOrderUrl({ channel: "naver_blog", destination: "smartstore", baseUrl: SMARTSTORE_HOME, campaignCode: "condolence-guide-01", variantCode: "v1", keyword: "funeral-wreath" })
    expect(tracked.trackingKind).toBe("naver-nt")
    expect(tracked.url).toBe(`${SMARTSTORE_HOME}?nt_source=naver_blog&nt_medium=organic_social&nt_detail=condolence-guide-01.v1&nt_keyword=funeral-wreath`)
    expect(tracked.url).not.toContain("utm_")
  })

  it("네이버 검색광고 → 스마트스토어는 매체 자동 추적이라 파라미터를 붙이지 않는다", () => {
    const tracked = buildTrackedOrderUrl({ channel: "naver_search_ad", destination: "smartstore", baseUrl: SMARTSTORE_HOME, campaignCode: "c1", variantCode: "v1" })
    expect(tracked).toEqual({ url: SMARTSTORE_HOME, trackingKind: "platform-auto", params: {} })
    // 같은 검색광고라도 자사몰로 보내면 UTM으로 추적한다
    expect(trackingKindFor("naver_search_ad", "imweb")).toBe("utm")
  })

  it("기존 query·hash는 보존하고 같은 추적 키는 새 값으로 바꾼다", () => {
    const tracked = buildTrackedOrderUrl({
      channel: "kakao_channel",
      destination: "imweb",
      baseUrl: "https://팔도플라워.com/shop_view?idx=12&utm_source=old&utm_campaign=old#detail",
      campaignCode: "corp-01",
      variantCode: "v3",
    })
    expect(tracked.url).toBe("https://팔도플라워.com/shop_view?idx=12&utm_source=kakao_channel&utm_medium=organic_social&utm_campaign=corp-01&utm_content=v3#detail")
    expect(tracked.url.match(/utm_source=/g)).toHaveLength(1)
  })

  it("한글·공백·전화번호 형태의 코드는 링크에 싣지 않는다", () => {
    const base = { channel: "naver_blog", destination: "smartstore", baseUrl: SMARTSTORE_HOME, variantCode: "v1" } as const
    expect(() => buildTrackedOrderUrl({ ...base, campaignCode: "근조 캠페인" })).toThrow(TrackingCodeError)
    expect(() => buildTrackedOrderUrl({ ...base, campaignCode: "a b" })).toThrow(TrackingCodeError)
    expect(() => buildTrackedOrderUrl({ ...base, campaignCode: "" })).toThrow(TrackingCodeError)
    expect(() => buildTrackedOrderUrl({ ...base, campaignCode: "c1", keyword: "홍길동" })).toThrow(TrackingCodeError)
  })

  it("캠페인·소재 조합이 다르면 nt_detail도 다르다", () => {
    const base = { channel: "naver_blog", destination: "smartstore", baseUrl: SMARTSTORE_HOME } as const
    const first = buildTrackedOrderUrl({ ...base, campaignCode: "a-b", variantCode: "c" })
    const second = buildTrackedOrderUrl({ ...base, campaignCode: "a", variantCode: "b-c" })
    expect(first.params["nt_detail"]).toBe("a-b.c")
    expect(second.params["nt_detail"]).toBe("a.b-c")
    expect(first.url).not.toBe(second.url)
    // 구분자인 마침표는 코드에 쓸 수 없다
    expect(() => buildTrackedOrderUrl({ ...base, campaignCode: "a.b", variantCode: "c" })).toThrow(TrackingCodeError)
  })

  it("목적지 URL에 남아 있던 이전 추적 값은 이번에 지정하지 않아도 지운다", () => {
    const smartstore = buildTrackedOrderUrl({ channel: "naver_blog", destination: "smartstore", baseUrl: `${SMARTSTORE_HOME}/products/5?nt_keyword=old-wedding&tab=review`, campaignCode: "funeral", variantCode: "v1" })
    expect(smartstore.url).toBe(`${SMARTSTORE_HOME}/products/5?tab=review&nt_source=naver_blog&nt_medium=organic_social&nt_detail=funeral.v1`)
    expect(smartstore.params).not.toHaveProperty("nt_keyword")

    const imweb = buildTrackedOrderUrl({ channel: "instagram", destination: "imweb", baseUrl: "https://팔도플라워.com/shop?utm_term=old&idx=3", campaignCode: "c1", variantCode: "v1" })
    expect(imweb.url).not.toContain("utm_term")
    expect(imweb.url).toContain("idx=3")

    // 매체 자동 추적 링크에도 이전 nt 값이 남지 않는다
    const auto = buildTrackedOrderUrl({ channel: "naver_search_ad", destination: "smartstore", baseUrl: `${SMARTSTORE_HOME}?nt_source=naver_blog#top`, campaignCode: "c1", variantCode: "v1" })
    expect(auto.url).toBe(`${SMARTSTORE_HOME}#top`)
  })

  it("목적지와 맞지 않는 URL로는 링크를 만들지 않는다", () => {
    expect(() => buildTrackedOrderUrl({ channel: "naver_blog", destination: "smartstore", baseUrl: IMWEB_HOME, campaignCode: "c1", variantCode: "v1" })).toThrow(DestinationUrlError)
  })
})

describe("채널 목록", () => {
  it("1차는 네이버 세 채널이고 전부 사람 게시다", () => {
    const primary = listMarketingChannels().filter((channel) => channel.tier === "primary")
    expect(primary.map((channel) => channel.code)).toEqual(["naver_search_ad", "naver_blog", "naver_place"])
    expect(listMarketingChannels().every((channel) => channel.publishMode === "manual")).toBe(true)
  })

  it("제외 채널은 코드로 인정하지 않는다", () => {
    expect(isMarketingChannelCode("naver_blog")).toBe(true)
    expect(isMarketingChannelCode("tistory")).toBe(false)
    expect(isMarketingChannelCode("naver_kin")).toBe(false)
    expect(getMarketingChannel("naver_search_ad").medium).toBe("cpc")
  })
})

describe("광고 문안 품질", () => {
  it.each(MODES)("%s 샘플 문안은 통과한다", (mode) => {
    expect(evaluateAdCopy({ mode, copy: SAMPLE_AD_COPY[mode] })).toEqual({ status: "pass", issues: [] })
  })

  it("근조 소재에 축하 어휘가 섞이면 실패한다", () => {
    const report = evaluateAdCopy({ mode: "condolence", copy: { ...SAMPLE_AD_COPY.condolence, body: "개업 축하 화환과 함께 근조화환도 준비됩니다." } })
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code.startsWith("forbidden-mode-"))).toBe(true)
  })

  it.each(["결혼을 축하합니다", "예식장 화환", "웨딩홀 안내", "경축 화환"])("근조 소재의 이미지 문구에 예식·축하 표현 '%s'가 있으면 실패한다", (text) => {
    const report = evaluateAdCopy({ mode: "condolence", copy: { ...SAMPLE_AD_COPY.condolence, imageTexts: [text] } })
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code.startsWith("ad-mode-mix:image_text[0]:"))).toBe(true)
  })

  it("근조 소재의 예식 차단은 장소명에 든 단어를 오탐하지 않는다", () => {
    const copy = { title: "더예식홀장례식장 근조화환 안내", body: "더예식홀장례식장으로 근조화환을 보내실 때는 빈소 호실을 확인해 주세요." }
    expect(evaluateAdCopy({ mode: "condolence", copy, placeName: "더예식홀장례식장" }).status).toBe("pass")
  })

  it("축하 소재의 이미지 문구에 장례 어휘가 있어도 잡는다", () => {
    const report = evaluateAdCopy({ mode: "celebration", copy: { ...SAMPLE_AD_COPY.celebration, imageTexts: ["삼가 고인의 명복을 빕니다"] } })
    expect(report.status).toBe("fail")
    expect(report.issues.map((issue) => issue.message).join(" ")).toContain("image_text[0]")
  })

  it.each([
    ["당일 배송 보장", "delivery-guarantee"],
    ["전국 최저가", "price"],
    ["고객 후기 1위", "review"],
    ["장례식장 제휴 업체", "designated"],
    ["문의 010-1234-5678", "phone"],
  ])("과장·금지 표현 '%s'는 캡션에서도 실패한다", (caption, rule) => {
    const report = evaluateAdCopy({ mode: "condolence", copy: { ...SAMPLE_AD_COPY.condolence, caption } })
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code.startsWith(`banned:${rule}:caption:`))).toBe(true)
  })

  it("지역명이 금지어와 겹치는 경우는 오탐하지 않는다", () => {
    const copy = { title: "상주시 예식장 축하화환 안내", body: "상주시 예식장으로 축하화환을 보내실 때는 예식 날짜와 홀 이름을 확인해 주세요." }
    expect(evaluateAdCopy({ mode: "celebration", copy }).status).toBe("fail")
    expect(evaluateAdCopy({ mode: "celebration", copy, regionTokens: ["상주시"] }).status).toBe("pass")
  })

  it("최근 게시 본문을 그대로 다시 내면 복제로 실패하고, 다른 글은 통과한다", () => {
    const copy = SAMPLE_AD_COPY.condolence
    expect(evaluateAdCopy({ mode: "condolence", copy, recentBodies: [copy.body] }).issues.map((issue) => issue.code)).toEqual(["repetition:body"])
    expect(evaluateAdCopy({ mode: "condolence", copy, recentBodies: [SAMPLE_AD_COPY.celebration.body] }).status).toBe("pass")
  })

  it("제목·본문이 비면 실패한다", () => {
    const report = evaluateAdCopy({ mode: "celebration", copy: { title: " ", body: "" } })
    expect(report.issues.map((issue) => issue.code)).toEqual(["structure:title-empty", "structure:body-empty"])
  })
})

describe("기존 SEO 품질 검사 회귀", () => {
  const content: AiGeneratedSeoContent = {
    meta_title: "거제 호텔 축하화환 안내",
    meta_description: "행사장 축하화환 주문 안내",
    description: "당일 배송으로 빈소까지 보내드립니다.",
    faq: [],
    keywords: [],
    internal_links: [],
  }

  it("콘텐츠 단위 진입점은 필드 단위 진입점과 같은 결과를 낸다", () => {
    expect(scanBannedExpressions(content).map((issue) => issue.code)).toEqual(["banned:delivery-guarantee:description:당일 배송"])
    expect(findForbiddenModeVocabulary({ content, mode: "celebration", placeName: "거제호텔", regionTokens: [] }).map((finding) => `${finding.field}:${finding.term}`)).toEqual(["description:빈소"])
  })
})

describe("승인 스냅샷", () => {
  const approver = { approvedBy: "admin@example.com", approvedAt: "2026-11-10T09:00:00+09:00" }

  it.each(MODES.flatMap((mode) => DESTINATIONS.map((destination) => [mode, destination] as const)))("%s × %s 샘플은 품질 통과 후 승인된다", (mode, destination) => {
    const variant = buildSampleVariant({ mode, channel: "naver_blog", destination })
    expect(variant.destination).toBe(destination)
    expect(checkDestinationUrl(destination, variant.orderUrl).ok).toBe(true)
    expect(variant.orderUrl).toContain(destination === "imweb" ? "utm_source=naver_blog" : "nt_source=naver_blog")

    const decision = approveVariant({ variant, ...approver })
    expect(decision).toMatchObject({ ok: true, quality: { status: "pass" } })
  })

  it("품질 FAIL은 승인할 수 없다", () => {
    const variant = buildSampleVariant({ mode: "condolence", channel: "naver_blog" })
    const bad = { ...variant, copy: { ...variant.copy, body: "당일 배송 보장" } }
    expect(approveVariant({ variant: bad, ...approver })).toMatchObject({ ok: false, reason: "quality-fail", quality: { status: "fail" } })
  })

  it("승인은 넘겨받은 검사 결과가 아니라 지금 소재를 직접 검사한다 — 통과 후 고친 문안은 승인되지 않는다", () => {
    const variant = buildSampleVariant({ mode: "condolence", channel: "naver_blog" })
    expect(evaluateAdCopy({ mode: variant.mode, copy: variant.copy }).status).toBe("pass")
    const edited = { ...variant, copy: { ...variant.copy, imageTexts: ["결혼을 축하합니다"] } }
    expect(approveVariant({ variant: edited, ...approver }).ok).toBe(false)
  })

  it("최근 게시 본문과 같은 글은 승인 단계에서도 막힌다", () => {
    const variant = buildSampleVariant({ mode: "condolence", channel: "naver_blog" })
    expect(approveVariant({ variant, qualityContext: { recentBodies: [variant.copy.body] }, ...approver })).toMatchObject({ ok: false, reason: "quality-fail" })
  })

  it("허용되지 않은 주문 링크나 승인자 누락은 거부한다", () => {
    const variant = buildSampleVariant({ mode: "condolence", channel: "naver_blog" })
    expect(approveVariant({ variant: { ...variant, orderUrl: "https://example.com/shop" }, ...approver })).toEqual({ ok: false, reason: "order-url-not-allowed" })
    expect(approveVariant({ variant, approvedBy: " ", approvedAt: approver.approvedAt })).toEqual({ ok: false, reason: "approver-missing" })
  })

  it("승인 후 문안·이미지·목적지·링크·수정번호 중 하나라도 바뀌면 승인이 무효가 된다", () => {
    const variant = buildSampleVariant({ mode: "celebration", channel: "naver_blog" })
    const decision = approveVariant({ variant, ...approver })
    if (!decision.ok) {
      throw new Error("approval expected")
    }
    const { snapshot } = decision
    expect(isVariantApprovalValid(snapshot, variant)).toBe(true)
    expect(isVariantApprovalValid(snapshot, { ...variant })).toBe(true)

    const changed = [
      { ...variant, copy: { ...variant.copy, body: `${variant.copy.body} 추가` } },
      { ...variant, copy: { ...variant.copy, imageTexts: ["다른 문구"] } },
      { ...variant, imageRefs: ["sample/other.webp"] },
      { ...variant, destination: "imweb" as const },
      { ...variant, orderUrl: `${variant.orderUrl}&x=1` },
      { ...variant, revision: variant.revision + 1 },
    ]
    for (const current of changed) {
      expect(isVariantApprovalValid(snapshot, current)).toBe(false)
    }
    expect(computeVariantApprovalHash(variant)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("사람 게시 확인은 유효한 승인본과 실제 게시 주소가 있어야 한다", () => {
    const variant = buildSampleVariant({ mode: "corporate-celebration", channel: "naver_blog" })
    const decision = approveVariant({ variant, ...approver })
    if (!decision.ok) {
      throw new Error("approval expected")
    }
    const base = { snapshot: decision.snapshot, current: variant, confirmedBy: "admin@example.com", confirmedAt: "2026-11-10T10:00:00+09:00" }

    const confirmed = confirmManualPost({ ...base, postedUrl: "https://blog.naver.com/paldo/223000000000" })
    expect(confirmed).toMatchObject({ ok: true, confirmation: { revision: 1, approvalHash: decision.snapshot.approvalHash } })

    expect(confirmManualPost({ ...base, postedUrl: "" })).toEqual({ ok: false, reason: "posted-url-invalid" })
    expect(confirmManualPost({ ...base, postedUrl: "http://blog.naver.com/x" })).toEqual({ ok: false, reason: "posted-url-invalid" })
    expect(confirmManualPost({ ...base, confirmedBy: "", postedUrl: "https://blog.naver.com/x" })).toEqual({ ok: false, reason: "confirmer-missing" })
    expect(confirmManualPost({ ...base, current: { ...variant, copy: { ...variant.copy, title: "바뀐 제목" } }, postedUrl: "https://blog.naver.com/x" })).toEqual({ ok: false, reason: "approval-stale" })
  })
})

describe("배포 상태 전이", () => {
  it("사람 게시 경로: 검수 → 승인 → 내보내기 → 게시 확인", () => {
    expect(canTransitionDistribution("draft", "needs_review", "manual")).toBe(true)
    expect(canTransitionDistribution("needs_review", "approved", "manual")).toBe(true)
    expect(canTransitionDistribution("approved", "manual_ready", "manual")).toBe(true)
    expect(canTransitionDistribution("manual_ready", "manual_confirmed", "manual")).toBe(true)
    expect(isTerminalDistributionStatus("manual_confirmed")).toBe(true)
  })

  it("검수·승인을 건너뛸 수 없고, 내보내기만으로 게시 완료가 되지 않는다", () => {
    expect(canTransitionDistribution("draft", "approved", "manual")).toBe(false)
    expect(canTransitionDistribution("draft", "manual_ready", "manual")).toBe(false)
    expect(canTransitionDistribution("approved", "manual_confirmed", "manual")).toBe(false)
    expect(isPostedStatus("manual_ready")).toBe(false)
    expect(isPostedStatus("manual_confirmed")).toBe(true)
  })

  it("게시 방식에 맞는 경로만 열린다", () => {
    expect(canTransitionDistribution("approved", "queued", "manual")).toBe(false)
    expect(canTransitionDistribution("approved", "manual_ready", "api")).toBe(false)
    expect(canTransitionDistribution("approved", "queued", "api")).toBe(true)
    expect(canTransitionDistribution("draft", "needs_review", "disabled")).toBe(false)
    expect(canTransitionDistribution("approved", "manual_ready", "disabled")).toBe(false)
  })

  it("API 응답이 불명확하면 재시도 없이 조회 결과로만 정리한다", () => {
    expect(canTransitionDistribution("publishing", "unknown", "api")).toBe(true)
    expect(canTransitionDistribution("unknown", "publishing", "api")).toBe(false)
    expect(canTransitionDistribution("unknown", "queued", "api")).toBe(false)
    expect(canTransitionDistribution("unknown", "published", "api")).toBe(true)
    expect(canTransitionDistribution("failed", "queued", "api")).toBe(false)
    expect(canTransitionDistribution("failed", "draft", "api")).toBe(true)
  })

  it("채널을 중지해도 이미 접수된 작업의 결과는 기록할 수 있고, 새 진입만 막힌다", () => {
    expect(canTransitionDistribution("publishing", "unknown", "disabled")).toBe(true)
    expect(canTransitionDistribution("publishing", "published", "disabled")).toBe(true)
    expect(canTransitionDistribution("unknown", "published", "disabled")).toBe(true)
    expect(canTransitionDistribution("unknown", "failed", "disabled")).toBe(true)
    expect(canTransitionDistribution("approved", "queued", "disabled")).toBe(false)
    expect(canTransitionDistribution("queued", "publishing", "disabled")).toBe(false)
  })

  it("수정하면 draft로 돌아가 다시 검수받는다", () => {
    expect(canTransitionDistribution("approved", "draft", "manual")).toBe(true)
    expect(canTransitionDistribution("manual_ready", "draft", "manual")).toBe(true)
    expect(canTransitionDistribution("manual_confirmed", "draft", "manual")).toBe(false)
  })
})
