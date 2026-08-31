// 지역×업종 허브 (P1) — 지역 정규화·허브 업종 판정·published 자동 그룹핑의 중앙 계층.
//
// 원칙 (2026-08-31 작업지시):
// - 허브별 장소 목록을 코드에 나열하지 않는다. published 데이터(PublicPageDto)에서 매 렌더 시 동적으로 묶는다.
//   신규 장소가 publish되면 코드 수정 없이 해당 허브·내부링크·sitemap에 자동 편입된다.
// - DB는 수정하지 않는다. region 품질 문제(예: 아이스퀘어호텔 region="김해")는 이 resolver가 흡수한다.
// - 업체명으로 지역을 추측하지 않는다 — 지역 판정 입력은 region/district/address 뿐이다.
// - 업종은 중앙 contentModeForCategory를 재사용하고, celebration 안에서 예식장 여부만
//   명칭 근거(웨딩·예식·컨벤션 등)로 판정한다. 근거 없는 일반 호텔은 허브에 넣지 않는다(diagnostic).
// - 이번 단계에서는 P1 허브 7개만 활성화한다. 그룹핑 엔진은 일반화돼 있지만
//   P1 목록 밖 조합은 허브 URL을 만들지 않는다 (자동 대량 생성 금지).
import { contentModeForCategory } from "@/lib/ai/content-mode"
import { isLodgingFacilityName } from "@/lib/domain/facility-type"
import type { PublicPageDto, SitemapEntry } from "./types"

// ── 지역 정규화 ───────────────────────────────────────────────────

export type SidoCode =
  | "seoul" | "busan" | "daegu" | "incheon" | "gwangju" | "daejeon" | "ulsan" | "sejong"
  | "gyeonggi" | "gangwon" | "chungbuk" | "chungnam" | "jeonbuk" | "jeonnam" | "gyeongbuk" | "gyeongnam" | "jeju"

export const SIDO_LABELS: Readonly<Record<SidoCode, string>> = {
  seoul: "서울", busan: "부산", daegu: "대구", incheon: "인천", gwangju: "광주", daejeon: "대전",
  ulsan: "울산", sejong: "세종", gyeonggi: "경기", gangwon: "강원", chungbuk: "충북", chungnam: "충남",
  jeonbuk: "전북", jeonnam: "전남", gyeongbuk: "경북", gyeongnam: "경남", jeju: "제주",
}

// 시/도 별칭 → 코드. 줄임말·정식 명칭·광역시 표기를 전부 흡수한다.
const SIDO_ALIASES: Readonly<Record<string, SidoCode>> = {
  서울: "seoul", 서울시: "seoul", 서울특별시: "seoul",
  부산: "busan", 부산시: "busan", 부산광역시: "busan",
  대구: "daegu", 대구시: "daegu", 대구광역시: "daegu",
  인천: "incheon", 인천시: "incheon", 인천광역시: "incheon",
  광주: "gwangju", 광주시: "gwangju", 광주광역시: "gwangju",
  대전: "daejeon", 대전시: "daejeon", 대전광역시: "daejeon",
  울산: "ulsan", 울산시: "ulsan", 울산광역시: "ulsan",
  세종: "sejong", 세종시: "sejong", 세종특별자치시: "sejong",
  경기: "gyeonggi", 경기도: "gyeonggi",
  강원: "gangwon", 강원도: "gangwon", 강원특별자치도: "gangwon",
  충북: "chungbuk", 충청북도: "chungbuk",
  충남: "chungnam", 충청남도: "chungnam",
  전북: "jeonbuk", 전라북도: "jeonbuk", 전북특별자치도: "jeonbuk",
  전남: "jeonnam", 전라남도: "jeonnam",
  경북: "gyeongbuk", 경상북도: "gyeongbuk",
  경남: "gyeongnam", 경상남도: "gyeongnam",
  제주: "jeju", 제주도: "jeju", 제주특별자치도: "jeju",
}

export type RegionResolverInput = {
  readonly region: string | null
  readonly district: string | null
  readonly address: string | null
}

// 시/도 판정 — 우선순위: ① region 필드가 시/도 별칭 ② 주소 첫 토큰 ③ 주소 내 별칭 토큰 탐색.
// 어느 것도 아니면 null (허브 제외 + diagnostic). 업체명은 입력이 아니다.
export function resolveSidoCode(input: RegionResolverInput): SidoCode | null {
  const region = (input.region ?? "").trim()
  const fromRegion = SIDO_ALIASES[region]
  if (fromRegion !== undefined) {
    return fromRegion
  }
  const addressTokens = (input.address ?? "").trim().split(/\s+/).filter((token) => token.length > 0)
  const first = addressTokens[0]
  if (first !== undefined && SIDO_ALIASES[first] !== undefined) {
    return SIDO_ALIASES[first]
  }
  // region이 시/군 단위(예: "김해")로 들어온 행 — 주소 안 어디든 시/도 별칭이 있으면 그것을 쓴다.
  for (const token of addressTokens) {
    const code = SIDO_ALIASES[token]
    if (code !== undefined) {
      return code
    }
  }
  return null
}

// ── 허브 업종 판정 ────────────────────────────────────────────────

export type HubType = "funeral" | "wedding" | "corporate"

// celebration 안에서 예식장(행사장)임을 보여주는 명칭 근거 — 근거 없는 일반 호텔·숙박은 허브 대상이 아니다.
const WEDDING_VENUE_PATTERN = /(웨딩|예식|컨벤션|연회|뷔페|부페)/

export function resolveHubType(place: Readonly<{ name: string; category: string }>): HubType | null {
  const mode = contentModeForCategory(place.category)
  if (mode === "condolence") {
    return "funeral"
  }
  if (mode === "corporate-celebration") {
    return "corporate"
  }
  if (mode === "celebration") {
    // 방어: 펜션류가 어떤 경로로든 published에 남아 있어도 허브에는 넣지 않는다 (분리 정책 유지).
    if (isLodgingFacilityName(place.name)) {
      return null
    }
    return WEDDING_VENUE_PATTERN.test(place.name) ? "wedding" : null
  }
  return null
}

// ── 허브 정의 (P1 고정 7개) ───────────────────────────────────────

export type HubDefinition = {
  readonly slug: string
  readonly hubType: HubType
  readonly sido: SidoCode
}

// P1 허브만 활성 — 이 목록 밖의 (업종, 지역) 조합은 허브 URL을 만들지 않는다.
export const P1_HUBS: readonly HubDefinition[] = [
  { slug: "funeral-gyeongbuk", hubType: "funeral", sido: "gyeongbuk" },
  { slug: "funeral-gyeongnam", hubType: "funeral", sido: "gyeongnam" },
  { slug: "funeral-daegu", hubType: "funeral", sido: "daegu" },
  { slug: "wedding-gyeongnam", hubType: "wedding", sido: "gyeongnam" },
  { slug: "wedding-daegu", hubType: "wedding", sido: "daegu" },
  { slug: "wedding-ulsan", hubType: "wedding", sido: "ulsan" },
  { slug: "corporate-ulsan", hubType: "corporate", sido: "ulsan" },
]

export function findHubBySlug(slug: string): HubDefinition | undefined {
  return P1_HUBS.find((hub) => hub.slug === slug)
}

export function hubPath(hub: HubDefinition): string {
  return `/hub/${hub.slug}`
}

// 향후 자동 확장용 활성 기준 — 이번 단계에서는 지표로만 쓰고, 허브 생성 자체는 P1 목록이 결정한다.
export function hubActivation(publishedCount: number): "active" | "hold" | "inactive" {
  if (publishedCount >= 3) return "active"
  if (publishedCount === 2) return "hold"
  return "inactive"
}

// 허브 화면·anchor 문구 — 업종별 화환 종류.
export const HUB_TYPE_COPY: Readonly<Record<HubType, { readonly facilityLabel: string; readonly wreathLabel: string }>> = {
  funeral: { facilityLabel: "장례식장", wreathLabel: "근조화환" },
  wedding: { facilityLabel: "예식장", wreathLabel: "축하화환" },
  corporate: { facilityLabel: "기업·사업장", wreathLabel: "축하화환" },
}

export function hubTitle(hub: HubDefinition): string {
  const copy = HUB_TYPE_COPY[hub.hubType]
  return `${SIDO_LABELS[hub.sido]} ${copy.facilityLabel} ${copy.wreathLabel} 안내`
}

// 허브→상세 anchor: "<업체명> 근조화환 안내" / "<업체명> 축하화환 안내"
export function hubMemberAnchor(hub: HubDefinition, placeName: string): string {
  return `${placeName} ${HUB_TYPE_COPY[hub.hubType].wreathLabel} 안내`
}

// ── published 자동 그룹핑 ─────────────────────────────────────────

export type HubPlacementDiagnostic = {
  readonly path: string
  readonly name: string
  readonly reason: "no-place-meta" | "region-unresolved" | "hub-type-unresolved" | "no-active-hub"
}

export type HubGrouping = {
  readonly byHub: ReadonlyMap<string, readonly PublicPageDto[]>
  readonly diagnostics: readonly HubPlacementDiagnostic[]
}

// 허브 편입 판정 1건 — 그룹핑·상세 역링크가 같은 판정을 공유한다.
export function hubForPage(page: PublicPageDto): HubDefinition | null {
  if (page.dataOrigin !== "database" || page.type !== "place" || page.place === null) {
    return null
  }
  const sido = resolveSidoCode({ region: page.region, district: page.district, address: page.address })
  if (sido === null) {
    return null
  }
  const hubType = resolveHubType(page.place)
  if (hubType === null) {
    return null
  }
  return P1_HUBS.find((hub) => hub.hubType === hubType && hub.sido === sido) ?? null
}

// published 페이지 전체 → 허브별 목록. fixture·place 메타 없는 행은 입장 자체가 안 된다.
export function groupPagesByHub(pages: readonly PublicPageDto[]): HubGrouping {
  const byHub = new Map<string, PublicPageDto[]>()
  for (const hub of P1_HUBS) {
    byHub.set(hub.slug, [])
  }
  const diagnostics: HubPlacementDiagnostic[] = []
  for (const page of pages) {
    if (page.dataOrigin !== "database" || page.type !== "place") {
      continue // fixture/seed — 허브 표면 밖 (diagnostic 대상도 아님)
    }
    if (page.place === null) {
      diagnostics.push({ path: page.path, name: page.title, reason: "no-place-meta" })
      continue
    }
    const sido = resolveSidoCode({ region: page.region, district: page.district, address: page.address })
    if (sido === null) {
      diagnostics.push({ path: page.path, name: page.place.name, reason: "region-unresolved" })
      continue
    }
    const hubType = resolveHubType(page.place)
    if (hubType === null) {
      diagnostics.push({ path: page.path, name: page.place.name, reason: "hub-type-unresolved" })
      continue
    }
    const hub = P1_HUBS.find((entry) => entry.hubType === hubType && entry.sido === sido)
    if (hub === undefined) {
      diagnostics.push({ path: page.path, name: page.place.name, reason: "no-active-hub" })
      continue
    }
    byHub.get(hub.slug)?.push(page)
  }
  for (const members of byHub.values()) {
    members.sort(compareHubMembers)
  }
  return { byHub, diagnostics }
}

// 목록 정렬: 시/군/구 가나다 → 업체명 가나다 (안정적인 화면 순서).
function compareHubMembers(a: PublicPageDto, b: PublicPageDto): number {
  const districtCompare = (a.district ?? "").localeCompare(b.district ?? "", "ko")
  if (districtCompare !== 0) {
    return districtCompare
  }
  return (a.place?.name ?? a.title).localeCompare(b.place?.name ?? b.title, "ko")
}

// ── 관련 장소 추천 (상세 페이지 하단) ────────────────────────────
// 우선순위: 같은 시/군/구 → 같은 시/도 → 같은 hub type. 자기 자신·fixture·허브 미편입 장소 제외, 최대 5곳.
export const RELATED_PLACES_LIMIT = 5

export function pickRelatedPlaces(current: PublicPageDto, pages: readonly PublicPageDto[]): readonly PublicPageDto[] {
  const currentHub = hubForPage(current)
  if (currentHub === null) {
    return []
  }
  const currentSido = resolveSidoCode({ region: current.region, district: current.district, address: current.address })
  const candidates = pages.filter((page) => {
    if (page.path === current.path) {
      return false
    }
    const hub = hubForPage(page)
    return hub !== null && hub.hubType === currentHub.hubType
  })
  const seen = new Set<string>()
  const picked: PublicPageDto[] = []
  const pushAll = (subset: readonly PublicPageDto[]) => {
    for (const page of subset) {
      if (picked.length >= RELATED_PLACES_LIMIT || seen.has(page.path)) {
        continue
      }
      seen.add(page.path)
      picked.push(page)
    }
  }
  const sameDistrict = current.district === null ? [] : candidates.filter((page) => page.district === current.district)
  const sameSido = candidates.filter((page) => resolveSidoCode({ region: page.region, district: page.district, address: page.address }) === currentSido)
  pushAll([...sameDistrict].sort(compareHubMembers))
  pushAll([...sameSido].sort(compareHubMembers))
  pushAll([...candidates].sort(compareHubMembers))
  return picked
}

// ── sitemap ──────────────────────────────────────────────────────
// 활성 P1 허브 중 published 구성원이 1곳 이상인 허브만 sitemap에 넣는다
// (구성원 0인 허브는 페이지도 404라 sitemap에 두면 soft 404가 된다).
export function buildHubSitemapEntries(pages: readonly PublicPageDto[], siteUrl: string): readonly SitemapEntry[] {
  const { byHub } = groupPagesByHub(pages)
  const base = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl
  const entries: SitemapEntry[] = []
  for (const hub of P1_HUBS) {
    const members = byHub.get(hub.slug) ?? []
    if (members.length === 0) {
      continue
    }
    const lastModified = members.reduce((latest, page) => (page.lastModifiedAt > latest ? page.lastModifiedAt : latest), members[0]?.lastModifiedAt ?? new Date(0).toISOString())
    entries.push({ url: `${base}${hubPath(hub)}`, lastModified, changeFrequency: "daily", priority: 0.7 })
  }
  return entries
}
