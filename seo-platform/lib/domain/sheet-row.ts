import { z } from "zod"
import type { SheetColumn } from "./constants"
import { createSourceKey, normalizeAddress, normalizeCompanyName, normalizePhone } from "./normalize"
import { err, ok, type Result } from "./result"

export const SheetRowSchema = z.object({
  회사명: z.string().min(1),
  업종: z.string().min(1),
  세부업종: z.string().optional(),
  지역: z.string().optional(),
  주소: z.string().optional(),
  대표전화: z.string().optional(),
  홈페이지: z.string().optional(),
  이메일: z.string().optional(),
  출처URL: z.string().optional(),
  수집일: z.string().optional(),
  등급: z.string().optional(),
  영업상태: z.string().optional(),
  메모: z.string().optional(),
})

export type SheetRow = z.infer<typeof SheetRowSchema>
export type SheetPayload = Record<SheetColumn, string | undefined>

export type PlaceImport = {
  readonly source: "google_sheets"
  readonly source_sheet_name: string
  readonly source_row_number: number
  readonly source_key: string
  readonly name: string
  readonly normalized_name: string
  readonly category: string
  readonly detail_category: string | undefined
  readonly region: string | undefined
  readonly city: string | undefined
  readonly district: string | undefined
  readonly address: string | undefined
  readonly normalized_address: string | undefined
  readonly phone: string | undefined
  readonly normalized_phone: string | undefined
  readonly homepage: string | undefined
  readonly email: string | undefined
  readonly source_url: string | undefined
  readonly collected_at: string | undefined
  readonly grade: string | undefined
  readonly sales_status: string | undefined
  readonly memo: string | undefined
  readonly imported_payload: SheetPayload
}

export type SheetRowError =
  | { readonly kind: "invalid_shape"; readonly issues: readonly string[] }
  | { readonly kind: "missing_dedupe_fields"; readonly name: string }

export function parsePlaceImport(
  raw: unknown,
  context: Readonly<{ sheetName: string; rowNumber: number }>,
): Result<PlaceImport, SheetRowError> {
  const parsed = SheetRowSchema.safeParse(raw)
  if (!parsed.success) {
    return err({ kind: "invalid_shape", issues: parsed.error.issues.map((issue) => issue.message) })
  }

  const row = parsed.data
  const sourceKey = createSourceKey({ name: row.회사명, phone: row.대표전화, address: row.주소 })
  if (sourceKey.endsWith("|")) {
    return err({ kind: "missing_dedupe_fields", name: row.회사명 })
  }

  return ok({
    source: "google_sheets",
    source_sheet_name: context.sheetName,
    source_row_number: context.rowNumber,
    source_key: sourceKey,
    name: row.회사명,
    normalized_name: normalizeCompanyName(row.회사명),
    category: mapCategory(row.업종, row.세부업종),
    detail_category: row.세부업종,
    region: row.지역,
    city: extractCity(row.지역),
    district: extractDistrict(row.주소),
    address: row.주소,
    normalized_address: row.주소 === undefined ? undefined : normalizeAddress(row.주소),
    phone: row.대표전화,
    normalized_phone: row.대표전화 === undefined ? undefined : normalizePhone(row.대표전화),
    homepage: row.홈페이지,
    email: row.이메일,
    source_url: row.출처URL,
    collected_at: row.수집일,
    grade: row.등급,
    sales_status: row.영업상태,
    memo: row.메모,
    imported_payload: createSheetPayload(row),
  })
}

export function mapCategory(category: string, detailCategory: string | undefined): string {
  const joined = `${category} ${detailCategory ?? ""}`
  if (/장례|상조|추모/.test(joined)) {
    return "funeral"
  }
  if (/병원|의원|의료|요양/.test(joined)) {
    return "hospital"
  }

  return category.trim()
}

function extractCity(region: string | undefined): string | undefined {
  return region?.trim().split(/\s+/)[0]
}

function extractDistrict(address: string | undefined): string | undefined {
  return address?.match(/\s([가-힣]+(?:구|군|시))\s/)?.[1]
}

function createSheetPayload(row: SheetRow): SheetPayload {
  return {
    회사명: row.회사명,
    업종: row.업종,
    세부업종: row.세부업종,
    지역: row.지역,
    주소: row.주소,
    대표전화: row.대표전화,
    홈페이지: row.홈페이지,
    이메일: row.이메일,
    출처URL: row.출처URL,
    수집일: row.수집일,
    등급: row.등급,
    영업상태: row.영업상태,
    메모: row.메모,
  }
}
