-- ════════════════════════════════════════════════════════════════
-- 광고 문안 자동 생성 기록과 비용 원장 (2026-11-10)
--
-- AI로 광고 초안을 만들 때마다 한 행을 남긴다. 호출하기 "전에" 최악 비용을 예약하고(reserve),
-- 호출이 끝나면 실제 비용으로 정산한다. 일·월 상한은 이 표의 합계로 판정하므로, 동시에 여러 요청이 와도
-- 상한을 넘겨 호출하지 않는다(예약 함수가 잠금을 잡고 합계를 본 뒤 행을 넣는다).
--
-- 설계 원칙:
--  - 실패·결과 불명 호출도 예산에서 뺀다 — 요금은 실패해도 나갈 수 있다.
--  - 결과를 알 수 없는 호출(unknown)은 자동으로 다시 부르지 않는다. 사람이 새로 요청한다.
--  - 같은 요청 키(request_key)는 한 번만 받는다 — 버튼을 두 번 눌러도 한 편만 만든다.
--  - 프롬프트·응답 원문·API 키는 저장하지 않는다. 사용량과 금액, 결과 소재만 남긴다.
--  - service role 서버 경로 전용(RLS on, 정책 0, 공개 역할 권한 회수). 기존 테이블은 건드리지 않는다.
--  - 재실행해도 안전하다. 적용은 Supabase SQL Editor에서 직접 실행한다.
--
-- 롤백(데이터가 없을 때만):
--   drop function if exists public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text);
--   drop table if exists public.marketing_generations;
-- ════════════════════════════════════════════════════════════════

create table if not exists public.marketing_generations (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete restrict,
  channel_code text not null references public.marketing_channels(code),
  -- 같은 요청을 두 번 받지 않기 위한 키 (화면이 폼마다 하나씩 발급)
  request_key text not null unique check (request_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  -- 이번 초안의 주제 식별자 — 같은 캠페인에서 덜 쓴 주제를 고르는 데 쓴다
  topic_key text not null,
  -- reserved: 예약하고 호출 중 / succeeded: 초안 저장됨 / failed: 호출 또는 저장 실패 / unknown: 응답을 받지 못해 결과 불명
  status text not null default 'reserved' check (status in ('reserved', 'succeeded', 'failed', 'unknown')),
  model text not null,
  -- 호출 전에 잡아 둔 최악 비용(USD)
  reserved_usd numeric(10, 6) not null check (reserved_usd > 0),
  -- 실제 사용량으로 계산한 비용. 모르면 null — 예산 판정에는 reserved_usd를 쓴다.
  actual_usd numeric(10, 6) check (actual_usd is null or actual_usd >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  -- 실제로 AI를 부른 횟수 (보정 포함)
  call_count integer not null default 0 check (call_count >= 0),
  -- 만들어진 소재
  variant_id uuid references public.marketing_variants(id) on delete restrict,
  -- 저장된 초안의 품질 판정 (pass | warn | fail)
  quality_status text check (quality_status is null or quality_status in ('pass', 'warn', 'fail')),
  error_code text,
  created_by text not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint marketing_generations_success_check check (status <> 'succeeded' or variant_id is not null)
);

create index if not exists marketing_generations_created_idx on public.marketing_generations (created_at desc);
create index if not exists marketing_generations_campaign_idx on public.marketing_generations (campaign_id, created_at desc);

-- ── 예약 (원자 연산) ──
-- 전역 잠금을 잡고 오늘(KST)·이번 달(KST)의 건수와 금액을 본 뒤, 상한 안이면 예약 행을 넣는다.
-- 금액은 정산된 행은 actual_usd(모르면 reserved_usd), 진행 중·불명 행은 reserved_usd로 센다.
-- 반환: {"kind": "reserved", "id": "…"} | {"kind": "duplicate"} | {"kind": "cap", "cap": "daily-count" | "daily-usd" | "monthly-usd"}
create or replace function public.reserve_marketing_generation(
  p_campaign_id uuid,
  p_channel_code text,
  p_request_key text,
  p_topic_key text,
  p_model text,
  p_reserve_usd numeric,
  p_daily_count_cap integer,
  p_daily_usd_cap numeric,
  p_monthly_usd_cap numeric,
  p_created_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  v_day_count integer;
  v_day_usd numeric;
  v_month_usd numeric;
  v_id uuid;
begin
  if p_reserve_usd is null or p_reserve_usd <= 0 or p_daily_count_cap is null or p_daily_usd_cap is null or p_monthly_usd_cap is null then
    raise exception 'reserve amount and caps are required';
  end if;
  if p_model is null or length(trim(p_model)) = 0 or p_created_by is null or length(trim(p_created_by)) = 0 then
    raise exception 'model and actor are required';
  end if;

  -- 예산 판정과 행 삽입 사이에 다른 예약이 끼어들지 못하게 한다 (트랜잭션이 끝나면 풀린다)
  perform pg_advisory_xact_lock(hashtext('marketing_generation_budget'));

  if exists (select 1 from public.marketing_generations where request_key = p_request_key) then
    return jsonb_build_object('kind', 'duplicate');
  end if;

  select count(*), coalesce(sum(coalesce(actual_usd, reserved_usd)), 0)
    into v_day_count, v_day_usd
    from public.marketing_generations where created_at >= v_day_start;
  select coalesce(sum(coalesce(actual_usd, reserved_usd)), 0)
    into v_month_usd
    from public.marketing_generations where created_at >= v_month_start;

  if v_day_count >= p_daily_count_cap then
    return jsonb_build_object('kind', 'cap', 'cap', 'daily-count');
  end if;
  if v_day_usd + p_reserve_usd > p_daily_usd_cap then
    return jsonb_build_object('kind', 'cap', 'cap', 'daily-usd');
  end if;
  if v_month_usd + p_reserve_usd > p_monthly_usd_cap then
    return jsonb_build_object('kind', 'cap', 'cap', 'monthly-usd');
  end if;

  insert into public.marketing_generations (campaign_id, channel_code, request_key, topic_key, model, reserved_usd, created_by)
  values (p_campaign_id, p_channel_code, p_request_key, p_topic_key, p_model, p_reserve_usd, p_created_by)
  returning id into v_id;

  return jsonb_build_object('kind', 'reserved', 'id', v_id);
end;
$$;

revoke all on function public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text) from public;
revoke all on function public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text) from anon;
revoke all on function public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text) from authenticated;
grant execute on function public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text) to service_role;

alter table public.marketing_generations enable row level security;
revoke all on table public.marketing_generations from anon, authenticated;

-- ── 검증 (읽기 전용) — 실행 후 아래 한 줄로 확인한다. 기대: true, true, 0, false ──
-- select
--   exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'marketing_generations') as table_present,
--   (select relrowsecurity from pg_class where relname = 'marketing_generations') as rls_enabled,
--   (select count(*) from public.marketing_generations) as rows,
--   has_function_privilege('anon', 'public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text)', 'execute') as anon_can_execute;
