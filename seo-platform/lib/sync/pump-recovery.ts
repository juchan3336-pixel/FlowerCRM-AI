import "server-only"

// pump 배치가 예기치 못하게 터졌을 때의 표식.
//
// 표식은 진단용일 뿐이고 복구 자체는 lease 만료가 담당한다 — 이 표식이 실패해도 lease가 풀리면
// 다음 Cron 호출이 같은 커서에서 이어받는다. 그래서 여기서는 조건부 UPDATE 한 번만 시도한다.
import { PUMP_BATCH_CRASHED_CODE } from "./job-policy"

export async function markPumpBatchCrashed(input: Readonly<{ jobId: string; leaseTokenHash: string }>): Promise<void> {
  const { createSupabaseSyncJobRepository } = await import("./supabase-job-repository")
  await createSupabaseSyncJobRepository().markInterrupted({
    jobId: input.jobId,
    errorCode: PUMP_BATCH_CRASHED_CODE,
    errorMessage: "동기화 배치 처리가 예기치 않게 중단됐습니다. 처리된 분량은 그대로 유지되며 다음 자동 처리에서 이어집니다.",
    nowIso: new Date().toISOString(),
    // lease 보유자일 때만 찍는다 — 이미 다른 pump가 가져갔다면 그 진행을 덮지 않는다.
    leaseTokenHash: input.leaseTokenHash,
  })
}
