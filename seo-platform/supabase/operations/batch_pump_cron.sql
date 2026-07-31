-- 승인 Batch 자동 생성 pump 예약 작업 (Supabase Cron + pg_net).
--
-- 이 파일은 migration이 아니다. Supabase Dashboard SQL Editor에서 사람이 단계별로 실행한다.
-- 여러 문장을 한 번에 Run 하면 Editor가 마지막 결과만 보여주므로, 단계별로 선택해서 Run 한다.
--
-- 왜 Cron인가: Vercel은 같은 함수의 HTTP 재귀 호출을 4회 초과에서 508 INFINITE_LOOP_DETECTED로
-- 차단한다. 승인 Batch는 item 1건당 self-fetch 1회였고 승인 상한이 5곳이라, 최대 규모 승인이
-- 정확히 5번째 발사에서 죽었다. 다음 item을 "자기 호출"이 아니라 DB 스케줄러가 끌어가게 바꾼다.
-- 호출자가 외부(Postgres)이므로 재귀 깊이는 항상 1이다.
--
-- ⚠️ 대상은 Production이 아니라 **Preview 별칭**이다. AI 생성은 Preview에서만 실행되며
--    Production 배포는 endpoint 자체가 하드 거부한다 (AI_PROVIDER=fake 유지 원칙).
--
-- 보안: pump 시크릿과 Vercel bypass 시크릿을 이 SQL에 평문으로 남기지 않는다.
-- Vault에 넣고 실행 시점에만 참조한다. cron.job.command에도 vault 조회식만 저장된다.

-- ════════════════════════════════════════════════════════════════
-- 0단계. 확장 확인 (없으면 활성화)
-- ════════════════════════════════════════════════════════════════
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- ════════════════════════════════════════════════════════════════
-- 1단계. Vault에 시크릿 2개 등록
--   · batch_pump_secret  = Vercel Preview 환경변수 BATCH_PUMP_SECRET 과 같은 값
--   · batch_bypass_secret = Vercel 프로젝트의 VERCEL_AUTOMATION_BYPASS_SECRET 값
--   값은 임의의 긴 난수를 쓴다 (예: openssl rand -base64 32).
-- ════════════════════════════════════════════════════════════════
select vault.create_secret('<BATCH_PUMP_SECRET>', 'batch_pump_secret', '승인 Batch pump endpoint 인증용');
select vault.create_secret('<VERCEL_AUTOMATION_BYPASS_SECRET>', 'batch_bypass_secret', 'Preview Deployment Protection 우회 헤더용');

-- 값을 교체할 때:
-- select vault.update_secret((select id from vault.secrets where name = 'batch_pump_secret'), '<NEW_VALUE>');

-- 등록 확인 (복호화된 값은 조회하지 않는다 — 이름과 시각만 본다):
select name, created_at, updated_at from vault.secrets where name in ('batch_pump_secret', 'batch_bypass_secret');

-- ════════════════════════════════════════════════════════════════
-- 2단계. Cron 등록 (1분 주기)
--   · pump는 접수 후 즉시 202를 반환하므로 pg_net은 생성 완료를 기다리지 않는다.
--   · timeout 5초는 "접수 응답을 받는 데" 쓰는 값이다 (생성 8.5~15.2초와 무관).
--   · 실행 중 승인이 없으면 pump가 200 noop을 돌려주므로 빈 호출은 사실상 무료다.
--   · URL은 고정 Preview 별칭이다 — 코드의 exact-pin(ALLOWED_EXEC_BASE_HOSTNAME)과 반드시 같아야 한다.
-- ════════════════════════════════════════════════════════════════
select cron.schedule(
  'batch-pump',
  '* * * * *',
  $CRON$
  select net.http_post(
    url := 'https://flowercrm-seo-git-preview-latest-juchans-projects-ecbdf050.vercel.app/api/batch/pump',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-batch-pump-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'batch_pump_secret'),
      'x-vercel-protection-bypass', (select decrypted_secret from vault.decrypted_secrets where name = 'batch_bypass_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $CRON$
);

-- ════════════════════════════════════════════════════════════════
-- 3단계. 등록 확인 · 중복 확인
-- ════════════════════════════════════════════════════════════════
select jobid, jobname, schedule, active from cron.job where jobname = 'batch-pump';

-- 중복 등록 여부 (기대: 1):
select count(*) as batch_pump_jobs from cron.job where jobname = 'batch-pump';

-- 동기화 pump와 함께 등록된 전체 목록:
select jobid, jobname, schedule, active from cron.job order by jobname;

-- command에 시크릿 원문이 저장되지 않았는지 (기대: uses_vault=true, leaks_plaintext=false):
select
  jobname,
  (command like '%decrypted_secrets%') as uses_vault,
  (command like '%<BATCH_PUMP_SECRET>%' or command like '%<VERCEL_AUTOMATION_BYPASS_SECRET>%') as leaks_plaintext
from cron.job
where jobname = 'batch-pump';

-- ════════════════════════════════════════════════════════════════
-- 4단계. 최근 실행 이력 · HTTP status
-- ════════════════════════════════════════════════════════════════
select runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'batch-pump')
order by start_time desc
limit 20;

-- pump가 실제로 어떤 HTTP 상태를 돌려줬는지
-- (202 = 접수됨 / 200 = 실행 중 승인 없음 / 401 = 시크릿·bypass 불일치 / 409 = 환경 게이트):
select id, status_code, created
from net._http_response
order by created desc
limit 20;

-- 진행 상황은 승인 행에서 직접 본다:
select status, execution_tick, pump_attempt, lease_expires_at, last_tick_at, last_error_code, batch_run_id
from public.batch_approvals
order by approved_at desc
limit 5;

-- item 진행:
select i.batch_id, i.sequence, i.status, i.current_step, i.started_at, i.finished_at
from public.batch_run_items i
where i.batch_id = (select batch_run_id from public.batch_approvals order by approved_at desc limit 1)
order by i.sequence;

-- ════════════════════════════════════════════════════════════════
-- 5단계. 일시 중지 / 재개
-- ════════════════════════════════════════════════════════════════
select cron.alter_job((select jobid from cron.job where jobname = 'batch-pump'), active := false);
-- 재개:
-- select cron.alter_job((select jobid from cron.job where jobname = 'batch-pump'), active := true);

-- ════════════════════════════════════════════════════════════════
-- 6단계. 완전 삭제
-- ════════════════════════════════════════════════════════════════
-- select cron.unschedule('batch-pump');

-- ════════════════════════════════════════════════════════════════
-- 7단계. pump endpoint 수동 안전 프로브
--
--   아래는 DB가 아니라 터미널에서 실행한다.
--
--   시크릿 없이 (기대: 401 — bypass 헤더가 없으면 Vercel 보호 화면 또는 앱의 401)
--     curl -i -X POST https://flowercrm-seo-git-preview-latest-juchans-projects-ecbdf050.vercel.app/api/batch/pump
--
--   bypass만 있고 pump 시크릿 없이 (기대: 401 {"ok":false,"reason":"pump-secret"})
--     curl -i -X POST https://flowercrm-seo-git-preview-latest-juchans-projects-ecbdf050.vercel.app/api/batch/pump \
--       -H "x-vercel-protection-bypass: <BYPASS>"
--
--   둘 다 있고 실행 중 승인이 없을 때 (기대: 200 {"ok":true,"noop":true,"reason":"idle"} — DB 무변경)
--     curl -i -X POST https://flowercrm-seo-git-preview-latest-juchans-projects-ecbdf050.vercel.app/api/batch/pump \
--       -H "x-vercel-protection-bypass: <BYPASS>" -H "x-batch-pump-secret: <PUMP_SECRET>"
--
--   ⚠️ 실행 중(running) 승인이 있는 상태에서 시크릿을 모두 갖춰 호출하면 202가 돌아오고
--      **실제 OpenAI 생성 1건이 진행된다.** 승인 전에는 시크릿 없는 프로브만 사용한다.
-- ════════════════════════════════════════════════════════════════
