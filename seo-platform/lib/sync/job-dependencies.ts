import "server-only"

// 자동 연속 동기화 job의 라이브 의존성 조립.
// 행 처리는 기존 syncSheetRows를 그대로 재사용한다 — 파싱·upsert 계획·slug 충돌·오류 기록이
// 수동 동기화와 완전히 동일한 경로를 타야 운영 필드 보호 계약이 갈라지지 않는다.
import { readGoogleSheetRows } from "./google-sheets"
import { createSupabaseSyncRepository } from "./supabase-repository"
import { createSupabaseSyncJobRepository } from "./supabase-job-repository"
import { syncSheetRows } from "./service"
import type { SyncJobDependencies } from "./job-service"

export function createLiveSyncJobDependencies(): SyncJobDependencies {
  return {
    repository: createSupabaseSyncJobRepository(),
    readSheet: async () => readGoogleSheetRows(),
    latestSourceRowNumber: async (sheetName: string) => (await createSupabaseSyncRepository().latestSourceRowNumber?.(sheetName)) ?? null,
    runBatch: async (input) =>
      syncSheetRows({
        repository: createSupabaseSyncRepository(),
        rows: input.rows,
        sheetName: input.sheetName,
        firstDataRowNumber: input.firstDataRowNumber,
        jobLink: { syncJobId: input.jobId, batchIndex: input.batchIndex },
      }),
  }
}
