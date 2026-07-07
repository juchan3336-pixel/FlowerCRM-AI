update public.seo_pages
set status = 'archived'
where status = 'noindex';

alter table public.seo_pages drop constraint if exists seo_pages_page_type_check;
alter table public.seo_pages add constraint seo_pages_page_type_check check (page_type in ('area', 'funeral', 'hospital', 'product', 'place'));

alter table public.seo_pages drop constraint if exists seo_pages_status_check;
alter table public.seo_pages add constraint seo_pages_status_check check (status in ('draft', 'ready', 'published', 'archived'));

create unique index seo_pages_one_place_page_per_place_idx
on public.seo_pages(place_id)
where page_type = 'place' and place_id is not null;

create or replace view public.published_place_pages
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
