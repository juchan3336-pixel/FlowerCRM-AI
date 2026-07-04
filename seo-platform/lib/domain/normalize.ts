const COMPANY_PREFIXES = [/\(주\)/gi, /㈜/g, /주식회사/g, /\(유\)/g, /유한회사/g] as const

export function normalizeCompanyName(value: string): string {
  const withoutPrefixes = COMPANY_PREFIXES.reduce(
    (current, pattern) => current.replace(pattern, ""),
    value,
  )

  return withoutPrefixes.toLocaleLowerCase("ko-KR").replace(/\s+/g, "").trim()
}

export function normalizePhone(value: string): string {
  return value.replace(/\D+/g, "")
}

export function normalizeAddress(value: string): string {
  return value.toLocaleLowerCase("ko-KR").replace(/\s+/g, "").trim()
}

export function createSourceKey(
  input: Readonly<{ name: string; phone?: string | undefined; address?: string | undefined }>,
): string {
  const normalizedName = normalizeCompanyName(input.name)
  const normalizedPhone = input.phone === undefined ? "" : normalizePhone(input.phone)

  if (normalizedPhone.length > 0) {
    return `${normalizedName}|${normalizedPhone}`
  }

  const normalizedAddress = input.address === undefined ? "" : normalizeAddress(input.address)
  return `${normalizedName}|${normalizedAddress}`
}
