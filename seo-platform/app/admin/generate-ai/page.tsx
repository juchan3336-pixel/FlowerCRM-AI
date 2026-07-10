import { AI_GENERATION_STATUSES, SEO_PAGE_TYPES } from "@/lib/domain/constants"

type GenerationType = {
  readonly label: string
  readonly field: string
  readonly state: "selected" | "locked"
}

type AuditItem = {
  readonly label: string
  readonly value: string
}

const GUARDRAILS = [
  "원본 장소에 없는 사실을 만들지 않습니다.",
  "전화번호, 이메일, 가격 정보는 생성하지 않습니다.",
  "주문과 배송 가능성은 기본 CTA로만 표현합니다.",
  "장례와 병원 문구는 사실적이고 절제되게 유지합니다.",
] as const

const GENERATION_TYPES = [
  { label: "설명", field: "description", state: "selected" },
  { label: "메타 제목", field: "meta_title", state: "selected" },
  { label: "메타 설명", field: "meta_description", state: "selected" },
  { label: "FAQ", field: "faq", state: "selected" },
  { label: "키워드", field: "keywords", state: "selected" },
  { label: "내부 링크", field: "internal_links", state: "locked" },
] as const satisfies readonly GenerationType[]

const AUDIT_ITEMS = [
  { label: "Provider", value: "FakeDeterministicAiProvider" },
  { label: "생성 상태", value: "미리보기만" },
  { label: "저장소", value: "메모리 fixture 저장소" },
  { label: "변경 모드", value: "서버 액션 미연결" },
] as const satisfies readonly AuditItem[]

export default function AdminGenerateAiPage() {
  return (
    <section aria-labelledby="admin-generate-ai-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">AI</p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-generate-ai-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              AI 생성 관리자 자리표시자
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              장소 SEO 필드를 위한 fixture 기반 미리보기 워크플로입니다. 이 화면은 대상 선택, 가짜 provider 출력, 가드레일, Apply 감사만
              문서화하고 실제 AI 호출, Supabase auth, 저장소 변경 연결은 하지 않습니다.
            </p>
          </div>
          <span className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--status-warning)]">
            미리보기만
          </span>
        </div>
      </header>

      <section aria-labelledby="target-selector-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <div className="flex flex-col gap-1">
          <h3 id="target-selector-title" className="text-lg font-semibold text-[var(--text-primary)]">
            대상 장소 / 페이지 선택기
          </h3>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">
            인증된 관리자 데이터 소스가 연결되기 전까지 선택기는 비활성화된 자리표시자입니다.
          </p>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm font-semibold text-[var(--text-primary)]">
            장소 fixture
            <select className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)]" disabled value="fixture-busan-funeral">
              <option value="fixture-busan-funeral">부산 장례식장 fixture place</option>
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm font-semibold text-[var(--text-primary)]">
            페이지 유형 fixture
            <select className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)]" disabled value="funeral">
              {SEO_PAGE_TYPES.map((pageType) => (
                <option key={pageType} value={pageType}>{pageType}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <section aria-labelledby="generation-types-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <h3 id="generation-types-title" className="text-lg font-semibold text-[var(--text-primary)]">
            생성 유형
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            읽기 전용 체크리스트는 AiGeneratedSeoContent가 받는 필드를 그대로 반영합니다.
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {GENERATION_TYPES.map((type) => (
              <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4" key={type.field}>
                <p className="text-sm font-semibold text-[var(--text-primary)]">{type.label}</p>
                <p className="mt-1 font-mono text-xs text-[var(--accent-primary)]">{type.field}</p>
                  <p className="mt-3 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                    {type.state === "selected" ? "미리보기용 선택" : "provider 계약에 포함"}
                  </p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="action-controls-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <h3 id="action-controls-title" className="text-lg font-semibold text-[var(--text-primary)]">
            비기능 제어
          </h3>
          <div className="mt-5 flex flex-col gap-3">
            <button className="rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-secondary)] opacity-70" disabled type="button">미리보기 생성</button>
            <button className="rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-secondary)] opacity-70" disabled type="button">장소에 적용</button>
            <button className="rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-secondary)] opacity-70" disabled type="button">일괄 생성 자리표시자</button>
          </div>
          <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">
            버튼은 계획된 워크플로만 보여주며 provider 호출이나 source data 업데이트는 하지 않습니다.
          </p>
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="미리보기 패널">
          <p className="text-sm leading-6 text-[var(--text-secondary)]">
            FakeDeterministicAiProvider는 선택한 장소에 대해 한국어 SEO 문구, FAQ, 키워드, 내부 링크를 반환합니다.
          </p>
          <p className="mt-3 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 font-mono text-xs leading-6 text-[var(--text-primary)]">
            description → meta_title → meta_description → faq → keywords → internal_links
          </p>
        </Panel>
        <Panel title="적용 상태 패널">
          <dl className="grid gap-3 text-sm">
            {AI_GENERATION_STATUSES.map((status) => (
              <div className="flex items-center justify-between rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3" key={status}>
                <dt className="font-semibold text-[var(--text-primary)]">{status}</dt>
                <dd className="text-[var(--text-secondary)]">fixture 상태 어휘</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="가드레일 요약">
          <ul className="flex flex-col gap-3 text-sm leading-6 text-[var(--text-secondary)]">
            {GUARDRAILS.map((guardrail) => (
              <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3" key={guardrail}>{guardrail}</li>
            ))}
          </ul>
        </Panel>
        <Panel title="감사 추적 요약">
          <dl className="grid gap-3 text-sm">
            {AUDIT_ITEMS.map((item) => (
              <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3" key={item.label}>
                <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{item.label}</dt>
                <dd className="mt-1 font-semibold text-[var(--text-primary)]">{item.value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </section>
  )
}

function Panel({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section aria-labelledby={`${title.toLowerCase().replaceAll(" ", "-")}-title`} className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <h3 id={`${title.toLowerCase().replaceAll(" ", "-")}-title`} className="text-lg font-semibold text-[var(--text-primary)]">
        {title}
      </h3>
      <div className="mt-4">{children}</div>
    </section>
  )
}
