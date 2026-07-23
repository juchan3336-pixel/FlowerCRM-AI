-- Batch 운영 경량 이벤트 로그 (PR-S4)
-- 상태 머신의 진실은 batch_runs/batch_run_items의 조건부 UPDATE이며, 이 테이블은 파생 감사 기록이다.
-- 기록은 fire-and-forget: 저장 실패·중복 충돌이 Batch 본 처리에 영향을 주지 않는다.
-- 기존 batch 4건은 역보정하지 않는다 (이벤트 없음 = 도입 이전 실행).
-- 보존: 자동 삭제·cron 없음(영구 보존). 1만 건 또는 1년 누적 시 정리 정책 재검토.

create table public.batch_run_events (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batch_runs(id) on delete cascade,
  item_id uuid references public.batch_run_items(id) on delete cascade,
  event_type text not null check (event_type in (
    'run_created',
    'run_started',
    'item_claimed',
    'item_step_changed',
    'item_result_recorded',
    'items_skipped',
    'item_interrupted_marked',
    'run_cancel_requested',
    'run_finished',
    'verification_updated'
  )),
  from_status text,
  to_status text,
  step text,
  actor text,
  -- 허용 요약 필드만 저장 (trigger/retry_count/error_code/skip_reason/http_status/verification_status/토큰·비용 요약/취소 여부).
  -- 생성 본문·FAQ·메타 설명·토큰/환경변수·stack trace·민감 원문 저장 금지 — 기록 계층의 sanitizer가 allowlist로 강제한다.
  detail jsonb not null default '{}',
  -- 결정적 멱등성 키 — 동일 전이·동일 액션 재호출은 unique 충돌로 no-op 처리된다.
  idempotency_key text not null,
  created_at timestamptz not null default now()
);

create unique index batch_run_events_idempotency_idx on public.batch_run_events (batch_id, idempotency_key);
create index batch_run_events_batch_idx on public.batch_run_events (batch_id, created_at);
create index batch_run_events_item_idx on public.batch_run_events (item_id, created_at);

-- service role 서버 경로 전용 — anon/authenticated 정책 0개 (기존 batch 테이블과 동일 패턴).
alter table public.batch_run_events enable row level security;
