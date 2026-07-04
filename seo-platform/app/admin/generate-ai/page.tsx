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
  "Do not invent facts absent from the source place.",
  "Do not generate phone, email, or price information.",
  "Express ordering and delivery availability only through the default CTA.",
  "Keep funeral and hospital language factual and restrained.",
] as const

const GENERATION_TYPES = [
  { label: "Description", field: "description", state: "selected" },
  { label: "Meta title", field: "meta_title", state: "selected" },
  { label: "Meta description", field: "meta_description", state: "selected" },
  { label: "FAQ", field: "faq", state: "selected" },
  { label: "Keywords", field: "keywords", state: "selected" },
  { label: "Internal links", field: "internal_links", state: "locked" },
] as const satisfies readonly GenerationType[]

const AUDIT_ITEMS = [
  { label: "Provider", value: "FakeDeterministicAiProvider" },
  { label: "Generation status", value: "preview-only" },
  { label: "Repository", value: "In-memory fixture repository" },
  { label: "Mutation mode", value: "No server actions connected" },
] as const satisfies readonly AuditItem[]

export default function AdminGenerateAiPage() {
  return (
    <section aria-labelledby="admin-generate-ai-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Generate AI</p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-generate-ai-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              AI generation admin placeholder
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              Fixture-backed preview workflow for place SEO fields. The surface documents target selection, fake-provider output,
              guardrails, and apply auditing without live AI calls, Supabase auth, or repository mutation wiring.
            </p>
          </div>
          <span className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--status-warning)]">
            preview-only
          </span>
        </div>
      </header>

      <section aria-labelledby="target-selector-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <div className="flex flex-col gap-1">
          <h3 id="target-selector-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Target place / page selector
          </h3>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">
            Selectors are disabled placeholders until an authenticated admin data source is connected.
          </p>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm font-semibold text-[var(--text-primary)]">
            Place fixture
            <select className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)]" disabled value="fixture-busan-funeral">
              <option value="fixture-busan-funeral">부산 장례식장 fixture place</option>
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm font-semibold text-[var(--text-primary)]">
            Page type fixture
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
            Generation types
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Read-only checklist mirrors the fields accepted by AiGeneratedSeoContent.
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {GENERATION_TYPES.map((type) => (
              <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4" key={type.field}>
                <p className="text-sm font-semibold text-[var(--text-primary)]">{type.label}</p>
                <p className="mt-1 font-mono text-xs text-[var(--accent-primary)]">{type.field}</p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                  {type.state === "selected" ? "Selected for preview" : "Included by provider contract"}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="action-controls-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <h3 id="action-controls-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Non-functional controls
          </h3>
          <div className="mt-5 flex flex-col gap-3">
            <button className="rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-secondary)] opacity-70" disabled type="button">Generate Preview</button>
            <button className="rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-secondary)] opacity-70" disabled type="button">Apply to Place</button>
            <button className="rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-secondary)] opacity-70" disabled type="button">Batch generate placeholder</button>
          </div>
          <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">
            Buttons render the planned workflow only; they do not call providers or update source data.
          </p>
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Preview panel">
          <p className="text-sm leading-6 text-[var(--text-secondary)]">
            FakeDeterministicAiProvider would return Korean SEO copy, FAQ, keywords, and internal links for the selected place.
          </p>
          <p className="mt-3 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 font-mono text-xs leading-6 text-[var(--text-primary)]">
            description → meta_title → meta_description → faq → keywords → internal_links
          </p>
        </Panel>
        <Panel title="Apply status panel">
          <dl className="grid gap-3 text-sm">
            {AI_GENERATION_STATUSES.map((status) => (
              <div className="flex items-center justify-between rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3" key={status}>
                <dt className="font-semibold text-[var(--text-primary)]">{status}</dt>
                <dd className="text-[var(--text-secondary)]">Fixture status vocabulary</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Guardrail summary">
          <ul className="flex flex-col gap-3 text-sm leading-6 text-[var(--text-secondary)]">
            {GUARDRAILS.map((guardrail) => (
              <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3" key={guardrail}>{guardrail}</li>
            ))}
          </ul>
        </Panel>
        <Panel title="Audit trail summary">
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
