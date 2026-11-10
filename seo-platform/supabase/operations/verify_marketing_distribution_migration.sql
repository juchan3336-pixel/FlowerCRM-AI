-- ════════════════════════════════════════════════════════════════
-- 광고 배포 스키마 적용 검증 (읽기 전용)
-- 대상 migration: supabase/migrations/202611100001_marketing_distribution.sql
--
-- migration 실행 뒤 Supabase SQL Editor에서 이 파일 전체를 실행하고 결과 한 행을 확인한다.
-- 각 열이 주석에 적힌 기대값이어야 한다. 데이터는 바꾸지 않는다.
-- ════════════════════════════════════════════════════════════════

with expected_tables(name) as (
  values
    ('marketing_destinations'), ('marketing_channels'), ('marketing_campaigns'), ('marketing_images'),
    ('marketing_variants'), ('marketing_distribution_jobs'), ('marketing_distribution_events'), ('marketing_metrics_daily')
)
select
  -- 1) 테이블 8개 존재 (기대: 8)
  (select count(*) from expected_tables e join pg_tables t on t.schemaname = 'public' and t.tablename = e.name) as tables_present,

  -- 2) 8개 모두 RLS 활성 (기대: 8)
  (select count(*) from expected_tables e join pg_class c on c.relname = e.name join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' where c.relrowsecurity) as rls_enabled,

  -- 3) 정책 0개 — service role 전용 (기대: 0)
  (select count(*) from pg_policies p join expected_tables e on e.name = p.tablename where p.schemaname = 'public') as policies,

  -- 4) anon/authenticated 테이블 권한 0건 (기대: 0)
  (select count(*) from information_schema.role_table_grants g join expected_tables e on e.name = g.table_name
    where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated')) as public_role_grants,

  -- 5) 주문 목적지 2곳과 주소
  (select count(*) = 2 from public.marketing_destinations) as destinations_two,
  (select base_url = 'https://팔도플라워.com' from public.marketing_destinations where code = 'imweb') as imweb_url_ok,
  (select base_url = 'https://smartstore.naver.com/free77888' from public.marketing_destinations where code = 'smartstore') as smartstore_url_ok,

  -- 6) 채널 11개, 1차 3개, 전부 사람 게시
  (select count(*) from public.marketing_channels) as channels_total,                                   -- 기대: 11
  (select count(*) from public.marketing_channels where tier = 'primary') as channels_primary,          -- 기대: 3
  (select count(*) from public.marketing_channels where publish_mode <> 'manual') as channels_not_manual, -- 기대: 0

  -- 7) 네이버 계열은 스마트스토어, 그 외는 자사몰이 기본 (기대: 0)
  (select count(*) from public.marketing_channels
    where (code like 'naver\_%' and default_destination_code <> 'smartstore')
       or (code not like 'naver\_%' and default_destination_code <> 'imweb')) as default_destination_mismatch,

  -- 8) 핵심 제약 존재 (기대: 6)
  (select count(*) from pg_constraint where conname in (
    'marketing_variants_campaign_code_key', 'marketing_variants_approval_check',
    'marketing_distribution_jobs_once_key', 'marketing_distribution_jobs_mode_status_check',
    'marketing_distribution_jobs_confirmed_check', 'marketing_metrics_daily_observation_key')) as key_constraints,

  -- 8-1) 보호 트리거 4개 (기대: 4)
  (select count(*) from pg_trigger where not tgisinternal and tgname in (
    'marketing_images_guard', 'marketing_variants_check_image_refs', 'marketing_variants_block_revise_after_post',
    'marketing_distribution_jobs_guard')) as guard_triggers,

  -- 8-2) 작업 생성 함수 존재, 공개 역할은 실행 불가 (기대: true, false, false)
  (select count(*) = 1 from pg_proc where proname = 'create_marketing_distribution_job') as job_function_present,
  has_function_privilege('anon', 'public.create_marketing_distribution_job(uuid, integer, text, timestamptz, text)', 'execute') as anon_can_execute,
  has_function_privilege('authenticated', 'public.create_marketing_distribution_job(uuid, integer, text, timestamptz, text)', 'execute') as authenticated_can_execute,

  -- 9) 신규 운영 테이블은 비어 있다 (기대: 전부 0)
  (select count(*) from public.marketing_campaigns) as campaigns_rows,
  (select count(*) from public.marketing_variants) as variants_rows,
  (select count(*) from public.marketing_distribution_jobs) as jobs_rows,
  (select count(*) from public.marketing_metrics_daily) as metrics_rows,

  -- 10) 기존 공개 데이터 무변경 확인용 기준값 — migration 전후가 같아야 한다
  (select count(*) from public.seo_pages where status = 'published') as published_pages;
