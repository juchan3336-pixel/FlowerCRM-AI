-- ════════════════════════════════════════════════════════════════
-- 광고 배포(marketing) 스키마 (2026-11-10)
--
-- 화환 소재(글+이미지)를 외부 채널에 배포하고, 어느 채널·소재가 어느 쇼핑몰 주문으로 이어졌는지
-- 기록하기 위한 테이블 8개. 공개 SEO(places·seo_pages·batch_*) 테이블은 어떤 변경도 하지 않는다.
--
-- 설계 원칙:
--  - 소재 변형(variant)의 검수·승인 상태와 배포 작업(job)의 실행 상태를 분리한다.
--    승인본 하나에 실행 기록이 여러 건 붙을 수 있고, 소재를 고치면 revision이 올라가 승인이 무효가 된다.
--  - 승인 근거는 불변이다: 승인한 revision·내용 해시·주문 링크를 job에 스냅샷으로 복사한다.
--    이미지는 내용 해시로 식별하며 같은 경로에 다른 파일을 덮어쓸 수 없다.
--  - 주문 목적지는 자사몰(imweb)과 네이버 스마트스토어(smartstore) 두 곳. 코드(lib/marketing)의
--    OrderDestinationCode·MarketingChannelCode·TrackingKind와 CHECK·FK가 같은 값을 쓴다.
--  - 비밀키·계정 비밀번호는 저장하지 않는다. account_ref는 "어느 계정인지" 식별하는 공개 이름만 담는다.
--  - service role 서버 경로 전용 — RLS를 켜고 anon/authenticated 정책을 두지 않는다.
--  - 재실행해도 안전하다(if not exists / on conflict do nothing). 적용은 Supabase SQL Editor에서 직접 실행한다.
--
-- 롤백(데이터가 없을 때만): 아래 역순으로
--   drop table if exists public.marketing_metrics_daily, public.marketing_distribution_events,
--     public.marketing_distribution_jobs, public.marketing_variants, public.marketing_images,
--     public.marketing_campaigns, public.marketing_channels, public.marketing_destinations;
-- ════════════════════════════════════════════════════════════════

-- ── 1. 주문 목적지 ──
create table if not exists public.marketing_destinations (
  code text primary key check (code in ('imweb', 'smartstore')),
  label text not null,
  -- 스토어 홈 — 승인된 상품 상세 URL이 없을 때 쓰는 기본 링크
  base_url text not null check (base_url like 'https://%'),
  enabled boolean not null default true,
  -- 운영자가 실제 접속·주문 가능을 확인한 시각
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.marketing_destinations (code, label, base_url) values
  ('imweb', '자사몰', 'https://팔도플라워.com'),
  ('smartstore', '네이버 스마트스토어', 'https://smartstore.naver.com/free77888')
on conflict (code) do nothing;

-- ── 2. 배포 채널 ──
create table if not exists public.marketing_channels (
  code text primary key check (code in (
    'naver_search_ad', 'naver_blog', 'naver_place', 'naver_cafe', 'kakao_channel', 'instagram',
    'facebook_page', 'google_business_profile', 'daangn_biz', 'youtube_shorts', 'google_search_ad'
  )),
  label text not null,
  tier text not null check (tier in ('primary', 'secondary')),
  -- manual = 사람이 붙여넣고 게시 URL 확인, api = 공식 API 자동 게시(2차), disabled = 배포 중지
  publish_mode text not null default 'manual' check (publish_mode in ('manual', 'api', 'disabled')),
  medium text not null check (medium in ('organic_social', 'cpc')),
  default_destination_code text not null references public.marketing_destinations(code),
  -- 어느 계정으로 게시하는지 (예: 블로그 아이디). 비밀번호·토큰 금지.
  account_ref text,
  -- 게시 전 확인한 플랫폼 운영정책 문서와 확인 시각
  policy_url text,
  policy_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.marketing_channels (code, label, tier, publish_mode, medium, default_destination_code) values
  ('naver_search_ad', '네이버 검색광고', 'primary', 'manual', 'cpc', 'smartstore'),
  ('naver_blog', '네이버 블로그', 'primary', 'manual', 'organic_social', 'smartstore'),
  ('naver_place', '네이버 플레이스 소식', 'primary', 'manual', 'organic_social', 'smartstore'),
  ('naver_cafe', '네이버 카페(허가된 홍보 게시판)', 'secondary', 'manual', 'organic_social', 'smartstore'),
  ('kakao_channel', '카카오 채널 소식', 'secondary', 'manual', 'organic_social', 'imweb'),
  ('instagram', '인스타그램', 'secondary', 'manual', 'organic_social', 'imweb'),
  ('facebook_page', '페이스북 페이지', 'secondary', 'manual', 'organic_social', 'imweb'),
  ('google_business_profile', '구글 비즈니스 프로필', 'secondary', 'manual', 'organic_social', 'imweb'),
  ('daangn_biz', '당근 비즈프로필', 'secondary', 'manual', 'organic_social', 'imweb'),
  ('youtube_shorts', '유튜브 쇼츠', 'secondary', 'manual', 'organic_social', 'imweb'),
  ('google_search_ad', '구글 검색광고', 'secondary', 'manual', 'cpc', 'imweb')
on conflict (code) do nothing;

-- ── 3. 캠페인 ──
create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  -- 추적 링크에 실리는 공개 코드 — 영문/숫자/-_ 만 (마침표는 nt_detail 구분자라 금지)
  code text not null unique check (code ~ '^[A-Za-z0-9_-]{1,50}$'),
  name text not null,
  mode text not null check (mode in ('condolence', 'celebration', 'corporate-celebration')),
  region text,
  starts_on date,
  ends_on date,
  -- 유료 광고 예산 상한(원). null = 유료 집행 없음.
  budget_cap_krw integer check (budget_cap_krw is null or budget_cap_krw >= 0),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'ended')),
  -- 목적지별 승인 상품 상세 URL: {"imweb": "https://…", "smartstore": "https://…"}. 없으면 스토어 홈.
  product_urls jsonb not null default '{}'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_campaigns_period_check check (starts_on is null or ends_on is null or ends_on >= starts_on)
);

create index if not exists marketing_campaigns_status_idx on public.marketing_campaigns (status, created_at desc);

-- ── 4. 이미지 자산 ──
-- 한 행 = 파일 내용 하나. 내용이 바뀌면 새 행·새 경로로 올린다(덮어쓰기 금지).
create table if not exists public.marketing_images (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  -- 파일 내용의 SHA-256 (hex)
  content_hash text not null unique check (content_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('photo', 'logo', 'composite')),
  -- 실제 촬영한 우리 상품 사진인지. false = 예시·견본 이미지.
  is_real_photo boolean not null default false,
  rights_status text not null default 'unverified' check (rights_status in ('owned', 'licensed', 'unverified')),
  -- 리본의 이름·사람 얼굴 등 개인정보가 보이지 않음을 확인한 사람과 시각
  privacy_checked_by text,
  privacy_checked_at timestamptz,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint marketing_images_privacy_check check ((privacy_checked_by is null) = (privacy_checked_at is null))
);

-- ── 5. 소재 변형 (채널별 글+이미지+주문 링크) ──
create table if not exists public.marketing_variants (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete restrict,
  -- 추적 링크에 실리는 소재 코드. 캠페인 안에서 유일 → (캠페인 코드, 소재 코드) 조합이 추적 단위.
  code text not null check (code ~ '^[A-Za-z0-9_-]{1,50}$'),
  channel_code text not null references public.marketing_channels(code),
  destination_code text not null references public.marketing_destinations(code),
  mode text not null check (mode in ('condolence', 'celebration', 'corporate-celebration')),

  -- 추적 파라미터까지 포함한 최종 주문 링크와 그 구성
  order_url text not null check (order_url like 'https://%'),
  tracking_kind text not null check (tracking_kind in ('utm', 'naver-nt', 'platform-auto')),
  tracking_params jsonb not null default '{}'::jsonb,

  title text not null,
  body text not null,
  caption text,
  -- 이미지 위에 합성되는 문구
  image_texts text[] not null default '{}',
  -- 사용 이미지 목록(순서 포함): [{"image_id": "…", "content_hash": "…"}]
  image_refs jsonb not null default '[]'::jsonb,

  -- 문안·이미지·목적지·링크 중 하나라도 바뀌면 1씩 올라간다
  revision integer not null default 1 check (revision >= 1),

  -- 검수 상태: draft → needs_review → approved. 수정하면 draft로 돌아간다.
  review_status text not null default 'draft' check (review_status in ('draft', 'needs_review', 'approved')),
  -- 마지막 품질 검사 결과와 그 검사가 본 revision
  quality_report jsonb,
  quality_checked_revision integer,

  -- 승인 스냅샷
  approved_revision integer,
  approval_hash text check (approval_hash is null or approval_hash ~ '^[0-9a-f]{64}$'),
  approved_by text,
  approved_at timestamptz,

  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint marketing_variants_campaign_code_key unique (campaign_id, code),
  -- 승인 상태라면 승인 스냅샷이 전부 있어야 하고, 승인한 revision이 현재 revision이어야 한다.
  constraint marketing_variants_approval_check check (
    review_status <> 'approved'
    or (approved_revision = revision and approval_hash is not null and approved_by is not null and approved_at is not null
        and quality_checked_revision = revision)
  )
);

create index if not exists marketing_variants_campaign_idx on public.marketing_variants (campaign_id, created_at desc);
create index if not exists marketing_variants_review_idx on public.marketing_variants (review_status, updated_at desc);

-- ── 6. 배포 작업 (승인본 한 건을 한 계정에 내보내는 실행 기록) ──
create table if not exists public.marketing_distribution_jobs (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.marketing_variants(id) on delete restrict,

  -- 승인 시점 스냅샷 — 이후 소재가 바뀌어도 "무엇을 내보냈는지"는 변하지 않는다
  variant_revision integer not null check (variant_revision >= 1),
  approval_hash text not null check (approval_hash ~ '^[0-9a-f]{64}$'),
  channel_code text not null references public.marketing_channels(code),
  destination_code text not null references public.marketing_destinations(code),
  order_url text not null check (order_url like 'https://%'),
  -- 게시 계정 ('' = 채널 기본 계정)
  channel_account text not null default '',
  -- 작업을 만든 시점의 게시 방식 — 이후 채널 설정이 바뀌어도 이 작업의 경로는 그대로다
  publish_mode text not null check (publish_mode in ('manual', 'api')),

  -- 사람 게시: manual_ready → manual_confirmed
  -- API 게시:  queued → publishing → published | unknown | failed,  unknown → published | failed
  -- cancelled: 게시 전에 소재가 수정되어 폐기됨
  status text not null check (status in ('manual_ready', 'manual_confirmed', 'queued', 'publishing', 'published', 'unknown', 'failed', 'cancelled')),

  scheduled_at timestamptz,
  attempt integer not null default 0 check (attempt >= 0),
  -- API가 돌려준 게시물 식별자
  provider_post_id text,
  -- 실제 게시된 글 주소
  posted_url text check (posted_url is null or posted_url like 'https://%'),
  confirmed_by text,
  confirmed_at timestamptz,
  -- 진단용 (토큰·응답 원문 금지)
  last_error_code text,

  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 같은 승인본을 같은 계정·목적지로 두 번 내보내지 않는다
  constraint marketing_distribution_jobs_once_key unique (variant_id, variant_revision, channel_account, destination_code),
  constraint marketing_distribution_jobs_mode_status_check check (
    status = 'cancelled'
    or (publish_mode = 'manual' and status in ('manual_ready', 'manual_confirmed'))
    or (publish_mode = 'api' and status in ('queued', 'publishing', 'published', 'unknown', 'failed'))
  ),
  -- 복사·내보내기만으로는 게시 완료가 아니다 — 게시 주소와 확인자가 있어야 한다
  constraint marketing_distribution_jobs_confirmed_check check (
    status <> 'manual_confirmed' or (posted_url is not null and confirmed_by is not null and confirmed_at is not null)
  )
);

create index if not exists marketing_distribution_jobs_variant_idx on public.marketing_distribution_jobs (variant_id, created_at desc);
create index if not exists marketing_distribution_jobs_status_idx on public.marketing_distribution_jobs (status, updated_at desc);

-- ── 7. 감사 기록 (추가만 한다) ──
create table if not exists public.marketing_distribution_events (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.marketing_variants(id) on delete restrict,
  job_id uuid references public.marketing_distribution_jobs(id) on delete restrict,
  -- created | revised | review_requested | approved | exported | post_confirmed | cancelled | status_changed
  event_type text not null,
  from_status text,
  to_status text,
  variant_revision integer,
  actor text not null,
  -- 민감정보 금지 (토큰·비밀번호·주문자 개인정보)
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists marketing_distribution_events_variant_idx on public.marketing_distribution_events (variant_id, created_at desc);

-- ── 8. 일별 성과 ──
-- 한 행 = (날짜, 보고서 출처, 집계 단위) 관측값 하나. 수집하지 못한 지표는 0이 아니라 null이다.
-- 두 쇼핑몰은 귀속 기간·취소 기준이 다르므로 목적지별로 따로 쌓고 합산은 화면에서 구분해 보여준다.
create table if not exists public.marketing_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  source text not null check (source in ('imweb_report', 'smartstore_report', 'naver_ads_report', 'google_ads_report', 'manual')),
  -- 집계 단위 식별자 — 아래 차원 열을 '|'로 이은 값(없는 차원은 빈 문자열). 재수집 시 같은 행을 덮어쓰기 위한 키.
  dimension_key text not null,
  channel_code text references public.marketing_channels(code),
  campaign_id uuid references public.marketing_campaigns(id) on delete restrict,
  variant_id uuid references public.marketing_variants(id) on delete restrict,
  destination_code text references public.marketing_destinations(code),

  impressions integer check (impressions is null or impressions >= 0),
  clicks integer check (clicks is null or clicks >= 0),
  visits integer check (visits is null or visits >= 0),
  orders integer check (orders is null or orders >= 0),
  -- 취소·환불 반영 매출(원)
  revenue_krw bigint check (revenue_krw is null or revenue_krw >= 0),
  ad_cost_krw bigint check (ad_cost_krw is null or ad_cost_krw >= 0),
  -- 제작·게시에 든 운영 시간(분)
  work_minutes integer check (work_minutes is null or work_minutes >= 0),
  -- 이 출처의 귀속 기준 메모 (예: "유입 후 7일, 취소 반영")
  attribution_note text,
  fetched_at timestamptz not null default now(),

  constraint marketing_metrics_daily_observation_key unique (date, source, dimension_key)
);

create index if not exists marketing_metrics_daily_date_idx on public.marketing_metrics_daily (date desc);
create index if not exists marketing_metrics_daily_campaign_idx on public.marketing_metrics_daily (campaign_id, date desc);

-- ── updated_at 자동 갱신 (기존 테이블과 동일 패턴) ──
drop trigger if exists marketing_destinations_set_updated_at on public.marketing_destinations;
create trigger marketing_destinations_set_updated_at before update on public.marketing_destinations for each row execute function public.set_updated_at();
drop trigger if exists marketing_channels_set_updated_at on public.marketing_channels;
create trigger marketing_channels_set_updated_at before update on public.marketing_channels for each row execute function public.set_updated_at();
drop trigger if exists marketing_campaigns_set_updated_at on public.marketing_campaigns;
create trigger marketing_campaigns_set_updated_at before update on public.marketing_campaigns for each row execute function public.set_updated_at();
drop trigger if exists marketing_variants_set_updated_at on public.marketing_variants;
create trigger marketing_variants_set_updated_at before update on public.marketing_variants for each row execute function public.set_updated_at();
drop trigger if exists marketing_distribution_jobs_set_updated_at on public.marketing_distribution_jobs;
create trigger marketing_distribution_jobs_set_updated_at before update on public.marketing_distribution_jobs for each row execute function public.set_updated_at();

-- ── 권한: service role 서버 경로 전용 ──
-- RLS를 켜고 정책을 두지 않으며, anon/authenticated의 테이블 권한도 회수한다.
alter table public.marketing_destinations enable row level security;
alter table public.marketing_channels enable row level security;
alter table public.marketing_campaigns enable row level security;
alter table public.marketing_images enable row level security;
alter table public.marketing_variants enable row level security;
alter table public.marketing_distribution_jobs enable row level security;
alter table public.marketing_distribution_events enable row level security;
alter table public.marketing_metrics_daily enable row level security;

revoke all on table
  public.marketing_destinations, public.marketing_channels, public.marketing_campaigns, public.marketing_images,
  public.marketing_variants, public.marketing_distribution_jobs, public.marketing_distribution_events, public.marketing_metrics_daily
from anon, authenticated;
