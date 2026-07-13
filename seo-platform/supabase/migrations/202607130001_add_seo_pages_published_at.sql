-- Adds the publish timestamp for place SEO pages.
-- Applied to production via Supabase SQL Editor on 2026-07-13.
alter table public.seo_pages add column if not exists published_at timestamptz;
