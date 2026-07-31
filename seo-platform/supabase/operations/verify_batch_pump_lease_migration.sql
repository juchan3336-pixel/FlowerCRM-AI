-- 202607310001_batch_approval_pump_lease.sql 적용 후 검증 (읽기 전용 — SELECT만).
-- Supabase SQL Editor에 전체 붙여넣고 Run. 결과 표 전체를 복사해 전달한다.
--
-- 문장은 하나뿐이다. Editor는 여러 문장을 실행하면 마지막 결과만 보여주므로,
-- 참고값까지 같은 결과 표에 INFO 행으로 넣었다 (검증 표가 화면에서 사라지지 않게).

with checks as (
  -- ── A. 신규 컬럼 ────────────────────────────────────────────────
  select 1 as ord, 'A1 lease_token_hash 존재 (nullable)' as check_name, 'YES' as expected,
    (select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'batch_approvals' and column_name = 'lease_token_hash') as actual
  union all select 2, 'A2 lease_expires_at 존재 (nullable)', 'YES',
    (select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'batch_approvals' and column_name = 'lease_expires_at')
  union all select 3, 'A3 pump_attempt 존재 (not null)', 'NO',
    (select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'batch_approvals' and column_name = 'pump_attempt')
  union all select 4, 'A4 pump_attempt default 0', '0',
    (select coalesce(column_default, '(none)') from information_schema.columns
      where table_schema = 'public' and table_name = 'batch_approvals' and column_name = 'pump_attempt')

  -- ── B. 인덱스 / RPC ─────────────────────────────────────────────
  union all select 10, 'B1 idx batch_approvals_pump_claim_idx', '1',
    (select count(*)::text from pg_indexes where schemaname = 'public' and indexname = 'batch_approvals_pump_claim_idx')
  union all select 11, 'B2 claim_batch_pump_lease 함수 존재', '1',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_batch_pump_lease')
  union all select 12, 'B3 함수가 security definer', 'true',
    (select prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_batch_pump_lease')
  union all select 13, 'B4 anon/authenticated 실행 권한 없음', '0',
    (select count(*)::text from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'claim_batch_pump_lease' and grantee in ('anon', 'authenticated'))
  union all select 14, 'B5 for update skip locked 사용', 'true',
    (select (pg_get_functiondef(p.oid) like '%skip locked%')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_batch_pump_lease')
  -- 승인 게이트 보호 — RPC가 running만 집는지 정의 자체로 확인한다.
  union all select 15, 'B6 RPC가 running 승인만 대상', 'true',
    (select (pg_get_functiondef(p.oid) like '%status = ''running''%')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_batch_pump_lease')
  union all select 16, 'B7 RPC가 batch_run 연결 승인만 대상', 'true',
    (select (pg_get_functiondef(p.oid) like '%batch_run_id is not null%')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_batch_pump_lease')

  -- ── C. 기존 승인·Batch 보존 ─────────────────────────────────────
  union all select 20, 'C1 batch_approvals 행 수', '1',
    (select count(*)::text from public.batch_approvals)
  union all select 21, 'C2 승인 status', 'completed',
    (select status from public.batch_approvals order by approved_at desc limit 1)
  union all select 22, 'C3 진행 중 승인', '0',
    (select count(*)::text from public.batch_approvals where status in ('approved', 'queued', 'running'))
  union all select 23, 'C4 lease 미보유 (신규 컬럼 기본값)', 'true',
    (select (lease_token_hash is null and lease_expires_at is null and pump_attempt = 0)::text
      from public.batch_approvals order by approved_at desc limit 1)
  union all select 24, 'C5 batch_runs 행 수', '10',
    (select count(*)::text from public.batch_runs)
  union all select 25, 'C6 batch_run_items 행 수', '27',
    (select count(*)::text from public.batch_run_items)
  union all select 26, 'C7 batch_run_events 행 수', '76',
    (select count(*)::text from public.batch_run_events)
  union all select 27, 'C8 진행 중 batch_run', '0',
    (select count(*)::text from public.batch_runs where status = 'running')
  union all select 28, 'C9 ai_generations 행 수', '31',
    (select count(*)::text from public.ai_generations)
  -- 보호 대상 item 상태 — 대구병원 failed 1건이 그대로 남아 있어야 한다.
  union all select 29, 'C10 failed item 수', '1',
    (select count(*)::text from public.batch_run_items where status = 'failed')
  union all select 30, 'C11 published item 수', '13',
    (select count(*)::text from public.batch_run_items where status = 'published')

  -- ── D. 운영 데이터 무변경 ───────────────────────────────────────
  union all select 40, 'D1 places 행 수', '20552',
    (select count(*)::text from public.places)
  union all select 41, 'D2 max source_row_number', '20553',
    (select max(source_row_number)::text from public.places)
  union all select 42, 'D3 source_row_number 중복', '0',
    (select (count(source_row_number) - count(distinct source_row_number))::text from public.places)
  union all select 43, 'D4 published places', '29',
    (select count(*)::text from public.places where status = 'published')
  union all select 44, 'D5 seo_pages published', '29',
    (select count(*)::text from public.seo_pages where status = 'published')
  union all select 45, 'D6 sync_errors', '52',
    (select count(*)::text from public.sync_errors)
  union all select 46, 'D7 active sync job', '0',
    (select count(*)::text from public.sync_jobs where status in ('queued', 'running'))

  -- ── E. 참고값 (PASS/FAIL 아님) ──────────────────────────────────
  -- cron.job은 pg_cron 확장을 활성화한 뒤에야 존재한다. 아직 없을 때 그 테이블을 직접 참조하면
  -- 파싱 단계에서 통째로 실패해 검증 표까지 함께 취소된다 — 그래서 확장 설치 여부만 확인한다.
  union all select 90, 'E1 pg_cron 설치 (Cron 등록 전이면 0)', '(참고)',
    (select count(*)::text from pg_extension where extname = 'pg_cron')
  union all select 91, 'E2 pg_net 설치 (Cron 등록 전이면 0)', '(참고)',
    (select count(*)::text from pg_extension where extname = 'pg_net')
  union all select 92, 'E3 batch_approvals 컬럼 수', '(참고)',
    (select count(*)::text from information_schema.columns
      where table_schema = 'public' and table_name = 'batch_approvals')
)
select check_name, expected, coalesce(actual, '(null)') as actual,
  case
    when expected = '(참고)' then 'INFO'
    when coalesce(actual, '(null)') = expected then 'PASS'
    else 'FAIL'
  end as verdict
from checks
order by ord;
