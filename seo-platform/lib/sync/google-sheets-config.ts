import { z } from "zod"

const serviceAccountSchema = z.object({
  client_email: z.email(),
  private_key: z.string().min(1),
})

export type GoogleServiceAccount = z.infer<typeof serviceAccountSchema>

export function parseGoogleServiceAccountJson(value: string): GoogleServiceAccount {
  try {
    const parsed: unknown = JSON.parse(value)
    const credentials = serviceAccountSchema.safeParse(parsed)
    if (!credentials.success) {
      throw new InvalidGoogleServiceAccountError(credentials.error.issues.map((issue) => issue.message).join("; "))
    }
    return credentials.data
  } catch (error) {
    if (error instanceof InvalidGoogleServiceAccountError) {
      throw error
    }
    throw new InvalidGoogleServiceAccountError("Service account JSON must be valid JSON")
  }
}

export class InvalidGoogleServiceAccountError extends Error {
  readonly name = "InvalidGoogleServiceAccountError"

  constructor(readonly detail: string) {
    super(`Invalid Google service account JSON: ${detail}`)
  }
}
