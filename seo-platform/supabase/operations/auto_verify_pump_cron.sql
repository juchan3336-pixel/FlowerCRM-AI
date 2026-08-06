-- ════════════════════════════════════════════════════════════════
-- 자동 업체 확인 pump Cron 등록 (2026-08-06)
--
-- 목적: 미확인 후보(약 7,000곳)를 기계가 계속 훑어, 공식 사이트에서 업체명·주소·전화가
--       모두 확인되는 곳만 자동으로 통과시킨다. 통과하지 못한 곳은 사유와 함께 큐에 남고
--       사람이 나중에 직접 확인하면 된다.
--
-- 선행 조건:
--   · migration 202608060002_place_auto_verify_columns.sql 적용 완료
--   · Vercel Production 환경변수 PUBLISH_PUMP_SECRET (이미 등록됨) — 이 pump가 함께 쓴다
--     (별도 시크릿을 쓰려면 OPERATIONS_PUMP_SECRET를 등록하면 그 값이 우선한다)
--
-- 처리량: 1분에 5곳 → 하루 약 7,200곳. AI 호출이 없어 비용이 들지 않는다.
-- 끄기: update settings set value = '"off"'::jsonb where key = 'auto_verify';
-- ════════════════════════════════════════════════════════════════

-- 1단계. Cron 등록 (기존 vault 시크릿 publish_pump_secret 재사용)
select cron.schedule(
  'auto-verify-pump',
  '* * * * *',
  $CRON$
  select net.http_post(
    url := 'https://flowercrm-seo.vercel.app/api/verify/pump',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-verify-pump-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'publish_pump_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $CRON$
);

-- 2단계. 자동 확인 스위치 켜기 (기본 꺼짐 — 이 행이 "on"일 때만 동작)
insert into settings (key, value, updated_at)
values ('auto_verify', '"on"'::jsonb, now())
on conflict (key) do update set value = '"on"'::jsonb, updated_at = now();

-- 3단계. 확인 (읽기 전용)
select jobname, schedule, active from cron.job where jobname = 'auto-verify-pump';
select key, value from settings where key = 'auto_verify';

-- 진행 상황 보기 (실행 후 몇 분 뒤부터 값이 쌓인다)
select
  count(*) filter (where auto_verify_checked_at is not null)                                as 확인_시도,
  count(*) filter (where official_verification_status = 'verified' and verified_by = 'auto-verify') as 자동_통과,
  count(*) filter (where auto_verify_checked_at is not null and official_verification_status is null) as 직접확인_대기
from places;

-- 통과하지 못한 사유 분포
select auto_verify_reason, count(*)
from places
where auto_verify_checked_at is not null and official_verification_status is null
group by 1 order by 2 desc;
