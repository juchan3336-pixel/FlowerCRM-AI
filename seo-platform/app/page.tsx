import { RootEntry } from "@/components/root-entry"
import { resolveRootEnvironmentLabel } from "@/lib/root-recovery"

// 기존 테스트·호출부 경로 호환용 재-export (복구 리다이렉트 헬퍼).
export { buildRootCodeRecoveryRedirect, buildRootRecoveryRedirect } from "@/lib/root-recovery"

// 루트 진입 화면 — 환경 배지는 서버에서 판정한다 (Production은 배지 미노출).
export default function Home() {
  return <RootEntry environmentLabel={resolveRootEnvironmentLabel(process.env["VERCEL_ENV"])} />
}
