-- 자동 연속 동기화 pump 예약 작업 (Supabase Cron + pg_net).
--
-- 이 파일은 migration이 아니다. Supabase Dashboard SQL Editor에서 사람이 단계별로 실행한다.
-- 각 단계는 독립적이며, 필요한 단계만 골라 실행할 수 있다.
--
-- 왜 Cron인가: Vercel은 같은 함수의 HTTP 재귀 호출을 4회 초과에서 508 INFINITE_LOOP_DETECTED로
-- 차단한다. 그래서 다음 배치를 "함수가 자기를 호출"해서 잇지 않고, DB 스케줄러가 pump를 다시 부른다.
-- 호출자가 외부(Postgres)이므로 재귀 깊이는 항상 1이다.
--
-- 보안: pump 시크릿을 이 SQL에 평문으로 남기지 않는다. Vault에 넣고 실행 시점에만 참조한다.
-- cron.job 테이블의 command에도 시크릿 원문이 아니라 vault 조회식만 저장된다.

-- ════════════════════════════════════════════════════════════════
-- 0단계. 확장 확인 (없으면 활성화)
-- ════════════════════════════════════════════════════════════════
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- ════════════════════════════════════════════════════════════════
-- 1단계. Vault에 pump 시크릿 등록
--   · <PUMP_SECRET>을 Vercel 환경변수 SYNC_PUMP_SECRET과 완전히 같은 값으로 바꿔 실행한다.
--   · 값은 임의의 긴 난수 문자열을 쓴다 (예: openssl rand -base64 32).
--   · 이미 등록돼 있으면 update 쪽만 실행한다.
-- ════════════════════════════════════════════════════════════════
select vault.create_secret('<PUMP_SECRET>', 'sync_pump_secret', '자동 연속 동기화 pump endpoint 인증용');

-- 값을 교체할 때:
-- select vault.update_secret(
--   (select id from vault.secrets where name = 'sync_pump_secret'),
--   '<NEW_PUMP_SECRET>'
-- );

-- 등록 확인 (복호화된 값은 조회하지 않는다 — 이름과 생성 시각만 본다):
select name, created_at, updated_at from vault.secrets where name = 'sync_pump_secret';

-- ════════════════════════════════════════════════════════════════
-- 2단계. Cron 등록 (1분 주기)
--   · pump는 접수 후 즉시 202를 반환하므로 pg_net은 배치 완료를 기다리지 않는다.
--   · timeout 5초는 "접수 응답을 받는 데" 쓰는 값이다 (배치 34~41초와 무관).
--   · 잔여가 없으면 pump가 200 noop을 돌려주므로 빈 호출은 사실상 무료다.
-- ════════════════════════════════════════════════════════════════
select cron.schedule(
  'sync-pump',
  '* * * * *',
  $CRON$
  select net.http_post(
    url := 'https://flowercrm-seo.vercel.app/api/sync/pump',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-sync-pump-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_pump_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $CRON$
);

-- ════════════════════════════════════════════════════════════════
-- 3단계. 등록 확인
-- ════════════════════════════════════════════════════════════════
select jobid, jobname, schedule, active
from cron.job
where jobname = 'sync-pump';

-- command에 시크릿 원문이 저장되지 않았는지 확인 (vault 조회식만 있어야 한다):
select jobname, (command like '%decrypted_secrets%') as uses_vault, (command like '%<PUMP_SECRET>%') as leaks_plaintext
from cron.job
where jobname = 'sync-pump';

-- ════════════════════════════════════════════════════════════════
-- 4단계. 최근 실행 이력
--   · status = 'succeeded'는 "SQL이 성공했다"는 뜻이다 (HTTP 응답 코드는 아래 net 테이블에서 본다).
-- ════════════════════════════════════════════════════════════════
select runid, job_pid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'sync-pump')
order by start_time desc
limit 20;

-- pump가 실제로 어떤 HTTP 상태를 돌려줬는지 (202 = 접수됨, 200 = 잔여 없음/이미 처리 중):
select id, status_code, created
from net._http_response
order by created desc
limit 20;

-- 진행 상황은 job 행에서 직접 본다:
select status, current_row, processed_count, remaining_count, batch_index, pump_attempt,
       lease_expires_at, last_tick_at, last_error_code, last_error_message
from public.sync_jobs
order by started_at desc
limit 5;

-- ════════════════════════════════════════════════════════════════
-- 5단계. 일시 중지 / 재개
-- ════════════════════════════════════════════════════════════════
-- 중지 (등록은 유지하고 실행만 멈춘다):
select cron.alter_job(
  (select jobid from cron.job where jobname = 'sync-pump'),
  active := false
);

-- 재개:
-- select cron.alter_job((select jobid from cron.job where jobname = 'sync-pump'), active := true);

-- ════════════════════════════════════════════════════════════════
-- 6단계. 완전 삭제
-- ════════════════════════════════════════════════════════════════
-- select cron.unschedule('sync-pump');

-- ════════════════════════════════════════════════════════════════
-- 7단계. pump endpoint 수동 안전 프로브
--
--   아래는 DB가 아니라 터미널에서 실행한다. 잔여 job이 없을 때는 200 noop이 돌아오고,
--   시크릿이 틀리면 401이 돌아온다. 어느 쪽도 DB를 쓰지 않는다.
--
--   시크릿 없이 (기대: 401 {"ok":false,"reason":"pump-secret"})
--     curl -i -X POST https://flowercrm-seo.vercel.app/api/sync/pump
--
--   시크릿과 함께 (기대: 잔여 job 없으면 200 {"ok":true,"noop":true,"reason":"idle"},
--                       처리할 job이 있으면 202 {"ok":true,"accepted":true} — 배치 1개가 실제로 진행된다)
--     curl -i -X POST https://flowercrm-seo.vercel.app/api/sync/pump \
--       -H "x-sync-pump-secret: <PUMP_SECRET>"
--
--   ⚠️ 202가 돌아오면 실제 동기화 배치 1개가 진행된다. 승인 전에는 시크릿 없는 프로브만 사용한다.
-- ════════════════════════════════════════════════════════════════
