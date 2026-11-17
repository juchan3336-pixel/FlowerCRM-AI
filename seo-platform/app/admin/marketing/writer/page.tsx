import Link from "next/link"

import { CopyButton } from "@/components/admin/marketing/copy-button"
import { PendingSubmitButton } from "@/components/admin/marketing/pending-button"
import { WriterRecheckForm } from "@/components/admin/marketing/writer-recheck"
import { Field, INPUT_CLASS, PageHeader, Panel, PRIMARY_BUTTON_CLASS } from "@/components/admin/marketing/ui"
import type { ContentMode } from "@/lib/ai/content-mode"
import { formatKstDateTime } from "@/lib/admin/time"
import { MODE_LABEL } from "@/lib/marketing/admin-view"
import { listDraftTopics } from "@/lib/marketing/ai/topics"
import { listWriterTargets, WRITER_INPUT_LIMITS } from "@/lib/marketing/writer/spec"
import { hashtagLine, writerFailureMessage, writerFullText, writerNoticeMessage, writerOrderLinks, writerTargetLabel } from "@/lib/marketing/writer/view"
import type { MarketingWriterOutputRow } from "@/types/database"

import { generateWriterAction } from "../actions"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-fA-F-]{36}$/
const MODES: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]

const QUALITY_LABEL: Readonly<Record<MarketingWriterOutputRow["quality_status"], string>> = {
  pass: "통과",
  warn: "다듬을 곳 있음",
  fail: "금지 규칙 위반",
}

// 광고 글쓰기 — 캠페인·검수 단계 없이 글 한 편을 만들어 복사해 쓴다.
export default async function MarketingWriterPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = await searchParams
  const outputId = typeof query["output"] === "string" && UUID.test(query["output"]) ? query["output"] : null

  let recent: readonly MarketingWriterOutputRow[] | null = null
  let selected: MarketingWriterOutputRow | null = null
  try {
    const { createSupabaseMarketingRepository } = await import("@/lib/marketing/supabase-repository")
    const repo = createSupabaseMarketingRepository()
    ;[recent, selected] = await Promise.all([repo.listWriterOutputs(20), outputId === null ? Promise.resolve(null) : repo.findWriterOutput(outputId)])
  } catch (cause) {
    console.error("[marketing] writer load failed", { message: cause instanceof Error ? cause.message : String(cause) })
  }
  const { resolveMarketingAiSelection } = await import("@/lib/marketing/ai/provider")
  const selection = resolveMarketingAiSelection({
    MARKETING_AI_PROVIDER: process.env["MARKETING_AI_PROVIDER"],
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    OPENAI_MODEL: process.env["OPENAI_MODEL"],
  })

  return (
    <MarketingWriterContent
      aiReady={selection.kind === "openai"}
      error={typeof query["error"] === "string" ? query["error"] : null}
      notice={typeof query["notice"] === "string" ? query["notice"] : null}
      recent={recent}
      // 폼마다 새 요청 키 — 같은 폼을 두 번 제출해도 글은 한 편만 만들어진다
      requestKey={crypto.randomUUID()}
      selected={selected}
    />
  )
}

// 데이터 주입형 본문 — 조회와 분리해 테스트·QA에서 고정 데이터로 직접 렌더한다.
export function MarketingWriterContent({
  recent,
  selected,
  notice,
  error,
  aiReady,
  requestKey,
}: Readonly<{ recent: readonly MarketingWriterOutputRow[] | null; selected: MarketingWriterOutputRow | null; notice: string | null; error: string | null; aiReady: boolean; requestKey: string }>) {
  const noticeText = notice === null ? null : writerNoticeMessage(notice)
  return (
    <section aria-labelledby="writer-title" className="flex flex-col gap-6">
      <PageHeader eyebrow="광고 배포" title="광고 글쓰기" titleId="writer-title">
        <p>
          종류와 결과물, 주제를 고르면 AI가 네이버 블로그 글, SNS·카페 글, 스마트스토어 상품 설명을 씁니다. 가격·배송 약속·후기 같은 금지 표현과 근조·축하 혼입을
          검사하고, 걸리면 한 번 다시 씁니다. 주문 링크는 시스템이 자사몰·스마트스토어 주소로 붙입니다.
        </p>
        <p className="mt-2">
          승인·게시 단계는 없습니다. 결과를 확인하고 복사해 쓰세요. 검수와 게시 기록이 필요한 글은{" "}
          <Link className="font-semibold text-[var(--accent-primary)] hover:underline" href="/admin/marketing">
            광고 배포
          </Link>
          에서 만듭니다.
        </p>
      </PageHeader>

      {error === null ? null : (
        <p className="rounded-3xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-4 text-sm leading-6 text-[var(--text-primary)]" role="alert">
          {writerFailureMessage(error)}
        </p>
      )}
      {recent === null ? (
        <section className="rounded-3xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-5 text-sm leading-6 text-[var(--text-primary)]">
          <h3 className="text-lg font-semibold">광고 글쓰기 기록을 읽지 못했습니다</h3>
          <p className="mt-2">처음 한 번, Supabase SQL Editor에서 아래 두 파일을 순서대로 실행해 주세요. 기존 캠페인과 초안 기록은 바뀌지 않습니다.</p>
          <ol className="mt-3 list-decimal pl-5">
            <li>
              <code className="font-mono text-xs">seo-platform/supabase/migrations/202611170001_marketing_writer.sql</code> — 전체 실행
            </li>
            <li>
              <code className="font-mono text-xs">seo-platform/supabase/operations/verify_marketing_writer_migration.sql</code> — 결과 한 행이 주석의 기대값과 같은지 확인
            </li>
          </ol>
        </section>
      ) : null}

      {selected === null ? null : <WriterResult noticeText={noticeText} row={selected} />}

      <Panel description="한 번 누르면 글 한 편을 만듭니다. 20~40초 걸립니다." id="writer-form" title="글 만들기">
        {aiReady ? (
          <form action={generateWriterAction} className="grid gap-4 p-5 md:grid-cols-2">
            <input name="requestKey" type="hidden" value={requestKey} />
            <Field label="종류">
              <select className={INPUT_CLASS} defaultValue="condolence" name="mode">
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABEL[mode]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="결과물">
              <select className={INPUT_CLASS} defaultValue="blog:naver_blog" name="target">
                {listWriterTargets().map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="md:col-span-2">
              <Field hint={`목록에서 고르거나 직접 적으세요(${String(WRITER_INPUT_LIMITS.topic)}자 이내). 목록의 주제를 고르면 그 주제에 꼭 들어갈 내용이 함께 전달됩니다.`} label="주제">
                <input className={INPUT_CLASS} list="writer-topics" maxLength={WRITER_INPUT_LIMITS.topic} name="topic" placeholder="예: 근조화환 리본 문구 쓰는 법" required />
              </Field>
              <datalist id="writer-topics">
                {MODES.flatMap((mode) => listDraftTopics(mode).map((topic) => <option key={`${mode}-${topic.key}`} label={MODE_LABEL[mode]} value={topic.prompt} />))}
              </datalist>
            </div>
            <Field hint="선택. 제목과 첫 문단에만 들어갑니다." label="지역">
              <input className={INPUT_CLASS} maxLength={WRITER_INPUT_LIMITS.region} name="region" placeholder="예: 창원" />
            </Field>
            <Field hint="선택. 참고만 하며, 확인되지 않은 사실은 글에 넣지 않습니다." label="강조할 점">
              <input className={INPUT_CLASS} maxLength={WRITER_INPUT_LIMITS.emphasis} name="emphasis" placeholder="예: 회사 이름으로 보낼 때 표기" />
            </Field>
            <fieldset className="flex flex-col gap-2 text-sm md:col-span-2">
              <legend className="font-semibold text-[var(--text-primary)]">주문 링크 (블로그·SNS)</legend>
              <div className="flex flex-wrap gap-4 text-[var(--text-primary)]">
                <label className="inline-flex items-center gap-2">
                  <input defaultChecked name="destinations" type="radio" value="both" /> 스마트스토어 + 자사몰
                </label>
                <label className="inline-flex items-center gap-2">
                  <input name="destinations" type="radio" value="smartstore" /> 스마트스토어만
                </label>
                <label className="inline-flex items-center gap-2">
                  <input name="destinations" type="radio" value="imweb" /> 자사몰만
                </label>
              </div>
            </fieldset>
            <div className="grid gap-4 rounded-2xl border border-dashed border-[var(--border-default)] p-4 md:col-span-2 md:grid-cols-2">
              <p className="text-xs leading-5 text-[var(--text-secondary)] md:col-span-2">
                스마트스토어 상품 설명일 때만 씁니다. 꽃 종류·크기·단수 같은 사양은 여기에 적은 것만 글에 들어갑니다.
              </p>
              <Field label="상품명">
                <input className={INPUT_CLASS} maxLength={WRITER_INPUT_LIMITS.productName} name="productName" placeholder="예: 근조 3단 화환" />
              </Field>
              <Field label="확인된 구성·사양">
                <textarea className={INPUT_CLASS} maxLength={WRITER_INPUT_LIMITS.productSpecs} name="productSpecs" placeholder={"예: 3단\n흰 국화"} rows={3} />
              </Field>
            </div>
            <div className="md:col-span-2">
              <PendingSubmitButton className={PRIMARY_BUTTON_CLASS} label="글 만들기" pendingLabel="쓰는 중… (20~40초)" />
            </div>
          </form>
        ) : (
          <p className="p-5 text-sm leading-6 text-[var(--text-primary)]">
            광고 AI가 꺼져 있습니다. Vercel 환경 변수 <code className="font-mono text-xs">MARKETING_AI_PROVIDER=openai</code>,{" "}
            <code className="font-mono text-xs">OPENAI_API_KEY</code>, <code className="font-mono text-xs">OPENAI_MODEL</code>을 확인해 주세요.
          </p>
        )}
      </Panel>

      <Panel description="최근 20편. 누르면 결과를 다시 볼 수 있습니다." title="최근 작성">
        {recent === null || recent.length === 0 ? (
          <p className="p-5 text-sm text-[var(--text-secondary)]">아직 만든 글이 없습니다.</p>
        ) : (
          <ul className="divide-y divide-[var(--border-default)]">
            {recent.map((row) => (
              <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm" key={row.id}>
                <span className="text-xs text-[var(--text-secondary)]">{formatKstDateTime(row.created_at)}</span>
                <span className="text-xs text-[var(--text-secondary)]">
                  {MODE_LABEL[row.mode]} · {writerTargetLabel(row)}
                </span>
                <Link className="min-w-0 flex-1 truncate font-semibold text-[var(--text-primary)] hover:text-[var(--accent-primary)]" href={`/admin/marketing/writer?output=${row.id}#writer-result`}>
                  {row.title}
                </Link>
                <span className={row.quality_status === "fail" ? "text-xs font-semibold text-[var(--status-error)]" : "text-xs text-[var(--text-secondary)]"}>{QUALITY_LABEL[row.quality_status]}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  )
}

function WriterResult({ row, noticeText }: Readonly<{ row: MarketingWriterOutputRow; noticeText: string | null }>) {
  const blocked = row.quality_status === "fail"
  const links = writerOrderLinks(row)
  return (
    <Panel description={`${MODE_LABEL[row.mode]} · ${writerTargetLabel(row)}${row.region === null ? "" : ` · ${row.region}`} · ${formatKstDateTime(row.created_at)}`} id="writer-result" title="결과">
      <div className="flex flex-col gap-4 p-5">
        {noticeText === null ? null : (
          <p className={blocked ? "text-sm font-semibold text-[var(--status-error)]" : "text-sm text-[var(--text-primary)]"} role="status">
            {noticeText}
          </p>
        )}
        {row.issues.length === 0 ? null : (
          <div className={blocked ? "rounded-2xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-4" : "rounded-2xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-4"}>
            <p className="text-sm font-semibold text-[var(--text-primary)]">{blocked ? "복사할 수 없는 이유" : "다듬을 곳"}</p>
            <ul className="mt-2 list-disc pl-5 text-sm leading-6 text-[var(--text-primary)]">
              {row.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <p className="text-xs font-semibold text-[var(--text-secondary)]">제목</p>
          <p className="mt-1 text-lg font-semibold text-[var(--text-primary)]">{row.title}</p>
        </div>
        <div>
          <p className="text-xs font-semibold text-[var(--text-secondary)]">본문 ({String(Array.from(row.body).length)}자)</p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-7 text-[var(--text-primary)]">{row.body}</p>
        </div>
        {row.tags.length === 0 ? null : (
          <div>
            <p className="text-xs font-semibold text-[var(--text-secondary)]">태그</p>
            <p className="mt-1 text-sm text-[var(--text-primary)]">{hashtagLine(row.tags)}</p>
          </div>
        )}
        {links.length === 0 ? null : (
          <div>
            <p className="text-xs font-semibold text-[var(--text-secondary)]">주문 링크 (추적 꼬리표 포함)</p>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {links.map((link) => (
                <li className="break-all text-[var(--text-primary)]" key={link.destination}>
                  {link.label}: {link.url}
                </li>
              ))}
            </ul>
          </div>
        )}
        {blocked ? null : (
          <div className="flex flex-wrap gap-2">
            <CopyButton label="전체 복사" text={writerFullText(row)} />
            <CopyButton label="제목 복사" text={row.title} />
            <CopyButton label="본문 복사" text={row.body} />
            {row.tags.length === 0 ? null : <CopyButton label="태그 복사" text={row.output_kind === "product" ? row.tags.join(",") : hashtagLine(row.tags)} />}
            {links.map((link) => (
              <CopyButton key={link.destination} label={`${link.label} 링크 복사`} text={link.url} />
            ))}
          </div>
        )}
        {row.quality_status === "pass" ? null : (
          <details className="rounded-2xl border border-[var(--border-default)] p-4" open={blocked}>
            <summary className="cursor-pointer text-sm font-semibold text-[var(--text-primary)]">직접 고쳐서 다시 검사 — AI를 다시 부르지 않습니다</summary>
            <div className="mt-3">
              <WriterRecheckForm body={row.body} outputId={row.id} tags={row.tags} title={row.title} />
            </div>
          </details>
        )}
      </div>
    </Panel>
  )
}
