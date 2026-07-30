"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

// 진행 중일 때만 서버 컴포넌트를 다시 그린다.
// 이 카드는 self-chain이 서버에서 도는 동안 상태가 바뀌므로, 새로고침하지 않으면 클릭 당시 화면에
// 그대로 머문다 (2026-07-29에 밤새 "진행 중"으로 보였던 화면이 실제로는 끝난 job이었다).
// 폴링 대상은 이미 force-dynamic인 /admin/sync 한 곳뿐이고, 진행이 끝나면 running=false가 되어 멈춘다.
export const SYNC_JOB_REFRESH_MS = 10_000

export function SyncJobAutoRefresh({ running }: Readonly<{ running: boolean }>) {
  const router = useRouter()

  useEffect(() => {
    if (!running) {
      return
    }
    const timer = setInterval(() => {
      router.refresh()
    }, SYNC_JOB_REFRESH_MS)
    return () => {
      clearInterval(timer)
    }
  }, [running, router])

  return null
}
