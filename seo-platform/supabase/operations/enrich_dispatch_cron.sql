-- Enrich 외부 예약 (Supabase Cron + pg_net → Vercel → GitHub workflow_dispatch).
--
-- 이 파일은 migration이 아니다. Supabase Dashboard SQL Editor에서 사람이 0단계부터 순서대로,
-- 한 단계씩 결과를 확인하며 실행한다. 여러 단계를 한꺼번에 실행하지 않는다.
--
-- 왜 필요한가: GitHub의 schedule 트리거가 이 저장소에서 대부분 실행되지 않는다(2026-11-10 실측:
-- 90분 cron을 켠 뒤 5시간 반 동안 0회, Collect는 30분 cron인데 하루 3~4회). 수동 실행은 항상
-- 즉시 시작하므로, 정해진 시각에 DB 스케줄러가 대신 실행을 요청한다.
--
-- 보안:
--   · GitHub 토큰은 여기에 없다. Vercel Production 환경변수 ENRICH_GITHUB_TOKEN 에만 있다.
--   · 이 SQL이 다루는 비밀은 서명키 하나다. Vault에 넣고, 요청에는 서명키가 아니라 서명만 싣는다.
--     (pg_net 대기열의 요청 헤더는 DB 역할이 읽을 수 있으므로, 헤더에 비밀 원문을 싣지 않는다.)
--   · 서명은 5분 뒤 무효이고, 그 안에 다시 보내져도 같은 slot으로 처리되어 한 번만 동작한다.
--
-- 시작하기 전에 끝나 있어야 하는 것 (값은 채팅·저장소에 붙이지 않는다):
--   A. 이 변경이 main에 merge됐고, .github/workflows/enrich.yml 에 schedule/cron 이 없다.
--      (GitHub 예약과 이 예약이 동시에 켜져 있으면 같은 행을 두 번 처리할 수 있다.)
--   B. migrations/202611100003_enrich_dispatch_control.sql 이 적용됐다.
--   C. GitHub → Settings → Developer settings → Fine-grained tokens 에서 토큰을 발급했다.
--        Repository access: juchan3336-pixel/FlowerCRM-AI 만
--        Permissions: Actions = Read and write (Metadata = Read 는 자동). 그 외 전부 없음.
--        만료일을 정하고 달력에 적어 둔다. (이 권한은 enrich 한 워크플로로 좁혀지지 않는다 —
--        이 저장소의 모든 워크플로를 실행·취소할 수 있는 토큰이다.)
--   D. 서명키를 만들었다: 32자 이상 난수 (예: openssl rand -hex 32).
--   E. Vercel → flowercrm-seo → Settings → Environment Variables (Production 만) 에 등록했다.
--        ENRICH_GITHUB_TOKEN            = C의 토큰
--        ENRICH_DISPATCH_SIGNING_SECRET = D의 서명키
--   F. 그 뒤에 Production을 다시 배포했고, 배포된 커밋이 A의 merge 커밋(또는 그 이후)이다.

-- ═══════════════════════════════════════════════════════════════════
-- 0단계. 확장, 시간대, 선행 조건 확인
-- ═══════════════════════════════════════════════════════════════════
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;
create extension if not exists pgcrypto with schema extensions;

-- cron 표현식은 이 시간대로 해석된다. UTC(또는 GMT)여야 3단계의 일정이 의도대로 돈다.
show cron.timezone;

-- migration이 적용됐는지: 한 행이 나오고 enabled=false, mode=dry_run 이어야 한다.
select enabled, mode, updated_at from public.enrich_dispatch_control;

-- 서버 역할이 두 테이블을 직접 쓸 수 없는지: 여덟 칸 모두 false 여야 한다. true 가 있으면 중단.
select t.name as table_name,
       has_table_privilege('service_role', 'public.' || t.name, 'INSERT') as can_insert,
       has_table_privilege('service_role', 'public.' || t.name, 'UPDATE') as can_update,
       has_table_privilege('service_role', 'public.' || t.name, 'DELETE') as can_delete,
       has_table_privilege('service_role', 'public.' || t.name, 'TRUNCATE') as can_truncate
from (values ('enrich_dispatch_control'), ('enrich_dispatch_ledger')) as t(name);

-- hmac 함수가 어느 스키마에 있는지 (extensions 여야 2단계 함수가 동작한다):
select n.nspname as schema, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'hmac';

-- ═══════════════════════════════════════════════════════════════════
-- 1단계. Vault에 서명키 등록
--   · <SIGNING_SECRET>을 Vercel의 ENRICH_DISPATCH_SIGNING_SECRET 과 완전히 같은 값으로 바꿔 실행.
--   · 실행 후 SQL Editor에 남은 원문은 지운다.
-- ═══════════════════════════════════════════════════════════════════
select vault.create_secret('<SIGNING_SECRET>', 'enrich_dispatch_signing_secret', 'Enrich 외부 예약 요청 서명용');

-- 값을 교체할 때 (Vercel 쪽도 같은 값으로 바꾸고 재배포해야 한다):
-- select vault.update_secret(
--   (select id from vault.secrets where name = 'enrich_dispatch_signing_secret'),
--   '<NEW_SIGNING_SECRET>'
-- );

-- 등록 확인 (복호화된 값은 조회하지 않는다):
select name, created_at, updated_at from vault.secrets where name = 'enrich_dispatch_signing_secret';

-- ═══════════════════════════════════════════════════════════════════
-- 2단계. 요청 기록 테이블과 요청 함수 (한 트랜잭션)
--   · 서명 대상: '<epoch초>.POST./api/enrich/dispatch.{}'  — 서버(lib/enrich-dispatch/policy.ts)와
--     글자 하나까지 같아야 한다. 본문은 항상 '{}' 이다.
--   · 요청마다 pg_net 요청 id와 시각을 남긴다. 응답은 이 id로만 찾는다 — 같은 DB의 다른 pump
--     응답과 섞어 보지 않는다. endpoint에 닿지 못했거나 인증에 실패한 요청도 여기에는 남는다.
--   · 함수는 신뢰하는 스키마만 이름으로 직접 부른다(search_path 비움).
--   · 실행 권한은 만들자마자 회수하고 cron을 돌리는 역할(postgres)에만 준다.
-- ═══════════════════════════════════════════════════════════════════
begin;

create table if not exists public.enrich_dispatch_requests (
  id bigint generated always as identity primary key,
  net_request_id bigint not null,
  signed_at timestamptz not null,
  requested_at timestamptz not null default now()
);
alter table public.enrich_dispatch_requests enable row level security;
revoke all on table public.enrich_dispatch_requests from public, anon, authenticated;

create or replace function public.request_enrich_dispatch()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_now timestamptz := clock_timestamp();
  v_timestamp text := floor(extract(epoch from v_now))::bigint::text;
  v_body text := '{}';
  v_signature text;
  v_request_id bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'enrich_dispatch_signing_secret';
  if v_secret is null or length(v_secret) < 32 then
    raise exception 'enrich dispatch signing secret is missing or too short';
  end if;

  v_signature := encode(
    extensions.hmac(
      convert_to(v_timestamp || '.POST./api/enrich/dispatch.' || v_body, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );

  select net.http_post(
    url := 'https://flowercrm-seo.vercel.app/api/enrich/dispatch',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-enrich-dispatch-timestamp', v_timestamp,
      'x-enrich-dispatch-signature', v_signature
    ),
    body := v_body::jsonb,
    timeout_milliseconds := 30000
  ) into v_request_id;

  insert into public.enrich_dispatch_requests (net_request_id, signed_at) values (v_request_id, v_now);
  return v_request_id;
end;
$$;

revoke all on function public.request_enrich_dispatch() from public, anon, authenticated, service_role;
grant execute on function public.request_enrich_dispatch() to postgres;

commit;

-- 권한이 의도대로인지 (postgres 와 소유자만 보여야 한다. anon/authenticated/PUBLIC 이 있으면 중단):
select p.proname, p.prosecdef as security_definer, r.rolname as owner, p.proacl
from pg_proc p join pg_roles r on r.oid = p.proowner
where p.proname = 'request_enrich_dispatch';

-- ═══════════════════════════════════════════════════════════════════
-- 3단계. Cron 등록 — 등록하되 꺼 둔 채로 끝낸다
--   · 90분 간격은 cron 한 줄로 못 쓰므로 두 개로 나눈다 (UTC).
--   · 한 트랜잭션 안에서 등록과 비활성화를 같이 한다. 켜는 것은 7단계다.
-- ═══════════════════════════════════════════════════════════════════
begin;
select cron.schedule('enrich-dispatch-a', '0 0,3,6,9,12,15,18,21 * * *', $CRON$ select public.request_enrich_dispatch(); $CRON$);
select cron.schedule('enrich-dispatch-b', '30 1,4,7,10,13,16,19,22 * * *', $CRON$ select public.request_enrich_dispatch(); $CRON$);
select cron.alter_job(jobid, active := false) from cron.job where jobname in ('enrich-dispatch-a', 'enrich-dispatch-b');
commit;

-- 둘 다 active=false 여야 한다. username 은 2단계에서 실행 권한을 준 역할(postgres)이어야 한다.
select jobid, jobname, schedule, active, username from cron.job where jobname like 'enrich-dispatch-%' order by jobname;

-- command에 비밀 원문이 없는지 확인 (함수 호출만 있어야 한다):
select jobname, command from cron.job where jobname like 'enrich-dispatch-%';

-- ═══════════════════════════════════════════════════════════════════
-- 4단계. 꺼진 상태에서 연결 확인 — 아무것도 dispatch되지 않는다
--   · 먼저 끈다(이 파일을 다시 실행하는 경우에도 이 단계는 항상 꺼진 상태에서 시작한다).
--   · 기대 응답: 200 {"result":"noop","reason":"disabled"}
--       401 → 서명키가 Vercel과 다르거나, 환경변수를 넣은 뒤 재배포하지 않았다.
--       409 missing-env → Vercel 환경변수 누락.   404 → 이 변경이 아직 배포되지 않았다.
--   · 이 200 은 "DB가 만든 서명을 서버가 받아들였다"는 실측이다. 이것 없이는 다음 단계로 가지 않는다.
-- ═══════════════════════════════════════════════════════════════════
update public.enrich_dispatch_control set enabled = false, mode = 'dry_run', updated_at = now() where id = 1;
select enabled, mode from public.enrich_dispatch_control;   -- false / dry_run 이어야 한다

select public.request_enrich_dispatch() as request_id;

-- 10초쯤 뒤, 방금 받은 request_id 로만 응답을 본다 (<REQUEST_ID>를 그 숫자로 바꾼다):
select r.id, r.status_code, r.content::text as body, r.timed_out, r.error_msg, r.created
from net._http_response r
where r.id = <REQUEST_ID>;

-- 이 시험 호출로 새 기록이 생기지 않았어야 한다. 시험 호출 이후에 만들어진 행이 0개인지 본다
-- (이전 실행의 기록이 있어도 오판하지 않도록, 방금 요청한 시각 이후만 센다):
select count(*) as rows_created_by_this_probe
from public.enrich_dispatch_ledger
where created_at >= (select max(requested_at) from public.enrich_dispatch_requests);

-- ═══════════════════════════════════════════════════════════════════
-- 5단계. dry-run 으로 한 번만 dispatch — 시트에 쓰지 않는다
--   · 5A → 5B → 5C → 5D 를 반드시 따로따로 실행한다. 한꺼번에 실행하지 않는다.
--     (pg_net 요청은 그 SQL 실행이 끝나 커밋된 뒤에 출발한다. 켜기·요청·끄기를 한 번에 실행하면
--      요청이 출발할 때는 이미 꺼져 있어서 아무것도 dispatch되지 않는다.)
-- ═══════════════════════════════════════════════════════════════════
-- 5A. 켜고 한 번 요청한다. 이 두 줄만 실행하고 끝낸다.
update public.enrich_dispatch_control set enabled = true, mode = 'dry_run', updated_at = now() where id = 1;
select public.request_enrich_dispatch() as request_id;

-- 5B. 30초쯤 뒤, 5A에서 받은 request_id 로 응답을 본다. 기대: 202 {"result":"sent","mode":"dry_run",...}
select r.id, r.status_code, r.content::text as body, r.timed_out, r.error_msg, r.created
from net._http_response r
where r.id = <REQUEST_ID>;

--     기록: status=sent, mode=dry_run 인 행 하나가 새로 생겼어야 한다.
select slot, status, mode, http_status, run_id, dispatch_id, created_at, updated_at
from public.enrich_dispatch_ledger
order by created_at desc
limit 5;

-- 5C. 응답과 기록을 확인한 뒤에 끈다. (5B를 확인하기 전에 끄면 요청이 꺼진 상태를 만날 수 있다.)
update public.enrich_dispatch_control set enabled = false, updated_at = now() where id = 1;

-- 5D. GitHub Actions 에서 확인한다. 전부 맞아야 다음으로 간다:
--   · 이름이 "Enrich <dispatch_id>" 인 run 이 하나 생겼고, 5B 행의 dispatch_id 와 같다.
--   · main 의 최신 커밋으로 돌았고, 로그에 "Dry run: true", "Limit: 50" 이 보인다.
--   · run 이 끝났고, 시트(기업DB·SYSTEM·LOG)에 변화가 없다.

-- ═══════════════════════════════════════════════════════════════════
-- 5E. 동시 호출 검증 — 6단계 전에 한 번. cron 은 아직 꺼져 있어야 한다(3단계 확인).
--   · SQL Editor 탭을 두 개 연다. 아래 순서를 지킨다. 시험용 slot 이름은 실제 slot 과 겹치지 않는다.
--   · 시험하는 동안만 켠다(dry_run). 끝나면 반드시 끄고 시험 행을 지운다.
-- ═══════════════════════════════════════════════════════════════════
-- [탭 1] 준비: 켜기
update public.enrich_dispatch_control set enabled = true, mode = 'dry_run', updated_at = now() where id = 1;

-- [탭 1] 아래 네 줄을 한 번에 선택해서 실행한다. slot 을 잡은 채 20초 동안 트랜잭션을 열어 둔다.
--        (SQL Editor 는 실행할 때마다 연결이 달라질 수 있어서, begin 과 commit 을 따로 실행하면
--         잠금이 유지되지 않는다. 그래서 한 번의 실행 안에 묶는다.)
--        기대: 20초 뒤 끝나고, claim 결과는 claimed
begin;
select public.claim_enrich_dispatch_slot('test-concurrency-a', '00000000-0000-4000-8000-00000000000a');
select pg_sleep(20);
commit;

-- [탭 2] 탭 1이 도는 20초 안에 실행한다. 기대: 바로 끝나지 않고 탭 1이 끝날 때까지 기다렸다가
--        blocked 를 돌려준다 (탭 1이 제어 행을 잠그고 있었고, 풀린 뒤에는 a 가 열려 있기 때문이다).
--        바로 끝났다면 탭 1보다 늦게 실행한 것이다 — 아래 정리를 하고 처음부터 다시 한다.
select public.claim_enrich_dispatch_slot('test-concurrency-b', '00000000-0000-4000-8000-00000000000b');

-- 여기부터 정리까지는 2분 안에 끝낸다 (2분이 지나면 claimed 행이 abandoned 로 정리돼 기대값이 달라진다).
-- [탭 1] 같은 slot 을 다른 id 로 다시: 기대 blocked (a 가 아직 claimed 로 열려 있다)
select public.claim_enrich_dispatch_slot('test-concurrency-a', '00000000-0000-4000-8000-00000000000c');

-- [탭 1] 남의 id 로는 준비도 기록도 안 된다: 기대 lost, 그리고 false
select public.prepare_enrich_dispatch('test-concurrency-a', '00000000-0000-4000-8000-00000000000c');
select public.finish_enrich_dispatch('test-concurrency-a', '00000000-0000-4000-8000-00000000000c', 'claimed', 'busy', null, null);

-- [탭 1] 끄고 나서 자기 id 로 준비: 기대 disabled, 그리고 그 행의 status 가 cancelled
update public.enrich_dispatch_control set enabled = false, updated_at = now() where id = 1;
select public.prepare_enrich_dispatch('test-concurrency-a', '00000000-0000-4000-8000-00000000000a');
select slot, status from public.enrich_dispatch_ledger where slot like 'test-concurrency-%';

-- [탭 1] 정리: 시험 행을 지우고 꺼진 상태인지 확인한다 (0행, 그리고 false / dry_run).
delete from public.enrich_dispatch_ledger where slot like 'test-concurrency-%';
select slot from public.enrich_dispatch_ledger where slot like 'test-concurrency-%';
select enabled, mode from public.enrich_dispatch_control;

-- ═══════════════════════════════════════════════════════════════════
-- 6단계. live 전환 — 여기서부터 시트에 쓴다. 5단계 확인이 끝난 뒤, 별도로 결정하고 실행한다.
--   · enabled=true + live 가 되는 순간부터는, cron 이 아직 꺼져 있어도 서명된 요청 하나
--     (수동 호출, 또는 대기열에 남아 있던 요청)가 실제 쓰기 실행을 시작시킨다.
-- ═══════════════════════════════════════════════════════════════════
update public.enrich_dispatch_control set enabled = true, mode = 'live', updated_at = now() where id = 1;

-- ═══════════════════════════════════════════════════════════════════
-- 7단계. Cron 켜기
-- ═══════════════════════════════════════════════════════════════════
select cron.alter_job(jobid, active := true) from cron.job where jobname in ('enrich-dispatch-a', 'enrich-dispatch-b');

select jobid, jobname, schedule, active from cron.job where jobname like 'enrich-dispatch-%' order by jobname;

-- ═══════════════════════════════════════════════════════════════════
-- 점검. 어느 단계에서 멈췄는지 구분해서 본다
--   cron이 돌았나 → 요청이 나갔나 → endpoint가 뭐라고 답했나 → slot이 어떻게 끝났나
--   (그 뒤 run 의 성공 여부와 시트 쓰기는 GitHub Actions 와 Discord 알림에서 본다.)
--   자동 경보는 없다. 켠 뒤 첫 이틀은 예약 시각마다 아래를 사람이 확인한다.
-- ═══════════════════════════════════════════════════════════════════
-- (1) cron 실행 이력
select j.jobname, d.status, d.return_message, d.start_time
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname like 'enrich-dispatch-%'
order by d.start_time desc
limit 20;

-- (2) 요청과 그 응답 (Enrich 요청만. 응답이 없는 행 = endpoint에 닿지 못했거나 응답이 이미 지워짐)
select q.requested_at, q.net_request_id, r.status_code, r.content::text as body, r.timed_out, r.error_msg
from public.enrich_dispatch_requests q
left join net._http_response r on r.id = q.net_request_id
order by q.requested_at desc
limit 20;

-- (3) slot 기록: 하루 16개 slot 이 sent / busy / 그 밖의 사유로 빠짐없이 설명되는지
select slot, status, mode, http_status, run_id, dispatch_id, updated_at
from public.enrich_dispatch_ledger
order by slot desc
limit 32;

-- ═══════════════════════════════════════════════════════════════════
-- 결과 불명 해제 (status 가 dispatching 또는 unknown 으로 남은 행)
--   · 이런 행이 하나라도 있으면 이후 모든 시도가 blocked 로 건너뛰어진다. 의도된 동작이다.
--   · 순서를 지킨다:
--       1) 먼저 끈다 (아래 "멈추기"의 첫 줄).
--       2) 1분 기다린다 (진행 중이던 호출이 끝나도록).
--       3) GitHub Actions 에서 이름이 "Enrich <그 행의 dispatch_id>" 인 run 이 있는지 찾는다.
--          있으면 그 run 이 끝날 때까지 기다린다.
--          없다고 해서 도착하지 않았다고 단정하지 않는다 — 목록에 늦게 나타날 수 있다.
--          몇 분 간격으로 다시 찾아보고, 그래도 없으면 "보이지 않지만 뒤늦게 시작될 수 있다"는
--          위험을 감수하고 푸는 것임을 알고 결정한다. 확신이 없으면 막힌 채로 둔다.
--       4) 확인한 그 행 하나만 해제하고, 무엇을 보고(또는 어떤 판단으로) 해제했는지 적어 둔다.
--       5) 다시 켠다.
-- ═══════════════════════════════════════════════════════════════════
select slot, status, mode, dispatch_id, http_status, updated_at
from public.enrich_dispatch_ledger
where status in ('dispatching', 'unknown');

-- update public.enrich_dispatch_ledger
-- set status = 'resolved', updated_at = now()
-- where slot = '<확인한 slot>' and dispatch_id = '<그 행의 dispatch_id>' and status in ('dispatching', 'unknown');

-- ═══════════════════════════════════════════════════════════════════
-- 멈추기
--   · 제어 행을 먼저 끈다. 그 뒤로는 서버가 dispatch 직전에 다시 확인하므로, 이미 대기열에
--     들어간 요청도 보내지 않는다. (끄는 순간 이미 그 확인을 통과한 요청 하나는 나갈 수 있다.)
--   · 이미 GitHub 에서 시작됐거나 대기 중인 run 은 이것으로 멈추지 않는다. Actions 화면에서
--     직접 취소한다. 진행 중인 run 을 강제 취소하면 그 실행분이 저장되지 않을 수 있고,
--     취소 시점이 마지막 저장 단계라면 기업DB·LOG·SYSTEM 중 일부만 쓰였을 수도 있다.
-- ═══════════════════════════════════════════════════════════════════
-- update public.enrich_dispatch_control set enabled = false, updated_at = now() where id = 1;
-- select cron.alter_job(jobid, active := false) from cron.job where jobname in ('enrich-dispatch-a', 'enrich-dispatch-b');

-- 완전히 걷어낼 때 (위 두 줄을 먼저 실행한 뒤):
-- select cron.unschedule('enrich-dispatch-a');
-- select cron.unschedule('enrich-dispatch-b');
-- drop function if exists public.request_enrich_dispatch();
-- delete from vault.secrets where name = 'enrich_dispatch_signing_secret';
-- 그리고 GitHub 에서 토큰을 폐기하고 Vercel 환경변수 두 개를 지운다.
-- GitHub 예약(cron)을 되살리는 것은 이 예약을 완전히 끈 뒤, 별도로 결정한다.
