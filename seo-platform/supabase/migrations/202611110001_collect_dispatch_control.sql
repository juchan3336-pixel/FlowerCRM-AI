-- Collect 외부 예약 dispatch — 제어 행, slot 기록, 그리고 판단을 내리는 세 RPC.
--
-- 구조만 만든다. 시크릿, 활성 cron, live 설정은 이 migration에 없다(operations/collect_dispatch_cron.sql
-- 을 사람이 단계별로 실행한다). 적용 직후 상태는 "꺼짐 + dry_run"이다.
--
-- 보낼지 말지는 전부 여기서 정한다. 세 RPC 모두 제어 행을 잠근 채로 판단하므로 동시에 들어온
-- 호출도 한 줄로 서고, 서버 코드는 RPC가 허락한 순간에만 다음 단계로 간다.

-- 1) 제어 행 (singleton). enabled=false이면 아무것도 보내지 않는다.
--    mode는 dispatch가 시트에 쓰는지를 정하는 유일한 값이다.
create table if not exists public.collect_dispatch_control (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  mode text not null default 'dry_run' check (mode in ('dry_run', 'live')),
  updated_at timestamptz not null default now()
);

insert into public.collect_dispatch_control (id) values (1) on conflict (id) do nothing;

-- 2) slot 기록. slot(UTC 00:45부터 90분 간격인 구간의 시작 시각)마다 한 행이고, 한 slot에서 dispatch는 최대 1회다.
--    status:
--      claimed       slot을 잡았다 (아직 아무것도 보내지 않음)
--      abandoned     claimed 상태로 2분 넘게 남아 정리됨 (아무것도 보내지 않음)
--      cancelled     보내기 직전에 꺼져 있어 취소됨 (아무것도 보내지 않음)
--      busy          진행·대기 중인 run이 있어 건너뜀
--      check_failed  run 상태를 확인하지 못해 건너뜀
--      out_of_time   보낼 시간이 남지 않아 건너뜀
--      dispatching   보내는 중 — 이 상태로 남은 행은 결과 불명과 같다
--      not_sent      보낼 준비까지 됐지만 시간이 없어 요청을 시작하지 않음 (보내지 않은 것이 확실)
--      sent          GitHub이 접수함
--      rejected      GitHub이 거절함 (보내지지 않은 것이 확실)
--      unknown       접수 여부를 알 수 없음 — 사람이 확인하고 풀 때까지 이후 시도를 막는다
--      resolved      사람이 확인하고 해제함
--    dispatch_id는 slot을 잡은 호출만 아는 값이다. 이후 모든 변경은 이 값이 맞아야 한다.
create table if not exists public.collect_dispatch_ledger (
  id bigint generated always as identity primary key,
  slot text not null unique,
  dispatch_id uuid not null,
  status text not null default 'claimed'
    check (status in ('claimed', 'abandoned', 'cancelled', 'busy', 'check_failed', 'out_of_time',
                      'dispatching', 'not_sent', 'sent', 'rejected', 'unknown', 'resolved')),
  mode text check (mode in ('dry_run', 'live')),
  http_status integer,
  run_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists collect_dispatch_ledger_status_idx on public.collect_dispatch_ledger (status);

-- 3) claim — slot을 잡는다.
--      disabled   꺼져 있다
--      blocked    끝나지 않은 다른 시도가 있다 (어느 slot이든): claimed·dispatching·unknown
--      duplicate  이 slot은 이미 기록이 있다
--      claimed    이 호출이 slot을 소유한다
--    claimed로 2분 넘게 남은 행은 먼저 abandoned로 정리한다. claimed는 "아직 아무것도 보내지
--    않았다"는 뜻이므로 정리해도 안전하고, 그 행의 원래 주인이 뒤늦게 깨어나도 prepare가
--    상태 조건에서 걸러낸다. dispatching·unknown은 절대 자동으로 풀지 않는다.
create or replace function public.claim_collect_dispatch_slot(p_slot text, p_dispatch_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_inserted integer;
begin
  select enabled into v_enabled from public.collect_dispatch_control where id = 1 for update;
  if v_enabled is distinct from true then
    return 'disabled';
  end if;

  update public.collect_dispatch_ledger
  set status = 'abandoned', updated_at = now()
  where status = 'claimed' and updated_at < now() - interval '2 minutes';

  if exists (select 1 from public.collect_dispatch_ledger where status in ('claimed', 'dispatching', 'unknown')) then
    return 'blocked';
  end if;

  insert into public.collect_dispatch_ledger (slot, dispatch_id)
  values (p_slot, p_dispatch_id)
  on conflict (slot) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    return 'duplicate';
  end if;
  return 'claimed';
end;
$$;

-- 4) prepare — 보내기 직전의 마지막 판단. 이 함수가 커밋된 뒤에만 dispatch가 나간다.
--      disabled        그 사이에 꺼졌다 (행을 cancelled로 정리한다)
--      lost            이 slot은 더 이상 이 dispatch id의 claimed 행이 아니다
--      dry_run | live  행을 dispatching으로 바꿨다. 돌려준 값이 이 dispatch의 mode다.
create or replace function public.prepare_collect_dispatch(p_slot text, p_dispatch_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_mode text;
  v_updated integer;
begin
  select enabled, mode into v_enabled, v_mode from public.collect_dispatch_control where id = 1 for update;

  if v_enabled is distinct from true then
    update public.collect_dispatch_ledger
    set status = 'cancelled', updated_at = now()
    where slot = p_slot and dispatch_id = p_dispatch_id and status = 'claimed';
    return 'disabled';
  end if;

  update public.collect_dispatch_ledger
  set status = 'dispatching', mode = v_mode, updated_at = now()
  where slot = p_slot and dispatch_id = p_dispatch_id and status = 'claimed';
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    return 'lost';
  end if;
  return v_mode;
end;
$$;

-- 5) finish — 결과 기록. slot·dispatch id·기대 상태가 모두 맞는 행 하나만 바꾼다.
--    허용되는 전이:  claimed → busy | check_failed | out_of_time
--                   dispatching → not_sent | sent | rejected | unknown
--    바뀐 행이 정확히 하나일 때만 true.
create or replace function public.finish_collect_dispatch(
  p_slot text,
  p_dispatch_id uuid,
  p_from_status text,
  p_status text,
  p_http_status integer,
  p_run_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if not (
    (p_from_status = 'claimed' and p_status in ('busy', 'check_failed', 'out_of_time'))
    or (p_from_status = 'dispatching' and p_status in ('not_sent', 'sent', 'rejected', 'unknown'))
  ) then
    return false;
  end if;

  update public.collect_dispatch_ledger
  set status = p_status, http_status = p_http_status, run_id = p_run_id, updated_at = now()
  where slot = p_slot and dispatch_id = p_dispatch_id and status = p_from_status;
  get diagnostics v_updated = row_count;

  return v_updated = 1;
end;
$$;

-- 6) 접근: 서버(service_role)만, 그것도 RPC를 통해서만.
--    GRANT는 기존 권한에 더할 뿐이다. 스키마의 기본 권한(default privileges)이 새 테이블에
--    쓰기 권한을 붙여 줬을 수 있으므로, 먼저 전부 회수하고 읽기만 다시 준다.
alter table public.collect_dispatch_control enable row level security;
alter table public.collect_dispatch_ledger enable row level security;
revoke all on table public.collect_dispatch_control from public, anon, authenticated, service_role;
revoke all on table public.collect_dispatch_ledger from public, anon, authenticated, service_role;
grant select on table public.collect_dispatch_control to service_role;
grant select on table public.collect_dispatch_ledger to service_role;

revoke all on function public.claim_collect_dispatch_slot(text, uuid) from public, anon, authenticated;
revoke all on function public.prepare_collect_dispatch(text, uuid) from public, anon, authenticated;
revoke all on function public.finish_collect_dispatch(text, uuid, text, text, integer, bigint) from public, anon, authenticated;
grant execute on function public.claim_collect_dispatch_slot(text, uuid) to service_role;
grant execute on function public.prepare_collect_dispatch(text, uuid) to service_role;
grant execute on function public.finish_collect_dispatch(text, uuid, text, text, integer, bigint) to service_role;
