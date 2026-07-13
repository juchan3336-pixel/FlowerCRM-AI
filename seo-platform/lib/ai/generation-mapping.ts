import type { Json } from "@/types/database"
import type { AiGeneratedSeoContent, AiGenerationInput, AiGenerationRecord, ApplyAiGenerationInput } from "./types"

export type AiGenerationTableRow = {
  readonly id: string
  readonly place_id: string
  readonly status: AiGenerationRecord["status"]
  readonly input: Json | null
  readonly output: Json | null
  readonly model: string | null
  readonly created_at: string
  readonly applied_at: string | null
}

export function wrapGenerationInput(input: AiGenerationInput, before: ApplyAiGenerationInput["before"] | null): Json {
  return { generation_input: input, before }
}

export function wrapGenerationOutput(output: AiGeneratedSeoContent, after: AiGeneratedSeoContent | null): Json {
  return { generated: output, after }
}

export function aiGenerationRowToRecord(row: AiGenerationTableRow): AiGenerationRecord {
  const inputWrapper = asRecord(row.input)
  const outputWrapper = asRecord(row.output)

  return {
    id: row.id,
    place_id: row.place_id,
    status: row.status,
    input: (inputWrapper?.["generation_input"] ?? row.input) as unknown as AiGenerationInput,
    output: (outputWrapper?.["generated"] ?? row.output) as unknown as AiGeneratedSeoContent,
    before: (inputWrapper?.["before"] ?? null) as AiGenerationRecord["before"],
    after: (outputWrapper?.["after"] ?? null) as AiGenerationRecord["after"],
    created_at: row.created_at,
    applied_at: row.applied_at,
  }
}

function asRecord(value: Json | null): Record<string, Json | undefined> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : null
}
