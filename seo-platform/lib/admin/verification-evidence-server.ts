import "server-only"

// 대조 근거 수집 — 등록된 공식 홈페이지(+연락처성 하위 페이지 최대 2개)를 읽어 매칭 규칙에 넘긴다.
// 판정 규칙은 lib/admin/verification-evidence(순수 함수)에 있고, 여기서는 수집만 한다.
//
// 한 곳당 요청은 최대 3회(홈 + 하위 2)로 묶어 두고, 각 요청은 8초 타임아웃이다.
// 실패해도 예외를 던지지 않는다 — 근거가 없을 뿐이며 작업자는 직접 확인하면 된다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import {
  FETCH_TIMEOUT_MS,
  isTextUnavailable,
  matchEvidenceFields,
  pickSubpageUrls,
  type VerificationEvidence,
} from "./verification-evidence"

async function fetchText(url: string): Promise<{ readonly text: string; readonly status: number }> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0 (compatible; FlowerCRM-VerifyBot/1.0)" },
    })
    if (!response.ok) {
      return { text: "", status: response.status }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    let text = buffer.toString("utf8")
    // 국내 장례식장 사이트는 EUC-KR이 흔하다 — UTF-8 해석에 한글이 없으면 한 번 더 시도한다.
    if (!/[가-힣]/.test(text)) {
      try {
        text = new TextDecoder("euc-kr").decode(buffer)
      } catch {
        // 디코딩 실패 시 원문 유지
      }
    }
    return { text, status: response.status }
  } catch {
    return { text: "", status: 0 }
  }
}

export async function collectVerificationEvidence(placeId: string): Promise<VerificationEvidence> {
  const client = createSupabaseServiceRoleClient()
  const { data: place } = await client.from("places").select("id,name,address,phone,homepage").eq("id", placeId).maybeSingle()
  if (place === null || typeof place.homepage !== "string" || place.homepage.trim().length === 0) {
    return { placeId, httpStatus: 0, matched: [], textUnavailable: true }
  }

  const homepage = place.homepage.trim()
  const home = await fetchText(homepage)
  let combined = home.text
  for (const url of pickSubpageUrls(home.text, homepage)) {
    combined += (await fetchText(url)).text
  }

  return {
    placeId,
    httpStatus: home.status,
    matched: matchEvidenceFields({ text: combined, name: place.name, address: place.address, phone: place.phone }),
    textUnavailable: isTextUnavailable(combined),
  }
}
