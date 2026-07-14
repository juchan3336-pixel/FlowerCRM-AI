import type { AiGenerationMetadata, AiRepository } from "./types"

// 기존 AiRepository/service 계약을 건드리지 않고, 생성 기록에 provider/model/usage 메타데이터를 주입한다.
// getMetadata는 provider 호출이 끝난 뒤(createAiGeneration 시점)에 평가되므로 토큰 사용량을 담을 수 있다.
export function withAiGenerationMetadata(repository: AiRepository, getMetadata: () => AiGenerationMetadata): AiRepository {
  return {
    findPlaceById: (placeId) => repository.findPlaceById(placeId),
    findAiGenerationById: (generationId) => repository.findAiGenerationById(generationId),
    applyAiGeneration: (input) => repository.applyAiGeneration(input),
    createAiGeneration: (input) => repository.createAiGeneration({ ...input, metadata: getMetadata() }),
  }
}
