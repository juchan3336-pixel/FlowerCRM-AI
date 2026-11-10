// ai_generations.output의 행 버전 — 읽고-고쳐-쓰기의 유실 방지.
//
// ai_generations에는 updated_at 트리거가 없다. output은 여러 경로(품질표 첨부, 수동 보정, 적용 확정,
// ready 보정, 게시 FAQ 보정)가 "전체를 읽어 일부 키를 바꾼 뒤 전체를 다시 쓰는" 방식으로 갱신한다.
// 조건 없이 쓰면 두 경로가 겹칠 때 먼저 쓴 쪽의 변경이 조용히 사라진다.
//
// 계약: 이미 있는 행의 output을 쓰는 모든 경로는
//   1) 읽은 output의 output_revision을 조건으로 건다 (없던 행이면 "아직 없음"을 조건으로)
//   2) 새 output_revision을 넣어 쓴다
//   3) 영향 행이 0이면 "그 사이 다른 경로가 썼다"로 처리한다 (다시 읽어 재시도하거나 실패로 보고)
// 한 경로라도 빠지면 그 경로의 쓰기는 다른 경로가 감지하지 못한다 — 새 쓰기 경로를 만들면 반드시 이 모듈을 쓴다.
import { randomUUID } from "node:crypto"

export const OUTPUT_REVISION_KEY = "output_revision"
// PostgREST JSON 경로. 키가 없으면 SQL NULL이다.
export const OUTPUT_REVISION_COLUMN = `output->>${OUTPUT_REVISION_KEY}`

export function outputRevisionOf(output: unknown): string | null {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return null
  }
  const revision = (output as Record<string, unknown>)[OUTPUT_REVISION_KEY]
  return typeof revision === "string" && revision.length > 0 ? revision : null
}

export function withNextOutputRevision<T extends Record<string, unknown>>(output: T): T & { readonly output_revision: string } {
  return { ...output, [OUTPUT_REVISION_KEY]: randomUUID() }
}

type RevisionFilterable<Q> = { eq: (column: string, value: string) => Q; is: (column: string, value: null) => Q }

// 읽었을 때의 revision 그대로일 때만 쓰이도록 조건을 건다.
export function whereOutputRevision<Q extends RevisionFilterable<Q>>(query: Q, readOutput: unknown): Q {
  const revision = outputRevisionOf(readOutput)
  return revision === null ? query.is(OUTPUT_REVISION_COLUMN, null) : query.eq(OUTPUT_REVISION_COLUMN, revision)
}
