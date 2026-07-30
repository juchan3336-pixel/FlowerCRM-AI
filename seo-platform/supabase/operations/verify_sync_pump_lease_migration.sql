-- 202607300001_sync_pump_lease.sql 적용 후 검증 (읽기 전용 — SELECT만).
-- Supabase SQL Editor에 전체 붙여넣고 Run. 결과 표 전체를 복사해 전달한다.

with checks as (
  -- ── A. 신규 컬럼 ────────────────────────────────────────────────
  select 1 as ord, 'A1 lease_token_hash 존재 (nullable)' as check_name, 'YES' as expected,
    (select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'sync_jobs' and column_name = 'lease_token_hash') as actual
  union all select 2, 'A2 lease_expires_at 존재 (nullable)', 'YES',
    (select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'sync_jobs' and column_name = 'lease_expires_at')
  union all select 3, 'A3 pump_attempt 존재 (not null)', 'NO',
    (select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'sync_jobs' and column_name = 'pump_attempt')
  union all select 4, 'A4 pump_attempt default 0', '0',
    (select coalesce(column_default, '(none)') from information_schema.columns
      where table_schema = 'public' and table_name = 'sync_jobs' and column_name = 'pump_attempt')
  union all select 5, 'A5 sync_jobs 컬럼 수 (35 + 3)', '38',
    (select count(*)::text from information_schema.columns
      where table_schema = 'public' and table_name = 'sync_jobs')

  -- ── B. 인덱스 / RPC ─────────────────────────────────────────────
  union all select 10, 'B1 idx sync_jobs_pump_claim_idx', '1',
    (select count(*)::text from pg_indexes where schemaname = 'public' and indexname = 'sync_jobs_pump_claim_idx')
  union all select 11, 'B2 claim_sync_pump_lease 함수 존재', '1',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_sync_pump_lease')
  union all select 12, 'B3 함수가 security definer', 'true',
    (select prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_sync_pump_lease')
  union all select 13, 'B4 anon/authenticated 실행 권한 없음', '0',
    (select count(*)::text from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'claim_sync_pump_lease' and grantee in ('anon', 'authenticated'))
  union all select 14, 'B5 for update skip locked 사용', 'true',
    (select (pg_get_functiondef(p.oid) like '%skip locked%')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_sync_pump_lease')

  -- ── C. 기존 job 보존 (현재 interrupted job) ─────────────────────
  union all select 20, 'C1 sync_jobs 행 수', '1',
    (select count(*)::text from public.sync_jobs)
  union all select 21, 'C2 active job', '0',
    (select count(*)::text from public.sync_jobs where status in ('queued', 'running'))
  union all select 22, 'C3 job status', 'interrupted',
    (select status from public.sync_jobs order by started_at desc limit 1)
  union all select 23, 'C4 current_row', '15403',
    (select current_row::text from public.sync_jobs order by started_at desc limit 1)
  union all select 24, 'C5 processed_count', '450',
    (select processed_count::text from public.sync_jobs order by started_at desc limit 1)
  union all select 25, 'C6 remaining_count', '5150',
    (select remaining_count::text from public.sync_jobs order by started_at desc limit 1)
  union all select 26, 'C7 batch_index', '9',
    (select batch_index::text from public.sync_jobs order by started_at desc limit 1)
  union all select 27, 'C8 lease 미보유 (신규 컬럼 기본값)', 'true',
    (select (lease_token_hash is null and lease_expires_at is null and pump_attempt = 0)::text
      from public.sync_jobs order by started_at desc limit 1)

  -- ── D. 운영 데이터 무변경 ───────────────────────────────────────
  union all select 30, 'D1 places 행 수', '15401',
    (select count(*)::text from public.places)
  union all select 31, 'D2 max source_row_number', '15402',
    (select max(source_row_number)::text from public.places)
  union all select 32, 'D3 source_row_number 중복', '0',
    (select (count(source_row_number) - count(distinct source_row_number))::text from public.places)
  union all select 33, 'D4 source_row_number 연속성', 'true',
    (select (count(source_row_number) = max(source_row_number) - min(source_row_number) + 1)::text from public.places)
  union all select 34, 'D5 published places', '29',
    (select count(*)::text from public.places where status = 'published')
  union all select 35, 'D6 seo_pages published', '29',
    (select count(*)::text from public.seo_pages where status = 'published')
  union all select 36, 'D7 sync_runs', '270',
    (select count(*)::text from public.sync_runs)
  union all select 37, 'D8 sync_errors', '52',
    (select count(*)::text from public.sync_errors)
)
select check_name, expected, coalesce(actual, '(null)') as actual,
  case when coalesce(actual, '(null)') = expected then 'PASS' else 'FAIL' end as verdict
from checks
order by ord;

-- 참고값 (PASS/FAIL 아님)
select
  (select max(source_row_number) + 1 from public.places) as next_row_after_synced,
  (select count(*) from cron.job where jobname = 'sync-pump') as pump_cron_registered;
