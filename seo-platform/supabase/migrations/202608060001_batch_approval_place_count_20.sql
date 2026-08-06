-- 승인 장소 수 상한 5 → 20 (2026-08-06)
--
-- 배경: 애플리케이션 상한(BATCH_MAX_ITEMS)을 20으로 올렸는데 DB CHECK가 5로 남아 있어
--       20곳 승인 시 INSERT가 거부되고 화면에는 "승인 요청을 보내지 못했습니다"만 떴다.
--       애플리케이션 방어선과 DB 방어선은 같은 값을 봐야 한다.
--
-- coalesce는 그대로 유지한다 — 빈 배열은 array_length가 NULL이라 BETWEEN이 NULL(통과)로
-- 평가되므로, coalesce(…, 0)이 있어야 빈 배열도 DB 계층에서 거부된다 (2026-07-24 검수 반영).
--
-- 적용: Supabase SQL Editor에서 실행. 기존 행에는 영향이 없다(전부 5곳 이하).
-- 되돌리기: 아래 20을 5로 바꿔 같은 방식으로 재생성 (단, 6곳 이상 승인 이력이 있으면 실패한다).

alter table public.batch_approvals
  drop constraint if exists batch_approvals_place_count_check;

alter table public.batch_approvals
  add constraint batch_approvals_place_count_check
    check (coalesce(array_length(approved_place_ids, 1), 0) between 1 and 20);

-- 확인 (읽기 전용)
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.batch_approvals'::regclass
  and conname = 'batch_approvals_place_count_check';
