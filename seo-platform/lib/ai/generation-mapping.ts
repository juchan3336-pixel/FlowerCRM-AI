import type { Json } from "@/types/database"
import type { AiGeneratedSeoContent, AiGenerationInput, AiGenerationMetadata, AiGenerationRecord, AiGenerationUsage, ApplyAiGenerationInput } from "./types"

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

// 승인된 output jsonb 고정 구조:
// { generated, after, provider, model, usage: {input_tokens, output_tokens, total_tokens} | null, estimated_cost, error_code }
// 모든 키는 optional 파싱 — 구 레코드({generated, after}만 존재)와 호환되어야 한다.

export function wrapGenerationInput(input: AiGenerationInput, before: ApplyAiGenerationInput["before"] | null): Json {
  return { generation_input: input, before }
}

export function wrapGenerationOutput(output: AiGeneratedSeoContent, after: AiGeneratedSeoContent | null, metadata?: AiGenerationMetadata | null): Json {
  return {
    generated: output,
    after,
    provider: metadata?.provider ?? null,
    model: metadata?.model ?? null,
    usage: metadata?.usage ?? null,
    estimated_cost: metadata?.estimated_cost ?? null,
    error_code: null,
  }
}

export function wrapFailedGenerationOutput(metadata: Readonly<{ provider: string; model: string | null }>, errorCode: string): Json {
  return {
    generated: null,
    after: null,
    provider: metadata.provider,
    model: metadata.model,
    usage: null,
    estimated_cost: null,
    error_code: errorCode,
  }
}

// apply 시 generated/after만 갱신하고 provider/usage 등 기존 메타데이터 키는 보존한다.
export function mergeGenerationOutputWrapper(existing: Json | null, output: AiGeneratedSeoContent, after: AiGeneratedSeoContent | null): Json {
  const base = asRecord(existing) ?? {}
  return { ...base, generated: output, after }
}

export type AiGenerationStoredMetadata = {
  readonly provider: string | null
  readonly model: string | null
  readonly usage: AiGenerationUsage | null
  readonly estimatedCost: number | null
  readonly errorCode: string | null
}

export function parseGenerationStoredMetadata(output: Json | null): AiGenerationStoredMetadata {
  const record = asRecord(output)
  const usageRecord = asRecord(record?.["usage"] ?? null)

  return {
    provider: textOrNull(record?.["provider"]),
    model: textOrNull(record?.["model"]),
    usage:
      usageRecord === null
        ? null
        : {
            input_tokens: numberOrNull(usageRecord["input_tokens"]),
            output_tokens: numberOrNull(usageRecord["output_tokens"]),
            total_tokens: numberOrNull(usageRecord["total_tokens"]),
          },
    estimatedCost: numberOrNull(record?.["estimated_cost"]),
    errorCode: textOrNull(record?.["error_code"]),
  }
}

export type StoredQualityIssue = {
  readonly level: "fail" | "warn"
  readonly code: string
  readonly message: string
}

export type StoredQualityReport = {
  readonly status: "pass" | "warn" | "fail"
  readonly issues: readonly StoredQualityIssue[]
}

// output 래퍼의 quality 성적표를 안전 파싱한다 (없거나 구 레코드면 null).
export function parseGenerationStoredQuality(output: Json | null): StoredQualityReport | null {
  const record = asRecord(output)
  const quality = asRecord(record?.["quality"] ?? null)
  if (quality === null) {
    return null
  }
  const status = quality["status"]
  if (status !== "pass" && status !== "warn" && status !== "fail") {
    return null
  }
  const rawIssues = quality["issues"]
  const issues: StoredQualityIssue[] = []
  if (Array.isArray(rawIssues)) {
    for (const entry of rawIssues) {
      const issue = asRecord(entry as Json)
      const level = issue?.["level"]
      const code = issue?.["code"]
      const message = issue?.["message"]
      if ((level === "fail" || level === "warn") && typeof code === "string" && typeof message === "string") {
        issues.push({ level, code, message })
      }
    }
  }
  return { status, issues }
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

function textOrNull(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function numberOrNull(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
