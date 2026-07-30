-- 자동 연속 동기화를 HTTP self-chain에서 Cron pull(pump) 구조로 전환한다.
--
-- 왜: Vercel은 같은 함수의 HTTP 재귀 호출을 4회 초과하면 508 INFINITE_LOOP_DETECTED로 차단한다.
-- 실측도 정확히 그랬다 — 재개마다 배치 4개를 정상 처리한 뒤 5번째 발사가 508로 죽었고(2026-07-30
-- 12:15, 17:33) 재시도 3회가 2.0초 안에 모두 508을 받았다. 재시도·timeout·배치 크기로는 우회할 수
-- 없는 구조적 한계여서, 다음 배치를 "자기 호출"이 아니라 외부 스케줄러가 끌어가게 바꾼다.
--
-- 이 migration은 그 pull 구조에 필요한 실행 소유권(lease)만 추가한다. 커서·집계·세션 컬럼은 그대로다.
-- 기존 행 영향: 신규 컬럼 3개 전부 nullable 또는 default 0이라 현재 job(진행 중 재개 대기)은 무변경.

-- ── lease (실행 소유권) ──────────────────────────────────────────
-- 한 번에 한 pump만 한 job의 배치를 돌려야 한다. 그 소유권을 토큰 해시로 들고,
-- 이후 모든 쓰기를 "내가 아직 소유자일 때만"으로 조건화한다 (늦게 끝난 워커가 최신 lease를 덮지 못함).
alter table public.sync_jobs add column if not exists lease_token_hash text;
-- lease 만료 시각. 함수가 배치 중간에 죽어도 이 시각이 지나면 다음 Cron이 같은 job을 다시 가져간다.
alter table public.sync_jobs add column if not exists lease_expires_at timestamptz;
-- 이 job이 pump에 claim된 횟수 (진단용 — 정체·재claim 반복을 눈으로 확인할 수 있게).
alter table public.sync_jobs add column if not exists pump_attempt integer not null default 0 check (pump_attempt >= 0);

-- claim 후보 조회 전용 부분 인덱스 — 진행 중 job만 대상이고 정렬은 결정론적이다.
create index if not exists sync_jobs_pump_claim_idx
  on public.sync_jobs (chain_index, created_at, id)
  where status in ('queued', 'running');

-- ── claim RPC ────────────────────────────────────────────────────
-- "후보 1개 선택 → 그 행에 lease 기록"을 한 문장의 원자 연산으로 묶는다.
-- PostgREST의 개별 UPDATE로는 후보 선택과 기록 사이가 벌어져 두 pump가 같은 job을 가져갈 수 있다.
-- for update skip locked이므로 동시 호출 중 승자 1개만 행을 받고 나머지는 즉시 빈 결과를 받는다.
create or replace function public.claim_sync_pump_lease(
  p_now timestamptz,
  p_lease_token_hash text,
  p_lease_seconds integer
)
returns setof public.sync_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_lease_token_hash is null or length(p_lease_token_hash) = 0 then
    raise exception 'lease token hash required';
  end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'lease seconds must be positive';
  end if;

  -- 처리 가능한 job: 진행 중(queued|running) ∧ lease가 없거나 이미 만료됨.
  -- 정렬은 chain_index → created_at → id로 고정한다 (같은 상태에서 항상 같은 job을 고른다).
  select id into v_id
  from public.sync_jobs
  where status in ('queued', 'running')
    and (lease_expires_at is null or lease_expires_at <= p_now)
  order by chain_index asc, created_at asc, id asc
  limit 1
  for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
  update public.sync_jobs
  set status = 'running',
      lease_token_hash = p_lease_token_hash,
      lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
      last_tick_at = p_now,
      pump_attempt = pump_attempt + 1,
      finished_at = null
  where id = v_id
  returning *;
end;
$$;

-- ── 롤백 범위 ────────────────────────────────────────────────────
-- 이 migration은 추가만 한다 (신규 컬럼 3개 · 인덱스 1개 · 함수 1개). 기존 컬럼·데이터·제약을
-- 바꾸거나 지우지 않으므로 되돌려도 기존 job 기록은 그대로 남는다.
--
-- 되돌리려면 (Cron을 먼저 비활성화한 뒤 실행한다 — 진행 중 배치가 없어야 한다):
--   drop function if exists public.claim_sync_pump_lease(timestamptz, text, integer);
--   drop index if exists public.sync_jobs_pump_claim_idx;
--   alter table public.sync_jobs drop column if exists pump_attempt;
--   alter table public.sync_jobs drop column if exists lease_expires_at;
--   alter table public.sync_jobs drop column if exists lease_token_hash;
--
-- 주의: 되돌리면 pump가 job을 claim할 수 없으므로 자동 처리가 멈춘다 (데이터 손실은 없다).
-- 이전 self-chain 구조로 돌아가려면 애플리케이션 코드도 함께 되돌려야 하며,
-- 그 구조는 Vercel 508 재귀 차단에 다시 걸린다.

-- 서버(service role) 전용 — 공개 키로는 호출할 수 없다.
revoke all on function public.claim_sync_pump_lease(timestamptz, text, integer) from public;
revoke all on function public.claim_sync_pump_lease(timestamptz, text, integer) from anon;
revoke all on function public.claim_sync_pump_lease(timestamptz, text, integer) from authenticated;
grant execute on function public.claim_sync_pump_lease(timestamptz, text, integer) to service_role;
