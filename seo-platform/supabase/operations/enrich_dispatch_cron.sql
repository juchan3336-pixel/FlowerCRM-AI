-- Enrich 외부 예약 (Supabase Cron + pg_net → Vercel → GitHub workflow_dispatch).
--
-- 이 파일은 migration이 아니다. Supabase Dashboard SQL Editor에서 사람이 단계별로 실행한다.
-- 먼저 migrations/202611100003_enrich_dispatch_control.sql 이 적용돼 있어야 한다.
--
-- 왜 필요한가: GitHub의 schedule 트리거가 이 저장소에서 대부분 실행되지 않는다(2026-11-10 실측:
-- 90분 cron을 켠 뒤 5시간 반 동안 0회, Collect는 30분 cron인데 하루 3~4회). 수동 실행은 항상
-- 즉시 시작하므로, 정해진 시각에 DB 스케줄러가 대신 실행을 요청한다.
--
-- 보안:
--   · GitHub 토큰은 여기에 없다. Vercel Production 환경변수 ENRICH_GITHUB_TOKEN 에만 있다.
--   · 이 SQL이 다루는 비밀은 서명키 하나다. Vault에 넣고, 요청에는 서명키가 아니라 서명만 싣는다.
--     (pg_net 대기열의 요청 헤더는 DB 역할이 읽을 수 있으므로, 헤더에 비밀 원문을 싣지 않는다.)
--   · 서명은 5분 뒤 무효다.
--
-- 사용자 수동 작업 순서 (값은 채팅·저장소에 붙이지 않는다):
--   A. GitHub → Settings → Developer settings → Fine-grained tokens 에서 토큰 발급
--        Repository access: juchan3336-pixel/FlowerCRM-AI 만
--        Permissions: Actions = Read and write (Metadata = Read 는 자동). 그 외 전부 없음.
--        만료일을 정하고 달력에 적어 둔다.
--   B. 서명키 생성: 32자 이상 난수 (예: openssl rand -hex 32)
--   C. Vercel → flowercrm-seo → Settings → Environment Variables (Production 만)
--        ENRICH_GITHUB_TOKEN            = A의 토큰
--        ENRICH_DISPATCH_SIGNING_SECRET = B의 서명키
--      저장 후 Production 재배포.
--   D. 아래 1단계부터 실행.

-- ═══════════════════════════════════════════════════════════════════
-- 0단계. 확장과 시간대 확인
-- ═══════════════════════════════════════════════════════════════════
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;
create extension if not exists pgcrypto;

-- cron 표현식은 이 시간대로 해석된다. UTC(또는 GMT)여야 아래 일정이 의도대로 돈다.
show cron.timezone;

-- ═══════════════════════════════════════════════════════════════════
-- 1단계. Vault에 서명키 등록
--   · <SIGNING_SECRET>을 Vercel의 ENRICH_DISPATCH_SIGNING_SECRET 과 완전히 같은 값으로 바꿔 실행.
--   · 실행 후 SQL Editor에 남은 원문은 지운다.
-- ═══════════════════════════════════════════════════════════════════
select vault.create_secret('<SIGNING_SECRET>', 'enrich_dispatch_signing_secret', 'Enrich 외부 예약 요청 서명용');

-- 값을 교체할 때:
-- select vault.update_secret(
--   (select id from vault.secrets where name = 'enrich_dispatch_signing_secret'),
--   '<NEW_SIGNING_SECRET>'
-- );

-- 등록 확인 (복호화된 값은 조회하지 않는다):
select name, created_at, updated_at from vault.secrets where name = 'enrich_dispatch_signing_secret';

-- ═══════════════════════════════════════════════════════════════════
-- 2단계. 요청 함수
--   · 서명 대상: '<epoch초>.POST./api/enrich/dispatch.{}'  — 서버(lib/enrich-dispatch/policy.ts)와
--     글자 하나까지 같아야 한다. 본문은 항상 '{}' 이다.
--   · 반환값은 pg_net 요청 id (net._http_response 에서 응답을 찾을 때 쓴다).
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.request_enrich_dispatch()
returns bigint
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_secret text;
  v_timestamp text := floor(extract(epoch from clock_timestamp()))::bigint::text;
  v_body text := '{}';
  v_signature text;
  v_request_id bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'enrich_dispatch_signing_secret';
  if v_secret is null or length(v_secret) < 32 then
    raise exception 'enrich dispatch signing secret is missing or too short';
  end if;

  v_signature := encode(
    hmac(convert_to(v_timestamp || '.POST./api/enrich/dispatch.' || v_body, 'utf8'), convert_to(v_secret, 'utf8'), 'sha256'),
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

  return v_request_id;
end;
$$;

revoke all on function public.request_enrich_dispatch() from public;
revoke all on function public.request_enrich_dispatch() from anon, authenticated;

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

select jobid, jobname, schedule, active from cron.job where jobname like 'enrich-dispatch-%' order by jobname;

-- command에 비밀 원문이 없는지 확인 (함수 호출만 있어야 한다):
select jobname, command from cron.job where jobname like 'enrich-dispatch-%';

-- ═══════════════════════════════════════════════════════════════════
-- 4단계. 꺼진 상태에서 연결 확인 (아무것도 dispatch되지 않는다)
--   · 제어 행이 enabled=false 이므로 기대 응답은 200 {"result":"noop","reason":"disabled"} 이다.
--   · 401 이면 서명키가 Vercel과 다르거나 배포에 반영되지 않았다. 409 이면 Vercel 환경변수 누락.
-- ═══════════════════════════════════════════════════════════════════
select enabled, mode, updated_at from public.enrich_dispatch_control;

select public.request_enrich_dispatch() as request_id;

-- 몇 초 뒤, 위 request_id 로 응답 확인:
select id, status_code, content::text as body, created
from net._http_response
order by created desc
limit 5;

-- ═══════════════════════════════════════════════════════════════════
-- 5단계. dry-run 으로 한 번 dispatch (시트에 쓰지 않는다)
--   · 기대 응답: 202 {"result":"sent","mode":"dry_run",...}
--   · GitHub Actions 에 workflow_dispatch run 이 하나 생기고 로그에 "Dry run: true" 가 보여야 한다.
--   · 바로 한 번 더 호출하면 200 {"result":"noop","reason":"duplicate-slot"} 이어야 한다.
-- ═══════════════════════════════════════════════════════════════════
update public.enrich_dispatch_control set enabled = true, mode = 'dry_run', updated_at = now() where id = 1;

select public.request_enrich_dispatch() as request_id;

select slot, status, http_status, run_id, dispatch_id, created_at, updated_at
from public.enrich_dispatch_ledger
order by created_at desc
limit 10;

-- ═══════════════════════════════════════════════════════════════════
-- 6단계. live 전환 (시트에 쓴다) — dry-run 확인이 끝난 뒤에만
-- ═══════════════════════════════════════════════════════════════════
update public.enrich_dispatch_control set enabled = true, mode = 'live', updated_at = now() where id = 1;

-- ═══════════════════════════════════════════════════════════════════
-- 7단계. Cron 켜기
-- ═══════════════════════════════════════════════════════════════════
select cron.alter_job(jobid, active := true) from cron.job where jobname in ('enrich-dispatch-a', 'enrich-dispatch-b');

select jobid, jobname, schedule, active from cron.job where jobname like 'enrich-dispatch-%' order by jobname;

-- ═══════════════════════════════════════════════════════════════════
-- 점검. 어느 단계에서 멈췄는지 구분해서 본다
--   cron이 돌았나 → 요청이 접수됐나 → endpoint가 뭐라고 답했나 → slot이 어떻게 끝났나
--   (그 뒤 run 의 성공 여부와 시트 쓰기는 GitHub Actions 와 Discord 알림에서 본다.)
-- ═══════════════════════════════════════════════════════════════════
select j.jobname, d.status, d.return_message, d.start_time
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname like 'enrich-dispatch-%'
order by d.start_time desc
limit 20;

select id, status_code, content::text as body, created
from net._http_response
order by created desc
limit 20;

-- 하루 16개 slot 이 sent / busy / duplicate 없이 빠짐없이 설명되는지:
select slot, status, http_status, run_id, updated_at
from public.enrich_dispatch_ledger
order by slot desc
limit 32;

-- ═══════════════════════════════════════════════════════════════════
-- 결과 불명(unknown / dispatching 으로 남은 행) 해제
--   · 이런 행이 하나라도 있으면 이후 모든 slot 이 blocked-unknown 으로 건너뛰어진다.
--   · 먼저 GitHub Actions 에서 그 시각에 run 이 실제로 생겼는지 확인한다
--     (run 이름에 dispatch_id 가 표시된다). 확인한 뒤에만 해제한다.
-- ═══════════════════════════════════════════════════════════════════
select slot, status, dispatch_id, http_status, updated_at
from public.enrich_dispatch_ledger
where status in ('dispatching', 'unknown');

-- update public.enrich_dispatch_ledger
-- set status = 'resolved', updated_at = now()
-- where slot = '<확인한 slot>' and status in ('dispatching', 'unknown');

-- ═══════════════════════════════════════════════════════════════════
-- 멈추기
--   · 제어 행을 먼저 끈다 — 이미 대기열에 들어간 요청도 endpoint에서 noop이 된다.
--   · 이미 GitHub 에서 시작됐거나 대기 중인 run 은 이것으로 취소되지 않는다(Actions 화면에서 취소).
--     진행 중인 run 을 강제 취소하면 그 실행분은 저장되지 않는다.
-- ═══════════════════════════════════════════════════════════════════
-- update public.enrich_dispatch_control set enabled = false, updated_at = now() where id = 1;
-- select cron.alter_job(jobid, active := false) from cron.job where jobname in ('enrich-dispatch-a', 'enrich-dispatch-b');

-- 완전히 걷어낼 때:
-- select cron.unschedule('enrich-dispatch-a');
-- select cron.unschedule('enrich-dispatch-b');
-- drop function if exists public.request_enrich_dispatch();
-- delete from vault.secrets where name = 'enrich_dispatch_signing_secret';
-- 그리고 GitHub 에서 토큰을 폐기하고 Vercel 환경변수 두 개를 지운다.
