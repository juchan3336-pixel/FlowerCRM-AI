-- 광고 글쓰기 migration(202611170001_marketing_writer.sql) 적용 확인 — 읽기 전용.
-- 기대: kind_column=true, writer_table=true, rls_enabled=true, existing_drafts_kept=true, writer_triggers=2,
--       anon_can_reserve=false, anon_can_complete=false, anon_can_read_outputs=false
select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'marketing_generations' and column_name = 'kind') as kind_column,
  exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'marketing_writer_outputs') as writer_table,
  (select relrowsecurity from pg_class where oid = 'public.marketing_writer_outputs'::regclass) as rls_enabled,
  not exists (select 1 from public.marketing_generations where kind = 'campaign-draft' and (campaign_id is null or channel_code is null)) as existing_drafts_kept,
  (select count(*) from pg_trigger where not tgisinternal and tgname in ('marketing_writer_outputs_check_generation', 'marketing_generations_check_writer_success')) as writer_triggers,
  has_function_privilege('anon', 'public.reserve_marketing_generation(uuid, text, text, text, text, numeric, integer, numeric, numeric, text)', 'execute') as anon_can_reserve,
  has_function_privilege('anon', 'public.complete_marketing_writer_generation(uuid, jsonb, numeric, integer, integer, integer, text, text)', 'execute') as anon_can_complete,
  has_table_privilege('anon', 'public.marketing_writer_outputs', 'select') as anon_can_read_outputs;
