import type { SeoPageType } from "./constants"

const ASCII_WORD = /[^a-z0-9]+/g
const HANGUL_START = 0xac00
const HANGUL_END = 0xd7a3
const HANGUL_VOWEL_COUNT = 21
const HANGUL_FINAL_COUNT = 28
const CHOSEONG = [
  "g",
  "kk",
  "n",
  "d",
  "tt",
  "r",
  "m",
  "b",
  "pp",
  "s",
  "ss",
  "",
  "j",
  "jj",
  "ch",
  "k",
  "t",
  "p",
  "h",
] as const
const JUNGSEONG = [
  "a",
  "ae",
  "ya",
  "yae",
  "eo",
  "e",
  "yeo",
  "ye",
  "o",
  "wa",
  "wae",
  "oe",
  "yo",
  "u",
  "wo",
  "we",
  "wi",
  "yu",
  "eu",
  "ui",
  "i",
] as const
const JONGSEONG = [
  "",
  "k",
  "k",
  "ks",
  "n",
  "nj",
  "nh",
  "t",
  "l",
  "lk",
  "lm",
  "lb",
  "ls",
  "lt",
  "lp",
  "lh",
  "m",
  "p",
  "ps",
  "t",
  "t",
  "ng",
  "t",
  "t",
  "k",
  "t",
  "p",
  "t",
] as const

export function toAsciiSlugPart(value: string): string {
  return romanizeHangul(value)
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(ASCII_WORD, "-")
    .replace(/^-+|-+$/g, "")
}

export function createBaseSlug(
  input: Readonly<{ pageType: SeoPageType; city?: string; district?: string; name: string }>,
): string {
  const parts = [input.pageType, input.city, input.district, input.name]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .map(toAsciiSlugPart)
    .filter((part) => part.length > 0)

  return parts.length === 0 ? input.pageType : parts.join("-")
}

export function createUniqueSlug(baseSlug: string, existingSlugs: ReadonlySet<string>): string {
  if (!existingSlugs.has(baseSlug)) {
    return baseSlug
  }

  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${baseSlug}-${String(suffix)}`
    if (!existingSlugs.has(candidate)) {
      return candidate
    }
  }

  throw new SlugExhaustedError(baseSlug)
}

export class SlugExhaustedError extends Error {
  readonly name = "SlugExhaustedError"

  constructor(readonly baseSlug: string) {
    super(`Could not create a unique slug for ${baseSlug}`)
  }
}

function romanizeHangul(value: string): string {
  return value.replace(/[가-힣]/g, romanizeCharacter)
}

function romanizeCharacter(character: string): string {
  const codePoint = character.codePointAt(0)
  if (codePoint === undefined || codePoint < HANGUL_START || codePoint > HANGUL_END) {
    return character
  }

  const offset = codePoint - HANGUL_START
  const choseongIndex = Math.floor(offset / (HANGUL_VOWEL_COUNT * HANGUL_FINAL_COUNT))
  const jungseongIndex = Math.floor((offset % (HANGUL_VOWEL_COUNT * HANGUL_FINAL_COUNT)) / HANGUL_FINAL_COUNT)
  const jongseongIndex = offset % HANGUL_FINAL_COUNT

  return `${pickRomanPart(CHOSEONG, choseongIndex)}${pickRomanPart(JUNGSEONG, jungseongIndex)}${pickRomanPart(JONGSEONG, jongseongIndex)}`
}

function pickRomanPart(parts: readonly string[], index: number): string {
  return parts[index] ?? ""
}
