// work/remap_source_row_numbers.mjs 는 source_key 정규화를 이식해서 쓴다
// (저장소 루트의 plain .mjs라 seo-platform TS를 직접 import할 수 없다).
// 정규화가 한 글자라도 어긋나면 시트↔DB 매칭이 통째로 틀어져 엉뚱한 행 번호를 쓰게 되므로,
// 두 구현이 같은 결과를 내는지 여기서 고정한다.
import { describe, expect, it } from "vitest"

import { createSourceKey, normalizeAddress, normalizeCompanyName, normalizePhone } from "@/lib/domain/normalize"

const toolUrl = new URL("../../work/remap_source_row_numbers.mjs", import.meta.url)

// 정규화는 부수효과 없는 별도 모듈이라 그대로 import해서 대조할 수 있다 (.mjs라 타입은 여기서 붙인다).
const ported = await import("../../work/source-key.mjs")

const CASES: readonly Readonly<{ name: string; phone?: string; address?: string }>[] = [
  { name: "곽병원 장례식장", phone: "053-1234-5678", address: "대구 중구 국채보상로 531" },
  { name: "(주)전국팔도플라워", phone: "02)123-4567" },
  { name: "㈜대한상사", phone: "" , address: "서울 강남구 테헤란로 1" },
  { name: "주식회사 한빛", address: "부산 해운대구  센텀중앙로  97" },
  { name: "(유)남해상사", phone: "+82 55 640 1919" },
  { name: "유한회사  대구기업", address: "" },
  { name: "  공백 앞뒤  ", phone: "abc" },
  { name: "MiXeD CaSe Co", address: "Seoul GANGNAM" },
  { name: "경상남도립통영노인전문병원 장례식장", phone: "055-640-1919", address: "경남 통영시 도산면 남해안대로 1818 (우)53000" },
  { name: "전화없음상사", address: "경남 김해시 활천로 33" },
]

describe("복구 도구의 source_key 정규화가 seo-platform 구현과 동일하다", () => {
  it("createSourceKey 결과가 모든 케이스에서 일치한다", () => {
    for (const input of CASES) {
      const expected = createSourceKey(input)
      const actual = ported.createSourceKey(input)
      expect(actual, `case: ${JSON.stringify(input)}`).toBe(expected)
    }
  })

  it("개별 정규화 함수도 일치한다", () => {
    for (const value of ["(주)한빛", "㈜대한", "주식회사 상사", "(유)남해", "유한회사 대구", "  A  B  ", "MiXeD"]) {
      expect(ported.normalizeCompanyName(value), `name: ${value}`).toBe(normalizeCompanyName(value))
    }
    for (const value of ["053-1234-5678", "+82 55 640 1919", "abc", ""]) {
      expect(ported.normalizePhone(value), `phone: ${value}`).toBe(normalizePhone(value))
    }
    for (const value of ["대구 중구  국채보상로 531", " Seoul GANGNAM ", ""]) {
      expect(ported.normalizeAddress(value), `address: ${value}`).toBe(normalizeAddress(value))
    }
  })

  it("전화가 있으면 전화 기준, 없으면 주소 기준 키를 만든다", () => {
    expect(ported.createSourceKey({ name: "가나", phone: "010-1111-2222", address: "서울" })).toBe("가나|01011112222")
    expect(ported.createSourceKey({ name: "가나", address: "서울 중구" })).toBe("가나|서울중구")
  })
})

describe("복구 도구 안전 계약", () => {
  it("기본이 dry-run이고 --apply가 있어야만 쓰기 경로로 간다", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(toolUrl, "utf8")
    expect(source).toContain('const APPLY = process.argv.includes("--apply")')
    expect(source).toContain("if (!APPLY) {")
    expect(source).toContain("dry-run 종료 — 쓰기 없음")
  })

  it("UPDATE 대상 컬럼이 source_row_number 하나뿐이다", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(toolUrl, "utf8")
    const bodies = [...source.matchAll(/body: JSON\.stringify\(\{([^}]*)\}\)/g)].map((match) => match[1] ?? "")
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body).toContain("source_row_number")
      // 운영 필드가 하나라도 들어가면 안 된다.
      for (const forbidden of [
        "source_key",
        "name",
        "address",
        "phone",
        "status",
        "slug",
        "description",
        "meta_title",
        "meta_description",
        "faq",
        "keywords",
        "internal_links",
        "order_url",
        "official_verification_status",
        "verified_at",
        "published_at",
        "synced_at",
      ]) {
        expect(body, `forbidden column in UPDATE body: ${forbidden}`).not.toContain(`${forbidden}:`)
      }
    }
  })

  it("조건부 UPDATE로 id와 기존 행 번호를 함께 검사한다", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(toolUrl, "utf8")
    expect(source).toContain("id=eq.${entry.place_id}&source_row_number=eq.${String(entry.from_row)}")
  })

  it("plan과 rollback 파일을 dry-run에서도 항상 남긴다", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(toolUrl, "utf8")
    expect(source).toContain("source_row_remap_plan.json")
    expect(source).toContain("source_row_remap_rollback.json")
    for (const field of ["place_id", "source_key", "from_row", "to_row", "company_name", "generated_at"]) {
      expect(source, `rollback field: ${field}`).toContain(field)
    }
  })

  it("차단 조건이 전부 구현돼 있다", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(toolUrl, "utf8")
    for (const blocker of ["duplicateSourceKeys", "duplicateTargetRows", "unmatchedInSheet", "unmatchedInDb", "ambiguous", "shiftMatchesExpectation", "expectedContinuity"]) {
      expect(source, `blocker: ${blocker}`).toContain(blocker)
    }
    expect(source).toContain("process.exit(1)")
  })

  it("예상 이동량 표가 실측 기준선과 같다", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(toolUrl, "utf8")
    const block = /const EXPECTED_SHIFTS = \{([^}]*)\}/.exec(source)?.[1] ?? ""
    expect(block).toContain("0: 129")
    expect(block).toContain('"-2": 174')
    expect(block).toContain('"-4": 11')
    expect(block).toContain('"-6": 14637')
  })
})
