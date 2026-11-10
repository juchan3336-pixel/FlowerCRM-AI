// 광고 소재 샘플 — 테스트와 이후 관리자 화면 미리보기에서 쓰는 고정 예시. 외부 호출·DB 없이 조립된다.
// 실제 게시용 문안이 아니다. 근조·예식·기업 세 모드가 각각 품질 검사를 통과하는 최소 형태만 담는다.
import type { ContentMode } from "@/lib/ai/content-mode"

import { resolveOrderDestination } from "./order-destination"
import { buildTrackedOrderUrl } from "./tracking-url"
import type { AdCopy, MarketingChannelCode, MarketingVariantDraft, OrderDestinationCode } from "./types"

export const SAMPLE_AD_COPY: Readonly<Record<ContentMode, AdCopy>> = {
  condolence: {
    title: "근조화환 주문 전에 확인할 세 가지",
    body: "장례식장으로 근조화환을 보내실 때는 빈소 호실과 상주 성함, 리본 문구를 먼저 확인해 두시면 주문이 수월합니다. 도착 시점은 주문 과정에서 확인하실 수 있습니다.",
    caption: "근조화환 주문 준비 안내",
    imageTexts: ["근조화환 주문 준비"],
  },
  celebration: {
    title: "예식장 축하화환 리본 문구 정하는 법",
    body: "결혼식 축하화환은 예식 날짜와 홀 이름, 보내는 분 성함을 정확히 적는 것이 중요합니다. 리본 문구 예시는 주문 과정에서 확인하실 수 있습니다.",
    caption: "예식 축하화환 리본 문구 안내",
    imageTexts: ["결혼을 축하합니다"],
  },
  "corporate-celebration": {
    title: "개업·취임 축하화환 보낼 때 준비할 정보",
    body: "개업식이나 취임식에 축하화환을 보내실 때는 행사 일시와 받는 분 직함, 회사명을 미리 확인해 주세요. 리본 문구는 주문 과정에서 직접 입력하실 수 있습니다.",
    caption: "개업·취임 축하화환 안내",
    imageTexts: ["개업을 축하합니다"],
  },
}

const SAMPLE_CAMPAIGN_CODE: Readonly<Record<ContentMode, string>> = {
  condolence: "condolence-guide-01",
  celebration: "wedding-ribbon-01",
  "corporate-celebration": "corporate-opening-01",
}

export type SampleVariantInput = {
  readonly mode: ContentMode
  readonly channel: MarketingChannelCode
  // 생략하면 채널 기본 목적지
  readonly destination?: OrderDestinationCode
}

export function buildSampleVariant(input: SampleVariantInput): MarketingVariantDraft {
  const resolved = resolveOrderDestination(input.destination === undefined ? { channel: input.channel, mode: input.mode } : { channel: input.channel, mode: input.mode, override: input.destination })
  const tracked = buildTrackedOrderUrl({
    channel: input.channel,
    destination: resolved.destination.code,
    baseUrl: resolved.url,
    campaignCode: SAMPLE_CAMPAIGN_CODE[input.mode],
    variantCode: "v1",
  })
  return {
    mode: input.mode,
    channel: input.channel,
    destination: resolved.destination.code,
    orderUrl: tracked.url,
    copy: SAMPLE_AD_COPY[input.mode],
    imageRefs: [`sample/${input.mode}/square.webp`],
    revision: 1,
  }
}
