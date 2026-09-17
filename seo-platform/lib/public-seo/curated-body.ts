import type { PublicPageDto } from "./types"

// 장소 본문(placeBody) 공개 옵트인 — 검수를 거친 페이지만 독립 본문 영역을 표시한다.
// 기존 AI 본문 98곳을 일괄 노출하지 않기 위한 게이트: 이 목록에 없는 페이지는
// placeBody가 있어도 화면에 나타나지 않는다 (기존 화면 무변경).
// 목록 추가 절차: 본문·FAQ를 공식 출처 기준으로 검수·보강한 뒤 PR로 slug를 추가한다.
export const CURATED_PLACE_BODY_SLUGS: ReadonlySet<string> = new Set([
  // 2026-09-17 콘텐츠 보강 1차 (예식 2·장례 2)
  "area-gyeongnam-changwonsi-riberakeonbensyeon",
  "area-gyeongnam-yangsansi-wweding-yangsanjeom",
  "funeral-gyeongnam-jinjusi-jinjujungangbyeongwon-jangryesikjang",
  "funeral-gyeongbuk-andongsi-andongjeonmunjangryesikjang",
])

// 표시할 본문 문단 — 옵트인 페이지가 아니거나 본문이 비어 있으면 null(영역 미표시).
// SEO 설명과 동일한 한 줄뿐인 본문은 중복 표시하지 않는다.
export function resolveCuratedBodyParagraphs(page: PublicPageDto): readonly string[] | null {
  if (!CURATED_PLACE_BODY_SLUGS.has(page.slug)) {
    return null
  }
  const body = page.placeBody?.trim() ?? ""
  if (body.length === 0 || body === page.description.trim()) {
    return null
  }
  const paragraphs = body
    .split(/\n{2,}|\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
  return paragraphs.length > 0 ? paragraphs : null
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
