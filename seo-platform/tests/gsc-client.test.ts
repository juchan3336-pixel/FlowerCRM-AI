// GSC 클라이언트 — 서비스 계정 JWT 서명과 API 요청 형태 계약.
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto"
import { describe, expect, it } from "vitest"

import { buildServiceAccountJwt, GscApiError, queryGscSearchAnalytics, readGscCredentialsFromEnv } from "@/lib/search-report/gsc-client"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()

describe("서비스 계정 JWT", () => {
  it("builds an RS256 JWT with the webmasters scope that verifies against the public key", () => {
    const jwt = buildServiceAccountJwt({ clientEmail: "svc@test.iam.gserviceaccount.com", privateKey: privatePem }, 1_770_000_000)
    const [header, claims, signature] = jwt.split(".")
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" })
    const parsedClaims = JSON.parse(Buffer.from(claims ?? "", "base64url").toString()) as Record<string, unknown>
    expect(parsedClaims["iss"]).toBe("svc@test.iam.gserviceaccount.com")
    expect(parsedClaims["scope"]).toBe("https://www.googleapis.com/auth/webmasters.readonly")
    expect(parsedClaims["aud"]).toBe("https://oauth2.googleapis.com/token")
    expect(parsedClaims["exp"]).toBe(1_770_003_600)
    const verified = cryptoVerify("RSA-SHA256", Buffer.from(`${header ?? ""}.${claims ?? ""}`), publicKey, Buffer.from(signature ?? "", "base64url"))
    expect(verified).toBe(true)
  })

  it("restores escaped newlines when reading the private key from env", () => {
    const escaped = privatePem.replace(/\n/g, "\\n")
    const credentials = readGscCredentialsFromEnv({ GSC_CLIENT_EMAIL: "svc@test", GSC_PRIVATE_KEY: escaped, GSC_SITE_URL: "sc-domain:example.com" })
    expect(credentials?.privateKey).toBe(privatePem)
    expect(readGscCredentialsFromEnv({ GSC_CLIENT_EMAIL: "svc@test" })).toBeNull()
  })
})

describe("searchAnalytics.query 요청", () => {
  const credentials = { clientEmail: "svc@test", privateKey: privatePem, siteUrl: "sc-domain:example.com" }

  it("posts to the encoded site endpoint with the access token and returns rows", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} })
      return Promise.resolve(
        new Response(JSON.stringify({ rows: [{ keys: ["https://example.com/places/a", "화환"], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] }), { status: 200 }),
      )
    }
    const rows = await queryGscSearchAnalytics(
      credentials,
      { startDate: "2026-08-05", endDate: "2026-08-05", dimensions: ["page", "query"] },
      { fetchImpl, accessToken: "token-1" },
    )

    expect(rows).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query")
    expect((calls[0]?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-1")
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>
    expect(body).toMatchObject({ startDate: "2026-08-05", dimensions: ["page", "query"], rowLimit: 25000, startRow: 0, dataState: "all" })
  })

  it("paginates with startRow when a page comes back full", async () => {
    const makeRow = (i: number) => ({ keys: [`https://example.com/places/p${String(i)}`], clicks: 0, impressions: 1, ctr: 0, position: 1 })
    const bodies: number[] = []
    const fetchImpl = (url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { startRow: number; rowLimit: number }
      bodies.push(body.startRow)
      // 1페이지는 rowLimit 가득, 2페이지는 1행 — 두 번째에서 종료해야 한다.
      const rows = body.startRow === 0 ? Array.from({ length: body.rowLimit }, (_, i) => makeRow(i)) : [makeRow(999999)]
      return Promise.resolve(new Response(JSON.stringify({ rows }), { status: 200 }))
    }
    const rows = await queryGscSearchAnalytics(credentials, { startDate: "d", endDate: "d", dimensions: ["page"], rowLimit: 3 }, { fetchImpl, accessToken: "t" })
    expect(rows).toHaveLength(4)
    expect(bodies).toEqual([0, 3])
  })

  it("wraps API failures in GscApiError with a truncated body and no throw-through of raw JSON", async () => {
    const fetchImpl = () => Promise.resolve(new Response("quota exceeded", { status: 429 }))
    await expect(queryGscSearchAnalytics(credentials, { startDate: "d", endDate: "d", dimensions: ["page"] }, { fetchImpl, accessToken: "t" })).rejects.toThrow(
      GscApiError,
    )
  })

  it("returns an empty list when the response has no rows (quiet days)", async () => {
    const fetchImpl = () => Promise.resolve(new Response("{}", { status: 200 }))
    const rows = await queryGscSearchAnalytics(credentials, { startDate: "d", endDate: "d", dimensions: ["page"] }, { fetchImpl, accessToken: "t" })
    expect(rows).toEqual([])
  })
})
