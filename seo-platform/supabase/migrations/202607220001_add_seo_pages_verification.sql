-- 게시 후 공개 URL 비동기 검증 상태 (fix/publish-verification-decoupling)
-- 기존 행은 모두 null 유지 — 게시 시점에 pending으로 세팅되고 after() 검증이 갱신한다.
alter table public.seo_pages
  add column if not exists verification_status text
    check (verification_status in ('pending', 'verified', 'delayed', 'failed'));

alter table public.seo_pages
  add column if not exists verification_checked_at timestamptz;

alter table public.seo_pages
  add column if not exists verification_attempts integer;

alter table public.seo_pages
  add column if not exists last_http_status integer;
