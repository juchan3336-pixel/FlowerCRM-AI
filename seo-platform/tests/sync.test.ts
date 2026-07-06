import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { InMemorySyncRepository } from "@/lib/sync/in-memory-repository"
import { syncSheetRows } from "@/lib/sync/service"

const fixturePath = resolve("tests/fixtures/sheet-rows.json")

async function readFixtureRows(): Promise<unknown> {
  return JSON.parse(await readFile(fixturePath, "utf8"))
}

describe("Google Sheets fixture sync", () => {
  it("inserts valid fixture rows and records malformed row errors on first import", async () => {
    // Given: Google Sheets-shaped fixture rows with one malformed row.
    const rows = await readFixtureRows()
    const repository = new InMemorySyncRepository()

    // When: the fixture is synced once.
    const result = await syncSheetRows({ repository, rows, sheetName: "기업 DB" })

    // Then: valid rows are inserted and the bad row is attached to sync_errors.
    expect(result).toMatchObject({ totalRows: 3, inserted: 2, updated: 0, skipped: 0, failed: 1 })
    expect(repository.places()).toHaveLength(2)
    expect(repository.syncRuns()).toHaveLength(1)
    expect(repository.syncErrors()).toHaveLength(1)
    expect(repository.syncErrors()[0]?.error_code).toBe("invalid_shape")
  })

  it("skips repeat imports without creating duplicate places", async () => {
    // Given: a repository that already imported the fixture once.
    const rows = await readFixtureRows()
    const repository = new InMemorySyncRepository()
    await syncSheetRows({ repository, rows, sheetName: "기업 DB" })

    // When: the same fixture is synced again.
    const repeat = await syncSheetRows({ repository, rows, sheetName: "기업 DB" })

    // Then: source keys remain unique and valid duplicate rows are skipped.
    expect(repeat).toMatchObject({ totalRows: 3, inserted: 0, updated: 0, skipped: 2, failed: 1 })
    expect(repository.places()).toHaveLength(2)
    expect(new Set(repository.places().map((place) => place.source_key)).size).toBe(2)
  })

  it("updates source-owned fields while preserving SEO-derived fields", async () => {
    // Given: an imported place with SEO fields edited after import.
    const rows = await readFixtureRows()
    const repository = new InMemorySyncRepository()
    await syncSheetRows({ repository, rows, sheetName: "기업 DB" })
    const firstPlace = repository.places()[0]
    expect(firstPlace).toBeDefined()
    if (firstPlace === undefined) {
      return
    }
    repository.seedSeoFields(firstPlace.source_key, {
      description: "관리자 작성 설명",
      meta_title: "관리자 메타 제목",
      meta_description: "관리자 메타 설명",
      faq: [{ question: "Q", answer: "A" }],
      keywords: ["근조화환"],
      internal_links: [{ href: "/area/seoul", label: "서울" }],
      order_url: "https://팔도플라워.com/custom",
      status: "published",
    })

    // When: the upstream Sheet row changes only source-owned data.
    const changedRows = [
      {
        회사명: "(주) 서울 성모 병원",
        업종: "병원",
        세부업종: "상급종합병원",
        지역: "서울 서초구",
        주소: "서울 서초구 반포대로 222",
        대표전화: "02-123-4567",
        홈페이지: "https://changed.example.com",
        이메일: "changed@hospital.example.com",
        출처URL: "https://source.example.com/hospital",
        수집일: "2026-07-04",
        등급: "S",
        영업상태: "거래기업",
        메모: "changed internal note",
      },
    ] as const
    const result = await syncSheetRows({ repository, rows: changedRows, sheetName: "기업 DB" })

    // Then: sync updates Sheet-owned columns and does not overwrite SEO-owned columns.
    const updatedPlace = repository.findSeededPlace(firstPlace.source_key)
    expect(result).toMatchObject({ inserted: 0, updated: 1, skipped: 0, failed: 0 })
    expect(updatedPlace?.homepage).toBe("https://changed.example.com")
    expect(updatedPlace?.grade).toBe("S")
    expect(updatedPlace?.description).toBe("관리자 작성 설명")
    expect(updatedPlace?.meta_title).toBe("관리자 메타 제목")
    expect(updatedPlace?.meta_description).toBe("관리자 메타 설명")
    expect(updatedPlace?.order_url).toBe("https://팔도플라워.com/custom")
    expect(updatedPlace?.status).toBe("published")
    expect(updatedPlace?.faq).toEqual([{ question: "Q", answer: "A" }])
    expect(updatedPlace?.keywords).toEqual(["근조화환"])
    expect(updatedPlace?.internal_links).toEqual([{ href: "/area/seoul", label: "서울" }])
  })

  it("preserves source row numbers when syncing a later Sheet batch", async () => {
    // Given: a later batch starts at Sheet row 302.
    const rows = [
      {
        회사명: "후속 배치 병원",
        업종: "병원",
        주소: "서울 강남구 테헤란로 1",
        대표전화: "02-111-2222",
      },
    ] as const
    const repository = new InMemorySyncRepository()

    // When: the batch is synced with an explicit first Sheet row number.
    const result = await syncSheetRows({ firstDataRowNumber: 302, repository, rows, sheetName: "기업 DB" })

    // Then: the imported place keeps the original Sheet row number for future continuation.
    expect(result).toMatchObject({ totalRows: 1, inserted: 1, updated: 0, skipped: 0, failed: 0 })
    expect(repository.places()[0]?.source_row_number).toBe(302)
  })

  it("updates a same-batch duplicate source key after the first insert", async () => {
    // Given: two rows resolve to the same source key in one batch.
    const rows = [
      {
        회사명: "중복 병원",
        업종: "병원",
        주소: "서울 강남구 테헤란로 2",
        대표전화: "02-333-4444",
      },
      {
        회사명: "중복 병원",
        업종: "병원",
        주소: "서울 강남구 테헤란로 2",
        대표전화: "02-333-4444",
      },
    ] as const
    const repository = new InMemorySyncRepository()

    // When: the duplicate rows are synced together.
    const result = await syncSheetRows({ repository, rows, sheetName: "기업 DB" })

    // Then: the first row inserts and the duplicate is updated without a unique-key failure.
    expect(result).toMatchObject({ totalRows: 2, inserted: 1, updated: 1, skipped: 0, failed: 0 })
    expect(repository.places()).toHaveLength(1)
  })
})
