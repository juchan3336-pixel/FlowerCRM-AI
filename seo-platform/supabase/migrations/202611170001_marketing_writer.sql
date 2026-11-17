-- ════════════════════════════════════════════════════════════════
-- 광고 글쓰기 도구 — 캠페인 없이 만드는 글의 생성 기록과 결과 (2026-11-17)
--
-- 관리자 화면 "광고 글쓰기"는 캠페인·검수·배포 작업 없이 블로그 글, SNS·카페 글, 스마트스토어 상품 설명을 만든다.
-- 비용은 캠페인 초안과 같은 원장(marketing_generations)에 넣는다 — 원장을 나누면 일·월 상한이 둘로 갈라진다.
--
-- 바뀌는 것:
--  - marketing_generations.kind 추가: 'campaign-draft'(기존 행 전부, 기본값) | 'writer'
--  - campaign_id·channel_code는 writer일 때만 비울 수 있다. campaign-draft의 기존 계약(캠페인·채널 필수, 성공이면 소재 필수)은 그대로다.
--  - writer의 성공은 결과(marketing_writer_outputs)가 있어야만 기록된다 — 결과 저장과 성공 정산은 한 함수(한 트랜잭션)에서 한다.
--  - reserve_marketing_generation: 시그니처 그대로. p_campaign_id가 null이면 writer로 예약한다.
--  - 새 함수 complete_marketing_writer_generation: 결과 저장 + 성공 정산.
--
-- 설계 원칙(기존과 같음): service role 서버 경로 전용(RLS on, 정책 0, 공개 역할 권한 회수),
-- 프롬프트·응답 원문·API 키는 저장하지 않는다(사람이 복사해 쓸 최종 글만 저장), 재실행해도 안전하다.
-- 적용: 202611100002_marketing_generations.sql을 적용한 DB에서 Supabase SQL Editor로 이 파일 전체를 실행한다.
--
-- 롤백(writer 행이 없을 때만):
--   drop function if exists public.complete_marketing_writer_generation(uuid, jsonb, numeric, integer, integer, integer, text, text);
--   drop table if exists public.marketing_writer_outputs;
--   그리고 202611100002 파일의 reserve 함수·제약을 다시 실행한다.
-- ════════════════════════════════════════════════════════════════

-- ── 원장: 종류 구분 ──
alter table public.marketing_generations add column if not exists kind text not null default 'campaign-draft';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'marketing_generations_kind_value_check') then
    alter table public.marketing_generations add constraint marketing_generations_kind_value_check check (kind in ('campaign-draft', 'writer'));
  end if;
end;
$$;

alter table public.marketing_generations alter column campaign_id drop not null;
alter table public.marketing_generations alter column channel_code drop not null;

-- 종류별 필수 값 — 캠페인 초안은 캠페인·채널이 있어야 하고, writer는 캠페인·소재를 갖지 않는다
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'marketing_generations_kind_shape_check') then
    alter table public.marketing_generations add constraint marketing_generations_kind_shape_check check (
      (kind = 'campaign-draft' and campaign_id is not null and channel_code is not null)
      or (kind = 'writer' and campaign_id is null and variant_id is null)
    );
  end if;
end;
$$;

-- 성공 조건을 종류별로 — 캠페인 초안은 기존처럼 소재가 있어야 한다. writer의 결과 확인은 아래 트리거가 한다.
alter table public.marketing_generations drop constraint if exists marketing_generations_success_check;
alter table public.marketing_generations add constraint marketing_generations_success_check check (status <> 'succeeded' or kind = 'writer' or variant_id is not null);

create index if not exists marketing_generations_kind_idx on public.marketing_generations (kind, created_at desc);

-- ── writer 결과 ──
create table if not exists public.marketing_writer_outputs (
  id uuid primary key default gen_random_uuid(),
  -- 이 결과를 만든 생성 기록 — 한 기록에 결과 하나
  generation_id uuid not null unique references public.marketing_generations(id) on delete restrict,
  mode text not null check (mode in ('condolence', 'celebration', 'corporate-celebration')),
  -- blog: 네이버 블로그 / sns: SNS·카페 / product: 스마트스토어 상품 설명
  output_kind text not null check (output_kind in ('blog', 'sns', 'product')),
  -- 글이 나갈 채널 — 상품 설명은 스토어 안에 쓰므로 없다
  channel_code text references public.marketing_channels(code),
  region text check (region is null or char_length(region) <= 20),
  topic text not null check (char_length(topic) between 1 and 200),
  -- 상품 설명의 근거 — 사람이 확인해 입력한 상품명·구성/사양. 재검사 때 "지어낸 사양" 판정에 쓴다(주제·강조할 점은 근거가 아니다)
  product_name text check (product_name is null or char_length(product_name) <= 40),
  product_specs text check (product_specs is null or char_length(product_specs) <= 300),
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 4000),
  tags text[] not null default '{}' check (cardinality(tags) <= 10),
  caption text check (caption is null or char_length(caption) <= 200),
  -- [{"destination": "imweb" | "smartstore", "url": "..."}] — 시스템이 허용 주소와 추적 빌더로 만든 주문 링크
  order_links jsonb not null default '[]'::jsonb check (jsonb_typeof(order_links) = 'array'),
  quality_status text not null check (quality_status in ('pass', 'warn', 'fail')),
  -- 보정 뒤에도 남은 문제(금지 규칙 위반 + 문장 문제)
  issues text[] not null default '{}',
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint marketing_writer_outputs_channel_check check ((output_kind = 'product') = (channel_code is null)),
  constraint marketing_writer_outputs_product_check check (output_kind = 'product' or (product_name is null and product_specs is null))
);

create index if not exists marketing_writer_outputs_created_idx on public.marketing_writer_outputs (created_at desc);

alter table public.marketing_writer_outputs enable row level security;
revoke all on table public.marketing_writer_outputs from anon, authenticated;

-- 결과는 writer 종류의 "예약 중" 기록에만 붙는다 — 캠페인 초안 기록이나 이미 정산된 기록에 결과를 끼워 넣지 못한다
create or replace function public.marketing_writer_outputs_check_generation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'marketing_writer_outputs rows are immutable';
  end if;
  if not exists (select 1 from public.marketing_generations g where g.id = new.generation_id and g.kind = 'writer' and g.status = 'reserved') then
    raise exception 'writer output requires a reserved writer generation';
  end if;
  return new;
end;
$$;

drop trigger if exists marketing_writer_outputs_check_generation on public.marketing_writer_outputs;
create trigger marketing_writer_outputs_check_generation
  before insert or update on public.marketing_writer_outputs
  for each row execute function public.marketing_writer_outputs_check_generation();

-- writer 기록은 결과가 있어야만 성공으로 바뀐다
create or replace function public.marketing_generations_check_writer_success()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.kind = 'writer' and new.status = 'succeeded' and not exists (select 1 from public.marketing_writer_outputs o where o.generation_id = new.id) then
    raise exception 'writer generation cannot succeed without an output';
  end if;
  if tg_op = 'UPDATE' and new.kind is distinct from old.kind then
    raise exception 'marketing_generations.kind is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists marketing_generations_check_writer_success on public.marketing_generations;
create trigger marketing_generations_check_writer_success
  before insert or update on public.marketing_generations
  for each row execute function public.marketing_generations_check_writer_success();

-- ── 예약 (원자 연산) — 시그니처 유지, p_campaign_id null이면 writer ──
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
  v_kind text := case when p_campaign_id is null then 'writer' else 'campaign-draft' end;
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
  if v_kind = 'campaign-draft' and p_channel_code is null then
    raise exception 'campaign draft requires a channel';
  end if;

  -- 예산 판정과 행 삽입 사이에 다른 예약이 끼어들지 못하게 한다 (트랜잭션이 끝나면 풀린다). 캠페인 초안과 writer가 같은 잠금·합계를 쓴다.
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

  insert into public.marketing_generations (kind, campaign_id, channel_code, request_key, topic_key, model, reserved_usd, created_by)
  values (v_kind, p_campaign_id, p_channel_code, p_request_key, p_topic_key, p_model, p_reserve_usd, p_created_by)
  returning id into v_id;

  return jsonb_build_object('kind', 'reserved', 'id', v_id);
end;
$$;

revoke all on function public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text) from public;
revoke all on function public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text) from anon;
revoke all on function public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text) from authenticated;
grant execute on function public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text) to service_role;

-- ── writer 결과 저장 + 성공 정산 (원자 연산) ──
-- 예약 중인 writer 기록에만 동작한다. 이미 정산됐거나 없는 기록이면 {"kind": "stale"}.
-- 반환: {"kind": "completed", "output_id": "…"} | {"kind": "stale"}
create or replace function public.complete_marketing_writer_generation(
  p_generation_id uuid,
  p_output jsonb,
  p_actual_usd numeric,
  p_input_tokens integer,
  p_output_tokens integer,
  p_call_count integer,
  p_quality_status text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_generation public.marketing_generations%rowtype;
  v_output_id uuid;
begin
  select * into v_generation from public.marketing_generations where id = p_generation_id for update;
  if not found or v_generation.kind <> 'writer' or v_generation.status <> 'reserved' then
    return jsonb_build_object('kind', 'stale');
  end if;
  if p_output is null or jsonb_typeof(p_output) <> 'object' then
    raise exception 'output is required';
  end if;

  insert into public.marketing_writer_outputs (generation_id, mode, output_kind, channel_code, region, topic, product_name, product_specs, title, body, tags, caption, order_links, quality_status, issues, created_by)
  values (
    p_generation_id,
    p_output->>'mode',
    p_output->>'output_kind',
    nullif(p_output->>'channel_code', ''),
    nullif(p_output->>'region', ''),
    p_output->>'topic',
    nullif(p_output->>'product_name', ''),
    nullif(p_output->>'product_specs', ''),
    p_output->>'title',
    p_output->>'body',
    coalesce(array(select jsonb_array_elements_text(coalesce(p_output->'tags', '[]'::jsonb))), '{}'),
    nullif(p_output->>'caption', ''),
    coalesce(p_output->'order_links', '[]'::jsonb),
    p_quality_status,
    coalesce(array(select jsonb_array_elements_text(coalesce(p_output->'issues', '[]'::jsonb))), '{}'),
    v_generation.created_by
  )
  returning id into v_output_id;

  update public.marketing_generations
    set status = 'succeeded',
        actual_usd = p_actual_usd,
        input_tokens = p_input_tokens,
        output_tokens = p_output_tokens,
        call_count = p_call_count,
        quality_status = p_quality_status,
        error_code = p_error_code,
        settled_at = now()
    where id = p_generation_id;

  return jsonb_build_object('kind', 'completed', 'output_id', v_output_id);
end;
$$;

revoke all on function public.complete_marketing_writer_generation(uuid, jsonb, numeric, integer, integer, integer, text, text) from public;
revoke all on function public.complete_marketing_writer_generation(uuid, jsonb, numeric, integer, integer, integer, text, text) from anon;
revoke all on function public.complete_marketing_writer_generation(uuid, jsonb, numeric, integer, integer, integer, text, text) from authenticated;
grant execute on function public.complete_marketing_writer_generation(uuid, jsonb, numeric, integer, integer, integer, text, text) to service_role;

-- 검증은 supabase/operations/verify_marketing_writer_migration.sql
