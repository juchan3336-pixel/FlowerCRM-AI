import Link from "next/link"

import { archivePlacePageAction, generatePlaceAiPreviewAction, preparePlacePublishAction, publishPlacePageAction, restorePlacePageAction, retryPlaceAiGenerationAction } from "@/app/admin/places/actions"
import { resolveGenerationQualityPanelState, type AdminPlaceContent, type AdminPlaceDetail, type AdminPlaceDetailResult, type AdminPlaceGenerationView } from "@/lib/admin/place-detail"
import { buildAdminPlacesHref, type AdminPlacesAiCode, type AdminPlacesNotice, type AdminPlacesWorkspaceParams } from "@/lib/admin/places-url"
import { resolvePublishEnvironment } from "@/lib/admin/publish-environment"
import { getSiteUrl } from "@/lib/site-url"
import { ConfirmCancelButton, ConfirmPanelShell, ConfirmPanelsProvider, ConfirmToggleButton, type ConfirmPanelKind } from "./confirm-action"
import { DrawerActionForm, DrawerActionsProvider } from "./drawer-actions"
import { NoticeToast } from "./notice-toast"
import { describeAiState, describePlaceStatus, describeSeoState } from "./place-row"
import { StatusChip } from "./status-chip"

// 성공 알림은 Toast로 일원화하고, Drawer 배너는 실패(오류 코드·설명·재시도 안내)에만 사용한다.
const FAILURE_BANNER_MESSAGES: Partial<Record<AdminPlacesNotice, string>> = {
  "ai-error": "AI 생성에 실패했습니다. 잠시 후 다시 시도하세요.",
  "ai-failed": "AI 생성에 실패했습니다. 기존 데이터는 변경되지 않았으며 다시 시도할 수 있습니다.",
  "ai-busy": "이 장소의 AI 생성이 이미 진행 중입니다. 잠시 후 결과를 확인하세요.",
  "ai-recent": "방금 생성된 AI 미리보기가 있습니다. 아래에서 검토한 뒤 필요하면 잠시 후 다시 생성하세요.",
  "no-preview": "적용할 AI 미리보기가 없습니다. 먼저 AI 생성을 실행하세요.",
  "prepare-blocked": "게시 준비가 차단되었습니다. 이름·주소·카테고리·슬러그가 채워져 있는지 확인한 뒤 다시 시도하세요.",
  "missing-env": "서버 환경 변수가 설정되지 않아 실행할 수 없습니다.",
  "publish-blocked": "게시 조건을 충족하지 않아 게시되지 않았습니다. 게시 대기 상태와 필수 콘텐츠(제목·메타 설명·본문·슬러그)를 확인한 뒤 다시 시도하세요.",
  "publish-failed": "게시 처리에 실패했습니다. 상태는 변경되지 않았습니다. 다시 시도하세요.",
  "approval-required": "게시하려면 검토 완료 체크박스에 동의해야 합니다.",
  "archive-blocked": "게시됨 상태가 아니어서 보관할 수 없습니다.",
  "archive-failed": "보관 처리에 실패했습니다. 상태는 변경되지 않았습니다. 다시 시도하세요.",
  "restore-blocked": "보관 상태가 아니어서 복원할 수 없습니다.",
  "restore-failed": "복원 처리에 실패했습니다. 상태는 변경되지 않았습니다. 다시 시도하세요.",
  "env-blocked": "Preview 환경에서는 운영 게시·보관·복원이 차단됩니다. 운영 admin(flowercrm-seo.vercel.app)에서 실행하세요.",
  "cache-refresh-failed": "게시 데이터는 저장됐지만 공개 페이지 확인이 지연되고 있습니다. 잠시 후 공개 URL을 다시 확인해 주세요. 계속 지연되면 Vercel 캐시 퍼지를 검토하세요.",
  "quality-blocked": "콘텐츠 품질 검사 FAIL로 게시 준비가 차단되었습니다. 아래 'AI 콘텐츠 품질 검사' 항목별 사유를 확인하고 콘텐츠를 보정한 뒤 다시 시도하세요.",
}

const GENERATION_STATUS_LABELS: Record<AdminPlaceGenerationView["status"], string> = {
  preview: "미리보기 생성",
  applied: "적용됨",
  rejected: "반려",
  failed: "실패",
}

const AI_CODE_MESSAGES: Record<AdminPlacesAiCode, string> = {
  api_key_missing: "OpenAI API 키가 설정되지 않았습니다. 환경변수를 확인하세요.",
  provider_config: "AI 제공자 설정이 올바르지 않습니다. 모델·키 설정을 확인하세요.",
  timeout: "AI 응답이 제한 시간을 초과했습니다.",
  rate_limit: "AI 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.",
  invalid_response: "AI 응답이 검증 규칙을 통과하지 못했습니다.",
  json_parse: "AI 응답 형식이 올바르지 않습니다.",
  network: "네트워크 오류로 AI 요청에 실패했습니다.",
  provider_error: "AI 제공자 오류가 발생했습니다.",
  retry_blocked: "품질 FAIL 복구 재시도를 실행할 수 없습니다 — 원본이 FAIL 상태가 아니거나 재시도 1회를 이미 사용했습니다.",
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
      {/* 소프트 내비게이션은 재마운트가 없어 notice가 새로 와도 마운트 시점 visible 상태에 갇힌다 — notice/aiCode 변경 시 key로 재마운트를 강제한다. */}
      <NoticeToast aiCode={params.aiCode} key={`${params.notice ?? "none"}:${params.aiCode ?? "none"}`} notice={params.notice} />
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
  const failureBanner = params.notice === null ? null : FAILURE_BANNER_MESSAGES[params.notice] ?? null
  const previewContent = detail.latestPreview === null ? null : detail.latestPreview.output
  const activePreviewContent = params.preview ? previewContent : null
  const showPreview = activePreviewContent !== null
  const shownContent = activePreviewContent ?? detail.content
  const stepIndex = resolveWorkflowStep(detail)
  const seoStatus = detail.seoPage?.status ?? null
  // 품질 패널·재시도 버튼은 항상 "현재 상태를 대표하는 generation"(최신 preview/applied) 기준 — 과거 FAIL preview가 현재 상태처럼 보이지 않게 한다.
  const qualityPanel = resolveGenerationQualityPanelState({
    generations: detail.generations,
    isPublished: detail.status === "published" || seoStatus === "published",
  })
  const publicUrl = detail.publicPath === null ? null : `${getSiteUrl()}${detail.publicPath}`
  const baseHrefState = { q: params.q, task: params.task, page: params.page, pageSize: params.pageSize, selected: detail.id } as const
  const currentHref = buildAdminPlacesHref(baseHrefState)
  const previewHref = buildAdminPlacesHref({ ...baseHrefState, preview: true })
  // 서버가 confirm 파라미터로 리다이렉트한 경우(예: 동의 미체크) 해당 패널을 연 채로 시작한다.
  const initialConfirm: ConfirmPanelKind | null =
    params.confirm === "publish" && seoStatus === "ready"
      ? "publish"
      : params.confirm === "archive" && seoStatus === "published"
        ? "archive"
        : params.confirm === "restore" && seoStatus === "archived"
          ? "restore"
          : null

  return (
    <DrawerActionsProvider>
    <ConfirmPanelsProvider initialOpen={initialConfirm} resetKey={`${detail.id}:${seoStatus ?? "none"}`}>
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

      {resolvePublishEnvironment(process.env["VERCEL_ENV"]).environment === "preview" ? (
        <p className="rounded-2xl border border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 p-3 text-xs font-semibold leading-5 text-[var(--status-warning)]">
          ⚠ Preview 배포입니다 — 운영 게시·보관·복원은 차단됩니다. 운영 admin(flowercrm-seo.vercel.app)에서 실행하세요.
        </p>
      ) : null}

      {failureBanner !== null ? (
        <p className="rounded-2xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-4 text-sm leading-6 text-[var(--text-primary)]">
          {failureBanner}
          {params.aiCode !== null ? (
            <span className="mt-1 block text-xs text-[var(--text-secondary)]">
              {AI_CODE_MESSAGES[params.aiCode]} (오류 코드: {params.aiCode})
            </span>
          ) : null}
        </p>
      ) : null}

      {qualityPanel !== null ? (
        <GenerationQualityPanel
          quality={qualityPanel.quality}
          recovered={qualityPanel.recovered}
          recoveryNote={qualityPanel.recoveryNote}
          titleNormalization={qualityPanel.generation.titleNormalization}
        />
      ) : null}

      {qualityPanel?.generation.retry != null && qualityPanel.generation.status === "preview" ? (
        <p className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3 text-xs leading-5 text-[var(--text-secondary)]">
          품질 FAIL 복구 재시도로 생성됨 — 원본 generation {qualityPanel.generation.retry.of.slice(0, 8)}… · 사유 {qualityPanel.generation.retry.reason}
        </p>
      ) : null}

      {/* 품질 FAIL 복구 재시도 — FAIL preview 원본당 1회만. 재시도 사용 후·게시 완료 후에는 노출하지 않는다. */}
      {qualityPanel?.showRetryButton === true ? (
        <DrawerActionForm
          action={retryPlaceAiGenerationAction}
          buttonClassName="w-full rounded-full border border-[var(--status-error)] px-4 py-3 text-sm font-semibold text-[var(--status-error)] transition-colors duration-150 hover:bg-[var(--status-error)]/10"
          fields={{ ...buildActionFields(detail, params), generationId: qualityPanel.generation.id }}
          kind="retry"
        />
      ) : null}

      <section aria-label="작업 버튼" className="grid grid-cols-2 gap-3">
        <DrawerActionForm
          action={generatePlaceAiPreviewAction}
          buttonClassName="w-full rounded-full bg-[var(--accent-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
          fields={buildActionFields(detail, params)}
          kind="ai"
        />
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
          <DrawerActionForm
            action={preparePlacePublishAction}
            buttonClassName="w-full rounded-full border border-[var(--accent-primary)] bg-[var(--surface-elevated)] px-4 py-3 text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/10"
            fields={buildActionFields(detail, params)}
            kind="prepare"
          />
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
          <ConfirmToggleButton
            className="col-span-2 inline-flex items-center justify-center rounded-full bg-[var(--status-warning)] px-4 py-3 text-center text-sm font-semibold text-white hover:opacity-90"
            kind="publish"
          >
            게시하기
          </ConfirmToggleButton>
        ) : null}
        {seoStatus === "published" ? (
          <ConfirmToggleButton
            className="col-span-2 inline-flex items-center justify-center rounded-full border border-[var(--border-default)] px-4 py-3 text-center text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--status-warning)] hover:text-[var(--status-warning)]"
            kind="archive"
          >
            게시 취소(보관)
          </ConfirmToggleButton>
        ) : null}
        {seoStatus === "archived" ? (
          <ConfirmToggleButton
            className="col-span-2 inline-flex items-center justify-center rounded-full border border-[var(--accent-primary)] px-4 py-3 text-center text-sm font-semibold text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10"
            kind="restore"
          >
            재검토 복원(게시 대기로)
          </ConfirmToggleButton>
        ) : null}
      </section>
      <p className="text-xs leading-5 text-[var(--text-secondary)]">
        미리보기·게시 준비는 AI 생성 후에, 게시하기는 SEO 페이지가 게시 대기(ready)일 때만 가능합니다. 공개 페이지 열기는 장소와 SEO 페이지가 모두 게시됨 상태일 때만 활성화됩니다.
      </p>

      {seoStatus === "ready" ? (
        <ConfirmPanelShell
          closedContent={<FinalReviewSection detail={detail} publicUrl={publicUrl} />}
          description="아래 내용으로 즉시 공개됩니다. 공개 페이지가 열리고 사이트맵에 포함됩니다."
          kind="publish"
          title="게시 확인"
          tone="warning"
        >
          <PublishConfirmBody detail={detail} params={params} publicUrl={publicUrl} />
        </ConfirmPanelShell>
      ) : null}
      {seoStatus === "published" ? (
        <ConfirmPanelShell
          description="공개 페이지가 내려가고 사이트맵에서 제외됩니다. 데이터는 삭제되지 않으며, 이후 재검토 복원으로 다시 게시할 수 있습니다."
          kind="archive"
          title="게시 취소(보관) 확인"
          tone="warning"
        >
          <ArchiveConfirmBody detail={detail} params={params} />
        </ConfirmPanelShell>
      ) : null}
      {seoStatus === "archived" ? (
        <ConfirmPanelShell
          description="SEO 페이지가 게시 대기(ready) 상태로 돌아갑니다. 내용을 재검토한 뒤 다시 게시할 수 있으며, 재게시 시 게시 시각이 새로 기록됩니다."
          kind="restore"
          title="재검토 복원 확인"
          tone="primary"
        >
          <RestoreConfirmBody detail={detail} params={params} />
        </ConfirmPanelShell>
      ) : null}

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
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-[var(--text-primary)]">AI {GENERATION_STATUS_LABELS[generation.status]}</span>
                  <GenerationProviderBadge provider={generation.provider} />
                  {generation.quality !== null ? (
                    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold ${QUALITY_STATUS_LABELS[generation.quality.status].className}`}>
                      품질 {generation.quality.status === "pass" ? "PASS" : generation.quality.status === "warn" ? "WARN" : "FAIL"}
                    </span>
                  ) : null}
                  {generation.retry !== null ? (
                    <span className="inline-flex whitespace-nowrap rounded-full border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-primary)]">
                      복구 재시도 (원본 {generation.retry.of.slice(0, 8)}…)
                    </span>
                  ) : null}
                  <span className="font-mono text-xs">{generation.appliedAt ?? generation.createdAt}</span>
                </div>
                <p className="mt-1 text-xs leading-5">
                  모델 {generation.model ?? "기록 없음"} · 토큰 {formatUsage(generation.usage)} · 비용 {formatCostLabel(generation)}
                  {generation.errorCode !== null ? <span className="ml-1 font-mono">· 오류 {generation.errorCode}</span> : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
    </ConfirmPanelsProvider>
    </DrawerActionsProvider>
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

function PublishConfirmBody({ detail, params, publicUrl }: Readonly<{ detail: AdminPlaceDetail; params: AdminPlacesWorkspaceParams; publicUrl: string | null }>) {
  return (
    <>
      <FinalReviewFields detail={detail} publicUrl={publicUrl} />
      <DrawerActionForm
        action={publishPlacePageAction}
        buttonClassName="w-fit rounded-full bg-[var(--status-warning)] px-5 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
        fields={buildActionFields(detail, params)}
        formClassName="mt-4 flex flex-col gap-3"
        kind="publish"
      >
        <label className="flex items-start gap-2 text-sm leading-6 text-[var(--text-primary)]">
          <input className="mt-1" name="approve" required type="checkbox" />
          위 내용을 모두 검토했으며, 이 장소 페이지를 공개하는 데 동의합니다.
        </label>
      </DrawerActionForm>
      <ConfirmCancelButton className="mt-3 inline-flex w-fit text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--accent-primary)]" kind="publish" />
    </>
  )
}

function ArchiveConfirmBody({ detail, params }: Readonly<{ detail: AdminPlaceDetail; params: AdminPlacesWorkspaceParams }>) {
  return (
    <div className="mt-4 flex items-center gap-3">
      <DrawerActionForm
        action={archivePlacePageAction}
        buttonClassName="rounded-full bg-[var(--status-warning)] px-5 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
        fields={buildActionFields(detail, params)}
        kind="archive"
      />
      <ConfirmCancelButton className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--accent-primary)]" kind="archive" />
    </div>
  )
}

function RestoreConfirmBody({ detail, params }: Readonly<{ detail: AdminPlaceDetail; params: AdminPlacesWorkspaceParams }>) {
  return (
    <div className="mt-4 flex items-center gap-3">
      <DrawerActionForm
        action={restorePlacePageAction}
        buttonClassName="rounded-full bg-[var(--accent-primary)] px-5 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
        fields={buildActionFields(detail, params)}
        kind="restore"
      />
      <ConfirmCancelButton className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--accent-primary)]" kind="restore" />
    </div>
  )
}

const QUALITY_STATUS_LABELS = {
  pass: { label: "PASS", className: "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]" },
  warn: { label: "경고", className: "border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]" },
  fail: { label: "실패 — 게시 준비 차단", className: "border-[var(--status-error)]/40 bg-[var(--status-error)]/10 text-[var(--status-error)]" },
} as const

// AI 미리보기 품질 성적표 — 항상 현재 상태를 대표하는 generation 기준. FAIL이면 게시 준비가 차단되므로 항목별 수정 이유를 그대로 보여준다.
function GenerationQualityPanel({
  quality,
  titleNormalization,
  recovered,
  recoveryNote,
}: Readonly<{
  quality: NonNullable<AdminPlaceGenerationView["quality"]>
  titleNormalization: AdminPlaceGenerationView["titleNormalization"]
  recovered: boolean
  recoveryNote: string | null
}>) {
  const tone = QUALITY_STATUS_LABELS[quality.status]
  return (
    <section aria-label="AI 콘텐츠 품질 검사" className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">AI 콘텐츠 품질 검사</h4>
        <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone.className}`}>{tone.label}</span>
        {recovered ? (
          <span className="inline-flex whitespace-nowrap rounded-full border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--accent-primary)]">
            복구 재시도 완료
          </span>
        ) : null}
        {titleNormalization?.normalized === true ? (
          <span className="inline-flex whitespace-nowrap rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2.5 py-0.5 text-xs font-semibold text-[var(--text-secondary)]">
            제목 자동 정규화됨
          </span>
        ) : null}
      </div>
      {recoveryNote !== null ? <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">{recoveryNote}</p> : null}
      {titleNormalization?.normalized === true ? (
        <p className="mt-2 break-words text-xs leading-5 text-[var(--text-secondary)]">
          모델 생성 제목 “{titleNormalization.model_title}” → 적용 제목 “{titleNormalization.final_title}”
        </p>
      ) : null}
      {quality.issues.length === 0 ? (
        <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">금지 표현·내부 링크·반복도 검사를 모두 통과했습니다.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-xs leading-5">
          {quality.issues.map((issue) => (
            <li className="flex gap-2" key={`${issue.code}:${issue.message}`}>
              <span aria-hidden className={issue.level === "fail" ? "text-[var(--status-error)]" : "text-[var(--status-warning)]"}>
                {issue.level === "fail" ? "✕" : "⚠"}
              </span>
              <span className="text-[var(--text-secondary)]">
                <span className="font-mono text-[10px] text-[var(--text-secondary)]/70">[{issue.code}]</span> {issue.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function buildActionFields(detail: AdminPlaceDetail, params: AdminPlacesWorkspaceParams): Record<string, string> {
  const fields: Record<string, string> = { placeId: detail.id, pageSize: String(params.pageSize) }
  if (params.q !== null) {
    fields["q"] = params.q
  }
  if (params.task !== null) {
    fields["task"] = params.task
  }
  if (params.page > 1) {
    fields["page"] = String(params.page)
  }
  return fields
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

function GenerationProviderBadge({ provider }: Readonly<{ provider: string | null }>) {
  if (provider === "openai") {
    return <StatusChip label="실제 AI" tone="accent" />
  }
  if (provider === "fake") {
    return <StatusChip label="샘플 AI" tone="neutral" />
  }
  return <StatusChip label="기록 없음" tone="muted" />
}

function formatUsage(usage: AdminPlaceGenerationView["usage"]): string {
  if (usage === null) {
    return "기록 없음"
  }
  const input = usage.input_tokens === null ? "-" : usage.input_tokens.toLocaleString("ko-KR")
  const output = usage.output_tokens === null ? "-" : usage.output_tokens.toLocaleString("ko-KR")
  const total = usage.total_tokens === null ? "-" : usage.total_tokens.toLocaleString("ko-KR")
  return `입력 ${input} · 출력 ${output} · 합계 ${total}`
}

function formatCostLabel(generation: AdminPlaceGenerationView): string {
  if (generation.provider !== "openai") {
    return "해당 없음"
  }
  if (generation.estimatedCost === null) {
    return "계산 불가"
  }
  return `≈$${generation.estimatedCost.toFixed(6)} (참고용 추정)`
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
