"use client"

import { useState } from "react"
import { useFormStatus } from "react-dom"

import { resolveNeedsReviewItemAction } from "@/app/admin/batch/actions"
import { RESOLVABLE_FIELDS, RESOLVABLE_FIELD_LABELS, type ResolvableField } from "@/lib/batch/needs-review-resolution"

export type NeedsReviewPreview = {
  readonly itemId: string
  readonly batchId: string
  readonly generationId: string
  readonly placeName: string
  readonly reasonLabel: string
  readonly qualityIssueLabels: readonly string[]
  readonly values: Readonly<Record<ResolvableField, string>>
}

const FIELD_HINTS: Readonly<Record<ResolvableField, string>> = {
  title: "한 줄로 입력합니다.",
  meta_description: "한 줄로 입력합니다.",
  body: "여러 문단을 그대로 입력합니다.",
  faq: "한 줄에 하나씩 `질문 | 답변` 형식으로 입력합니다.",
  keywords: "한 줄에 키워드 하나씩 입력합니다.",
  internal_links: "한 줄에 하나씩 `표시문구 | /경로` 형식으로 입력합니다. 비우면 링크 없음입니다.",
}

const MULTILINE_FIELDS: readonly ResolvableField[] = ["body", "faq", "keywords", "internal_links"]

// confirmed/onConfirmedChange를 주면 확인 체크 상태가 부모 제어형이 된다 — 일괄 패널이 선택 목록으로 재사용한다.
// busy는 일괄 처리 진행 중 개별 제출을 잠근다 (동시 claim은 서버 조건부 UPDATE가 막지만 UX 혼선을 피한다).
export function NeedsReviewResolutionForm({
  preview,
  confirmed: confirmedProp,
  onConfirmedChange,
  busy = false,
}: Readonly<{ preview: NeedsReviewPreview; confirmed?: boolean; onConfirmedChange?: (confirmed: boolean) => void; busy?: boolean }>) {
  const [openFields, setOpenFields] = useState<readonly ResolvableField[]>([])
  const [confirmedLocal, setConfirmedLocal] = useState(false)
  const confirmed = confirmedProp ?? confirmedLocal
  const setConfirmed = onConfirmedChange ?? setConfirmedLocal

  return (
    <form action={resolveNeedsReviewItemAction} className="flex flex-col gap-4 border-t border-[var(--border-default)] p-5">
      <input name="batchId" type="hidden" value={preview.batchId} />
      <input name="itemId" type="hidden" value={preview.itemId} />
      <input name="generationId" type="hidden" value={preview.generationId} />

      <div>
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{preview.placeName} — 검토 후 게시 준비</h4>
        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{preview.reasonLabel}</p>
        {preview.qualityIssueLabels.length > 0 ? (
          <ul className="mt-2 list-disc pl-5 text-xs leading-5 text-[var(--status-warning)]">
            {preview.qualityIssueLabels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <p className="text-xs leading-5 text-[var(--text-secondary)]">
        원문을 그대로 승인하려면 아무 필드도 열지 말고 확인란만 체크하세요. 여는 필드만 보정 대상이 되고, 나머지는 생성 원문이 유지됩니다. AI 재생성은 하지 않습니다.
      </p>

      <ul className="flex flex-col gap-3">
        {RESOLVABLE_FIELDS.map((field) => {
          const isOpen = openFields.includes(field)
          return (
            <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3" key={field}>
              <label className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                <input
                  checked={isOpen}
                  name={`edit.${field}`}
                  onChange={(event) => { setOpenFields((current) => (event.target.checked ? [...current, field] : current.filter((entry) => entry !== field))) }}
                  type="checkbox"
                />
                {RESOLVABLE_FIELD_LABELS[field]} 수정
              </label>
              {isOpen ? (
                <div className="mt-2">
                  <p className="mb-1 text-xs leading-5 text-[var(--text-secondary)]">{FIELD_HINTS[field]}</p>
                  {MULTILINE_FIELDS.includes(field) ? (
                    <textarea
                      className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2 font-mono text-xs leading-5 text-[var(--text-primary)]"
                      defaultValue={preview.values[field]}
                      name={`value.${field}`}
                      rows={field === "body" ? 6 : 4}
                    />
                  ) : (
                    <input
                      className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2 text-xs text-[var(--text-primary)]"
                      defaultValue={preview.values[field]}
                      name={`value.${field}`}
                      type="text"
                    />
                  )}
                </div>
              ) : (
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-secondary)]">{preview.values[field] || "—"}</pre>
              )}
            </li>
          )
        })}
      </ul>

      <label className="flex items-start gap-2 text-xs leading-5 text-[var(--text-primary)]">
        <input checked={confirmed} name="reviewConfirmed" onChange={(event) => { setConfirmed(event.target.checked) }} type="checkbox" />
        <span>공식 정보(명칭·주소)와 금지 표현을 확인했으며, 이 콘텐츠를 게시 준비(ready) 상태로 올리는 데 동의합니다. 게시는 별도 단계입니다.</span>
      </label>

      <ResolveButton disabled={!confirmed || busy} />
    </form>
  )
}

// 제출 수명주기(useFormStatus)에만 pending을 묶는다 — 서버 액션 redirect는 소프트 내비게이션이라
// 수동 set-only 상태로 두면 완료 후에도 버튼이 영구 비활성된다.
function ResolveButton({ disabled }: Readonly<{ disabled: boolean }>) {
  const { pending } = useFormStatus()
  return (
    <button
      aria-busy={pending}
      className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled || pending}
      type="submit"
    >
      {pending ? (
        <>
          <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          검토 결과 반영 중…
        </>
      ) : (
        "검토 완료 및 게시 준비"
      )}
    </button>
  )
}
