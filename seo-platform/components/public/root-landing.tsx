import { DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import { buildCanonicalUrl } from "@/lib/public-seo/public-pages"
import { HUB_INDEX_PATH, HUB_INDEX_TITLE, hubPath, hubTitle, SIDO_LABELS, type ActiveHubSummary } from "@/lib/public-seo/region-hub"
import { buildRootJsonLd, ROOT_CHECKLIST, ROOT_DESCRIPTION, ROOT_PURPOSES, ROOT_TITLE } from "@/lib/public-seo/root-landing"
import { getPublicSiteUrl } from "@/lib/site-url"

// 공개 루트(/) 고객용 첫 화면 — 서비스 소개·이용 목적·주문 전 확인사항·지역별 안내 진입.
// /hub 인덱스와 역할이 다르다: 여기서는 허브 전체 나열·장소 나열을 하지 않고 진입만 안내한다.
// 서버 컴포넌트 — 고객용 콘텐츠가 서버 응답 HTML에 그대로 실린다.
export function PublicRootLanding({ summaries }: Readonly<{ summaries: readonly ActiveHubSummary[] }>) {
  const canonicalUrl = buildCanonicalUrl(getPublicSiteUrl(), "/")
  const jsonLdObjects = buildRootJsonLd(canonicalUrl)

  return (
    <main className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
      <article className="mx-auto flex max-w-5xl flex-col gap-10 py-10 sm:py-14">
        <header className="flex flex-col gap-4 rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--accent-primary)]">전국팔도플라워</p>
          <h1 className="text-3xl font-bold tracking-[-0.015em] text-[var(--text-primary)] sm:text-4xl">{ROOT_TITLE}</h1>
          <p className="max-w-3xl text-base leading-7 text-[var(--text-secondary)]">{ROOT_DESCRIPTION}</p>
          <p className="max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
            이 사이트는 각 시설의 공식 홈페이지가 아니며, 화환 주문 전에 참고할 장소 정보를 정리한 팔도플라워의 안내 서비스입니다.
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <a
              className="inline-flex items-center justify-center rounded-full bg-[var(--accent-primary)] px-6 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
              href={HUB_INDEX_PATH}
            >
              지역별 화환 안내 보기
            </a>
            <a
              className="inline-flex items-center justify-center rounded-full border border-[var(--accent-primary)] px-6 py-3 text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/10"
              href={DEFAULT_ORDER_URL}
              rel="noopener"
            >
              화환 주문하기 (판매 사이트로 이동)
            </a>
          </div>
          <p className="text-xs leading-5 text-[var(--text-secondary)]">화환 주문은 외부 판매 사이트(팔도플라워.com)에서 진행됩니다.</p>
        </header>

        <section aria-label="이용 목적" className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">이런 상황에서 이용하세요</h2>
          <ul className="grid gap-3 sm:grid-cols-3">
            {ROOT_PURPOSES.map((purpose) => (
              <li className="flex h-full flex-col gap-2 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5" key={purpose.heading}>
                <span className="text-lg font-semibold text-[var(--text-primary)]">{purpose.heading}</span>
                <span className="text-sm leading-6 text-[var(--text-secondary)]">{purpose.description}</span>
              </li>
            ))}
          </ul>
        </section>

        {summaries.length > 0 ? (
          <section aria-label="지역별 화환 안내" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">지역별 화환 안내</h2>
              <a className="text-sm font-semibold text-[var(--accent-primary)] transition-opacity duration-150 hover:opacity-80" href={HUB_INDEX_PATH}>
                {HUB_INDEX_TITLE} 전체 보기 →
              </a>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {summaries.map(({ hub, count }) => (
                <li key={hub.slug}>
                  <a
                    className="flex h-full flex-col gap-2 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 transition-colors duration-150 ease-out hover:border-[var(--accent-primary)]"
                    href={hubPath(hub)}
                  >
                    <span className="text-lg font-semibold text-[var(--text-primary)]">{SIDO_LABELS[hub.sido]}</span>
                    <span className="text-sm text-[var(--text-secondary)]">{hubTitle(hub)}</span>
                    <span className="mt-auto pt-2 text-sm font-semibold text-[var(--text-primary)]">{count}곳 안내 중</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-label="주문 전 확인사항" className="flex flex-col gap-4 rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">주문 전 확인사항</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {ROOT_CHECKLIST.map((item) => (
              <li className="flex items-start gap-2 text-sm leading-6 text-[var(--text-secondary)]" key={item}>
                <span aria-hidden className="mt-0.5 font-semibold text-[var(--accent-primary)]">
                  ✓
                </span>
                {item}
              </li>
            ))}
          </ul>
          <p className="text-xs leading-5 text-[var(--text-secondary)]">
            각 장소 안내는 공식 정보를 기준으로 확인한 내용이며, 시설 사정에 따라 달라질 수 있으니 주문 전 시설 측 확인을 함께 이용하시기 바랍니다.
          </p>
        </section>
      </article>

      {jsonLdObjects.map((jsonLd) => (
        <script dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} key={jsonLd["@type"]} type="application/ld+json" />
      ))}
    </main>
  )
}
