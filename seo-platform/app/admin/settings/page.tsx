import { loadAdminSettings } from "@/lib/settings/admin-settings"
import type { AdminSettingsLoadResult, SettingsField } from "@/lib/settings/types"

export const dynamic = "force-dynamic"

function SettingsReadonlyField({ field }: Readonly<{ field: SettingsField }>) {
  const fieldId = `settings-${field.label.toLowerCase().replaceAll(" ", "-").replaceAll("/", "-")}`
  const helpId = `${fieldId}-help`

  return (
    <label className="flex flex-col gap-2" htmlFor={fieldId}>
      <span className="text-sm font-semibold text-[var(--text-primary)]">{field.label}</span>
      <input
        aria-describedby={helpId}
        className="w-full rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 font-mono text-sm text-[var(--text-secondary)] opacity-80"
        disabled
        id={fieldId}
        readOnly
        type="text"
        value={field.value}
      />
      <span className="text-sm leading-6 text-[var(--text-secondary)]" id={helpId}>
        {field.help}
      </span>
    </label>
  )
}

export function AdminSettingsContent({ settings }: Readonly<{ settings: AdminSettingsLoadResult }>) {
  const sourceLabel = settings.source === "supabase" ? "Supabase settings table" : "local fixture defaults"

  return (
    <section aria-labelledby="admin-settings-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Settings</p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-settings-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              Settings preview
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              Read-only settings are loaded from {sourceLabel}. Saving remains disabled until authenticated settings table writes
              are implemented in a later slice.
            </p>
          </div>
          <button
            aria-describedby="settings-save-help"
            className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--text-secondary)] opacity-70"
            disabled
            type="button"
          >
            Save settings placeholder
          </button>
        </div>
        <p id="settings-save-help" className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Saving is disabled until an authenticated settings table write path is implemented in a later slice.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        {settings.sections.map((section) => (
          <section
            aria-labelledby={`settings-section-${section.title.toLowerCase().replaceAll(" ", "-")}`}
            className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5"
            key={section.title}
          >
            <h3
              className="text-lg font-semibold text-[var(--text-primary)]"
              id={`settings-section-${section.title.toLowerCase().replaceAll(" ", "-")}`}
            >
              {section.title}
            </h3>
            <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{section.description}</p>
            <div className="mt-5 grid gap-4">
              {section.fields.map((field) => (
                <SettingsReadonlyField field={field} key={field.label} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}

async function getAdminSettings(): Promise<AdminSettingsLoadResult> {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return loadAdminSettings()
  }

  const { createSupabaseSettingsRepository } = await import("@/lib/settings/supabase-settings")
  return loadAdminSettings(createSupabaseSettingsRepository())
}

export default async function AdminSettingsPage() {
  return <AdminSettingsContent settings={await getAdminSettings()} />
}
