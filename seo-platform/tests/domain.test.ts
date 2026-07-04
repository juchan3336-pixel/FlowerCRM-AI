import { describe, expect, it } from "vitest"
import { SEO_DERIVED_PLACE_COLUMNS, SOURCE_OWNED_PLACE_COLUMNS } from "@/lib/domain/constants"
import { createSourceKey, normalizeCompanyName, normalizePhone } from "@/lib/domain/normalize"
import { mapCategory, parsePlaceImport } from "@/lib/domain/sheet-row"
import { createBaseSlug, createUniqueSlug } from "@/lib/domain/slug"

describe("place normalization", () => {
  it("normalizes company names and phone numbers when creating source keys", () => {
    const sourceKey = createSourceKey({ name: "(주) 서울 성모 병원", phone: "02-123-4567" })

    expect(normalizeCompanyName("㈜ 서울 성모 병원")).toBe("서울성모병원")
    expect(normalizePhone("02-123-4567")).toBe("021234567")
    expect(sourceKey).toBe("서울성모병원|021234567")
  })

  it("falls back to normalized address when phone is missing", () => {
    const sourceKey = createSourceKey({ name: "유한회사 평화장례식장", address: "서울 강남구 테헤란로 1" })

    expect(sourceKey).toBe("평화장례식장|서울강남구테헤란로1")
  })

  it("maps Sheet categories into SEO platform domain categories", () => {
    expect(mapCategory("병원", "종합병원")).toBe("hospital")
    expect(mapCategory("장례식장", "전문장례식장")).toBe("funeral")
    expect(mapCategory("제조업", "화환 제조")).toBe("제조업")
  })
})

describe("sheet row parsing", () => {
  it("parses Sheet-shaped rows into source-owned place imports", () => {
    const result = parsePlaceImport(
      {
        회사명: "부산 중앙병원",
        업종: "병원",
        세부업종: "종합병원",
        지역: "부산 해운대구",
        주소: "부산 해운대구 센텀중앙로 1",
        대표전화: "051-111-2222",
        홈페이지: "https://example.com",
        이메일: "private@example.com",
        출처URL: "https://source.example.com",
        수집일: "2026-07-03",
        등급: "A",
        영업상태: "영업대상",
        메모: "internal note",
      },
      { sheetName: "기업 DB", rowNumber: 2 },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.source_key).toBe("부산중앙병원|0511112222")
    expect(result.value.category).toBe("hospital")
    expect(result.value.city).toBe("부산")
    expect(result.value.district).toBe("해운대구")
  })

  it("rejects malformed rows before they reach Supabase", () => {
    const result = parsePlaceImport({ 업종: "병원" }, { sheetName: "기업 DB", rowNumber: 3 })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.kind).toBe("invalid_shape")
  })

  it("keeps Sheet sync columns separate from SEO-derived columns", () => {
    const seoColumns: readonly string[] = SEO_DERIVED_PLACE_COLUMNS
    const overlap = SOURCE_OWNED_PLACE_COLUMNS.filter((column) => seoColumns.includes(column))

    expect(overlap).toEqual([])
    expect(SEO_DERIVED_PLACE_COLUMNS).toContain("meta_description")
    expect(SOURCE_OWNED_PLACE_COLUMNS).toContain("imported_payload")
  })
})

describe("slug generation", () => {
  it("creates stable ASCII-safe slugs with collision suffixes", () => {
    const baseSlug = createBaseSlug({
      pageType: "funeral",
      city: "Seoul",
      district: "Seocho",
      name: "Seoul St. Mary",
    })

    expect(baseSlug).toBe("funeral-seoul-seocho-seoul-st-mary")
    expect(createUniqueSlug(baseSlug, new Set([baseSlug]))).toBe(
      "funeral-seoul-seocho-seoul-st-mary-2",
    )
  })

  it("creates deterministic ASCII-safe slugs from Korean Sheet values", () => {
    const baseSlug = createBaseSlug({
      pageType: "hospital",
      city: "서울",
      district: "서초구",
      name: "서울 성모 병원",
    })

    expect(baseSlug).toMatch(/^hospital-[a-z0-9-]+$/)
    expect(baseSlug).not.toBe("hospital")
  })
})
