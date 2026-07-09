export function normalizeSupabaseProjectUrl(value: string | undefined): string {
  if (value === undefined) {
    return ""
  }

  const trimmed = value.trim()
  try {
    return new URL(trimmed).origin
  } catch {
    return trimmed
  }
}
