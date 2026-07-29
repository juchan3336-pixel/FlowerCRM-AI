"use client"

import { useRef, useState, useTransition } from "react"

import { runRowRemapDryRunAction, type RowRemapDryRunResponse } from "./actions"
import { createSubmitGate } from "@/components/admin/batch-launch-form"
import { REMAP_FAILURE_MESSAGES, type RemapFailureCode, type RemapSummary, type RemapUpdate } from "@/lib/sync/row-remap-core"

// 관리자 행번호 정합성 Dry-run 패널.
// 버튼을 누르면 서버가 시트·DB를 읽어 재매핑 계획을 계산만 하고, 요약 지표만 돌려준다.
// 자격증명은 서버에만 있고 응답에는 수치뿐이라 브라우저로 민감 정보가 내려오지 않는다.
export function RowRemapDryRunPanel() {
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<RowRemapDryRunResponse | null>(null)
  // isPending이 반영되기 전의 연속 클릭까지 막는다 (같은 조회를 두 번 돌리지 않도록).
  const gateRef = useRef(createSubmitGate())

  const run = () => {
    if (!gateRef.current.tryAcquire()) {
      return
    }
    setResult(null)
    startTransition(async () => {
      try {
        setResult(await runRowRemapDryRunAction())
      } finally {
        gateRef.current.release()
      }
    })
  }

  return (
    <section aria-labelledby="row-remap-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="row-remap-title" className="text-lg font-semibold text-[var(--text-primary)]">
            행번호 정합성 검사
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
            Google Sheets와 Supabase를 읽어 행 번호가 얼마나 어긋났는지만 계산합니다. 데이터는 전혀 바꾸지 않습니다 — 동기화도, 장소 수정도, 작업 생성도 일어나지 않습니다.
          </p>
        </div>
        <button
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isPending}
          onClick={run}
          type="button"
        >
          {isPending ? (
            <>
              <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-[var(--accent-primary)]/40 border-t-[var(--accent-primary)]" />
              검사 중...
            </>
          ) : (
            "행번호 정합성 검사"
          )}
        </button>
      </div>

      <div aria-live="polite" role="status">
        {isPending ? (
          <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">시트와 Supabase를 읽는 중입니다. 1만 행 이상이라 수십 초 걸릴 수 있습니다.</p>
        ) : null}
      </div>

      {result === null ? null : result.kind === "failed" ? (
        <p className="mt-4 rounded-2xl border-2 border-[var(--status-error)] bg-[var(--status-error)]/10 p-4 text-sm leading-6 text-[var(--text-primary)]" role="alert">
          <span className="font-semibold text-[var(--status-error)]">검사에 실패했습니다.</span> {failureMessage(result.errorCode)}
        </p>
      ) : (
        <RowRemapResult failures={result.failures} summary={result.summary} updates={result.updates} verdict={result.verdict} />
      )}
    </section>
  )
}

function RowRemapResult({
  summary,
  verdict,
  failures,
  updates,
}: Readonly<{ summary: RemapSummary; verdict: "PASS" | "FAIL"; failures: readonly string[]; updates: readonly RemapUpdate[] }>) {
  const pass = verdict === "PASS"

  // 적용 단계에 넘길 계획 파일. 브라우저에서 만들어 내려받게 한다 (서버에 파일을 남기지 않는다).
  const downloadPlan = () => {
    const blob = new Blob([JSON.stringify({ verdict, failures, summary, updates }, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "source_row_remap_plan.json"
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return (
    <>
      <p
        className={`mt-4 rounded-2xl border-2 p-4 text-sm leading-6 ${pass ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/10" : "border-[var(--status-error)] bg-[var(--status-error)]/10"}`}
        role="alert"
      >
        <span className={`font-semibold ${pass ? "text-[var(--accent-primary)]" : "text-[var(--status-error)]"}`}>{pass ? "PASS" : "FAIL"}</span>{" "}
        {pass
          ? "재매핑 계획이 예상과 일치합니다. 복구 적용을 진행할 수 있습니다."
          : "재매핑 계획이 예상과 다릅니다. 복구 적용 작업을 진행하지 마세요 — 아래 사유를 먼저 해소해야 합니다."}
        {failures.length === 0 ? null : (
          <span className="mt-2 block">
            {failures.map((code) => (
              <span className="block text-[var(--text-primary)]" key={code}>
                · {failureCodeMessage(code)}
              </span>
            ))}
          </span>
        )}
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
          <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
            <tr>
              <th className="px-4 py-3" scope="col">항목</th>
              <th className="px-4 py-3 text-right" scope="col">값</th>
              <th className="px-4 py-3" scope="col">판정</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-default)]">
            {metricRows(summary).map((row) => (
              <tr className="text-[var(--text-primary)]" key={row.label}>
                <td className="px-4 py-2.5 text-[var(--text-secondary)]">{row.label}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">{row.value}</td>
                <td className={`px-4 py-2.5 text-xs font-semibold ${row.ok === null ? "text-[var(--text-secondary)]" : row.ok ? "text-[var(--accent-primary)]" : "text-[var(--status-error)]"}`}>
                  {row.ok === null ? "" : row.ok ? "OK" : "불일치"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">복사용 요약</p>
      <pre className="mt-1 overflow-x-auto rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 text-xs leading-5 text-[var(--text-primary)]">
        <code>{JSON.stringify({ verdict, failures, ...summary }, null, 2)}</code>
      </pre>

      {pass ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)]"
            onClick={downloadPlan}
            type="button"
          >
            적용 계획 내려받기 ({format(updates.length)}건)
          </button>
          <span className="text-xs leading-5 text-[var(--text-secondary)]">
            place_id와 행 번호만 담긴 파일입니다. 실제 적용은 승인 후 별도 단계에서 진행합니다.
          </span>
        </div>
      ) : null}
    </>
  )
}

type MetricRow = { readonly label: string; readonly value: string; readonly ok: boolean | null }

function metricRows(summary: RemapSummary): readonly MetricRow[] {
  return [
    { label: "Sheet 데이터 행 수", value: format(summary.sheetRows), ok: null },
    { label: "Sheet 마지막 행", value: format(summary.sheetLastRow), ok: null },
    { label: "Supabase 기업 DB 행 수", value: format(summary.dbRows), ok: null },
    { label: "Supabase max(source_row_number)", value: format(summary.maxSourceRowNumber), ok: null },
    { label: "matched", value: format(summary.matched), ok: null },
    { label: "unchanged", value: format(summary.unchanged), ok: null },
    { label: "updateCount", value: format(summary.updateCount), ok: null },
    { label: "unmatchedInSheet", value: format(summary.unmatchedInSheet), ok: summary.unmatchedInSheet === 0 },
    { label: "unmatchedInDb", value: format(summary.unmatchedInDb), ok: summary.unmatchedInDb === 0 },
    { label: "ambiguous", value: format(summary.ambiguous), ok: summary.ambiguous === 0 },
    { label: "duplicateSourceKeys", value: format(summary.duplicateSourceKeys), ok: summary.duplicateSourceKeys === 0 },
    { label: "duplicateTargetRows", value: format(summary.duplicateTargetRows), ok: summary.duplicateTargetRows === 0 },
    { label: "expectedContinuity", value: String(summary.expectedContinuity), ok: summary.expectedContinuity },
    { label: "publishedInUpdates", value: format(summary.publishedInUpdates), ok: null },
    { label: "행 번호 범위 (전)", value: `${format(summary.minBefore)} ~ ${format(summary.maxBefore)}`, ok: null },
    { label: "행 번호 범위 (후)", value: `${format(summary.minAfter)} ~ ${format(summary.maxAfter)}`, ok: null },
    ...shiftRows(summary),
  ]
}

// 이동량 histogram — 예상표와 나란히 보여 어디가 어긋났는지 바로 보이게 한다.
function shiftRows(summary: RemapSummary): readonly MetricRow[] {
  const shifts = [...new Set([...Object.keys(summary.shiftHistogram), ...Object.keys(summary.expectedShifts)])].sort(
    (a, b) => Number(b) - Number(a),
  )
  return shifts.map((shift) => {
    const actual = summary.shiftHistogram[shift] ?? 0
    const expected = summary.expectedShifts[shift] ?? 0
    return { label: `이동량 ${shift} (예상 ${format(expected)})`, value: format(actual), ok: actual === expected }
  })
}

function format(value: number | null): string {
  return value === null ? "-" : value.toLocaleString("ko-KR")
}

function failureCodeMessage(code: string): string {
  return code in REMAP_FAILURE_MESSAGES ? REMAP_FAILURE_MESSAGES[code as RemapFailureCode] : code
}

// 실행 자체가 실패한 경우 — 안전한 코드만 한글로 옮긴다 (원문·stack trace 노출 금지).
function failureMessage(code: string): string {
  switch (code) {
    case "google-read-failed":
      return "Google Sheets를 읽지 못했습니다. 시트 공유 상태와 자격 설정을 확인하세요."
    case "supabase-read-failed":
      return "Supabase를 읽지 못했습니다. 잠시 후 다시 시도하세요."
    case "missing-env":
      return "Google Sheets 연동이 설정되지 않은 환경입니다."
    default:
      return "예기치 않은 오류로 검사를 마치지 못했습니다. 잠시 후 다시 시도하세요."
  }
}
