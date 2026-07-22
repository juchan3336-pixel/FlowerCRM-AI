"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

import { cancelBatchAction, processNextBatchItemAction } from "@/app/admin/batch/actions"

type BatchProgressRunnerProps = {
  readonly batchId: string
  readonly runStatus: "running" | "completed" | "cancelled" | "failed"
  readonly hasClaimable: boolean
  // 최초 시작(start=1 쿼리)만 자동 진행 — 재진입·새로고침 시에는 '이어서 진행' 버튼을 눌러야 한다.
  readonly autoStart: boolean
}

export function BatchProgressRunner({ batchId, runStatus, hasClaimable, autoStart }: BatchProgressRunnerProps) {
  const router = useRouter()
  const [looping, setLooping] = useState(false)
  const [stopRequested, setStopRequested] = useState(false)
  const stopRef = useRef(false)
  const startedRef = useRef(false)

  const runLoop = useCallback(async () => {
    if (stopRef.current) {
      return
    }
    setLooping(true)
    try {
      // 한 번에 1건만 처리하고 화면을 갱신한다 — 완료 응답 후 다음 호출이라 순차성이 보장된다.
      let guard = 0
      while (guard < 10) {
        if (stopRef.current as boolean) {
          break
        }
        guard += 1
        const result = await processNextBatchItemAction(batchId)
        router.refresh()
        if (result.done) {
          break
        }
      }
    } finally {
      setLooping(false)
    }
  }, [batchId, router])

  useEffect(() => {
    if (autoStart && runStatus === "running" && !startedRef.current) {
      startedRef.current = true
      void runLoop()
    }
  }, [autoStart, runStatus, runLoop])

  if (runStatus !== "running") {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {looping ? (
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          순차 처리 중… (장소별 결과가 나올 때마다 목록이 갱신됩니다)
        </p>
      ) : hasClaimable ? (
        <button
          className="rounded-full bg-[var(--accent-primary)] px-6 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          onClick={() => {
            stopRef.current = false
            setStopRequested(false)
            void runLoop()
          }}
          type="button"
        >
          이어서 진행
        </button>
      ) : null}
      <form action={cancelBatchAction}>
        <input name="batchId" type="hidden" value={batchId} />
        <button
          className="rounded-full border border-[var(--status-warning)] px-6 py-2.5 text-sm font-semibold text-[var(--status-warning)] hover:bg-[var(--status-warning)]/10 disabled:opacity-50"
          disabled={stopRequested}
          onClick={() => {
            // 현재 처리 중인 장소는 완료되고, 남은 대기 건은 서버에서 건너뜀 처리된다.
            stopRef.current = true
            setStopRequested(true)
          }}
          type="submit"
        >
          중단 (남은 건 건너뜀)
        </button>
      </form>
    </div>
  )
}
