// 시설 유형 구분 — 빈소 운영 장례식장과 안치·봉안 시설을 가르는 단일 규칙.
// 2026-08-06 사고(추모공원·봉안당 7곳이 근조 문맥으로 공개)의 회귀 방어.
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { classifyFuneralFacility, isMemorialFacilityName, MEMORIAL_FACILITY_EXCLUSION_REASON } from "@/lib/domain/facility-type"
import { decideBatchCandidate, BATCH_INELIGIBLE_LABELS } from "@/lib/batch/candidate-policy"
import { decidePublishCandidate, PUBLISH_INELIGIBLE_LABELS } from "@/lib/batch/publish-candidate-policy"

describe("시설 유형 판정", () => {
  it("classifies memorial, columbarium, tree-burial, cemetery, sangjo, and pet facilities as non-parlor", () => {
    for (const name of [
      "우성추모공원",
      "안동추모공원 봉안",
      "은해사 수림장",
      "천주교안동교구 봉안경당",
      "구미시추모공원",
      "경주용주사추모공원",
      "삼광사추모공원",
      "쌍룡사 납골당",
      "대원사추모공원 정토원",
      "현대공원 1묘원",
      "남해추모누리공원 자연장지",
      "거제시추모의집",
      "태양상조 함양지점",
      "리틀포즈 반려동물 장례식장",
    ]) {
      expect(classifyFuneralFacility(name), name).toBe("memorial-facility")
      expect(isMemorialFacilityName(name), name).toBe(true)
    }
  })

  it("keeps real funeral parlors — including memorial parks that operate one", () => {
    for (const name of [
      "합천추모공원 장례식장",
      "함안하늘공원 장례식장",
      "창원시립상복공원 장례식장",
      "안동병원 장례식장",
      "대구상례원",
      "김해시민장례식장",
      "명품장례문화원",
      "쉴낙원 양산시민장례식장",
    ]) {
      expect(classifyFuneralFacility(name), name).toBe("funeral-parlor")
      expect(isMemorialFacilityName(name), name).toBe(false)
    }
  })
})

describe("생성 후보 판정 — 시설 유형 차단", () => {
  const place = {
    id: "p1",
    name: "우성추모공원",
    address: "경북 성주군 어딘가",
    phone: "054-000-0000",
    slug: "funeral-gyeongbuk-seongjugun-useongchumogongwon",
    status: "draft" as const,
    category: "funeral",
    official_verification_status: "verified" as const,
    verification_source_urls: ["https://example.test/"],
  }
  const base = { place, generationCount: 0, slugDuplicateCount: 0, seoPagePathExists: false, verificationSourceUrls: place.verification_source_urls, activeBatchItemCount: 0, activeApprovalCount: 0 }

  it("blocks a verified memorial facility even though every other condition passes", () => {
    // verified 상태여도(필터 배포 전 검증분) 명칭 판정에서 막힌다.
    expect(decideBatchCandidate(base)).toEqual({ eligible: false, reason: "memorial-facility", mode: "condolence" })
    expect(BATCH_INELIGIBLE_LABELS["memorial-facility"]).toContain("빈소 없는")
  })

  it("still accepts a real parlor with the same shape", () => {
    expect(decideBatchCandidate({ ...base, place: { ...place, name: "합천추모공원 장례식장" } })).toEqual({ eligible: true, mode: "condolence" })
  })

  it("does not touch non-condolence modes", () => {
    // 이름에 '추모'가 들어간 호텔 등은 celebration 모드라 이 규칙의 대상이 아니다.
    const hotel = { ...base, place: { ...place, name: "추모공원 앞 호텔", category: "호텔" } }
    expect(decideBatchCandidate(hotel)).toEqual({ eligible: true, mode: "celebration" })
  })
})

describe("게시 판정 — 시설 유형 최종 방어 (자동 게시 포함)", () => {
  const seoPage = { id: "s1", status: "ready" as const, path: "/places/funeral-gyeongbuk-seongjugun-useongchumogongwon" }

  it("blocks a memorial facility at publish time even with an applied generation", () => {
    const decision = decidePublishCandidate({
      place: { id: "p1", status: "draft", official_verification_status: "verified", name: "우성추모공원", category: "funeral" },
      seoPage,
      latestGenerationId: "g1",
    })
    expect(decision).toEqual({ eligible: false, reason: "memorial-facility" })
    expect(PUBLISH_INELIGIBLE_LABELS["memorial-facility"]).toContain("빈소 없는")
  })

  it("keeps publishing real parlors and stays backward compatible when name is absent", () => {
    expect(
      decidePublishCandidate({
        place: { id: "p1", status: "draft", official_verification_status: "verified", name: "안동병원 장례식장", category: "funeral" },
        seoPage,
        latestGenerationId: "g1",
      }),
    ).toEqual({ eligible: true })
    // name/category 없이 호출하는 기존 코드 경로는 그대로 통과한다.
    expect(
      decidePublishCandidate({ place: { id: "p1", status: "draft", official_verification_status: "verified" }, seoPage, latestGenerationId: "g1" }),
    ).toEqual({ eligible: true })
  })
})

describe("DB 구분 값", () => {
  it("exposes the exclusion reason code used by the operations SQL", () => {
    expect(MEMORIAL_FACILITY_EXCLUSION_REASON).toBe("memorial-facility")
  })
})
