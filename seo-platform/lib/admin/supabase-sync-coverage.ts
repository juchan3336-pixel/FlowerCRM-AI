import type { SyncCoverageStatus } from "./sync"

const FIRST_DATA_ROW_NUMBER = 2
const MISSING_ROW_PREVIEW_LIMIT = 20
const PAGE_SIZE = 1000
// 쪽을 하나씩 순서대로 기다리면 장소 4만 건에서 45번 왕복이 줄줄이 이어진다.
// 한 번에 여러 쪽을 동시에 받고, 판정은 종전과 똑같이 쪽 순서대로 한다.
const PAGE_WINDOW = 8

export type AdminSyncCoverageFetcher = Readonly<{
  countImportedPlaces: () => Promise<number>
  countOpenRunningRuns: () => Promise<number>
  latestSourceRowNumber: () => Promise<number | null>
  fetchMissingSourceRowsPage: (offset: number, limit: number) => Promise<readonly number[]>
}>

export async function loadAdminSyncCoverage(fetcher: AdminSyncCoverageFetcher): Promise<SyncCoverageStatus> {
  const [importedPlaces, openRunningRuns, latestSourceRowNumber] = await Promise.all([
    fetcher.countImportedPlaces(),
    fetcher.countOpenRunningRuns(),
    fetcher.latestSourceRowNumber(),
  ])

  return {
    importedPlaces,
    latestSourceRowNumber,
    missingSourceRows: await collectMissingSourceRowsPreview(fetcher.fetchMissingSourceRowsPage, latestSourceRowNumber, importedPlaces),
    openRunningRuns,
  }
}

async function collectMissingSourceRowsPreview(
  fetchMissingSourceRowsPage: (offset: number, limit: number) => Promise<readonly number[]>,
  latestSourceRowNumber: number | null,
  importedPlaces: number,
): Promise<readonly number[]> {
  if (latestSourceRowNumber === null) {
    return []
  }

  const missing: number[] = []
  let nextExpectedRowNumber = FIRST_DATA_ROW_NUMBER

  // 행 번호가 있는 장소는 가져온 장소 수를 넘지 않으므로, 그 뒤 쪽은 미리 요청하지 않는다.
  const knownPages = Math.max(1, Math.ceil(importedPlaces / PAGE_SIZE))
  let pending: Promise<readonly number[]>[] = []
  for (let offset = 0; nextExpectedRowNumber <= latestSourceRowNumber && missing.length < MISSING_ROW_PREVIEW_LIMIT; offset += PAGE_SIZE) {
    if (pending.length === 0) {
      const pageIndex = offset / PAGE_SIZE
      const windowSize = Math.min(PAGE_WINDOW, Math.max(1, knownPages - pageIndex))
      pending = Array.from({ length: windowSize }, (_, index) => fetchMissingSourceRowsPage(offset + index * PAGE_SIZE, PAGE_SIZE))
      // 앞쪽에서 끝나 뒤쪽 결과를 쓰지 않게 되어도, 그 실패가 처리되지 않은 거부로 남지 않게 한다.
      for (const page of pending) page.catch(() => undefined)
    }
    const pageRows = (await pending.shift()) ?? []
    if (pageRows.length === 0) {
      break
    }

    for (const sourceRowNumber of pageRows) {
      if (sourceRowNumber < nextExpectedRowNumber) {
        continue
      }

      while (nextExpectedRowNumber < sourceRowNumber && missing.length < MISSING_ROW_PREVIEW_LIMIT) {
        missing.push(nextExpectedRowNumber)
        nextExpectedRowNumber += 1
      }

      if (nextExpectedRowNumber === sourceRowNumber) {
        nextExpectedRowNumber += 1
      }

      if (missing.length >= MISSING_ROW_PREVIEW_LIMIT || nextExpectedRowNumber > latestSourceRowNumber) {
        break
      }
    }

    if (pageRows.length < PAGE_SIZE) {
      break
    }
  }

  return missing
}
