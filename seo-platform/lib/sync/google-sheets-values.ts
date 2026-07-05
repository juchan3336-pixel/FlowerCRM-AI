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
