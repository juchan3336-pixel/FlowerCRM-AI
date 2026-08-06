-- ════════════════════════════════════════════════════════════════
-- 자동 게시 pump Cron 등록 (2026-08-06)
--
-- 목적: 생성 성공(게시 준비 완료·적격) 장소를 Production이 1분 주기로 한 곳씩 자동 게시한다.
--       품질·어휘·RPC 가드는 관리자 수동 게시와 완전히 동일하다.
--
-- 적용 순서 (Supabase SQL Editor):
--   0) Vercel Production 환경변수 PUBLISH_PUMP_SECRET를 먼저 등록하고 재배포한다.
--      (긴 무작위 문자열 — 아래 Vault에 넣는 값과 동일해야 한다)
--   1) Vault에 시크릿 저장 (이미 있으면 이 단계는 건너뛴다)
--   2) Cron 등록
--   3) 자동 게시 스위치 켜기 (settings.auto_publish = "on")
--   4) 확인 쿼리
--
-- 끄고 싶을 때: update settings set value = '"off"'::jsonb where key = 'auto_publish';
--   (Cron은 계속 돌지만 pump가 disabled로 즉시 종료한다 — 사실상 무료)
-- ════════════════════════════════════════════════════════════════

-- 1단계. Vault 시크릿 (값은 직접 바꿔 넣을 것)
-- select vault.create_secret('여기에-PUBLISH_PUMP_SECRET-값', 'publish_pump_secret');

-- 2단계. Cron 등록 (1분 주기, 한 호출 = 1곳 게시)
select cron.schedule(
  'publish-pump',
  '* * * * *',
  $CRON$
  select net.http_post(
    url := 'https://flowercrm-seo.vercel.app/api/publish/pump',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-publish-pump-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'publish_pump_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $CRON$
);

-- 3단계. 자동 게시 스위치 켜기 (기본은 꺼짐 — 이 행이 "on"일 때만 동작)
insert into settings (key, value, updated_at)
values ('auto_publish', '"on"'::jsonb, now())
on conflict (key) do update set value = '"on"'::jsonb, updated_at = now();

-- 4단계. 확인 (읽기 전용)
select jobname, schedule, active from cron.job where jobname = 'publish-pump';
select key, value from settings where key = 'auto_publish';
