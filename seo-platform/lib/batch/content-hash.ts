// 게시 승인 스냅샷용 콘텐츠 해시 — 승인 시점의 places 콘텐츠를 고정하고,
// 실제 게시 직전 해시가 다르면 해당 item만 중단한다 (승인 후 콘텐츠 변조 감지).
import { createHash } from "node:crypto"

export type PublishableContent = {
  readonly meta_title: string | null
  readonly meta_description: string | null
  readonly description: string | null
  readonly faq: unknown
  readonly keywords: unknown
  readonly internal_links: unknown
}

export function computePlaceContentHash(content: PublishableContent): string {
  // 키 순서를 고정한 결정적 직렬화 — 동일 콘텐츠는 항상 동일 해시.
  const canonical = JSON.stringify([
    content.meta_title ?? null,
    content.meta_description ?? null,
    content.description ?? null,
    content.faq ?? null,
    content.keywords ?? null,
    content.internal_links ?? null,
  ])
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

// jsonb는 객체 키 순서를 보존하지 않는다 — 저장하면 키를 (UTF-8 바이트 길이, 바이트 순)으로 다시 정렬해 돌려준다.
// 코드에서 만든 객체({question, answer})를 그대로 해시하면, 저장 뒤 다시 읽은 값({answer, question})의 해시와 달라진다.
// 저장할 콘텐츠를 이 모양으로 바꿔 두면 "쓰기 전에 계산한 해시"와 "다시 읽어 계산한 해시"가 같다.
// computePlaceContentHash 자체는 바꾸지 않는다 — 이미 발급된 승인 스냅샷 해시와의 호환을 위해서다.
// (DB에서 읽은 값은 이미 이 모양이므로 기존 해시 결과는 그대로다.)
export function toJsonbShape<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => toJsonbShape(entry)) as unknown as T
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
    entries.sort(([left], [right]) => {
      const leftBytes = Buffer.from(left, "utf8")
      const rightBytes = Buffer.from(right, "utf8")
      return leftBytes.length !== rightBytes.length ? leftBytes.length - rightBytes.length : Buffer.compare(leftBytes, rightBytes)
    })
    return Object.fromEntries(entries.map(([key, entry]) => [key, toJsonbShape(entry)])) as T
  }
  return value
}

export type ApprovalSnapshot = {
  readonly generation_id: string
  readonly seo_page_id: string
  readonly content_hash: string
  readonly approved_by: string
  readonly approved_at: string
}

export function isApprovalStillValid(snapshot: ApprovalSnapshot, currentContentHash: string, currentGenerationId: string | null): boolean {
  return snapshot.content_hash === currentContentHash && snapshot.generation_id === (currentGenerationId ?? "")
}
