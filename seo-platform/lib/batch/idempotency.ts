// 멱등성 키 — 동일 배치·장소·단계의 서버 액션 재호출을 식별한다.
// 키는 결정적이며(랜덤·시간 없음), 조건부 UPDATE(기대 상태 일치)와 함께 중복 생성·중복 게시를 차단한다.
import type { BatchStepContext } from "./types"

export function buildBatchIdempotencyKey(batchId: string, placeId: string): string {
  return `batch:${batchId}:place:${placeId}`
}

export function buildBatchStepKey(context: BatchStepContext): string {
  return `batch:${context.batchId}:place:${context.placeId}:${context.kind}:${context.step}`
}
