"use client"

import { useEffect, useRef, useState } from "react"

import type { ContentMode } from "@/lib/ai/content-mode"
import { BRAND_NAME, ORDER_BANNER_SIZE, orderBannerSpec } from "@/lib/marketing/order-banner"

const FONT_STACK = '"Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif'

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

function draw(canvas: HTMLCanvasElement, mode: ContentMode): void {
  const context = canvas.getContext("2d")
  if (context === null) {
    return
  }
  const spec = orderBannerSpec(mode)
  const { width, height } = ORDER_BANNER_SIZE
  context.fillStyle = spec.background
  context.fillRect(0, 0, width, height)

  context.textBaseline = "alphabetic"
  context.fillStyle = spec.muted
  context.font = `600 34px ${FONT_STACK}`
  context.fillText(BRAND_NAME, 80, 110)

  context.fillStyle = spec.foreground
  context.font = `700 68px ${FONT_STACK}`
  context.fillText(spec.headline, 80, 205)

  context.fillStyle = spec.muted
  context.font = `400 32px ${FONT_STACK}`
  context.fillText(spec.subline, 80, 262)

  // 버튼 모양 — 누르는 이미지임을 알 수 있게
  context.font = `700 34px ${FONT_STACK}`
  const label = `${spec.button}  ›`
  const buttonWidth = context.measureText(label).width + 88
  context.fillStyle = spec.accent
  roundedRect(context, 80, 292, buttonWidth, 68, 34)
  context.fill()
  context.fillStyle = spec.accentText
  context.fillText(label, 124, 338)
}

// 주문 배너 미리보기와 내려받기. 글에 이 이미지를 넣고 이미지에 주문 링크를 걸면, 누르면 주문 페이지로 가는 고정 배너가 된다.
export function OrderBanner({ mode, fileName, orderUrl }: Readonly<{ mode: ContentMode; fileName: string; orderUrl: string }>) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) {
      return
    }
    draw(canvas, mode)
    // 웹 폰트가 늦게 로드되면 다시 그린다
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (!cancelled) {
        draw(canvas, mode)
      }
    })
    return () => {
      cancelled = true
    }
  }, [mode])

  return (
    <div className="flex flex-col gap-3">
      <canvas
        aria-label={`주문 배너 미리보기: ${orderBannerSpec(mode).headline}`}
        className="w-full max-w-xl rounded-2xl border border-[var(--border-default)]"
        height={ORDER_BANNER_SIZE.height}
        ref={canvasRef}
        role="img"
        width={ORDER_BANNER_SIZE.width}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="inline-flex min-h-9 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] transition-colors duration-150 ease-out hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
          type="button"
          onClick={() => {
            const canvas = canvasRef.current
            if (canvas === null) {
              return
            }
            canvas.toBlob((blob) => {
              if (blob === null) {
                setMessage("이미지를 만들지 못했습니다. 미리보기를 마우스 오른쪽 버튼으로 저장해 주세요.")
                return
              }
              const url = URL.createObjectURL(blob)
              const link = document.createElement("a")
              link.href = url
              link.download = fileName
              link.click()
              URL.revokeObjectURL(url)
              setMessage("배너 이미지를 내려받았습니다.")
            }, "image/png")
          }}
        >
          배너 이미지 내려받기
        </button>
        <button
          className="inline-flex min-h-9 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] transition-colors duration-150 ease-out hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(orderUrl).then(
              () => {
                setMessage("배너에 걸 주문 링크를 복사했습니다.")
              },
              () => {
                setMessage("복사하지 못했습니다. 위의 주문 링크를 직접 선택해 복사해 주세요.")
              },
            )
          }}
        >
          배너에 걸 링크 복사
        </button>
        {message === null ? null : (
          <span className="text-xs text-[var(--text-secondary)]" role="status">
            {message}
          </span>
        )}
      </div>
    </div>
  )
}
