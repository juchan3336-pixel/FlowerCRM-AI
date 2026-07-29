// source-key.mjs 의 타입 선언 — seo-platform 테스트가 타입 체크를 통과하도록 붙인다.
// 구현은 .mjs 쪽이고, 원본(seo-platform/lib/domain/normalize.ts)과의 동치는
// seo-platform/tests/sync-row-remap-parity.test.ts 가 보장한다.
export function normalizeCompanyName(value: string): string
export function normalizePhone(value: string): string
export function normalizeAddress(value: string): string
export function createSourceKey(input: Readonly<{ name: string; phone?: string | undefined; address?: string | undefined }>): string
