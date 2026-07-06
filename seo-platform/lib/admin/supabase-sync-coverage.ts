import type { SyncCoverageStatus } from "./sync"

const FIRST_DATA_ROW_NUMBER = 2
const MISSING_ROW_PREVIEW_LIMIT = 20
const PAGE_SIZE = 1000

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
    missingSourceRows: await collectMissingSourceRowsPreview(fetcher.fetchMissingSourceRowsPage, latestSourceRowNumber),
    openRunningRuns,
  }
}

async function collectMissingSourceRowsPreview(
  fetchMissingSourceRowsPage: (offset: number, limit: number) => Promise<readonly number[]>,
  latestSourceRowNumber: number | null,
): Promise<readonly number[]> {
  if (latestSourceRowNumber === null) {
    return []
  }

  const missing: number[] = []
  let nextExpectedRowNumber = FIRST_DATA_ROW_NUMBER

  for (let offset = 0; nextExpectedRowNumber <= latestSourceRowNumber && missing.length < MISSING_ROW_PREVIEW_LIMIT; offset += PAGE_SIZE) {
    const pageRows = await fetchMissingSourceRowsPage(offset, PAGE_SIZE)
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
