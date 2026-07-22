-- Batch 운영 v1 (feature/batch-generation-publish-v1 PR-1)
-- 1) batch_runs / batch_run_items — 5건 단위 일괄 생성·게시 오케스트레이션 상태 머신 + 감사 로그
-- 2) places 공식 검증 상태 — 배치 대상은 official_verification_status='verified'만 허용
-- 기존 테이블 행 데이터는 변경하지 않는다 (places 신규 컬럼은 전부 null 시작,
-- sync upsert는 SOURCE_FIELD_KEYS만 갱신하므로 이 컬럼들은 재동기화에도 보존된다).

create table public.batch_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('generate', 'publish')),
  status text not null default 'running' check (status in ('running', 'completed', 'cancelled', 'failed')),
  created_by text,
  -- {max_items, max_cost_usd, warn_policy, usd_krw_rate, official_check_approved, estimated_cost_usd, estimated_tokens}
  settings jsonb not null default '{}'::jsonb,
  -- {items, ready, warn_ready, needs_review, failed, skipped, interrupted, published, publish_failed, tokens_input, tokens_output, actual_cost_usd}
  totals jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 동시 실행 락: kind별로 running 배치는 1개만 허용한다.
create unique index batch_runs_single_running_idx on public.batch_runs(kind) where status = 'running';

create table public.batch_run_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batch_runs(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  sequence integer not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'ready', 'warn_ready', 'needs_review', 'failed', 'skipped', 'interrupted', 'published', 'publish_failed')),
  current_step text check (current_step in ('generating', 'checking', 'applying', 'publishing', 'verifying')),
  -- 시작 시점 장소 스냅샷(name/address/phone/slug/공식검증 상태) — 감사·불일치 감지용
  input_snapshot jsonb,
  idempotency_key text not null,
  generation_id uuid references public.ai_generations(id),
  retry_generation_id uuid references public.ai_generations(id),
  quality_status text check (quality_status in ('pass', 'warn', 'fail')),
  quality_issues jsonb,
  tokens_input integer,
  tokens_output integer,
  cost_usd numeric,
  -- 게시 승인 스냅샷: {generation_id, seo_page_id, content_hash, approved_by, approved_at}
  approval_snapshot jsonb,
  publish_result text,
  verification_status text check (verification_status in ('pending', 'verified', 'delayed', 'failed')),
  skip_reason text,
  last_error_code text,
  last_error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, place_id),
  unique (batch_id, sequence)
);

create index batch_run_items_batch_status_idx on public.batch_run_items(batch_id, status);

create trigger batch_runs_set_updated_at before update on public.batch_runs for each row execute function public.set_updated_at();
create trigger batch_run_items_set_updated_at before update on public.batch_run_items for each row execute function public.set_updated_at();

alter table public.batch_runs enable row level security;
alter table public.batch_run_items enable row level security;

-- places 공식 검증 상태 — 기존 행은 모두 null(=unverified 취급). sync가 갱신하지 않는 운영 전용 컬럼.
alter table public.places
  add column if not exists official_verification_status text
    check (official_verification_status in ('verified', 'excluded'));

alter table public.places add column if not exists verified_at timestamptz;
alter table public.places add column if not exists verified_by text;
alter table public.places add column if not exists verification_source_urls jsonb;
alter table public.places add column if not exists exclusion_reason text;
