const foundationItems = [
  {
    title: "Supabase schema",
    body: "Places, SEO pages, AI generations, sync runs, sync errors, settings, RLS, and public-safe view are defined as the first dependency wave.",
    badge: "ready",
  },
  {
    title: "Strict domain types",
    body: "Sheet-shaped rows, source keys, page statuses, and public DTO boundaries are typed for later sync and route workers.",
    badge: "ready",
  },
  {
    title: "Route waves deferred",
    body: "Admin, sync service, AI preview/apply, public SEO routes, sitemap, and robots remain intentionally outside this foundation wave.",
    badge: "planned",
  },
] as const

export default function Home() {
  return (
    <main className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
      <section className="mx-auto flex max-w-6xl flex-col gap-10 py-16 sm:py-20">
        <header className="flex flex-col gap-5">
          <p className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)]">
            Foundation wave
          </p>
          <div className="max-w-3xl">
            <h1 className="text-4xl font-bold tracking-[-0.02em] text-[var(--text-primary)] sm:text-5xl">
              SEO Platform schema and app shell are ready for the next workers.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--text-secondary)]">
              This isolated app preserves the existing collect and enrich pipeline while establishing the Supabase boundary that future sync, admin, and public SEO routes will use.
            </p>
          </div>
        </header>

        <div className="grid gap-4 md:grid-cols-3">
          {foundationItems.map((item) => (
            <article
              className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5"
              key={item.title}
            >
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-xl font-semibold text-[var(--text-primary)]">{item.title}</h2>
                <span className="rounded-full bg-[var(--surface-secondary)] px-3 py-1 text-xs font-semibold text-[var(--accent-primary)]">
                  {item.badge}
                </span>
              </div>
              <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">{item.body}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
