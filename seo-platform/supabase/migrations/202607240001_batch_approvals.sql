-- 승인 Batch 자동 AI 생성 v1 — PR-A 승인 모델 (feature/approved-batch-auto-generation-v1)
-- 사용자가 후보를 승인하면 시스템이 브라우저 없이 AI Batch 생성을 실행하기 위한 승인·토큰·상태 기반.
--
-- 설계 원칙:
--  - 기존 batch_runs/batch_run_items/batch_run_events는 어떤 변경도 하지 않는다.
--    승인은 run 생성 "이전" 개념이므로 별도 테이블로 분리해 기존 상태 머신·지표·재개 로직을 보호한다.
--  - Activation token 원문은 어디에도 저장하지 않는다 — SHA-256 해시만 저장한다.
--  - Chain secret / Vercel Automation Bypass secret은 서버 환경변수 전용이며 DB에 저장하지 않는다.
--  - approved_place_ids와 approval_snapshot은 승인 시점에 동결된다 — 실행 endpoint는 요청 본문의
--    place 목록을 신뢰하지 않고 이 스냅샷만 사용한다 (임의 place id 주입 차단).
--  - 이 파일은 설계 산출물이다. 적용은 사용자가 Supabase SQL Editor에서 직접 실행한다 (기존 관례).

create table public.batch_approvals (
  id uuid primary key default gen_random_uuid(),

  -- 상태 머신: approved → queued → running → completed / failed
  --            approved|queued → expired / cancelled, running → cancelled
  -- 모든 전이는 애플리케이션의 조건부 UPDATE로만 수행한다 (기대 상태 불일치 = 0행 no-op).
  status text not null default 'approved'
    check (status in ('approved', 'queued', 'running', 'completed', 'failed', 'expired', 'cancelled')),

  -- 승인 감사 기록
  approved_by text not null,
  approved_at timestamptz not null default now(),
  approval_expires_at timestamptz not null,

  -- 승인 시점 동결 대상 (1~5건)
  approved_place_ids uuid[] not null,
  approved_max_cost_usd numeric not null,

  -- 승인 시점 장소 스냅샷 배열 — 각 항목: place_id, 장소명, 주소, 전화, slug,
  -- official_verification_status, verification_source_urls, had_generation=false,
  -- had_seo_page=false, 예상 토큰·비용, snapshot_hash(항목별 SHA-256).
  -- 실행 단계(PR-B)는 실행 직전 장소 정보를 다시 읽어 snapshot_hash와 대조하고,
  -- 달라진 item만 차단한다 (승인 후 변경 감지).
  approval_snapshot jsonb not null,

  -- Activation token: 256-bit 난수의 SHA-256 해시만 저장 (원문 미저장).
  -- approved|queued → running 최초 활성화 1회에만 소진되며, 소진 시각이 기록된다.
  execution_token_hash text not null unique,
  activation_consumed_at timestamptz,

  -- 후속 tick 중복·순서 제어 — 조건부 CAS(execution_tick = 기대값)로만 증가한다.
  execution_tick integer not null default 0,

  -- 활성화 시 생성되는 기존 batch_runs 연결. 연결 후 재활성화는 금지된다.
  batch_run_id uuid references public.batch_runs(id) on delete set null,

  -- 진단용 (민감정보 금지: 토큰 원문·secret·stack trace·생성 본문 저장 금지)
  last_tick_at timestamptz,
  last_error_code text,
  last_error_message text,
  preview_deployment_sha text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- coalesce 필수: 빈 배열은 array_length가 NULL이라 BETWEEN이 NULL(통과)로 평가된다 —
  -- coalesce(…, 0)으로 빈 배열도 DB 계층에서 거부한다 (2026-07-24 검수 반영).
  constraint batch_approvals_place_count_check
    check (coalesce(array_length(approved_place_ids, 1), 0) between 1 and 5),
  constraint batch_approvals_max_cost_check
    check (approved_max_cost_usd > 0),
  constraint batch_approvals_expiry_check
    check (approval_expires_at > approved_at),
  constraint batch_approvals_tick_check
    check (execution_tick >= 0)
);

-- 활성 승인(approved/queued/running)은 전역 1건만 허용 — 기존 startGenerationBatch의
-- already-running 가드와 같은 원칙을 승인 계층에도 적용한다 (동시 자동 배치 금지).
create unique index batch_approvals_single_active_idx
  on public.batch_approvals ((true))
  where status in ('approved', 'queued', 'running');

create index batch_approvals_status_idx on public.batch_approvals (status, created_at desc);
create index batch_approvals_batch_run_idx on public.batch_approvals (batch_run_id);

-- updated_at 자동 갱신 (기존 batch 테이블과 동일 패턴)
create trigger batch_approvals_set_updated_at
  before update on public.batch_approvals
  for each row execute function public.set_updated_at();

-- service role 서버 경로 전용 — anon/authenticated 정책 0개 (기존 batch 테이블과 동일 패턴).
alter table public.batch_approvals enable row level security;
