import { formatKrw, formatTokens, formatUsd, type AiUsageSummary } from "@/lib/admin/ai-usage"
import { formatKstDateTime } from "@/lib/admin/time"

const QUALITY_LABELS: Record<"pass" | "warn" | "fail", string> = { pass: "PASS", warn: "WARN", fail: "FAIL" }
const QUALITY_CLASSES: Record<"pass" | "warn" | "fail", string> = {
  pass: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-700",
  fail: "bg-red-100 text-red-700",
}

export function AiUsageSection({ usage }: Readonly<{ usage: AiUsageSummary }>) {
  const passRateLabel = usage.qualityEvaluatedCount === 0 ? "—" : `${String(Math.round((usage.qualityPassCount / usage.qualityEvaluatedCount) * 100))}%`
  const cards: readonly { label: string; value: string; detail: string }[] = [
    {
      label: "AI 생성 횟수",
      value: usage.totalGenerations.toLocaleString("ko-KR"),
      detail: `openai ${usage.openAiGenerations.toLocaleString("ko-KR")} · fake ${usage.fakeGenerations.toLocaleString("ko-KR")}`,
    },
    {
      label: "총 토큰 (OpenAI)",
      value: formatTokens(usage.totalTokens),
      detail: `input ${formatTokens(usage.totalInputTokens)} · output ${formatTokens(usage.totalOutputTokens)}`,
    },
    { label: "누적 비용 USD", value: formatUsd(usage.totalCostUsd), detail: "fake provider 제외" },
    { label: "누적 비용 KRW", value: formatKrw(usage.totalCostKrw), detail: `적용 환율 $1 = ₩${usage.usdKrwRate.toLocaleString("ko-KR")}` },
    { label: "평균 생성 비용", value: formatUsd(usage.averageCostUsd), detail: "OpenAI 1건당" },
    {
      label: "Quality PASS 비율",
      value: passRateLabel,
      detail: `검사 ${usage.qualityEvaluatedCount.toLocaleString("ko-KR")}건 중 ${usage.qualityPassCount.toLocaleString("ko-KR")}건`,
    },
  ]

  return (
    <section aria-labelledby="admin-dashboard-ai-usage" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 id="admin-dashboard-ai-usage" className="text-xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
          AI 사용량
        </h3>
        <p className="text-sm leading-6 text-[var(--text-secondary)]">ai_generations 기준 읽기 전용 집계입니다. 비용·토큰은 실제 OpenAI 호출만 합산합니다.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4" key={card.label}>
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{card.value}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{card.detail}</p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <h4 className="border-b border-[var(--border-default)] p-5 text-lg font-semibold text-[var(--text-primary)]">최근 AI 생성 내역</h4>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-3" scope="col">장소명</th>
                <th className="px-5 py-3" scope="col">provider/model</th>
                <th className="px-5 py-3" scope="col">토큰 (in/out/total)</th>
                <th className="px-5 py-3" scope="col">비용</th>
                <th className="px-5 py-3" scope="col">생성 시각</th>
                <th className="px-5 py-3" scope="col">상태</th>
                <th className="px-5 py-3" scope="col">Quality</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {usage.recent.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-sm text-[var(--text-secondary)]" colSpan={7}>
                    아직 AI 생성 내역이 없습니다.
                  </td>
                </tr>
              ) : (
                usage.recent.map((item) => (
                  <tr key={item.id}>
                    <td className="px-5 py-3 font-semibold text-[var(--text-primary)]">{item.placeName}</td>
                    <td className="px-5 py-3 text-[var(--text-secondary)]">
                      {item.provider}/{item.model}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-[var(--text-secondary)]">
                      {formatTokens(item.inputTokens)} / {formatTokens(item.outputTokens)} / {formatTokens(item.totalTokens)}
                    </td>
                    <td className="px-5 py-3 text-[var(--text-secondary)]">
                      {formatUsd(item.estimatedCostUsd)} · {formatKrw(item.estimatedCostKrw)}
                    </td>
                    <td className="px-5 py-3 text-[var(--text-secondary)]">{formatKstDateTime(item.createdAt)}</td>
                    <td className="px-5 py-3 text-[var(--text-secondary)]">{item.status}</td>
                    <td className="px-5 py-3">
                      {item.quality === null ? (
                        <span className="text-[var(--text-secondary)]">—</span>
                      ) : (
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${QUALITY_CLASSES[item.quality]}`}>{QUALITY_LABELS[item.quality]}</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
