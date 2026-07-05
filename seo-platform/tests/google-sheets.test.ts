import { describe, expect, it } from "vitest"

import { InvalidGoogleServiceAccountError, parseGoogleServiceAccountJson } from "@/lib/sync/google-sheets-config"
import { valuesToSheetRows } from "@/lib/sync/google-sheets-values"

describe("Google Sheets value mapping", () => {
  it("maps Sheets values into existing Korean column row objects", () => {
    // Given: raw Google Sheets values with a header row and two data rows.
    const values = [
      ["회사명", "업종", "대표전화", "메모"],
      ["서울성모병원", "병원", "02-123-4567", "VIP"],
      ["부산장례식장", "장례식장", "051-123-4567"],
    ] as const

    // When: values are converted before passing into the existing sync parser.
    const rows = valuesToSheetRows(values)

    // Then: row objects preserve current Sheet column names and leave blank trailing cells undefined.
    expect(rows).toEqual([
      { 회사명: "서울성모병원", 업종: "병원", 대표전화: "02-123-4567", 메모: "VIP" },
      { 회사명: "부산장례식장", 업종: "장례식장", 대표전화: "051-123-4567", 메모: undefined },
    ])
  })

  it("keeps column indexes aligned when a Sheet header cell is blank", () => {
    // Given: a blank header between useful Sheet columns.
    const values = [["회사명", undefined, "대표전화"], ["서울성모병원", "ignored", "02-123-4567"]] as const

    // When: values are converted into row objects.
    const rows = valuesToSheetRows(values)

    // Then: later headers still read from their original column index.
    expect(rows).toEqual([{ 회사명: "서울성모병원", 대표전화: "02-123-4567" }])
  })

  it("returns a typed error for malformed service-account JSON", () => {
    // Given: an invalid JSON value pasted into the service-account environment variable.
    const parse = () => parseGoogleServiceAccountJson("not-json")

    // When/Then: the boundary returns a typed configuration error instead of a raw SyntaxError.
    expect(parse).toThrow(InvalidGoogleServiceAccountError)
  })
})
