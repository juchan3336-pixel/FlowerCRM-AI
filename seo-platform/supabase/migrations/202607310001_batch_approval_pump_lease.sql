-- 승인 Batch 자동 실행을 HTTP self-chain에서 Cron pull(pump) 구조로 전환한다.
--
-- 왜: Vercel은 같은 함수의 HTTP 재귀 호출을 4회 초과에서 508 INFINITE_LOOP_DETECTED로 차단한다
-- (2026-07-30 동기화에서 실측). 승인 Batch는 item 1건당 self-fetch 1회이므로 승인 장소가 5곳이면
-- 5번째 발사에서 508이 난다. 게다가 발사한 쪽이 응답 상태를 보지 않아 508을 성공으로 삼키고,
-- 오류 표식이 없어 approval이 running으로 영구 정지한다. 승인 상한이 5곳이라 정확히 최대 규모에서 터진다.
--
-- 이 migration은 그 pull 구조에 필요한 실행 소유권(lease)만 추가한다.
-- 승인 상태 머신·item 상태 기계·비용 상한·스냅샷 보호는 전부 그대로다.
-- 기존 행 영향: 신규 컬럼 3개가 nullable 또는 default 0이라 기존 승인 1건은 무변경.

-- ── lease (실행 소유권) ──────────────────────────────────────────
-- 한 번에 한 pump만 한 approval의 item을 처리해야 한다. 그 소유권을 토큰 해시로 들고,
-- 승인 상태를 바꾸는 쓰기를 "내가 아직 소유자일 때만"으로 조건화한다.
alter table public.batch_approvals add column if not exists lease_token_hash text;
-- lease 만료 시각. 함수가 생성 도중 죽어도 이 시각이 지나면 다음 Cron이 같은 승인을 다시 가져간다.
alter table public.batch_approvals add column if not exists lease_expires_at timestamptz;
-- 이 승인이 pump에 claim된 횟수 (진단용 — 정체·재claim 반복을 눈으로 확인할 수 있게).
alter table public.batch_approvals add column if not exists pump_attempt integer not null default 0 check (pump_attempt >= 0);

-- claim 후보 조회 전용 부분 인덱스 — 실행 중 승인만 대상이고 정렬은 결정론적이다.
create index if not exists batch_approvals_pump_claim_idx
  on public.batch_approvals (activated_at, created_at, id)
  where status = 'running';

-- ── claim RPC ────────────────────────────────────────────────────
-- "후보 1개 선택 → 그 행에 lease 기록"을 한 문장의 원자 연산으로 묶는다.
-- for update skip locked이므로 동시 호출 중 승자 1개만 행을 받고 나머지는 즉시 빈 결과를 받는다.
--
-- claim 대상은 사용자가 직접 activate 해서 running이 되고 batch_run까지 연결된 승인뿐이다.
-- approved·queued는 절대 집지 않는다 — pump가 승인을 스스로 실행 상태로 올리면 승인 게이트가 무너지고
-- 곧바로 OpenAI 비용이 발생한다. 상태 전이는 지금처럼 사용자 activate 경로만 수행한다.
create or replace function public.claim_batch_pump_lease(
  p_now timestamptz,
  p_lease_token_hash text,
  p_lease_seconds integer
)
returns setof public.batch_approvals
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

  select id into v_id
  from public.batch_approvals
  where status = 'running'
    and batch_run_id is not null
    and (lease_expires_at is null or lease_expires_at <= p_now)
  order by activated_at asc nulls last, created_at asc, id asc
  limit 1
  for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
  update public.batch_approvals
  set lease_token_hash = p_lease_token_hash,
      lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
      pump_attempt = pump_attempt + 1
  where id = v_id
  returning *;
end;
$$;

-- ── 롤백 범위 ────────────────────────────────────────────────────
-- 이 migration은 추가만 한다 (신규 컬럼 3개 · 인덱스 1개 · 함수 1개). 기존 컬럼·데이터·제약을
-- 바꾸거나 지우지 않으므로 되돌려도 기존 승인·batch_runs·batch_run_items·batch_run_events는 그대로다.
--
-- 되돌리려면 (Cron을 먼저 비활성화한 뒤, 진행 중 승인이 없을 때 실행한다):
--   drop function if exists public.claim_batch_pump_lease(timestamptz, text, integer);
--   drop index if exists public.batch_approvals_pump_claim_idx;
--   alter table public.batch_approvals drop column if exists pump_attempt;
--   alter table public.batch_approvals drop column if exists lease_expires_at;
--   alter table public.batch_approvals drop column if exists lease_token_hash;
--
-- 주의: 되돌리면 pump가 승인을 claim할 수 없어 자동 생성이 멈춘다 (데이터 손실은 없다).
-- 이전 self-chain 구조로 돌아가려면 애플리케이션 코드도 함께 되돌려야 하며,
-- 그 구조는 승인 5곳에서 다시 508에 걸린다.

-- 서버(service role) 전용 — 공개 키로는 호출할 수 없다.
revoke all on function public.claim_batch_pump_lease(timestamptz, text, integer) from public;
revoke all on function public.claim_batch_pump_lease(timestamptz, text, integer) from anon;
revoke all on function public.claim_batch_pump_lease(timestamptz, text, integer) from authenticated;
grant execute on function public.claim_batch_pump_lease(timestamptz, text, integer) to service_role;
