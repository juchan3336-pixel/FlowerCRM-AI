import Link from "next/link"

import { archivePlacePageAction, generatePlaceAiPreviewAction, preparePlacePublishAction, publishPlacePageAction, restorePlacePageAction } from "@/app/admin/places/actions"
import type { AdminPlaceContent, AdminPlaceDetail, AdminPlaceDetailResult, AdminPlaceGenerationView } from "@/lib/admin/place-detail"
import { buildAdminPlacesHref, type AdminPlacesNotice, type AdminPlacesWorkspaceParams } from "@/lib/admin/places-url"
import { getSiteUrl } from "@/lib/site-url"
import { describeAiState, describePlaceStatus, describeSeoState } from "./place-row"
import { StatusChip } from "./status-chip"

const NOTICE_MESSAGES: Record<AdminPlacesNotice, Readonly<{ text: string; tone: "accent" | "warning" }>> = {
  "ai-generated": { text: "AI 미리보기가 생성되었습니다. 아래에서 내용을 검토하세요.", tone: "accent" },
  "ai-error": { text: "AI 생성에 실패했습니다. 잠시 후 다시 시도하세요.", tone: "warning" },
  "no-preview": { text: "적용할 AI 미리보기가 없습니다. 먼저 AI 생성을 실행하세요.", tone: "warning" },
  prepared: { text: "게시 준비가 완료되었습니다. AI 내용이 적용되고 SEO 페이지가 게시 대기 상태가 되었습니다.", tone: "accent" },
  "prepared-existing": { text: "AI 내용을 적용했습니다. 이 장소의 SEO 페이지는 이미 존재합니다.", tone: "accent" },
  "prepare-blocked": { text: "게시 준비가 차단되었습니다. 이름·주소·카테고리·슬러그가 채워져 있는지 확인하세요.", tone: "warning" },
  "missing-env": { text: "서버 환경 변수가 설정되지 않아 실행할 수 없습니다.", tone: "warning" },
  published: { text: "게시가 완료되었습니다. 공개 페이지와 사이트맵에 반영됩니다.", tone: "accent" },
  "already-published": { text: "이미 게시된 페이지입니다. 변경 사항이 없습니다.", tone: "accent" },
  "publish-blocked": { text: "게시 조건을 충족하지 않아 게시되지 않았습니다. 게시 대기 상태와 필수 콘텐츠(제목·메타 설명·본문·슬러그)를 확인하세요.", tone: "warning" },
  "publish-failed": { text: "게시 처리에 실패했습니다. 상태는 변경되지 않았습니다. 다시 시도하세요.", tone: "warning" },
  "approval-required": { text: "게시하려면 검토 완료 체크박스에 동의해야 합니다.", tone: "warning" },
  archived: { text: "보관되었습니다. 공개 페이지가 내려가고 사이트맵에서 제외됩니다.", tone: "accent" },
  "archive-blocked": { text: "게시됨 상태가 아니어서 보관할 수 없습니다.", tone: "warning" },
  "archive-failed": { text: "보관 처리에 실패했습니다. 상태는 변경되지 않았습니다. 다시 시도하세요.", tone: "warning" },
  restored: { text: "게시 대기 상태로 복원되었습니다. 재검토 후 다시 게시할 수 있습니다.", tone: "accent" },
  "restore-blocked": { text: "보관 상태가 아니어서 복원할 수 없습니다.", tone: "warning" },
  "restore-failed": { text: "복원 처리에 실패했습니다. 상태는 변경되지 않았습니다. 다시 시도하세요.", tone: "warning" },
}

const GENERATION_STATUS_LABELS: Record<AdminPlaceGenerationView["status"], string> = {
  preview: "미리보기 생성",
  applied: "적용됨",
  rejected: "반려",
  failed: "실패",
}

const WORKFLOW_STEPS = ["AI 생성 안됨", "미리보기 생성", "게시 준비", "게시 완료", "보관"] as const

type PlaceDetailDrawerProps = {
  readonly detail: AdminPlaceDetailResult
  readonly params: AdminPlacesWorkspaceParams
}

export function PlaceDetailDrawer({ detail, params }: PlaceDetailDrawerProps) {
  const closeHref = buildAdminPlacesHref({ q: params.q, task: params.task, page: params.page, pageSize: params.pageSize })

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="장소 상세">
      <Link aria-label="상세 닫기" className="flex-1 bg-black/30" href={closeHref} />
      <aside className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-[var(--border-default)] bg-[var(--surface-primary)] shadow-2xl">
        {detail.kind === "found" ? (
          <PlaceDetailBody detail={detail.detail} params={params} closeHref={closeHref} />
        ) : (
          <div className="flex flex-col gap-4 p-6">
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-xl font-semibold text-[var(--text-primary)]">장소 상세</h3>
              <CloseLink href={closeHref} />
            </div>
            <p className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 text-sm leading-6 text-[var(--text-secondary)]">
              {detail.kind === "not-found" ? "선택한 장소를 찾을 수 없습니다. 목록에서 다시 선택하세요." : `상세 정보를 불러오지 못했습니다. (${detail.message})`}
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}

function resolveWorkflowStep(detail: AdminPlaceDetail): number {
  if (detail.seoPage?.status === "archived") {
    return 4
  }
  if (detail.isPublic) {
    return 3
  }
  if (detail.seoPage?.status === "ready") {
    return 2
  }
  if (detail.latestPreview !== null || detail.aiState === "적용됨") {
    return 1
  }
  return 0
}

function PlaceDetailBody({ detail, params, closeHref }: Readonly<{ detail: AdminPlaceDetail; params: AdminPlacesWorkspaceParams; closeHref: string }>) {
  const placeStatus = describePlaceStatus(detail.status)
  const aiState = describeAiState(detail.aiState)
  const seoState = describeSeoState(detail.seoPage?.status ?? "누락")
  const notice = params.notice === null ? null : NOTICE_MESSAGES[params.notice]
  const previewContent = detail.latestPreview === null ? null : detail.latestPreview.output
  const activePreviewContent = params.preview ? previewContent : null
  const showPreview = activePreviewContent !== null
  const shownContent = activePreviewContent ?? detail.content
  const stepIndex = resolveWorkflowStep(detail)
  const seoStatus = detail.seoPage?.status ?? null
  const publicUrl = detail.publicPath === null ? null : `${getSiteUrl()}${detail.publicPath}`
  const baseHrefState = { q: params.q, task: params.task, page: params.page, pageSize: params.pageSize, selected: detail.id } as const
  const currentHref = buildAdminPlacesHref(baseHrefState)
  const previewHref = buildAdminPlacesHref({ ...baseHrefState, preview: true })

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">장소 상세</p>
          <h3 className="mt-1 text-xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{detail.name}</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusChip label={`장소 ${placeStatus.label}`} tone={placeStatus.tone} />
            <StatusChip label={`AI ${aiState.label}`} tone={aiState.tone} />
            <StatusChip label={`SEO ${seoState.label}`} tone={seoState.tone} />
          </div>
        </div>
        <CloseLink href={closeHref} />
      </header>

      <ol aria-label="상태 흐름" className="flex flex-wrap items-center gap-1 text-xs font-semibold">
        {WORKFLOW_STEPS.map((step, index) => (
          <li className="flex items-center gap-1" key={step}>
            <span
              aria-current={index === stepIndex ? "step" : undefined}
              className={`rounded-full border px-3 py-1.5 ${
                index === stepIndex
                  ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white"
                  : index < stepIndex
                    ? "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
                    : "border-[var(--border-default)] bg-[var(--surface-secondary)] text-[var(--text-secondary)]"
              }`}
            >
              {step}
            </span>
            {index < WORKFLOW_STEPS.length - 1 ? <span aria-hidden className="text-[var(--text-secondary)]">→</span> : null}
          </li>
        ))}
      </ol>

      {notice !== null ? (
        <p
          className={`rounded-2xl border p-4 text-sm leading-6 ${
            notice.tone === "accent"
              ? "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--text-primary)]"
              : "border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--text-primary)]"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {params.confirm === "publish" && seoStatus === "ready" ? (
        <PublishConfirmPanel detail={detail} params={params} cancelHref={currentHref} publicUrl={publicUrl} />
      ) : null}
      {params.confirm === "archive" && seoStatus === "published" ? (
        <ArchiveConfirmPanel detail={detail} params={params} cancelHref={currentHref} />
      ) : null}
      {params.confirm === "restore" && seoStatus === "archived" ? (
        <RestoreConfirmPanel detail={detail} params={params} cancelHref={currentHref} />
      ) : null}

      <section aria-label="작업 버튼" className="grid grid-cols-2 gap-3">
        <form action={generatePlaceAiPreviewAction}>
          <WorkspaceStateFields detail={detail} params={params} />
          <button className="w-full rounded-full bg-[var(--accent-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90" type="submit">
            AI 생성
          </button>
        </form>
        {detail.latestPreview !== null ? (
          <Link
            className="inline-flex items-center justify-center rounded-full border border-[var(--accent-primary)] px-4 py-3 text-center text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/10"
            href={showPreview ? currentHref : previewHref}
          >
            {showPreview ? "현재 적용값 보기" : "미리보기"}
          </Link>
        ) : (
          <DisabledButton label="미리보기" />
        )}
        {detail.latestPreview !== null ? (
          <form action={preparePlacePublishAction}>
            <WorkspaceStateFields detail={detail} params={params} />
            <button className="w-full rounded-full border border-[var(--accent-primary)] bg-[var(--surface-elevated)] px-4 py-3 text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/10" type="submit">
              게시 준비
            </button>
          </form>
        ) : (
          <DisabledButton label="게시 준비" />
        )}
        {detail.isPublic && publicUrl !== null ? (
          <a
            className="inline-flex items-center justify-center rounded-full border border-[var(--border-default)] px-4 py-3 text-center text-sm font-semibold text-[var(--text-primary)] transition-colors duration-150 hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]"
            href={publicUrl}
            rel="noreferrer"
            target="_blank"
          >
            공개 페이지 열기
          </a>
        ) : (
          <DisabledButton label="공개 페이지 열기" />
        )}
        {seoStatus === "ready" ? (
          <Link
            className="col-span-2 inline-flex items-center justify-center rounded-full bg-[var(--status-warning)] px-4 py-3 text-center text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
            href={buildAdminPlacesHref({ ...baseHrefState, confirm: "publish" })}
          >
            게시하기
          </Link>
        ) : null}
        {seoStatus === "published" ? (
          <Link
            className="col-span-2 inline-flex items-center justify-center rounded-full border border-[var(--border-default)] px-4 py-3 text-center text-sm font-semibold text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--status-warning)] hover:text-[var(--status-warning)]"
            href={buildAdminPlacesHref({ ...baseHrefState, confirm: "archive" })}
          >
            게시 취소(보관)
          </Link>
        ) : null}
        {seoStatus === "archived" ? (
          <Link
            className="col-span-2 inline-flex items-center justify-center rounded-full border border-[var(--accent-primary)] px-4 py-3 text-center text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/10"
            href={buildAdminPlacesHref({ ...baseHrefState, confirm: "restore" })}
          >
            재검토 복원(게시 대기로)
          </Link>
        ) : null}
      </section>
      <p className="text-xs leading-5 text-[var(--text-secondary)]">
        미리보기·게시 준비는 AI 생성 후에, 게시하기는 SEO 페이지가 게시 대기(ready)일 때만 가능합니다. 공개 페이지 열기는 장소와 SEO 페이지가 모두 게시됨 상태일 때만 활성화됩니다.
      </p>

      {seoStatus === "ready" && params.confirm === null ? <FinalReviewSection detail={detail} publicUrl={publicUrl} /> : null}

      <section aria-label="기본정보" className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">기본정보</h4>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <DetailField label="카테고리" value={detail.category} />
          <DetailField label="지역" value={detail.region} />
          <DetailField label="주소" value={detail.address ?? "—"} />
          <DetailField label="전화" value={detail.phone ?? "—"} />
          <DetailField label="홈페이지" value={detail.homepage ?? "—"} />
          <DetailField label="페이지 주소(슬러그)" value={detail.slug ?? "—"} mono />
        </dl>
      </section>

      <section aria-label="콘텐츠" className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-[var(--text-primary)]">콘텐츠 {showPreview ? "— AI 미리보기" : "— 현재 적용값"}</h4>
          {detail.latestPreview !== null ? (
            <div className="flex gap-2 text-xs font-semibold">
              <Link className={showPreview ? "text-[var(--text-secondary)] hover:text-[var(--accent-primary)]" : "text-[var(--accent-primary)]"} href={currentHref}>
                현재 적용값
              </Link>
              <span className="text-[var(--border-default)]">|</span>
              <Link className={showPreview ? "text-[var(--accent-primary)]" : "text-[var(--text-secondary)] hover:text-[var(--accent-primary)]"} href={previewHref}>
                AI 미리보기
              </Link>
            </div>
          ) : null}
        </div>
        <ContentPreview content={shownContent} emptyMessage={showPreview ? "미리보기 내용이 없습니다." : "아직 적용된 콘텐츠가 없습니다. AI 생성으로 시작하세요."} />
      </section>

      <section aria-label="게시 정보" className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">게시 정보</h4>
        <dl className="mt-3 grid gap-3 text-sm">
          <DetailField label="공개 URL" value={publicUrl ?? "슬러그가 없어 공개 URL을 만들 수 없습니다"} mono={publicUrl !== null} />
          <DetailField label="SEO 페이지" value={detail.seoPage === null ? "아직 생성되지 않음" : `${describeSeoState(detail.seoPage.status).label} · ${detail.seoPage.path}`} />
          <DetailField label="게시 시각" value={detail.seoPage?.publishedAt ?? "—"} />
          <DetailField label="공개 여부" value={detail.isPublic ? "공개 중" : "비공개 (장소·SEO 페이지 모두 게시됨일 때 공개)"} />
        </dl>
      </section>

      <section aria-label="작업 이력" className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">작업 이력</h4>
        {detail.generations.length === 0 && detail.seoPage === null ? (
          <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">아직 작업 이력이 없습니다.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm leading-6 text-[var(--text-secondary)]">
            {detail.seoPage?.publishedAt != null ? (
              <li className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2">
                <span className="font-semibold text-[var(--text-primary)]">{detail.seoPage.status === "published" ? "게시됨" : "마지막 게시"}</span>
                <span className="ml-2 font-mono text-xs">{detail.seoPage.publishedAt}</span>
              </li>
            ) : null}
            {detail.seoPage !== null ? (
              <li className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2">
                <span className="font-semibold text-[var(--text-primary)]">SEO 페이지 {describeSeoState(detail.seoPage.status).label}</span>
                <span className="ml-2 font-mono text-xs">{detail.seoPage.lastModifiedAt ?? detail.seoPage.createdAt}</span>
              </li>
            ) : null}
            {detail.generations.map((generation) => (
              <li className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2" key={generation.id}>
                <span className="font-semibold text-[var(--text-primary)]">AI {GENERATION_STATUS_LABELS[generation.status]}</span>
                <span className="ml-2 font-mono text-xs">{generation.appliedAt ?? generation.createdAt}</span>
                {generation.model !== null ? <span className="ml-2 text-xs">({generation.model})</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function FinalReviewSection({ detail, publicUrl }: Readonly<{ detail: AdminPlaceDetail; publicUrl: string | null }>) {
  return (
    <section aria-label="최종 게시 승인" className="rounded-2xl border border-[var(--status-warning)]/50 bg-[var(--surface-elevated)] p-4">
      <h4 className="text-sm font-semibold text-[var(--text-primary)]">최종 게시 승인 — 검토 항목</h4>
      <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">아래 내용이 그대로 공개 페이지에 게시됩니다. 게시하기 버튼을 누르면 확인 단계가 열립니다.</p>
      <FinalReviewFields detail={detail} publicUrl={publicUrl} />
    </section>
  )
}

function FinalReviewFields({ detail, publicUrl }: Readonly<{ detail: AdminPlaceDetail; publicUrl: string | null }>) {
  return (
    <dl className="mt-3 grid gap-3 text-sm">
      <DetailField label="SEO 제목" value={detail.content.metaTitle ?? "— (필수, 게시 불가)"} />
      <DetailField label="메타 설명" value={detail.content.metaDescription ?? "— (필수, 게시 불가)"} />
      <DetailField label="본문" value={detail.content.description ?? "— (필수, 게시 불가)"} />
      <DetailField label="FAQ" value={detail.content.faq.length === 0 ? "없음" : detail.content.faq.map((item) => item.question).join(" / ")} />
      <DetailField label="키워드" value={detail.content.keywords.length === 0 ? "없음" : detail.content.keywords.join(", ")} />
      <DetailField label="내부 링크" value={detail.content.internalLinks.length === 0 ? "없음" : detail.content.internalLinks.map((link) => `${link.label} (${link.href})`).join(" / ")} />
      <DetailField label="공개 URL" value={publicUrl ?? "슬러그 없음 — 게시 불가"} mono={publicUrl !== null} />
      <DetailField label="장소 상태" value={describePlaceStatus(detail.status).label} />
      <DetailField label="SEO 페이지 상태" value={describeSeoState(detail.seoPage?.status ?? "누락").label} />
    </dl>
  )
}

function PublishConfirmPanel({ detail, params, cancelHref, publicUrl }: Readonly<{ detail: AdminPlaceDetail; params: AdminPlacesWorkspaceParams; cancelHref: string; publicUrl: string | null }>) {
  return (
    <section aria-label="게시 확인" className="rounded-2xl border-2 border-[var(--status-warning)] bg-[var(--surface-elevated)] p-4">
      <h4 className="text-base font-semibold text-[var(--text-primary)]">게시 확인</h4>
      <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
        아래 내용으로 즉시 공개됩니다. 공개 페이지가 열리고 사이트맵에 포함됩니다.
      </p>
      <FinalReviewFields detail={detail} publicUrl={publicUrl} />
      <form action={publishPlacePageAction} className="mt-4 flex flex-col gap-3">
        <WorkspaceStateFields detail={detail} params={params} />
        <label className="flex items-start gap-2 text-sm leading-6 text-[var(--text-primary)]">
          <input className="mt-1" name="approve" required type="checkbox" />
          위 내용을 모두 검토했으며, 이 장소 페이지를 공개하는 데 동의합니다.
        </label>
        <div className="flex items-center gap-3">
          <button className="rounded-full bg-[var(--status-warning)] px-5 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90" type="submit">
            게시 확인
          </button>
          <Link className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--accent-primary)]" href={cancelHref}>
            취소
          </Link>
        </div>
      </form>
    </section>
  )
}

function ArchiveConfirmPanel({ detail, params, cancelHref }: Readonly<{ detail: AdminPlaceDetail; params: AdminPlacesWorkspaceParams; cancelHref: string }>) {
  return (
    <section aria-label="보관 확인" className="rounded-2xl border-2 border-[var(--status-warning)] bg-[var(--surface-elevated)] p-4">
      <h4 className="text-base font-semibold text-[var(--text-primary)]">게시 취소(보관) 확인</h4>
      <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
        공개 페이지가 내려가고 사이트맵에서 제외됩니다. 데이터는 삭제되지 않으며, 이후 재검토 복원으로 다시 게시할 수 있습니다.
      </p>
      <form action={archivePlacePageAction} className="mt-4 flex items-center gap-3">
        <WorkspaceStateFields detail={detail} params={params} />
        <button className="rounded-full bg-[var(--status-warning)] px-5 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90" type="submit">
          보관 확인
        </button>
        <Link className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--accent-primary)]" href={cancelHref}>
          취소
        </Link>
      </form>
    </section>
  )
}

function RestoreConfirmPanel({ detail, params, cancelHref }: Readonly<{ detail: AdminPlaceDetail; params: AdminPlacesWorkspaceParams; cancelHref: string }>) {
  return (
    <section aria-label="복원 확인" className="rounded-2xl border-2 border-[var(--accent-primary)] bg-[var(--surface-elevated)] p-4">
      <h4 className="text-base font-semibold text-[var(--text-primary)]">재검토 복원 확인</h4>
      <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
        SEO 페이지가 게시 대기(ready) 상태로 돌아갑니다. 내용을 재검토한 뒤 다시 게시할 수 있으며, 재게시 시 게시 시각이 새로 기록됩니다.
      </p>
      <form action={restorePlacePageAction} className="mt-4 flex items-center gap-3">
        <WorkspaceStateFields detail={detail} params={params} />
        <button className="rounded-full bg-[var(--accent-primary)] px-5 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90" type="submit">
          복원 확인
        </button>
        <Link className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--accent-primary)]" href={cancelHref}>
          취소
        </Link>
      </form>
    </section>
  )
}

function WorkspaceStateFields({ detail, params }: Readonly<{ detail: AdminPlaceDetail; params: AdminPlacesWorkspaceParams }>) {
  return (
    <>
      <input name="placeId" type="hidden" value={detail.id} />
      {params.q !== null ? <input name="q" type="hidden" value={params.q} /> : null}
      {params.task !== null ? <input name="task" type="hidden" value={params.task} /> : null}
      {params.page > 1 ? <input name="page" type="hidden" value={String(params.page)} /> : null}
      <input name="pageSize" type="hidden" value={String(params.pageSize)} />
    </>
  )
}

function ContentPreview({ content, emptyMessage }: Readonly<{ content: AdminPlaceContent; emptyMessage: string }>) {
  const isEmpty = content.description === null && content.metaTitle === null && content.metaDescription === null && content.faq.length === 0

  if (isEmpty) {
    return <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{emptyMessage}</p>
  }

  return (
    <dl className="mt-3 grid gap-3 text-sm">
      <DetailField label="SEO 제목" value={content.metaTitle ?? "—"} />
      <DetailField label="메타 설명" value={content.metaDescription ?? "—"} />
      <DetailField label="본문" value={content.description ?? "—"} />
      <div>
        <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">FAQ</dt>
        {content.faq.length === 0 ? (
          <dd className="mt-1 text-[var(--text-secondary)]">—</dd>
        ) : (
          <dd className="mt-1 space-y-2">
            {content.faq.map((item) => (
              <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2" key={item.question}>
                <p className="font-semibold text-[var(--text-primary)]">{item.question}</p>
                <p className="mt-1 text-[var(--text-secondary)]">{item.answer}</p>
              </div>
            ))}
          </dd>
        )}
      </div>
      {content.keywords.length > 0 ? <DetailField label="키워드" value={content.keywords.join(", ")} /> : null}
      {content.internalLinks.length > 0 ? (
        <DetailField label="내부 링크" value={content.internalLinks.map((link) => `${link.label} (${link.href})`).join(" / ")} />
      ) : null}
    </dl>
  )
}

function DetailField({ label, value, mono = false }: Readonly<{ label: string; value: string; mono?: boolean }>) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</dt>
      <dd className={`mt-1 break-words text-[var(--text-primary)] ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  )
}

function DisabledButton({ label }: Readonly<{ label: string }>) {
  return (
    <span aria-disabled className="inline-flex items-center justify-center rounded-full border border-[var(--border-default)] px-4 py-3 text-center text-sm font-semibold text-[var(--text-secondary)] opacity-50">
      {label}
    </span>
  )
}

function CloseLink({ href }: Readonly<{ href: string }>) {
  return (
    <Link
      className="whitespace-nowrap rounded-full border border-[var(--border-default)] px-4 py-2 text-sm font-semibold text-[var(--text-primary)] transition-colors duration-150 hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]"
      href={href}
    >
      닫기 ✕
    </Link>
  )
}
