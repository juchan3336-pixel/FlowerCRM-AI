"use client"

import { useActionState } from "react"

import { recheckWriterAction } from "@/app/admin/marketing/actions"
import { hashtagLine, type WriterRecheckState } from "@/lib/marketing/writer/view"

import { CopyButton } from "./copy-button"
import { PendingSubmitButton } from "./pending-button"
import { INPUT_CLASS, SECONDARY_BUTTON_CLASS } from "./ui"

const INITIAL: WriterRecheckState = { status: "idle" }

// 결과를 직접 고쳐 다시 검사한다 — AI를 다시 부르지 않으므로 비용이 없고, 원본 기록은 그대로 남는다.
// 금지 태그 하나 때문에 막힌 글을 한 단어만 고쳐 쓸 수 있게 한다.
export function WriterRecheckForm({ outputId, title, body, tags }: Readonly<{ outputId: string; title: string; body: string; tags: readonly string[] }>) {
  const [state, action] = useActionState(recheckWriterAction, INITIAL)
  const passed = state.status === "checked" && state.quality !== "fail"
  return (
    <div className="flex flex-col gap-3">
      <form action={action} className="flex flex-col gap-3">
        <input name="outputId" type="hidden" value={outputId} />
        <label className="flex flex-col gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
          제목
          <input className={INPUT_CLASS} defaultValue={title} maxLength={200} name="title" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
          본문
          <textarea className={INPUT_CLASS} defaultValue={body} maxLength={4000} name="body" rows={10} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
          태그 (띄어쓰기나 쉼표로 구분, # 없이)
          <input className={INPUT_CLASS} defaultValue={tags.join(" ")} name="tags" />
        </label>
        <div>
          <PendingSubmitButton className={SECONDARY_BUTTON_CLASS} label="고친 글 다시 검사 (비용 없음)" pendingLabel="검사 중…" />
        </div>
      </form>
      {state.status === "error" ? (
        <p className="text-sm font-semibold text-[var(--status-error)]" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.status === "checked" ? (
        <div className="flex flex-col gap-2" role="status">
          <p className={passed ? "text-sm font-semibold text-[var(--accent-primary)]" : "text-sm font-semibold text-[var(--status-error)]"}>
            {state.quality === "pass" ? "검사를 통과했습니다. 고친 글을 복사해 쓰세요." : state.quality === "warn" ? "금지 규칙은 통과했습니다. 아래 다듬을 곳을 확인하고 복사해 쓰세요." : "아직 금지 규칙에 걸립니다. 아래 이유를 고쳐 다시 검사해 주세요."}
          </p>
          {state.issues.length === 0 ? null : (
            <ul className="list-disc pl-5 text-sm leading-6 text-[var(--text-primary)]">
              {state.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          {passed ? (
            <div className="flex flex-wrap gap-2">
              <CopyButton label="고친 글 전체 복사" text={state.fullText} />
              <CopyButton label="제목 복사" text={state.title} />
              <CopyButton label="본문 복사" text={state.body} />
              {state.tags.length === 0 ? null : <CopyButton label="태그 복사" text={hashtagLine(state.tags)} />}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
