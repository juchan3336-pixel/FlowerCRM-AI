import type { Metadata } from "next"
import { headers } from "next/headers"

import { PublicRootLanding } from "@/components/public/root-landing"
import { RootEntry } from "@/components/root-entry"
import { RootRecoveryRedirect } from "@/components/root-recovery-redirect"
import { listPublishedPlacePages } from "@/lib/public-seo/place-pages"
import { buildCanonicalUrl } from "@/lib/public-seo/public-pages"
import { listActiveHubSummaries } from "@/lib/public-seo/region-hub"
import { ROOT_DESCRIPTION, ROOT_DOCUMENT_TITLE } from "@/lib/public-seo/root-landing"
import { resolveRootEnvironmentLabel } from "@/lib/root-recovery"
import { resolveRootSurface } from "@/lib/root-surface"
import { getPublicSiteUrl } from "@/lib/site-url"

// 기존 테스트·호출부 경로 호환용 재-export (복구 리다이렉트 헬퍼).
export { buildRootCodeRecoveryRedirect, buildRootRecoveryRedirect } from "@/lib/root-recovery"

// 루트(/)는 host로 표면을 가른다 — 공개 도메인은 고객용 첫 화면, 운영 관리자용
// origin(구 Vercel 도메인)은 기존 관리자 진입 화면(비밀번호 복구 리다이렉트 포함)을 보존한다.
// 고객용 화면의 지역 안내는 published 데이터에서 매 렌더 시 계산한다 (/hub와 같은 계약).
export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  const host = (await headers()).get("host")
  if (resolveRootSurface(host) === "admin") {
    // 관리자용 origin 루트는 기존 layout 기본 메타를 그대로 쓴다 (무변경).
    return {}
  }
  const canonicalUrl = buildCanonicalUrl(getPublicSiteUrl(), "/")
  // layout title template은 같은 세그먼트의 page에 적용되지 않는다 — 브랜드 접미사 1회를 직접 붙인다.
  return {
    title: { absolute: ROOT_DOCUMENT_TITLE },
    description: ROOT_DESCRIPTION,
    alternates: { canonical: canonicalUrl },
    openGraph: { title: ROOT_DOCUMENT_TITLE, description: ROOT_DESCRIPTION, url: canonicalUrl, type: "website" },
  }
}

export default async function Home() {
  const host = (await headers()).get("host")
  // 복구 리다이렉트는 표면과 무관하게 장착한다 — 복구 링크가 어느 도메인 루트에 도착해도 기존 흐름 보존.
  if (resolveRootSurface(host) === "admin") {
    return (
      <>
        <RootRecoveryRedirect />
        <RootEntry environmentLabel={resolveRootEnvironmentLabel(process.env["VERCEL_ENV"])} />
      </>
    )
  }
  const pages = await listPublishedPlacePages()
  return (
    <>
      <RootRecoveryRedirect />
      <PublicRootLanding summaries={listActiveHubSummaries(pages)} />
    </>
  )
}
