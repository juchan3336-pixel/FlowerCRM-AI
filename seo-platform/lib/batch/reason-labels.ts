import { parseForbiddenVocabularyCode } from "@/lib/ai/mode-vocabulary"

// 관리자 UI 전용 사유 한글 라벨 — DB·감사 로그의 원본 코드는 절대 변환·수정하지 않고 표시 계층에서만 매핑한다.
// Batch 생성·게시 결과 화면과 품질 패널이 공유한다. 미등록 코드는 원본 문자열을 노출하지 않고 안전한 기본 문구로 대체한다.

// Quality issue 코드 → 짧은 사유 문구 (품질 패널·quality-fail 사유 조합에 사용)
export const QUALITY_ISSUE_LABELS: Readonly<Record<string, string>> = {
  "banned:delivery-guarantee": "배송 가능 여부를 확정적으로 표현함",
  "repeat:title": "기존 페이지와 제목 구조가 유사함",
  "repeat:faq": "기존 페이지와 FAQ 질문이 중복됨",
  "repeat:keywords": "기존 페이지와 키워드 구성이 유사함",
  "repeat:sentence": "기존 페이지와 동일한 문장이 반복됨",
  "repeat:first-sentence": "기존 페이지와 첫 문장이 유사함",
  "invalid:internal-link": "존재하지 않는 내부 링크가 포함됨",
  "banned:affiliation": "공식 제휴·지정 업체로 오인될 표현이 포함됨",
  "address:mismatch": "공식 주소와 생성 콘텐츠의 주소가 일치하지 않음",
}

const UNKNOWN_ISSUE_LABEL = "품질 검사 기준을 충족하지 못한 항목이 있음"

// 금지 어휘 코드는 필드·표현이 코드 안에 담겨 있어 고정 라벨로 옮길 수 없다.
// 이건 원본 코드 노출이 아니라 '무엇이 왜 걸렸는지'를 보여주기 위한 것이라 필드명만 한글로 바꿔 조립한다.
const VOCABULARY_FIELD_LABELS: Readonly<Record<string, string>> = {
  meta_title: "제목",
  meta_description: "메타 설명",
  description: "본문",
}

export function formatVocabularyField(field: string): string {
  const fixed = VOCABULARY_FIELD_LABELS[field]
  if (fixed !== undefined) {
    return fixed
  }
  const faq = /^faq\[(\d+)]\.(question|answer)$/.exec(field)
  if (faq !== null) {
    return `FAQ ${String(Number(faq[1]) + 1)} ${faq[2] === "question" ? "질문" : "답변"}`
  }
  const keyword = /^keywords\[(\d+)]$/.exec(field)
  if (keyword !== null) {
    return `키워드 ${String(Number(keyword[1]) + 1)}`
  }
  const link = /^internal_links\[(\d+)]\.label$/.exec(field)
  if (link !== null) {
    return `내부 링크 ${String(Number(link[1]) + 1)} 문구`
  }
  return "생성 콘텐츠"
}

// 금지 표현 코드는 `banned:<규칙>:<필드>:<매칭 문자열>` 형태로 상세를 담는다.
// 규칙만 있는 구 코드(`banned:delivery-guarantee`)도 그대로 읽을 수 있어야 한다.
export function parseBannedCode(code: string): { readonly rule: string; readonly field: string | null; readonly matched: string | null } | null {
  if (!code.startsWith("banned:")) {
    return null
  }
  const [rule, field, ...rest] = code.slice("banned:".length).split(":")
  if (rule === undefined || rule.length === 0) {
    return null
  }
  const matched = rest.join(":")
  return { rule, field: field ?? null, matched: matched.length > 0 ? matched : null }
}

export function formatQualityIssueCode(code: string): string {
  const forbidden = parseForbiddenVocabularyCode(code)
  if (forbidden !== null) {
    return `${formatVocabularyField(forbidden.field)}에 업종과 맞지 않는 표현 '${forbidden.term}'`
  }
  const banned = parseBannedCode(code)
  if (banned?.field != null && banned.matched != null) {
    const rule = QUALITY_ISSUE_LABELS[`banned:${banned.rule}`] ?? BANNED_RULE_LABELS[banned.rule] ?? UNKNOWN_ISSUE_LABEL
    return `${formatVocabularyField(banned.field)}에 '${banned.matched}' — ${rule}`
  }
  return QUALITY_ISSUE_LABELS[code] ?? UNKNOWN_ISSUE_LABEL
}

// 규칙 코드별 짧은 설명 (상세 코드에서 조립할 때 사용)
const BANNED_RULE_LABELS: Readonly<Record<string, string>> = {
  "official-order": "공식 주문·공식 CTA 표현 금지",
  "cta-term": "내부 용어 'CTA' 사용 금지",
  designated: "제휴·지정·협력 업체 표현 금지",
  "delivery-guarantee": "배송 확정·보장 표현 금지",
  "facility-claim": "시설·분위기·서비스 수준 추정 금지",
  price: "가격·요금 표현 금지",
  phone: "전화번호 금지",
  review: "후기·별점 표현 금지",
  "raw-enum": "내부 카테고리 원어 노출 금지",
}

// item skip_reason / last_error_code → 사용자용 문구 (생성·게시 배치 공통)
const ITEM_REASON_LABELS: Readonly<Record<string, string>> = {
  skipped_cost_limit: "설정한 비용 한도에 도달하여 처리하지 않음",
  interrupted: "작업이 중단되어 이어서 진행이 필요함",
  "cancelled-by-user": "사용자가 중단하여 남은 항목을 건너뜀",
  "warn-other": "자동 진행이 허용되지 않는 주의 항목이 있어 확인이 필요함",
  "warn-count": "주의 항목이 2건 이상이라 확인이 필요함",
  "quality-missing": "품질 검사 결과를 계산하지 못해 확인이 필요함",
  "retry-quality-fail": "복구 재시도 후에도 품질 검사를 통과하지 못함",
  "quality-fail-repeat-faq": "FAQ 질문 중복으로 복구 재시도를 진행함",
  "quality-fail-retry-blocked": "복구 재시도를 이미 사용해 자동 재생성 없이 검토 대기로 남김",
  "review-quality-not-pass": "검토 해소 중 품질 재평가가 통과하지 못해 확인 대기로 되돌림",
  "review-seo-page-blocked": "검토 해소 중 게시 준비 단계가 차단되어 확인 대기로 되돌림",
  "review-unexpected": "검토 해소 중 예상하지 못한 오류가 발생해 확인 대기로 되돌림",
  "seo-page-blocked": "게시 준비 단계가 차단됨",
  "approval-missing": "승인 스냅샷이 없어 게시할 수 없음",
  "place-missing": "장소 정보를 찾을 수 없음",
  "content-changed": "승인 이후 콘텐츠가 변경되어 게시를 중단함 — 다시 검토·승인 필요",
  "publish-blocked": "게시 조건을 충족하지 않아 게시되지 않음",
  "unsupported-content-category": "업종을 판정할 수 없어 콘텐츠 검사를 하지 못해 게시하지 않음",
  "forbidden-mode-vocabulary": "업종에 맞지 않는 표현이 있어 적용·게시하지 않음",
  "forbidden-mode-vocabulary-after-retry": "복구 재시도 후에도 업종에 맞지 않는 표현이 남아 중단함",
  "publish-unexpected": "게시 처리 중 오류가 발생함",
  unexpected: "처리 중 예상하지 못한 오류가 발생함",
}

const UNKNOWN_REASON_LABEL = "처리 중 문제가 발생했습니다. 상세 원인은 감사 로그(사유 코드)에서 확인하세요."

const QUALITY_FAIL_PREFIX = "quality-fail:"
const RETRY_REASON_PREFIX = "retry-"

// 복합 코드(quality-fail:code1,code2)를 포함해 어떤 원본 코드도 화면에 그대로 노출하지 않는다.
export function formatBatchItemReason(reason: string | null): string | null {
  if (reason === null || reason.trim().length === 0) {
    return null
  }
  if (reason.startsWith(QUALITY_FAIL_PREFIX)) {
    const codes = reason
      .slice(QUALITY_FAIL_PREFIX.length)
      .split(",")
      .map((code) => code.trim())
      .filter((code) => code.length > 0)
    const labels = [...new Set(codes.map((code) => formatQualityIssueCode(code)))]
    const summary = labels.length > 0 ? labels.join(", ") : UNKNOWN_ISSUE_LABEL
    return `${summary} — 품질 검사를 통과하지 못했습니다.`
  }
  // 복구 재시도 경로의 실패 코드는 "retry-" 접두로 기록된다 (lib/ai/retry-policy의 BATCH_RETRY_ERROR_CODE_PREFIX).
  // 미등록 하위 사유도 재시도 1회 소진 사실이 드러나는 문구로 대체한다.
  if (reason.startsWith(RETRY_REASON_PREFIX)) {
    return ITEM_REASON_LABELS[reason] ?? "복구 재시도를 완료하지 못해 중단됨 — 재시도 1회는 소진되었습니다."
  }
  return ITEM_REASON_LABELS[reason] ?? UNKNOWN_REASON_LABEL
}
