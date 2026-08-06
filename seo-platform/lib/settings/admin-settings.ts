import type { AdminSettingKey, AdminSettingsLoadResult, AdminSettingsRepository, SettingRow, SettingsSection } from "./types"
import { getPublicSiteUrl } from "@/lib/site-url"
import type { Json } from "@/types/database"

type SettingsFieldDefinition = {
  readonly key: AdminSettingKey
  readonly label: string
  readonly fallbackValue: string
  readonly help: string
}

type SettingsSectionDefinition = {
  readonly title: string
  readonly description: string
  readonly fields: readonly SettingsFieldDefinition[]
}

// 설정 화면의 '사이트 URL' fallback은 공개 canonical origin이다 (사이트맵·메타데이터 미리보기 용도).
const siteUrlFallback = getPublicSiteUrl()
const defaultOrderUrlFallback = new URL("/order", `${siteUrlFallback}/`).toString()

const SETTINGS_SECTION_DEFINITIONS = [
  {
    title: "사이트 식별",
    description: "서버 자격 증명이 설정되면 Supabase settings table에서 값을 읽고, 아니면 로컬 기본값을 안전하게 렌더링합니다.",
    fields: [
      { key: "site_url", label: "사이트 URL", fallbackValue: siteUrlFallback, help: "사이트맵과 메타데이터 미리보기에 쓰는 canonical origin입니다." },
      { key: "brand_name", label: "브랜드명", fallbackValue: "전국팔도꽃배달", help: "제목 템플릿과 OpenGraph 대체 문구에 쓰는 기본 브랜드 텍스트입니다." },
      { key: "default_order_url", label: "기본 주문 URL", fallbackValue: defaultOrderUrlFallback, help: "장소 행에 주문 URL이 없을 때 쓰는 fallback CTA 목적지입니다." },
      { key: "default_og_image", label: "기본 OG 이미지", fallbackValue: "/og/default-flower-crm.png", help: "생성 이미지가 없는 페이지가 공유 미리보기를 쓸 때 사용하는 공용 이미지 경로입니다." },
    ],
  },
  {
    title: "검색 검증",
    description: "검증 문자열은 공개 메타데이터 값이며 비밀 값이 아닙니다.",
    fields: [
      { key: "google_site_verification", label: "Google 검증 코드", fallbackValue: "google-site-verification=fixture-placeholder", help: "나중에 Google site verification meta 값으로 렌더링됩니다." },
      { key: "naver_site_verification", label: "Naver 검증 코드", fallbackValue: "naver-site-verification=fixture-placeholder", help: "나중에 Naver site verification meta 값으로 렌더링됩니다." },
    ],
  },
  {
    title: "운영 자동화",
    description: "자동 게시 스위치는 settings 테이블 auto_publish 값으로 제어합니다 — \"on\"일 때만 Cron이 게시 준비 완료 장소를 자동 게시합니다.",
    fields: [
      { key: "auto_publish", label: "자동 게시", fallbackValue: "off", help: "on이면 생성 성공(게시 준비 완료) 장소를 Production Cron이 1분 주기로 한 곳씩 자동 게시합니다. 품질·어휘 가드는 수동 게시와 동일하게 적용됩니다." },
    ],
  },
  {
    title: "AI 기본값",
    description: "provider와 모델 제어는 계획용으로 보이지만 이 단계에서는 AI 서비스를 호출하지 않습니다.",
    fields: [
      { key: "ai_provider_label", label: "AI 공급자", fallbackValue: "OpenAI 자리표시자", help: "안전한 라벨로만 표시되며 provider 자격 증명은 저장하지 않습니다." },
      { key: "ai_model_label", label: "AI 모델", fallbackValue: "gpt-4.1-mini 자리표시자", help: "향후 생성 설정을 위한 미리보기 모델 라벨입니다." },
    ],
  },
  {
    title: "공개 데이터 정책",
    description: "정책 값은 공개 SEO 페이지가 무엇을 렌더링해도 되는지 문서화합니다.",
    fields: [
      { key: "public_address_policy", label: "공개 주소 정책", fallbackValue: "시/군/구만 표시", help: "상세 주소가 공개 자리표시자에 들어가지 않도록 합니다." },
      { key: "public_phone_policy", label: "공개 전화 정책", fallbackValue: "명시적 게시 승인 전까지 마스킹", help: "fixture 전화 값이 공개 연락처 데이터가 되는 것을 방지합니다." },
    ],
  },
] as const satisfies readonly SettingsSectionDefinition[]

export async function loadAdminSettings(repository?: AdminSettingsRepository): Promise<AdminSettingsLoadResult> {
  if (repository === undefined) {
    return { source: "fixture", sections: buildSettingsSections([]) }
  }

  const rows = await repository.listSettings()
  return { source: "supabase", sections: buildSettingsSections(rows) }
}

export function buildSettingsSections(rows: readonly SettingRow[]): readonly SettingsSection[] {
  const valuesByKey = new Map(rows.map((row) => [row.key, row.value]))

  return SETTINGS_SECTION_DEFINITIONS.map((section) => ({
    title: section.title,
    description: section.description,
    fields: section.fields.map((field) => ({
      key: field.key,
      label: field.label,
      value: settingValueToDisplay(valuesByKey.get(field.key), field.fallbackValue),
      help: field.help,
    })),
  }))
}

function settingValueToDisplay(value: Json | undefined, fallbackValue: string): string {
  if (value === undefined || value === null) {
    return fallbackValue
  }

  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  return JSON.stringify(value)
}
