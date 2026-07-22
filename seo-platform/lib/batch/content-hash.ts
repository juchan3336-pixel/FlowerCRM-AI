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
