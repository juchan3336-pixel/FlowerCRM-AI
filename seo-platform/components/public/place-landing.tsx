import { DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import {
  HERO_INTAKE_NOTICE,
  HERO_TRUST_LINE,
  NON_AFFILIATION_NOTICE,
  ORDER_PROCESS_STEPS,
  PLACE_INFO_NOTICE,
  WHY_ITEMS,
  buildHeroDisclaimer,
  buildPlaceLandingCopy,
  buildPlaceLandingFaq,
  directionalParticle,
  type ProductCategoryCopy,
  type SituationItem,
} from "@/lib/public-seo/landing-copy"
import { buildOrderCtaUrl } from "@/lib/public-seo/order-cta"
import type { PublicPageDto } from "@/lib/public-seo/types"
import { PlaceLandingStickyCta } from "./place-landing-sticky-cta"

const HERO_CTA_ID = "place-hero-order-cta"
const PRODUCTS_SECTION_ID = "place-products"

type PlaceLandingProps = {
  readonly page: PublicPageDto
}

// 소비자용 전환형 랜딩 — 데이터·메타·JSON-LD 계층은 페이지 라우트에 그대로 두고 렌더링만 담당한다.
export function PlaceLanding({ page }: PlaceLandingProps) {
  const copy = buildPlaceLandingCopy(page)
  const placeName = page.place?.name ?? page.title
  const orderUrl = buildOrderCtaUrl(page)
  const faq = page.content.faq.length > 0 ? page.content.faq.map((entry) => ({ title: entry.question, body: entry.answer })) : buildPlaceLandingFaq(placeName)
  const locationText = [page.region, page.city, page.district].filter((value): value is string => value !== null).filter((value, index, all) => all.indexOf(value) === index).join(" · ")

  return (
    <div className="place-landing bg-[var(--pl-bg)] pb-20 text-[var(--pl-ink)] sm:pb-0">
      <div className="mx-auto flex max-w-5xl flex-col px-5 sm:px-8">
        <nav aria-label="breadcrumb" className="pt-6 text-xs text-[var(--pl-soft)]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <a className="transition-colors duration-150 hover:text-[var(--pl-navy)]" href={DEFAULT_ORDER_URL}>
                홈
              </a>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="font-semibold text-[var(--pl-muted)]">
              {page.title}
            </li>
          </ol>
        </nav>

        {/* A. Hero */}
        <header className="grid gap-8 py-10 sm:py-14 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="flex flex-col gap-4">
            <p className="text-sm font-bold tracking-[0.04em] text-[var(--pl-navy)]">{copy.eyebrowLabel}</p>
            <h1 className="text-3xl font-bold leading-snug tracking-[-0.01em] [font-family:var(--pl-serif)] sm:text-4xl lg:text-[2.6rem]">{copy.heroTitle}</h1>
            <p className="max-w-xl text-base leading-7 text-[var(--pl-muted)]">{page.description}</p>
            <p className="max-w-xl text-sm leading-6 text-[var(--pl-soft)]">{HERO_INTAKE_NOTICE}</p>
            <p className="text-sm font-semibold text-[var(--pl-gold)]">{HERO_TRUST_LINE}</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <a
                className="inline-flex min-h-12 items-center justify-center rounded-full bg-[var(--pl-navy)] px-8 text-sm font-bold text-white transition-colors duration-150 hover:bg-[var(--pl-navy-hover)]"
                href={orderUrl}
                id={HERO_CTA_ID}
              >
                화환 주문하기
              </a>
              <a
                className="inline-flex min-h-12 items-center justify-center rounded-full border-2 border-[var(--pl-navy)] px-8 text-sm font-bold text-[var(--pl-navy)] transition-colors duration-150 hover:bg-[var(--pl-navy)]/5"
                href={`#${PRODUCTS_SECTION_ID}`}
              >
                상품 보기
              </a>
            </div>
            <p className="mt-2 max-w-xl border-l-2 border-[var(--pl-gold)] pl-3 text-xs leading-5 text-[var(--pl-soft)]">{buildHeroDisclaimer(placeName)}</p>
          </div>
          <div aria-hidden className="hidden aspect-[4/3] rounded-3xl border border-[var(--pl-line)] bg-[radial-gradient(ellipse_at_30%_20%,#f8f4ec,transparent_60%),radial-gradient(ellipse_at_80%_80%,#efe6d4,transparent_55%),linear-gradient(160deg,#f7f2e9,#ece3d2)] lg:block" />
        </header>

        {/* B. 빠른 상품 선택 */}
        <section aria-labelledby="products-heading" className="border-t border-[var(--pl-line)] py-12" id={PRODUCTS_SECTION_ID}>
          <h2 className="text-2xl font-bold [font-family:var(--pl-serif)]" id="products-heading">
            어떤 꽃이 필요하신가요?
          </h2>
          <p className="mt-2 text-sm leading-6 text-[var(--pl-muted)]">보내는 목적에 맞는 카테고리를 선택하세요.</p>
          <div className="mt-7 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {copy.productOrder.map((product) => (
              <ProductCard key={product.key} orderHref={buildOrderCtaUrl(page, { product: product.name })} product={product} />
            ))}
          </div>
        </section>

        {/* C. 신뢰 */}
        <section aria-labelledby="why-heading" className="border-t border-[var(--pl-line)] py-12">
          <h2 className="text-2xl font-bold [font-family:var(--pl-serif)]" id="why-heading">
            왜 전국팔도플라워인가
          </h2>
          <div className="mt-7 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
            {WHY_ITEMS.map((item) => (
              <DashItem item={item} key={item.title} />
            ))}
          </div>
        </section>

        {/* D. 주문 절차 */}
        <section aria-labelledby="process-heading" className="border-t border-[var(--pl-line)] py-12">
          <h2 className="text-2xl font-bold [font-family:var(--pl-serif)]" id="process-heading">
            주문은 이렇게 진행됩니다
          </h2>
          <ol className="mt-7 grid grid-cols-2 gap-5 lg:grid-cols-4">
            {ORDER_PROCESS_STEPS.map((step, index) => (
              <li className="border-t-2 border-[var(--pl-navy)] pt-3" key={step.title}>
                <span aria-hidden className="text-lg font-bold text-[var(--pl-gold)] [font-family:var(--pl-serif)]">
                  {index + 1}
                </span>
                <p className="text-sm font-bold">{step.title}</p>
                <p className="mt-1 text-xs leading-5 text-[var(--pl-muted)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* F. 상황별 안내 (카테고리 분기) */}
        <section aria-labelledby="situation-heading" className="border-t border-[var(--pl-line)] py-12">
          <h2 className="text-2xl font-bold [font-family:var(--pl-serif)]" id="situation-heading">
            {copy.situationTitle}
          </h2>
          <div className="mt-7 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-3">
            {copy.situationItems.map((item) => (
              <DashItem item={item} key={item.title} />
            ))}
          </div>
        </section>

        {/* G. FAQ */}
        <section aria-labelledby="faq-heading" className="border-t border-[var(--pl-line)] py-12">
          <h2 className="text-2xl font-bold [font-family:var(--pl-serif)]" id="faq-heading">
            자주 묻는 질문
          </h2>
          <div className="mt-5">
            {faq.map((entry) => (
              <details className="group border-b border-[var(--pl-line)] py-4" key={entry.title}>
                <summary className="cursor-pointer list-none text-base font-semibold marker:content-none">
                  <span aria-hidden className="mr-2 text-[var(--pl-gold)]">
                    ＋
                  </span>
                  {entry.title}
                </summary>
                <p className="mt-2 pl-6 text-sm leading-6 text-[var(--pl-muted)]">{entry.body}</p>
              </details>
            ))}
          </div>
        </section>

        {/* E. 장소 정보 — 배송지 참고 정보 (하단 배치) */}
        <section aria-labelledby="place-info-heading" className="border-t border-[var(--pl-line)] py-12">
          <h2 className="text-2xl font-bold [font-family:var(--pl-serif)]" id="place-info-heading">
            배송지 참고 정보
          </h2>
          <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_320px]">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-[var(--pl-soft)]">장소명</dt>
              <dd className="m-0 font-semibold">{placeName}</dd>
              <dt className="text-[var(--pl-soft)]">분류</dt>
              <dd className="m-0">{copy.categoryLabel}</dd>
              {locationText.length > 0 ? (
                <>
                  <dt className="text-[var(--pl-soft)]">지역</dt>
                  <dd className="m-0">{locationText}</dd>
                </>
              ) : null}
              {page.address !== null ? (
                <>
                  <dt className="text-[var(--pl-soft)]">주소</dt>
                  <dd className="m-0">{page.address}</dd>
                </>
              ) : null}
              <dt className="text-[var(--pl-soft)]">안내</dt>
              <dd className="m-0 text-[var(--pl-muted)]">{PLACE_INFO_NOTICE}</dd>
            </dl>
            {page.content.internalLinks.length > 0 ? (
              <nav aria-label="관련 안내">
                <p className="text-sm font-bold text-[var(--pl-soft)]">관련 안내</p>
                <ul className="mt-3 flex flex-col gap-2">
                  {page.content.internalLinks.map((link) => (
                    <li key={link.href}>
                      <a className="text-sm font-semibold text-[var(--pl-navy)] underline-offset-4 transition-colors duration-150 hover:underline" href={link.href}>
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
          </div>
          <p className="mt-6 border-l-2 border-[var(--pl-gold)] pl-3 text-xs leading-5 text-[var(--pl-soft)]">{NON_AFFILIATION_NOTICE}</p>
        </section>

        {/* H. 하단 CTA */}
        <section aria-label="주문 안내" className="border-t border-[var(--pl-line)] py-14 text-center">
          <h2 className="text-2xl font-bold [font-family:var(--pl-serif)]">마음을 전할 준비가 되셨나요?</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--pl-muted)]">
            {placeName}
            {directionalParticle(placeName)} 보내는 화환, 지금 주문하실 수 있습니다.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a
              className="inline-flex min-h-12 items-center justify-center rounded-full bg-[var(--pl-gold)] px-8 text-sm font-bold text-white transition-opacity duration-150 hover:opacity-90"
              href={orderUrl}
            >
              화환 주문하기
            </a>
            <a
              className="inline-flex min-h-12 items-center justify-center rounded-full border-2 border-[var(--pl-navy)] px-8 text-sm font-bold text-[var(--pl-navy)] transition-colors duration-150 hover:bg-[var(--pl-navy)]/5"
              href={`#${PRODUCTS_SECTION_ID}`}
            >
              상품 보기
            </a>
          </div>
        </section>
      </div>

      <PlaceLandingStickyCta heroCtaId={HERO_CTA_ID} orderHref={orderUrl} productsHref={`#${PRODUCTS_SECTION_ID}`} />
    </div>
  )
}

function ProductCard({ product, orderHref }: Readonly<{ product: ProductCategoryCopy; orderHref: string }>) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[var(--pl-line)] bg-white">
      <div aria-hidden className="aspect-square bg-[radial-gradient(ellipse_at_35%_25%,#f8f4ec,transparent_60%),linear-gradient(155deg,#f6f1e8,#ebe1cf)] sm:aspect-[4/3]" />
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <p className="text-base font-bold">{product.name}</p>
        <p className="text-xs leading-5 text-[var(--pl-muted)]">{product.purpose}</p>
        <div className="mt-2">
          <a
            className="inline-flex min-h-9 items-center justify-center rounded-full bg-[var(--pl-navy)] px-4 text-xs font-bold text-white transition-colors duration-150 hover:bg-[var(--pl-navy-hover)]"
            href={orderHref}
          >
            바로 주문
          </a>
        </div>
      </div>
    </div>
  )
}

function DashItem({ item }: Readonly<{ item: SituationItem }>) {
  return (
    <div>
      <p className="text-sm font-bold">
        <span aria-hidden className="mr-1.5 text-[var(--pl-gold)]">
          —
        </span>
        {item.title}
      </p>
      <p className="mt-1 text-sm leading-6 text-[var(--pl-muted)]">{item.body}</p>
    </div>
  )
}
