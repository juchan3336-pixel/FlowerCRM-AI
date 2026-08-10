// 시설 유형 구분 — 빈소 운영 장례식장과 안치·봉안 시설을 가르는 단일 규칙.
// 2026-08-06 사고(추모공원·봉안당 7곳이 근조 문맥으로 공개)의 회귀 방어.
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  classifyFuneralFacility,
  isLodgingFacilityName,
  isMemorialFacilityName,
  LODGING_FACILITY_EXCLUSION_REASON,
  MEMORIAL_FACILITY_EXCLUSION_REASON,
} from "@/lib/domain/facility-type"
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

describe("숙박 시설 판정 — celebration 혼입 차단 (2026-08-07)", () => {
  it("classifies pure lodging names as lodging facilities", () => {
    for (const name of [
      "까사까미노펜션",
      "인우드펜션형찜질방",
      "솔내음가득히펜션",
      "썬브릿지펜션",
      "더원스파앤풀빌라",
      "거제몽돌팬션",
      "장목모텔",
      "해변민박",
      "포항게스트하우스",
      "산속글램핑장",
      "바다뷰카라반",
      "남해캠핑빌리지",
      "부산역호스텔",
      "지리산야영장",
    ]) {
      expect(isLodgingFacilityName(name), name).toBe(true)
    }
  })

  it("keeps hotels, wedding halls, convention centers, and resorts as celebration venues", () => {
    // 리조트·콘도는 연회장·웨딩홀을 함께 운영하는 곳이 많아 일괄 제외하지 않는다.
    for (const name of ["베니키아 프리미어 호텔 해운대", "MH컨벤션웨딩홀", "웨딩컨벤션 연암", "시그니엘 부산", "소노캄 고양", "빌라쥬 드 아난티", "한화리조트 거제"]) {
      expect(isLodgingFacilityName(name), name).toBe(false)
    }
  })

  it("blocks a verified lodging place in the batch candidate decision", () => {
    const place = {
      id: "p-lodging",
      name: "까사까미노펜션",
      slug: "celebration-ulsan-bukgu-kkasakkaminopensyeon",
      status: "draft" as const,
      category: "숙박/행사",
      official_verification_status: "verified" as const,
      exclusion_reason: null,
      verification_source_urls: ["https://example.test/"],
    }
    const base = { place, generationCount: 0, slugDuplicateCount: 0, seoPagePathExists: false, verificationSourceUrls: place.verification_source_urls, activeBatchItemCount: 0, activeApprovalCount: 0 }
    expect(decideBatchCandidate(base)).toEqual({ eligible: false, reason: "lodging-facility", mode: "celebration" })
    expect(BATCH_INELIGIBLE_LABELS["lodging-facility"]).toContain("숙박")
    // 같은 category의 실제 행사장은 통과한다.
    expect(decideBatchCandidate({ ...base, place: { ...place, name: "MH컨벤션웨딩홀", slug: "celebration-ulsan-namgu-mhkonbensyeonwedinghol" } })).toEqual({
      eligible: true,
      mode: "celebration",
    })
    // condolence 모드는 이 규칙의 대상이 아니다 — '펜션' 문자열이 있어도 category=funeral이면 lodging 검사 없음.
    expect(
      decideBatchCandidate({ ...base, place: { ...place, name: "펜션앞장례식장", category: "funeral", slug: "funeral-x" } }),
    ).toEqual({ eligible: true, mode: "condolence" })
  })

  it("blocks a lodging place at publish time as the final defence", () => {
    const seoPage = { id: "s1", status: "ready" as const, path: "/places/celebration-ulsan-bukgu-kkasakkaminopensyeon" }
    expect(
      decidePublishCandidate({
        place: { id: "p1", status: "draft", official_verification_status: "verified", name: "까사까미노펜션", category: "숙박/행사" },
        seoPage,
        latestGenerationId: "g1",
      }),
    ).toEqual({ eligible: false, reason: "lodging-facility" })
    expect(PUBLISH_INELIGIBLE_LABELS["lodging-facility"]).toContain("숙박")
    expect(
      decidePublishCandidate({
        place: { id: "p1", status: "draft", official_verification_status: "verified", name: "베니키아 프리미어 호텔 해운대", category: "호텔" },
        seoPage,
        latestGenerationId: "g1",
      }),
    ).toEqual({ eligible: true })
  })
})

describe("DB 구분 값", () => {
  it("exposes the exclusion reason codes used by the operations SQL", () => {
    expect(MEMORIAL_FACILITY_EXCLUSION_REASON).toBe("memorial-facility")
    expect(LODGING_FACILITY_EXCLUSION_REASON).toBe("lodging-facility")
  })
})
