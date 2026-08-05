export type PublishEnvironment = "production" | "preview" | "development" | "local"

export type PublishEnvironmentDecision = {
  readonly environment: PublishEnvironment
  readonly allowed: boolean
}

// 게시·보관·복원은 실행된 배포의 캐시만 revalidate할 수 있다 (Vercel ISR 캐시는 배포 간 유지되지만
// on-demand revalidation은 실행 배포 기준). Preview/Development 배포에서 실행하면 DB만 바뀌고
// 운영 공개 페이지 캐시가 갱신되지 않아 stale 404/200이 남으므로 Production 배포에서만 허용한다.
// 로컬 개발(VERCEL_ENV 미설정)은 개발 도구로 간주해 허용하되, 게시 후 공개 URL 검증이 실패를 드러낸다.
export function resolvePublishEnvironment(vercelEnv: string | undefined): PublishEnvironmentDecision {
  if (vercelEnv === "production") {
    return { environment: "production", allowed: true }
  }
  if (vercelEnv === "preview") {
    return { environment: "preview", allowed: false }
  }
  if (vercelEnv === "development") {
    return { environment: "development", allowed: false }
  }
  return { environment: "local", allowed: true }
}

// 수동 AI 생성·복구 재시도는 게시와 방향이 반대다: 실생성은 고정 Preview(AI_PROVIDER=openai) 전용이고
// Production은 AI_PROVIDER=fake라 샘플 초안만 만들어진다 (2026-08-04 KCC에서 운영자 클릭으로
// fake 초안 2건이 생긴 실측 사고). 같은 환경 판정을 재사용하되 Production만 막는다 —
// Preview는 실생성 환경이고, 로컬·development는 개발 도구(fake)로 허용한다.
export function resolveManualGenerationEnvironment(vercelEnv: string | undefined): PublishEnvironmentDecision {
  const decision = resolvePublishEnvironment(vercelEnv)
  return { environment: decision.environment, allowed: decision.environment !== "production" }
}
