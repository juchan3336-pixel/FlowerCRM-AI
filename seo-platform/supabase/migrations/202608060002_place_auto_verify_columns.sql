-- 자동 업체 확인 결과 기록 컬럼 (2026-08-06)
--
-- 배경: 미검증 후보 6,955곳을 사람이 하나씩 홈페이지로 확인하는 것이 파이프라인의 병목이다.
--       기계가 확실히 확인한 것(공식 사이트 + 업체명·주소·전화 3항목 일치)만 자동 통과시키고,
--       나머지는 사유와 함께 큐에 남겨 사람이 나중에 본다.
--
-- 이 컬럼들이 없으면 pump가 같은 장소를 무한히 다시 조회한다 — 진행 위치를 남기는 것이 목적이다.
-- sync가 덮어쓰는 SOURCE_FIELD_KEYS 밖의 운영 전용 컬럼이며 기존 행은 전부 NULL이다.
--
-- 적용: Supabase SQL Editor에서 실행.
-- 되돌리기:
--   alter table public.places
--     drop column if exists auto_verify_checked_at,
--     drop column if exists auto_verify_score,
--     drop column if exists auto_verify_reason;

alter table public.places
  add column if not exists auto_verify_checked_at timestamptz,
  add column if not exists auto_verify_score smallint,
  add column if not exists auto_verify_reason text;

comment on column public.places.auto_verify_checked_at is '자동 업체 확인을 마지막으로 시도한 시각 (NULL이면 아직 미시도)';
comment on column public.places.auto_verify_score is '홈페이지에서 확인된 항목 수 (업체명·주소·전화 중 0~3)';
comment on column public.places.auto_verify_reason is '자동 통과하지 못한 사유 코드 (통과 시 NULL)';

-- 아직 확인하지 않은 후보를 빠르게 찾기 위한 부분 인덱스
create index if not exists places_auto_verify_pending_idx
  on public.places (collected_at desc)
  where auto_verify_checked_at is null
    and status = 'draft'
    and official_verification_status is null;

-- 확인 (읽기 전용)
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'places' and column_name like 'auto_verify%'
order by column_name;
