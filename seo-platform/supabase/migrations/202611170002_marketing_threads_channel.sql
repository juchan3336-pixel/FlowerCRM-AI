-- ════════════════════════════════════════════════════════════════
-- 광고 배포 채널에 스레드(Threads) 추가 (2026-11-17)
--
-- 광고 글쓰기의 SNS 결과물로 스레드를 고를 수 있게 한다. 채널 코드 목록(CHECK)에 'threads'를 더하고 채널 행을 넣는다.
-- 기존 채널 행·소재·배포 작업은 바뀌지 않는다. 재실행해도 안전하다.
-- 적용: 202611170001_marketing_writer.sql을 적용한 DB에서 Supabase SQL Editor로 이 파일 전체를 실행한다.
--
-- 롤백(스레드 기록이 없을 때만):
--   delete from public.marketing_channels where code = 'threads';
--   그리고 아래 제약을 'threads' 없이 다시 만든다.
-- ════════════════════════════════════════════════════════════════

alter table public.marketing_channels drop constraint if exists marketing_channels_code_check;
alter table public.marketing_channels add constraint marketing_channels_code_check check (code in (
  'naver_search_ad', 'naver_blog', 'naver_place', 'naver_cafe', 'kakao_channel', 'instagram',
  'facebook_page', 'google_business_profile', 'daangn_biz', 'youtube_shorts', 'google_search_ad', 'threads'
));

-- 인스타그램과 같은 메타 계열 — 자사몰로 보내고, 사람이 직접 게시한다
insert into public.marketing_channels (code, label, tier, publish_mode, medium, default_destination_code)
values ('threads', '스레드', 'secondary', 'manual', 'organic_social', 'imweb')
on conflict (code) do nothing;

-- ── 검증 (읽기 전용) — 기대: 1, 12 ──
-- select
--   (select count(*) from public.marketing_channels where code = 'threads') as threads_rows,
--   (select count(*) from public.marketing_channels) as channel_rows;
