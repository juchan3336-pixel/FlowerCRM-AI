// 허브 페이지 카피 — 사실 기반 일반 안내만 담는다.
//
// 금지 (2026-08-31 작업지시): 실제 빈소 존재·장례 진행 단정, 공식 제휴 표현, 배송 보장,
// 반입 가능 단정, 가격, 가상 시설. 아래 문구는 전부 "확인 안내" 어조를 유지한다.
import { HUB_TYPE_COPY, SIDO_LABELS, type HubDefinition } from "./region-hub"

export type HubFaqItem = { readonly question: string; readonly answer: string }

export type HubCopy = {
  readonly metaTitle: string
  readonly metaDescription: string
  readonly heading: string
  readonly intro: string
  readonly checklistTitle: string
  readonly checklist: readonly string[]
  readonly faq: readonly HubFaqItem[]
}

export function buildHubCopy(hub: HubDefinition, placeCount: number): HubCopy {
  const sido = SIDO_LABELS[hub.sido]
  const { facilityLabel, wreathLabel } = HUB_TYPE_COPY[hub.hubType]
  const heading = `${sido} ${facilityLabel} ${wreathLabel} 안내`
  const base = {
    metaTitle: `${sido} ${facilityLabel} ${wreathLabel} 안내 (${String(placeCount)}곳)`,
    heading,
  }
  switch (hub.hubType) {
    case "funeral":
      return {
        ...base,
        metaDescription: `${sido} 지역 장례식장 ${String(placeCount)}곳의 근조화환 주문 안내를 한곳에서 확인하세요. 시설별 위치·연락처와 주문 전 확인 사항을 정리했습니다.`,
        intro: `${sido} 지역에서 공식 홈페이지 확인을 거친 장례식장 ${String(placeCount)}곳의 근조화환 안내를 모았습니다. 각 시설 페이지에서 위치와 연락처, 화환 주문 전 확인할 정보를 볼 수 있습니다.`,
        checklistTitle: `${sido} 장례식장 근조화환 주문 전 확인 사항`,
        checklist: [
          "빈소명과 고인·상주 성함을 먼저 확인하고 리본 문구를 준비하세요.",
          "같은 이름의 시설이 여러 지역에 있을 수 있으니 주소로 시설을 확인하세요.",
          "화환 수령 위치와 절차는 시설마다 다를 수 있어 방문 전 시설 측 확인이 필요합니다.",
          "발인 일정에 맞춰 도착해야 하므로 주문 시 일정 정보를 함께 전달하세요.",
        ],
        faq: [
          { question: "근조화환 주문 전에 어떤 정보를 확인해야 하나요?", answer: "빈소명, 고인·상주 성함, 발인 일정, 수령 위치를 확인하시면 주문이 원활합니다." },
          { question: "이 목록에는 어떤 장례식장이 실려 있나요?", answer: `${sido} 지역에서 명칭·주소·연락처를 공식 안내로 확인한 시설만 싣고 있으며, 새로 확인된 시설은 계속 추가됩니다.` },
          { question: "화환 반입이 모든 시설에서 가능한가요?", answer: "시설마다 정책이 다를 수 있습니다. 각 시설 안내 페이지와 시설 측 확인을 함께 이용하시기 바랍니다." },
        ],
      }
    case "wedding":
      return {
        ...base,
        metaDescription: `${sido} 지역 예식장·웨딩홀·컨벤션 ${String(placeCount)}곳의 축하화환 주문 안내를 한곳에서 확인하세요. 행사장별 위치와 주문 전 확인 사항을 정리했습니다.`,
        intro: `${sido} 지역에서 공식 홈페이지 확인을 거친 예식장·웨딩홀·컨벤션 ${String(placeCount)}곳의 축하화환 안내를 모았습니다. 각 행사장 페이지에서 위치와 연락처, 주문 전 확인할 정보를 볼 수 있습니다.`,
        checklistTitle: `${sido} 예식장 축하화환 주문 전 확인 사항`,
        checklist: [
          "예식 일시와 홀 이름을 확인하고 리본 문구에 보내는 분 성함을 준비하세요.",
          "같은 건물에 여러 홀이 있는 경우가 많아 층·홀 이름까지 확인하면 정확합니다.",
          "화환 수령 위치와 반입 절차는 행사장마다 다를 수 있어 행사장 측 확인이 필요합니다.",
          "예식 시작 전에 도착해야 하므로 주문 시 예식 시간을 함께 전달하세요.",
        ],
        faq: [
          { question: "축하화환 주문 전에 어떤 정보를 확인해야 하나요?", answer: "예식 일시, 홀 이름, 받는 분 성함, 수령 위치를 확인하시면 주문이 원활합니다." },
          { question: "이 목록에는 어떤 행사장이 실려 있나요?", answer: `${sido} 지역에서 명칭·주소·연락처를 공식 안내로 확인한 예식장·웨딩홀·컨벤션만 싣고 있으며, 새로 확인된 곳은 계속 추가됩니다.` },
          { question: "화환 반입이 모든 행사장에서 가능한가요?", answer: "행사장마다 정책이 다를 수 있습니다. 각 행사장 안내 페이지와 행사장 측 확인을 함께 이용하시기 바랍니다." },
        ],
      }
    case "corporate":
      return {
        ...base,
        metaDescription: `${sido} 지역 기업·사업장 ${String(placeCount)}곳의 개업·준공·창립 축하화환 주문 안내를 한곳에서 확인하세요.`,
        intro: `${sido} 지역에서 공식 홈페이지 확인을 거친 기업·사업장 ${String(placeCount)}곳의 축하화환 안내를 모았습니다. 개업·이전·준공·창립·취임 축하화환 주문 전 확인할 정보를 각 사업장 페이지에서 볼 수 있습니다.`,
        checklistTitle: `${sido} 기업 축하화환 주문 전 확인 사항`,
        checklist: [
          "받는 부서·담당자 성함과 행사 성격(개업·준공·창립 등)을 먼저 확인하세요.",
          "사업장 정문·안내데스크 등 수령 위치는 사업장마다 다를 수 있습니다.",
          "행사 일정에 맞춰 도착해야 하므로 주문 시 행사 일시를 함께 전달하세요.",
        ],
        faq: [
          { question: "기업 축하화환 주문 전에 어떤 정보를 확인해야 하나요?", answer: "행사 성격과 일시, 받는 부서·담당자, 수령 위치를 확인하시면 주문이 원활합니다." },
          { question: "이 목록에는 어떤 사업장이 실려 있나요?", answer: `${sido} 지역에서 명칭·주소·연락처를 공식 안내로 확인한 기업·사업장만 싣고 있으며, 새로 확인된 곳은 계속 추가됩니다.` },
        ],
      }
  }
}
