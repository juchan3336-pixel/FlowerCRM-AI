// 공개 루트(/) 고객용 첫 화면 — 순수 계층 (문구·sitemap 항목·JSON-LD).
// 역할 구분: /는 서비스 소개·이용 목적·주문 전 확인사항, /hub는 지역·업종 선택 — 내용을 복제하지 않는다.
import { buildCanonicalUrl } from "@/lib/public-seo/public-pages"
import type { JsonLdObject, PublicPageDto, SitemapEntry } from "@/lib/public-seo/types"

export const ROOT_TITLE = "장소별 근조·축하화환 안내"

// 루트는 layout과 같은 세그먼트라 title template("%s | 팔도플라워")이 적용되지 않는다 —
// 문서 title은 브랜드 접미사 1회를 직접 붙인 절대값을 쓴다.
export const ROOT_DOCUMENT_TITLE = `${ROOT_TITLE} | 팔도플라워`

// 소비자용 설명 — 공식 홈페이지·제휴로 오인시키는 표현, 배송 보장·가격 단정은 쓰지 않는다.
export const ROOT_DESCRIPTION =
  "장례식장 근조화환, 예식장·행사 축하화환, 기업·사업장 축하화환을 주문하기 전에 확인할 장소 정보를 지역별로 안내하는 팔도플라워 서비스입니다."

// 이용 목적 3종 — /hub 인덱스의 업종 축과 같은 순서.
export const ROOT_PURPOSES: readonly Readonly<{ heading: string; description: string }>[] = [
  { heading: "장례식장 근조화환", description: "조문 전에 장례식장 위치와 안내 정보를 확인하고 근조화환을 준비할 수 있습니다." },
  { heading: "예식장 축하화환", description: "예식장·웨딩홀·컨벤션의 행사 축하화환 주문 전 확인할 정보를 안내합니다." },
  { heading: "기업·사업장 축하화환", description: "개업·준공·창립 등 기업 행사 축하화환 주문 전 확인할 정보를 안내합니다." },
]

// 주문 전 확인사항 — 실제 고인·상주·빈소·행사 정보는 만들지 않는다 (일반 준비 항목만).
export const ROOT_CHECKLIST: readonly string[] = [
  "정확한 시설명과 주소",
  "행사 또는 장례 일정",
  "화환 수령 위치와 담당자",
  "시설별 화환 반입 절차 사전 확인",
]

// 루트 sitemap 항목 — lastmod는 게시 데이터 최신 변경 시각을 따른다 (첫 화면의 지역 안내 구성이
// 게시 상태에서 파생되므로, 허브 인덱스 항목과 같은 근거·계약을 쓴다).
// 게시 데이터가 하나도 없으면 null — sitemap은 비어 있어야 한다는 기존 계약 유지.
export function buildRootSitemapEntry(pages: readonly PublicPageDto[], siteUrl: string): SitemapEntry | null {
  if (pages.length === 0) {
    return null
  }
  const lastModified = pages.reduce((latest, page) => (page.lastModifiedAt > latest ? page.lastModifiedAt : latest), new Date(0).toISOString())
  return { url: buildCanonicalUrl(siteUrl, "/"), lastModified, changeFrequency: "daily", priority: 0.8 }
}

export function buildRootJsonLd(canonicalUrl: string): readonly JsonLdObject[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "팔도플라워 장소별 화환 안내",
      description: ROOT_DESCRIPTION,
      url: canonicalUrl,
      inLanguage: "ko",
    },
  ]
}
