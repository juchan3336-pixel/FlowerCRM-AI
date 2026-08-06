// 1단계 업체 확인 보조 — 등록된 공식 홈페이지에서 업체명·주소·전화가 발견되는지 대조한다.
//
// 이 결과는 **판정이 아니라 근거**다. 2026-08-06 실측(장례식장 15곳)에서 홈페이지 본문만으로
// 3항목이 모두 잡힌 곳은 2곳뿐이었다 — 화면을 스크립트로 그리는 사이트, 연락처가 이미지인 사이트,
// 주소 표기 차이(도로명/지번) 때문이다. 그래서 "불일치 = 가짜"가 아니며, 자동 승인에 쓰지 않는다.
// 작업자가 홈페이지를 일일이 열지 않고도 확실한 건을 먼저 처리하도록 근거만 보여 주는 용도다.
//
// 매칭 규칙(순수 함수)과 네트워크 수집을 분리해 규칙만 따로 테스트한다.

export type EvidenceField = "name" | "address" | "phone"

export type VerificationEvidence = {
  readonly placeId: string
  // 홈페이지 응답 상태 — 0은 접속 실패(타임아웃·DNS·차단).
  readonly httpStatus: number
  readonly matched: readonly EvidenceField[]
  // 본문에서 글자를 거의 못 얻은 경우 (스크립트로 그리는 사이트 등) — "불일치"와 구분해서 보여준다.
  readonly textUnavailable: boolean
}

export function digitsOnly(value: string | null): string {
  return (value ?? "").replace(/\D/g, "")
}

// 주소에서 대조에 쓸 토큰들 — 도로명+번지와 지번(동/리 + 번지) 둘 다 뽑아 하나라도 맞으면 인정한다.
export function addressTokens(address: string | null): readonly string[] {
  const source = address ?? ""
  const tokens: string[] = []
  for (const pattern of [/([가-힣0-9]+(?:대?로|길))\s*(\d+(?:-\d+)?)/, /([가-힣]+(?:동|리|가))\s*(\d+(?:-\d+)?)/]) {
    const found = pattern.exec(source)
    const label = found?.[1]
    const number = found?.[2]
    if (label !== undefined && number !== undefined) {
      tokens.push(`${label}${number}`)
    }
  }
  return tokens
}

// 업체명 핵심어 — '전문장례식장' 같은 공통 접미어를 떼고 고유 부분만 남긴다.
export function nameCore(name: string): string {
  return name
    .replace(/(전문|종합|시립|공설)?\s*장례\s*(식장|예식장|문화원|타운)?/g, "")
    .replace(/\s+/g, "")
    .trim()
}

// 수집한 HTML 텍스트에서 무엇이 확인되는지 판정한다.
export function matchEvidenceFields(
  input: Readonly<{ text: string; name: string; address: string | null; phone: string | null }>,
): readonly EvidenceField[] {
  const flat = input.text.replace(/<[^>]+>/g, " ")
  const compact = flat.replace(/\s/g, "")
  const numeric = digitsOnly(flat)
  const matched: EvidenceField[] = []

  const core = nameCore(input.name)
  if (core.length >= 2 && compact.includes(core)) {
    matched.push("name")
  }
  if (addressTokens(input.address).some((token) => compact.includes(token))) {
    matched.push("address")
  }
  const phone = digitsOnly(input.phone)
  if (phone.length >= 9 && numeric.includes(phone)) {
    matched.push("phone")
  }
  return matched
}

// 본문에 한글이 거의 없으면 텍스트를 못 얻은 것으로 본다 — 불일치와 다른 상태다.
export function isTextUnavailable(text: string): boolean {
  const hangul = text.replace(/<[^>]+>/g, " ").match(/[가-힣]/g)
  return (hangul?.length ?? 0) < 20
}

// 연락처·위치가 있을 법한 하위 페이지 링크만 고른다 (전체 크롤링 금지 — 한 곳당 요청 수를 묶어 둔다).
const SUBPAGE_HINT = /(오시는|찾아오|약도|위치|연락|문의|contact|location|map|이용안내|시설|소개|about|intro|guide)/i
export const MAX_SUBPAGES = 2
export const FETCH_TIMEOUT_MS = 8_000

export function pickSubpageUrls(html: string, baseUrl: string): readonly string[] {
  const found: string[] = []
  for (const match of html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,60}?)<\/a>/gi)) {
    const href = match[1] ?? ""
    const label = match[2] ?? ""
    if (!SUBPAGE_HINT.test(label) && !SUBPAGE_HINT.test(href)) {
      continue
    }
    try {
      const absolute = new URL(href, baseUrl).toString()
      if (absolute.startsWith("http") && !found.includes(absolute)) {
        found.push(absolute)
      }
    } catch {
      // 잘못된 href는 건너뛴다.
    }
    if (found.length >= MAX_SUBPAGES) {
      break
    }
  }
  return found
}
