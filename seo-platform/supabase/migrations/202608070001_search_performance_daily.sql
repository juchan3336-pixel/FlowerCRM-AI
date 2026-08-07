-- ════════════════════════════════════════════════════════════════
-- 검색 성과 일별 지표 테이블 (2026-08-07)
--
-- Google Search Console Search Analytics를 하루 1회 동기화해 페이지별·검색어별
-- 노출수·클릭수·평균 순위를 날짜 단위로 쌓는다. query='' 행은 페이지 합계다.
-- 동기화는 /api/search-report/sync (Cron)가, 조회는 /admin/search-report가 담당한다.
-- ════════════════════════════════════════════════════════════════

create table if not exists search_performance_daily (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  page_path text not null,
  -- '' = 페이지 합계 행 (검색어별 행과 한 테이블에서 유니크 제약을 공유하기 위해 null 대신 '')
  query text not null default '',
  impressions integer not null default 0 check (impressions >= 0),
  clicks integer not null default 0 check (clicks >= 0),
  -- GSC 평균 게재순위 (1.0 = 최상단). 0은 지표 없음.
  position numeric(8, 2) not null default 0 check (position >= 0),
  fetched_at timestamptz not null default now(),
  unique (date, page_path, query)
);

-- 화면 조회 패턴: 특정 페이지의 최근 일별 시계열 + 특정 날짜의 페이지 목록
create index if not exists search_performance_daily_page_date_idx on search_performance_daily (page_path, date desc);
create index if not exists search_performance_daily_date_idx on search_performance_daily (date desc) where query = '';

-- ── 검증 (읽기 전용) ──
-- select count(*) from search_performance_daily;  -- 0이어야 한다 (신규 테이블)
