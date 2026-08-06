// 자동 업체 확인 통과 규칙 — "확실한 것만 통과, 나머지는 사람" 계약을 고정한다.
import { describe, expect, it } from "vitest"

import { decideAutoVerify, hostOf, isNonOfficialHost, SHARED_HOST_THRESHOLD, AUTO_VERIFY_MANUAL_LABELS } from "@/lib/admin/auto-verify-policy"

const full = ["name", "address", "phone"] as const
const base = { homepage: "https://jyfuneralhall.com/", httpStatus: 200, matched: full, textUnavailable: false, sameHostPlaceCount: 1 }

describe("자동 확인 통과 규칙", () => {
  it("passes only a place-owned site where all three fields are confirmed", () => {
    expect(decideAutoVerify(base)).toEqual({ kind: "verified" })
  })

  it("never passes blog/SNS/portal/directory addresses even with a full match", () => {
    // 큐 대상의 16%가 이런 주소다 — 3항목이 다 나와도 그 업체 공식 사이트라는 근거가 못 된다.
    for (const homepage of [
      "https://blog.naver.com/somefuneral",
      "https://m.blog.naver.com/x",
      "https://www.instagram.com/x",
      "http://cafe.daum.net/x",
      "https://namu.wiki/w/x",
      "http://ok114.co.kr/0553715544",
      "https://booking.naver.com/x",
    ]) {
      expect(decideAutoVerify({ ...base, homepage }), homepage).toEqual({ kind: "manual", reason: "blocked-host" })
    }
  })

  it("never passes a host shared by several places (branch lists, franchise sites)", () => {
    expect(decideAutoVerify({ ...base, sameHostPlaceCount: SHARED_HOST_THRESHOLD })).toEqual({ kind: "manual", reason: "shared-host" })
    expect(decideAutoVerify({ ...base, sameHostPlaceCount: SHARED_HOST_THRESHOLD - 1 })).toEqual({ kind: "verified" })
  })

  it("keeps unreachable, unreadable, and partial matches for a human, each with its own reason", () => {
    expect(decideAutoVerify({ ...base, httpStatus: 0 })).toEqual({ kind: "manual", reason: "unreachable" })
    expect(decideAutoVerify({ ...base, httpStatus: 404 })).toEqual({ kind: "manual", reason: "unreachable" })
    expect(decideAutoVerify({ ...base, textUnavailable: true })).toEqual({ kind: "manual", reason: "text-unavailable" })
    expect(decideAutoVerify({ ...base, matched: ["name", "phone"] })).toEqual({ kind: "manual", reason: "insufficient-match" })
    expect(decideAutoVerify({ ...base, matched: [] })).toEqual({ kind: "manual", reason: "insufficient-match" })
    expect(decideAutoVerify({ ...base, homepage: "not a url" })).toEqual({ kind: "manual", reason: "invalid-homepage" })
  })

  it("exposes a human-readable label for every manual reason", () => {
    for (const reason of ["blocked-host", "shared-host", "unreachable", "text-unavailable", "insufficient-match", "invalid-homepage"] as const) {
      expect(AUTO_VERIFY_MANUAL_LABELS[reason].length).toBeGreaterThan(0)
    }
  })

  it("normalises hosts before matching", () => {
    expect(hostOf("https://www.Blog.Naver.com/x")).toBe("blog.naver.com")
    expect(isNonOfficialHost("blog.naver.com")).toBe(true)
    expect(isNonOfficialHost("jyfuneralhall.com")).toBe(false)
  })
})

describe("자동 확인 대상 범위", () => {
  it("labels ineligible rows distinctly instead of calling them a failed match", () => {
    // 2026-08-06: 업종 미지원 행(행정사사무소 등)이 'insufficient-match'로 찍혀
    // "홈페이지에서 확인 못 함"처럼 보였다. 사유가 다르면 라벨도 달라야 한다.
    expect(AUTO_VERIFY_MANUAL_LABELS["not-eligible"]).toContain("업종")
    expect(AUTO_VERIFY_MANUAL_LABELS["not-eligible"]).not.toBe(AUTO_VERIFY_MANUAL_LABELS["insufficient-match"])
  })
})
