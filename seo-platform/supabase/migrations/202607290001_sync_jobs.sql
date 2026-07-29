-- Google Sheets 증분 동기화 자동 연속 처리 (sync self-chain v1)
--
-- 왜 sync_runs 확장이 아니라 신규 테이블인가 —
-- sync_runs는 syncSheetRows() 1회 = 1행이며 "50건 배치 1회"의 기록이다. 버튼 1클릭으로 N개의 50건
-- 배치를 이어 돌리면 sync_runs는 N행이 된다. sync_runs에 job 상태를 얹으면 "최신 실행" 카드·최근
-- 실행 목록·오류 목록의 기존 의미가 전부 깨진다. 그래서 job(작업 = 버튼 1클릭)을 별도 테이블로 두고,
-- sync_runs는 배치 기록 그대로 유지한 채 job에 연결만 한다.
--
-- 기존 데이터 영향: 신규 테이블 1개 + sync_runs에 nullable 컬럼 2개. 기존 sync_runs 행은 전부
-- sync_job_id=null / batch_index=null로 남는다 (도입 이전 수동 실행 = job 없음). 역보정하지 않는다.

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  -- queued: 접수됨(첫 tick 대기) / running: tick 진행 중
  -- completed: 잔여 0으로 정상 종료 / partial_completed: 상한 도달로 중단(잔여 있음, 재개 가능)
  -- interrupted: chain 유실·서버 재시작으로 정체(재개 가능) / failed: 복구 불가 오류 / cancelled: 사용자 중단
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'partial_completed', 'failed', 'cancelled', 'interrupted')),
  source_sheet_name text not null,
  created_by text,

  -- ── 커서 ─────────────────────────────────────────────────────────
  -- 행 번호는 시트 기준 1-base이며 2가 첫 데이터 행이다 (1행은 헤더).
  batch_size integer not null default 50 check (batch_size between 1 and 200),
  -- job 시작 시점의 다음 미동기화 행 (= places의 max(source_row_number) + 1)
  start_row integer not null check (start_row >= 2),
  -- 다음에 처리할 행. 파싱 실패 행도 "시도함"으로 전진시킨다 —
  -- places max(source_row_number)를 커서로 쓰면 실패 행에서 영원히 같은 50건을 다시 읽는다.
  current_row integer not null check (current_row >= 2),
  -- job 시작 시점에 확인한 시트 마지막 행 (진행률 분모의 기준선)
  target_last_row integer not null default 1 check (target_last_row >= 1),
  -- 매 tick마다 다시 읽은 시트 마지막 행 (동기화 중 시트가 늘어나면 함께 늘어난다)
  latest_sheet_row integer not null default 1 check (latest_sheet_row >= 1),

  -- ── 진행 집계 ────────────────────────────────────────────────────
  batch_index integer not null default 0 check (batch_index >= 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  remaining_count integer not null default 0 check (remaining_count >= 0),

  -- ── self-chain 인증 ──────────────────────────────────────────────
  -- 다음 tick 요청이 제시해야 하는 1회용 토큰의 sha256. 원문은 절대 저장하지 않는다
  -- (batch_approvals.execution_token_hash와 동일 패턴). tick 성공 시 회전하므로
  -- 중복·지연 요청은 hash 불일치로 자연히 no-op이 된다 — 별도 tick CAS가 필요 없다.
  next_tick_token_hash text,

  started_at timestamptz not null default now(),
  last_tick_at timestamptz,
  finished_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 동시 실행 락 — 진행 중 job은 전체에서 1개만 허용한다 (batch_runs_single_running_idx와 동일 방식).
-- 중복 클릭·중복 chain 발사가 두 번째 job을 만들지 못한다.
create unique index sync_jobs_single_active_idx on public.sync_jobs ((true)) where status in ('queued', 'running');
create index sync_jobs_status_started_idx on public.sync_jobs (status, started_at desc);

create trigger sync_jobs_set_updated_at before update on public.sync_jobs for each row execute function public.set_updated_at();

-- service role 서버 경로 전용 — anon 정책 0개 (batch 테이블과 동일).
alter table public.sync_jobs enable row level security;
create policy "authenticated sync_jobs admin" on public.sync_jobs for all to authenticated using (true) with check (true);
revoke all on public.sync_jobs from anon;

-- 배치 기록을 job에 연결한다. 기존 행은 null 유지 (도입 이전 수동 1회 실행).
alter table public.sync_runs add column if not exists sync_job_id uuid references public.sync_jobs(id) on delete set null;
alter table public.sync_runs add column if not exists batch_index integer check (batch_index is null or batch_index >= 0);

create index if not exists sync_runs_job_idx on public.sync_runs (sync_job_id, batch_index);
