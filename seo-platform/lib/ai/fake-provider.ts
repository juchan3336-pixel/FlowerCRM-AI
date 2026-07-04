import type { AiGeneratedSeoContent, AiGenerationInput, AiProvider } from "./types"

export class FakeDeterministicAiProvider implements AiProvider {
  generateSeoContent(input: AiGenerationInput): Promise<AiGeneratedSeoContent> {
    const area = [input.place.city, input.place.district].filter(Boolean).join(" ") || "지역"
    const category = input.place.category
    const name = input.place.name
    return Promise.resolve({
      description: `${area}의 ${name} ${category} 페이지입니다. 근조화환 주문은 공식 CTA를 통해 확인하세요.`,
      meta_title: `${name} ${category} 근조화환 안내`,
      meta_description: `${area} ${category} 방문자를 위한 근조화환 주문 안내와 기본 정보를 정리했습니다.`,
      faq: [
        {
          question: `${name} 근처로 근조화환을 보낼 수 있나요?`,
          answer: "공식 주문 CTA에서 배송 가능 여부를 확인하고 주문을 진행할 수 있습니다.",
        },
        {
          question: "공개되지 않은 연락처가 표시되나요?",
          answer: "검증되지 않은 연락처와 비용 정보는 생성하지 않습니다.",
        },
      ],
      keywords: [`${area} 근조화환`, `${category} 화환`, name],
      internal_links: [{ href: `/area/${encodeURIComponent(area.replaceAll(" ", "-"))}`, label: `${area} 장례화환` }],
    })
  }
}
