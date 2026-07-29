// "A:M" / "A1:M" / "A2:M100" 어느 형태로 설정돼 있어도 첫 열·마지막 열 문자만 뽑는다.
// 증분 조회가 헤더 range와 데이터 range를 직접 만들 때 쓴다.
export function parseColumnBounds(range: string): Readonly<{ first: string; last: string }> {
  const match = /^([A-Z]+)\d*:([A-Z]+)\d*$/i.exec(range.trim())
  if (match?.[1] === undefined || match[2] === undefined) {
    return { first: "A", last: "M" }
  }
  return { first: match[1].toUpperCase(), last: match[2].toUpperCase() }
}

export function valuesToSheetRows(values: readonly (readonly unknown[])[]): readonly Record<string, string | undefined>[] {
  const [headerRow, ...dataRows] = values
  if (headerRow === undefined) {
    return []
  }

  const columns = headerRow.map((header, index) => ({ header: cellToText(header), index })).filter(isSheetValueColumn)
  return dataRows.map((row) => rowToRecord(columns, row))
}

function rowToRecord(columns: readonly SheetValueColumn[], row: readonly unknown[]): Record<string, string | undefined> {
  return Object.fromEntries(columns.map((column) => [column.header, cellToText(row[column.index])]))
}

function cellToText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return undefined
}

type SheetValueColumn = {
  readonly header: string
  readonly index: number
}

function isSheetValueColumn(column: Readonly<{ header: string | undefined; index: number }>): column is SheetValueColumn {
  return column.header !== undefined
}
