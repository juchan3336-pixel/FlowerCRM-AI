"use client"

import { useEffect, useState } from "react"

type PlaceLandingStickyCtaProps = {
  readonly orderHref: string
  readonly productsHref: string
  readonly heroCtaId: string
}

// 모바일 하단 고정 CTA — Hero의 대표 CTA가 화면에 보이는 동안은 숨겨 중복 노출을 막는다.
// IntersectionObserver는 일부 내장 브라우저에서 발화하지 않아 scroll 리스너(rAF 스로틀)로 판정한다.
export function PlaceLandingStickyCta({ orderHref, productsHref, heroCtaId }: PlaceLandingStickyCtaProps) {
  const [heroCtaVisible, setHeroCtaVisible] = useState(true)

  useEffect(() => {
    const update = () => {
      const heroCta = document.getElementById(heroCtaId)
      if (heroCta === null) {
        setHeroCtaVisible(false)
        return
      }
      const rect = heroCta.getBoundingClientRect()
      setHeroCtaVisible(rect.bottom > 0 && rect.top < window.innerHeight)
    }

    let frame = requestAnimationFrame(update)
    const requestUpdate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    window.addEventListener("scroll", requestUpdate, { passive: true })
    window.addEventListener("resize", requestUpdate)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", requestUpdate)
      window.removeEventListener("resize", requestUpdate)
    }
  }, [heroCtaId])

  return (
    <div
      aria-hidden={heroCtaVisible}
      className={`fixed inset-x-0 bottom-0 z-40 flex gap-2 border-t border-[var(--pl-line)] bg-[var(--pl-bg)]/95 px-4 py-2.5 backdrop-blur-sm transition-transform duration-200 sm:hidden ${
        heroCtaVisible ? "translate-y-full" : "translate-y-0"
      }`}
    >
      <a
        className="pl-cta-primary inline-flex min-h-12 flex-1 items-center justify-center rounded-full bg-[var(--pl-navy)] text-sm font-bold text-white"
        href={orderHref}
        tabIndex={heroCtaVisible ? -1 : 0}
      >
        화환 주문하기
      </a>
      <a
        className="inline-flex min-h-12 items-center justify-center rounded-full border-2 border-[var(--pl-navy)] px-5 text-sm font-bold text-[var(--pl-navy)]"
        href={productsHref}
        tabIndex={heroCtaVisible ? -1 : 0}
      >
        상품 보기
      </a>
    </div>
  )
}
