-- =============================================================
-- 장소 게시/보관/복원 원자 처리 RPC (2026-07-13)
-- places + seo_pages를 한 트랜잭션(함수 본문) 안에서 함께 변경.
-- updated_at은 기존 BEFORE UPDATE 트리거(set_updated_at)가 자동 갱신.
-- Applied to production via Supabase SQL Editor on 2026-07-13.
-- =============================================================

-- ① 게시: seo_pages ready → published + places → published (원자)
create or replace function public.publish_place_page(target_place_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_place public.places%rowtype;
  v_seo public.seo_pages%rowtype;
  v_now timestamptz := now();
begin
  select * into v_place from public.places where id = target_place_id for update;
  if not found then
    return jsonb_build_object('kind', 'missing-place');
  end if;

  select * into v_seo from public.seo_pages
  where place_id = target_place_id and page_type = 'place'
  for update;
  if not found then
    return jsonb_build_object('kind', 'missing-seo-page');
  end if;

  if v_seo.status = 'published' then
    return jsonb_build_object(
      'kind', 'already-published',
      'path', v_seo.path,
      'published_at', v_seo.published_at
    );
  end if;

  if v_seo.status <> 'ready' then
    return jsonb_build_object('kind', 'not-ready', 'seo_status', v_seo.status);
  end if;

  if v_place.status not in ('draft', 'published') then
    return jsonb_build_object('kind', 'place-not-publishable', 'place_status', v_place.status);
  end if;

  if nullif(trim(coalesce(v_place.meta_title, '')), '') is null
     or nullif(trim(coalesce(v_place.meta_description, '')), '') is null
     or nullif(trim(coalesce(v_place.description, '')), '') is null
     or nullif(trim(coalesce(v_place.slug, '')), '') is null then
    return jsonb_build_object('kind', 'missing-content');
  end if;

  update public.places
  set status = 'published'
  where id = v_place.id;

  update public.seo_pages
  set status = 'published',
      published_at = v_now,          -- 최초 게시 및 재게시 시 새 공개 시점으로 기록
      last_modified_at = v_now
  where id = v_seo.id;

  return jsonb_build_object(
    'kind', 'published',
    'seo_page_id', v_seo.id,
    'path', v_seo.path,
    'published_at', v_now
  );
end
$$;

-- ② 보관: seo_pages published → archived + places → draft (원자, published_at 보존, 삭제 없음)
create or replace function public.archive_place_page(target_place_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_place public.places%rowtype;
  v_seo public.seo_pages%rowtype;
  v_now timestamptz := now();
begin
  select * into v_place from public.places where id = target_place_id for update;
  if not found then
    return jsonb_build_object('kind', 'missing-place');
  end if;

  select * into v_seo from public.seo_pages
  where place_id = target_place_id and page_type = 'place'
  for update;
  if not found then
    return jsonb_build_object('kind', 'missing-seo-page');
  end if;

  if v_seo.status <> 'published' then
    return jsonb_build_object('kind', 'not-published', 'seo_status', v_seo.status);
  end if;

  update public.seo_pages
  set status = 'archived',
      last_modified_at = v_now       -- published_at은 그대로 보존
  where id = v_seo.id;

  update public.places
  set status = 'draft'
  where id = v_place.id;

  return jsonb_build_object(
    'kind', 'archived',
    'path', v_seo.path,
    'published_at', v_seo.published_at
  );
end
$$;

-- ③ 복원: seo_pages archived → ready (재검토 후 재게시 가능)
create or replace function public.restore_place_page(target_place_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seo public.seo_pages%rowtype;
  v_now timestamptz := now();
begin
  select * into v_seo from public.seo_pages
  where place_id = target_place_id and page_type = 'place'
  for update;
  if not found then
    return jsonb_build_object('kind', 'missing-seo-page');
  end if;

  if v_seo.status <> 'archived' then
    return jsonb_build_object('kind', 'not-archived', 'seo_status', v_seo.status);
  end if;

  update public.seo_pages
  set status = 'ready',
      last_modified_at = v_now
  where id = v_seo.id;

  return jsonb_build_object('kind', 'restored', 'path', v_seo.path);
end
$$;

-- ④ 권한: service_role 전용
revoke all on function public.publish_place_page(uuid) from public, anon, authenticated;
revoke all on function public.archive_place_page(uuid) from public, anon, authenticated;
revoke all on function public.restore_place_page(uuid) from public, anon, authenticated;

grant execute on function public.publish_place_page(uuid) to service_role;
grant execute on function public.archive_place_page(uuid) to service_role;
grant execute on function public.restore_place_page(uuid) to service_role;
