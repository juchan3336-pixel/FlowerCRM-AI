create extension if not exists pgcrypto;

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.places (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'google_sheets',
  source_sheet_name text,
  source_row_number integer check (source_row_number is null or source_row_number > 0),
  source_key text not null unique,
  name text not null,
  normalized_name text not null,
  category text not null,
  detail_category text,
  region text,
  city text,
  district text,
  address text,
  normalized_address text,
  phone text,
  normalized_phone text,
  homepage text,
  email text,
  source_url text,
  collected_at date,
  grade text,
  sales_status text,
  memo text,
  lat numeric,
  lng numeric,
  slug text unique,
  status text not null default 'draft' check (status in ('draft', 'published', 'noindex', 'archived')),
  order_url text,
  description text,
  meta_title text,
  meta_description text,
  faq jsonb not null default '[]'::jsonb check (jsonb_typeof(faq) = 'array'),
  keywords jsonb not null default '[]'::jsonb check (jsonb_typeof(keywords) = 'array'),
  internal_links jsonb not null default '[]'::jsonb check (jsonb_typeof(internal_links) = 'array'),
  imported_payload jsonb,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.seo_pages (
  id uuid primary key default gen_random_uuid(),
  place_id uuid references public.places(id) on delete cascade,
  page_type text not null check (page_type in ('area', 'funeral', 'hospital', 'product')),
  slug text not null,
  path text not null unique,
  title text,
  description text,
  canonical_url text,
  status text not null default 'draft' check (status in ('draft', 'published', 'noindex', 'archived')),
  priority numeric not null default 0.7 check (priority >= 0 and priority <= 1),
  change_frequency text not null default 'weekly' check (change_frequency in ('always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never')),
  last_modified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  place_id uuid references public.places(id) on delete cascade,
  generation_type text not null,
  prompt text,
  input jsonb,
  output jsonb,
  model text,
  status text not null default 'preview' check (status in ('preview', 'applied', 'rejected', 'failed')),
  applied_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'google_sheets',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'completed', 'failed', 'cancelled')),
  total_rows integer not null default 0 check (total_rows >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  message text
);

create table public.sync_errors (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid references public.sync_runs(id) on delete cascade,
  source_sheet_name text,
  source_row_number integer check (source_row_number is null or source_row_number > 0),
  source_payload jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);

create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create trigger places_set_updated_at before update on public.places for each row execute function public.set_updated_at();
create trigger seo_pages_set_updated_at before update on public.seo_pages for each row execute function public.set_updated_at();
create trigger settings_set_updated_at before update on public.settings for each row execute function public.set_updated_at();

create index places_status_idx on public.places(status);
create index places_category_region_idx on public.places(category, region);
create index places_city_district_idx on public.places(city, district);
create index places_normalized_phone_idx on public.places(normalized_phone) where normalized_phone is not null;
create index seo_pages_status_type_idx on public.seo_pages(status, page_type);
create index seo_pages_place_id_idx on public.seo_pages(place_id);
create index ai_generations_place_status_idx on public.ai_generations(place_id, status);
create index sync_errors_run_idx on public.sync_errors(sync_run_id);

alter table public.places enable row level security;
alter table public.seo_pages enable row level security;
alter table public.ai_generations enable row level security;
alter table public.sync_runs enable row level security;
alter table public.sync_errors enable row level security;
alter table public.settings enable row level security;

create policy "public-safe settings are readable" on public.settings for select to anon, authenticated using (key in ('site_url', 'brand_name', 'default_order_url', 'default_og_image', 'google_site_verification', 'naver_site_verification', 'public_phone_enabled', 'public_address_enabled'));
create policy "authenticated places admin read" on public.places for select to authenticated using (true);
create policy "authenticated seo_pages admin write" on public.seo_pages for all to authenticated using (true) with check (true);
create policy "authenticated ai admin" on public.ai_generations for all to authenticated using (true) with check (true);
create policy "authenticated sync_runs admin" on public.sync_runs for all to authenticated using (true) with check (true);
create policy "authenticated sync_errors admin" on public.sync_errors for all to authenticated using (true) with check (true);
create policy "authenticated settings admin" on public.settings for all to authenticated using (true) with check (true);

revoke all on public.places from anon;
revoke all on public.seo_pages from anon;
revoke all on public.ai_generations from anon;
revoke all on public.sync_runs from anon;
revoke all on public.sync_errors from anon;

create view public.published_place_pages
with (security_barrier = true)
as
select
  sp.id as seo_page_id,
  sp.page_type,
  sp.slug as page_slug,
  sp.path,
  sp.title,
  sp.description as page_description,
  sp.canonical_url,
  sp.priority,
  sp.change_frequency,
  sp.last_modified_at,
  p.id as place_id,
  p.name,
  p.category,
  p.detail_category,
  p.region,
  p.city,
  p.district,
  p.address,
  p.homepage,
  p.slug as place_slug,
  p.order_url,
  p.description as place_description,
  p.meta_title,
  p.meta_description,
  p.faq,
  p.keywords,
  p.internal_links
from public.seo_pages sp
left join public.places p on p.id = sp.place_id
where sp.status = 'published'
  and (p.id is null or p.status = 'published');

grant select on public.published_place_pages to anon, authenticated;
