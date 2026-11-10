-- Enrich 외부 예약 dispatch — 제어 행과 slot 기록.
--
-- 구조만 만든다. 시크릿, 활성 cron, live 설정은 이 migration에 없다(operations/enrich_dispatch_cron.sql
-- 을 사람이 단계별로 실행한다). 적용 직후 상태는 "꺼짐 + dry_run"이다.

-- 1) 제어 행 (singleton). enabled=false이면 endpoint는 아무것도 하지 않는다.
--    mode는 dispatch가 시트에 쓰는지를 정하는 유일한 값이다.
create table if not exists public.enrich_dispatch_control (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  mode text not null default 'dry_run' check (mode in ('dry_run', 'live')),
  updated_at timestamptz not null default now()
);

insert into public.enrich_dispatch_control (id) values (1) on conflict (id) do nothing;

-- 2) slot 기록. slot(UTC 90분 구간의 시작 시각)마다 한 행이고, 한 slot에서 dispatch는 최대 1회다.
--    status:
--      claimed       slot을 잡았다 (아직 아무것도 보내지 않음)
--      busy          진행·대기 중인 run이 있어 건너뜀
--      check_failed  run 상태를 확인하지 못해 건너뜀
--      dispatching   보내는 중 — 이 상태로 남은 행은 결과 불명과 같다
--      sent          GitHub이 접수함
--      rejected      GitHub이 거절함 (보내지지 않은 것이 확실)
--      unknown       접수 여부를 알 수 없음 — 사람이 확인하고 풀 때까지 이후 slot을 막는다
--      resolved      사람이 확인하고 해제함
create table if not exists public.enrich_dispatch_ledger (
  id bigint generated always as identity primary key,
  slot text not null unique,
  dispatch_id uuid not null,
  status text not null default 'claimed'
    check (status in ('claimed', 'busy', 'check_failed', 'dispatching', 'sent', 'rejected', 'unknown', 'resolved')),
  http_status integer,
  run_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists enrich_dispatch_ledger_status_idx on public.enrich_dispatch_ledger (status);

-- 3) slot claim. 제어 행을 잠가 동시 호출을 한 줄로 세운 뒤:
--      - 결과를 모르는 dispatch(dispatching/unknown)가 하나라도 있으면 blocked_unknown
--      - 이 slot이 이미 있으면 duplicate
--      - 아니면 행을 만들고 claimed
--    같은 slot을 두 호출이 동시에 잡으려 해도 claimed는 한쪽만 받는다.
create or replace function public.claim_enrich_dispatch_slot(p_slot text, p_dispatch_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
begin
  perform 1 from public.enrich_dispatch_control where id = 1 for update;

  if exists (select 1 from public.enrich_dispatch_ledger where status in ('dispatching', 'unknown')) then
    return 'blocked_unknown';
  end if;

  insert into public.enrich_dispatch_ledger (slot, dispatch_id)
  values (p_slot, p_dispatch_id)
  on conflict (slot) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    return 'duplicate';
  end if;
  return 'claimed';
end;
$$;

-- 4) 접근: 서버(service_role)만. 브라우저에서 오는 역할은 읽지도 쓰지도 못한다.
alter table public.enrich_dispatch_control enable row level security;
alter table public.enrich_dispatch_ledger enable row level security;
revoke all on table public.enrich_dispatch_control from anon, authenticated;
revoke all on table public.enrich_dispatch_ledger from anon, authenticated;
grant select on table public.enrich_dispatch_control to service_role;
grant select, insert, update on table public.enrich_dispatch_ledger to service_role;

revoke all on function public.claim_enrich_dispatch_slot(text, uuid) from public;
revoke all on function public.claim_enrich_dispatch_slot(text, uuid) from anon, authenticated;
grant execute on function public.claim_enrich_dispatch_slot(text, uuid) to service_role;
