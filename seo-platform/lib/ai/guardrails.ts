import { z } from "zod"
import type { SyncedPlace } from "@/lib/sync/types"
import type { AiGeneratedSeoContent } from "./types"

export class AiGuardrailViolationError extends Error {
  readonly name = "AiGuardrailViolationError"

  constructor(readonly reason: string) {
    super(`AI guardrail violation: ${reason}`)
  }
}

const PRICE_PATTERN = /(?:가격|금액|price|₩|\b\d{1,3}(?:,\d{3})*\s*원\b)/iu
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu
const PHONE_PATTERN = /(?:\+?\d{1,3}[-.\s]?)?(?:0\d{1,2}[-.\s]?)?\d{3,4}[-.\s]?\d{4}/u

const aiFaqItemSchema = z
  .object({
    question: z.string().min(1),
    answer: z.string().min(1),
  })
  .strict()

const aiInternalLinkSchema = z
  .object({
    href: z.string().min(1),
    label: z.string().min(1),
  })
  .strict()

const aiGeneratedSeoContentSchema = z
  .object({
    description: z.string().min(1),
    meta_title: z.string().min(1),
    meta_description: z.string().min(1),
    faq: z.array(aiFaqItemSchema),
    keywords: z.array(z.string().min(1)),
    internal_links: z.array(aiInternalLinkSchema),
  })
  .strict()

export function parseAiProviderOutput(output: unknown): AiGeneratedSeoContent {
  const result = aiGeneratedSeoContentSchema.safeParse(output)
  if (!result.success) {
    throw new AiGuardrailViolationError(`invalid output shape: ${formatIssue(result.error.issues[0])}`)
  }
  return result.data
}

export function assertAiOutputAllowed(output: AiGeneratedSeoContent, place: SyncedPlace): void {
  const text = JSON.stringify(output)
  const forbiddenValues = [place.phone, place.normalized_phone, place.email].filter(isFilled)
  const leakedValue = forbiddenValues.find((value) => text.includes(value))
  if (leakedValue !== undefined) {
    throw new AiGuardrailViolationError("source private value leaked")
  }
  if (EMAIL_PATTERN.test(text)) {
    throw new AiGuardrailViolationError("email generated")
  }
  if (PHONE_PATTERN.test(text)) {
    throw new AiGuardrailViolationError("phone generated")
  }
  if (PRICE_PATTERN.test(text)) {
    throw new AiGuardrailViolationError("price generated")
  }
}

function isFilled(value: string | null): value is string {
  return value !== null && value.length > 0
}

function formatIssue(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) {
    return "unknown"
  }
  const path = issue.path.length > 0 ? issue.path.join(".") : "root"
  return `${path} ${issue.message}`
}
