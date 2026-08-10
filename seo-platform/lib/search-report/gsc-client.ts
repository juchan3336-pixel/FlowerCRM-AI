// Google Search Console(GSC) Search Analytics 클라이언트 — 서비스 계정 JWT로 직접 인증한다.
//
// googleapis 패키지를 쓰지 않는 이유: 필요한 호출이 토큰 교환 1개 + searchanalytics.query 1개뿐이라
// 의존성(수 MB)을 늘릴 이유가 없다. RS256 서명은 node:crypto로 충분하다.
//
// 필요한 환경 변수 (Vercel):
// - GSC_CLIENT_EMAIL: 서비스 계정 이메일 (…@….iam.gserviceaccount.com)
// - GSC_PRIVATE_KEY:  서비스 계정 개인키 PEM (JSON 키 파일의 private_key 값 — \n 이스케이프 허용)
// - GSC_SITE_URL:     GSC 속성 식별자 (도메인 속성이면 "sc-domain:example.com", URL 접두 속성이면 "https://…/")
// 서비스 계정을 Search Console 속성에 '전체' 권한 사용자로 추가해야 데이터가 조회된다.
import { createSign } from "node:crypto"

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"

export type GscCredentials = {
  readonly clientEmail: string
  readonly privateKey: string
  readonly siteUrl: string
}

export type GscQueryRequest = {
  readonly startDate: string // YYYY-MM-DD (GSC 기준일 — PT 타임존이지만 일 단위 지표라 그대로 쓴다)
  readonly endDate: string
  readonly dimensions: readonly ("date" | "page" | "query")[]
  readonly rowLimit?: number
  // all = 최근(잠정) 데이터 포함 — 최근 2~3일 지표는 이후 실행에서 확정값으로 덮어쓴다.
  readonly dataState?: "all" | "final"
}

export type GscRow = {
  readonly keys: readonly string[]
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly position: number
}

export function readGscCredentialsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): GscCredentials | null {
  const clientEmail = env["GSC_CLIENT_EMAIL"]
  const rawKey = env["GSC_PRIVATE_KEY"]
  const siteUrl = env["GSC_SITE_URL"]
  if (clientEmail === undefined || clientEmail.length === 0 || rawKey === undefined || rawKey.length === 0 || siteUrl === undefined || siteUrl.length === 0) {
    return null
  }
  // Vercel env에 한 줄로 저장된 키는 \n이 리터럴로 들어온다 — 실제 개행으로 복원한다.
  return { clientEmail, privateKey: rawKey.replace(/\\n/g, "\n"), siteUrl }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

// 서비스 계정 JWT 조립 + RS256 서명 — 토큰 교환 요청의 assertion이 된다.
export function buildServiceAccountJwt(credentials: Pick<GscCredentials, "clientEmail" | "privateKey">, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = base64url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  )
  const signer = createSign("RSA-SHA256")
  signer.update(`${header}.${claims}`)
  const signature = signer.sign(credentials.privateKey).toString("base64url")
  return `${header}.${claims}.${signature}`
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class GscApiError extends Error {
  readonly name = "GscApiError"

  constructor(
    readonly step: "token" | "query",
    readonly status: number,
    detail: string,
  ) {
    // 응답 본문은 키·토큰이 없더라도 300자로 자른다 — 로그 폭주 방지.
    super(`GSC ${step} failed (${String(status)}): ${detail.slice(0, 300)}`)
  }
}

export async function fetchGscAccessToken(
  credentials: Pick<GscCredentials, "clientEmail" | "privateKey">,
  deps: Readonly<{ fetchImpl?: FetchLike; nowSeconds?: number }> = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const assertion = buildServiceAccountJwt(credentials, deps.nowSeconds ?? Math.floor(Date.now() / 1000))
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new GscApiError("token", response.status, text)
  }
  const parsed = JSON.parse(text) as { access_token?: string }
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new GscApiError("token", response.status, "missing access_token")
  }
  return parsed.access_token
}

export async function queryGscSearchAnalytics(
  credentials: GscCredentials,
  request: GscQueryRequest,
  deps: Readonly<{ fetchImpl?: FetchLike; accessToken?: string }> = {},
): Promise<readonly GscRow[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const accessToken = deps.accessToken ?? (await fetchGscAccessToken(credentials, { fetchImpl }))
  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(credentials.siteUrl)}/searchAnalytics/query`
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      startDate: request.startDate,
      endDate: request.endDate,
      dimensions: request.dimensions,
      rowLimit: request.rowLimit ?? 25000,
      dataState: request.dataState ?? "all",
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new GscApiError("query", response.status, text)
  }
  const parsed = JSON.parse(text) as { rows?: readonly GscRow[] }
  return parsed.rows ?? []
}
