-- ════════════════════════════════════════════════════════════════
-- 순수 숙박 시설(펜션·모텔 등)을 축하(celebration) 후보에서 DB 분리 (2026-08-07)
--
-- 배경: 시트 category '숙박/행사'가 통째로 celebration(축하화환) 모드로 매핑돼
--       행사장이 아닌 펜션·모텔·민박 등이 후보에 대량 혼입됐다
--       (숙박/행사+호텔 1,848곳 중 명칭 기준 749곳, verified 234곳 중 121곳).
--       생성·게시된 곳은 없다(사고 아님) — 후보·검증 단계 혼입만 정리한다.
--       이 스크립트는 해당 시설을 official_verification_status='excluded' +
--       exclusion_reason='lodging-facility'로 표시해 후보·생성·게시 전 계층에서 차단한다.
--       (코드 계층 차단은 PR의 facility-type/candidate-policy가 함께 담당 — 이중 방어)
--
-- 판정: 이름에 펜션·팬션·모텔·민박·게스트하우스·게스트룸·찜질방·캠핑·글램핑·카라반·
--       풀빌라·호스텔·야영장·민숙이 포함된 경우.
--       리조트·콘도는 제외하지 않는다 — 연회장·웨딩홀을 함께 운영하는 곳이 많다.
--
-- 되돌리기: update places set official_verification_status = null, exclusion_reason = null
--           where exclusion_reason = 'lodging-facility';
-- ════════════════════════════════════════════════════════════════

-- ── 0단계. 적용 전 확인 (읽기 전용) — 대상 규모와 published 0곳을 먼저 확인한다
select count(*)                                     as 전체_대상,
       count(*) filter (where status = 'draft')     as draft_대상,
       count(*) filter (where status = 'published') as published_대상, -- 0이어야 한다
       count(*) filter (where official_verification_status = 'verified') as verified_되돌림_대상
from places
where category in ('숙박/행사', '호텔')
  and name ~ '(펜션|팬션|모텔|민박|게스트 ?하우스|게스트룸|찜질방|캠핑|글램핑|카라반|풀빌라|호스텔|야영장|민숙)';

-- ── 1단계. 숙박 시설 구분 표시 (draft만 — published가 0이 아니면 실행 전 보고)
update places
set official_verification_status = 'excluded',
    exclusion_reason = 'lodging-facility',
    updated_at = now()
where category in ('숙박/행사', '호텔')
  and status = 'draft'
  and name ~ '(펜션|팬션|모텔|민박|게스트 ?하우스|게스트룸|찜질방|캠핑|글램핑|카라반|풀빌라|호스텔|야영장|민숙)'
  and coalesce(exclusion_reason, '') <> 'lodging-facility';

-- ── 2단계. 적용 결과 확인 (읽기 전용)
select exclusion_reason, official_verification_status, status, count(*)
from places
where exclusion_reason = 'lodging-facility'
group by 1, 2, 3
order by 3;

-- 공개 지표 무변경 확인 — 게시된 펜션이 없으므로 이 두 수치는 실행 전과 같아야 한다
select count(*) as published_places from places where status = 'published';
select count(*) as published_seo_pages from seo_pages where status = 'published';
