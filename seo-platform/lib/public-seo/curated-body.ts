import type { PublicPageDto } from "./types"

// 장소 본문 공개 — 검수 편집 본문(curated-editorial)이 붙은 페이지만 독립 본문 영역을 표시한다.
//
// 예전에는 옵트인 slug 목록에 있으면 DB 본문(places.description)을 그대로 실었다. 그 본문에 "예식 시작 전에
// 도착하도록 접수" 같은 단정 문장이 있었고(2026-09 1차 4곳), 2026-11-10에 편집 본문으로 대체했다.
// DB 본문으로 되돌아가는 경로는 두지 않는다: 편집 본문의 식별자가 맞지 않게 되면(SEO 페이지가 다시 만들어지거나
// 장소명이 바뀌면) 옛 문장이 다시 나타나는 대신 본문 영역 전체가 사라진다.
// 본문을 공개하려면 curated-editorial.ts에 검수한 편집 본문을 추가한다.
export function resolveCuratedBodyParagraphs(page: PublicPageDto): readonly string[] | null {
  if (page.editorialBody === null || page.editorialBody.paragraphs.length === 0) {
    return null
  }
  return page.editorialBody.paragraphs
}

// 공식 홈페이지 표기용 host — 링크 라벨에 원본 URL 전체 대신 도메인만 노출한다.
export function officialHomepageLabel(homepage: string): string | null {
  try {
    const url = new URL(homepage)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null
    }
    return url.hostname
  } catch {
    return null
  }
}
