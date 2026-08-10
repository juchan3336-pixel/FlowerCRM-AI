-- ════════════════════════════════════════════════════════════════
-- GSC 검색 성과 동기화 Cron 등록 (2026-08-07)
--
-- 목적: Google Search Console 지표(페이지별·검색어별 노출·클릭·평균 순위)를
--       하루 1회 search_performance_daily로 동기화한다. 최근 5일을 매번 덮어써
--       잠정치가 확정치로 수렴한다.
--
-- 적용 순서 (Supabase SQL Editor):
--   0) 사전 준비 (사용자):
--      a. Google Cloud Console에서 서비스 계정 생성 + JSON 키 발급
--      b. Search Console 속성(place.꽃배달도메인)에 서비스 계정 이메일을 '전체' 권한 사용자로 추가
--      c. Vercel 환경변수 등록 후 재배포:
--         GSC_CLIENT_EMAIL  = 서비스 계정 이메일
--         GSC_PRIVATE_KEY   = JSON 키의 private_key 값 (여러 줄 그대로 붙여넣기 가능)
--         GSC_SITE_URL      = sc-domain:xn--hq1bo4e93ri3lbmc.com  (도메인 속성 기준)
--         SEARCH_REPORT_SYNC_SECRET = 긴 무작위 문자열 (아래 Vault 값과 동일)
--   1) migration 202608070001_search_performance_daily.sql 먼저 적용
--   2) Vault에 시크릿 저장
--   3) Cron 등록 (매일 09:30 KST = 00:30 UTC — GSC 전일 데이터 반영 시간 고려)
--   4) 확인 쿼리
--
-- 수동 1회 실행(초기 적재): 아래 3단계의 net.http_post 블록만 따로 실행하면 된다.
-- ════════════════════════════════════════════════════════════════

-- 2단계. Vault 시크릿 (값은 직접 바꿔 넣을 것)
-- select vault.create_secret('여기에-SEARCH_REPORT_SYNC_SECRET-값', 'search_report_sync_secret');

-- 3단계. Cron 등록 (매일 00:30 UTC = 09:30 KST)
select cron.schedule(
  'search-report-sync',
  '30 0 * * *',
  $CRON$
  select net.http_post(
    url := 'https://flowercrm-seo.vercel.app/api/search-report/sync',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-search-report-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'search_report_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $CRON$
);

-- 4단계. 확인 (읽기 전용)
select jobname, schedule, active from cron.job where jobname = 'search-report-sync';
-- 동기화 후: select date, count(*) from search_performance_daily where query = '' group by 1 order by 1 desc;
