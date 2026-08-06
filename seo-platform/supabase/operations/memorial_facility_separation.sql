-- ════════════════════════════════════════════════════════════════
-- 추모·안치 시설을 장례식장과 DB에서 분리 (2026-08-06)
--
-- 배경: 시트 category='funeral'에 빈소가 없는 추모공원·봉안당·수목장·납골당이 섞여 있어
--       근조화환 문맥("빈소명을 확인하세요")으로 7곳이 공개되는 사고가 발생했다.
--       이 스크립트는 그 시설들을 official_verification_status='excluded' +
--       exclusion_reason='memorial-facility'로 표시해 후보·생성·게시·자동게시 전 계층에서 차단한다.
--
-- 대상: funeral 380곳 중 추모·안치 시설 80곳 (draft 73 + published 7)
-- 판정: 이름에 추모공원·추모관·추모누리·추모의집·봉안·수목장·수림장·납골·묘원·묘지·공원묘·자연장·장사시설
--       또는 상조·반려동물·펫장례가 있고, '장례식장/장례예식장/장례문화원/장례타운'이 없는 경우
--       → '합천추모공원 장례식장'처럼 실제 빈소를 함께 운영하는 곳은 제외되지 않는다.
--
-- 되돌리기: update places set official_verification_status = null, exclusion_reason = null
--           where exclusion_reason = 'memorial-facility';
-- ════════════════════════════════════════════════════════════════

-- ── 0단계. 적용 전 확인 (읽기 전용) — 몇 곳이 대상인지 먼저 본다
select count(*) filter (where status = 'draft')     as draft_대상,
       count(*) filter (where status = 'published') as published_대상,
       count(*)                                     as 전체_대상
from places
where category = 'funeral'
  and (
    name ~ '(상조|반려동물|펫 ?장례|동물장례)'
    or (name ~ '(추모공원|추모관|추모누리|추모의집|봉안|수목장|수림장|납골|묘원|묘지|공원묘|자연장|장사시설)'
        and name !~ '(장례식장|장례예식장|장례문화원|장례타운)')
  );

-- ── 1단계. 추모·안치 시설 구분 표시 (draft만 — published는 3단계에서 따로 처리)
update places
set official_verification_status = 'excluded',
    exclusion_reason = 'memorial-facility',
    updated_at = now()
where category = 'funeral'
  and status = 'draft'
  and (
    name ~ '(상조|반려동물|펫 ?장례|동물장례)'
    or (name ~ '(추모공원|추모관|추모누리|추모의집|봉안|수목장|수림장|납골|묘원|묘지|공원묘|자연장|장사시설)'
        and name !~ '(장례식장|장례예식장|장례문화원|장례타운)')
  )
  and coalesce(exclusion_reason, '') <> 'memorial-facility';

-- ── 2단계. 이미 공개된 추모시설 7곳 비공개 전환 (archive RPC — seo_pages.status=archived)
select archive_place_page('0c2b3c0f-213b-4016-a28b-d55197a51d58'); -- 은해사 수림장
select archive_place_page('3e9f4b1c-932e-4a1e-8cdb-b1ff03314ddb'); -- 구미시추모공원
select archive_place_page('535e6298-d954-4250-b03a-64de16114666'); -- 우리추모공원
select archive_place_page('8f6a0b2c-c5a6-4cb1-bc77-1d9ca1b1e300'); -- 우성추모공원
select archive_place_page('99a9e2c3-7b7e-482a-93f0-042b5692e9c6'); -- 안동추모공원 봉안
select archive_place_page('eebfb667-1e78-49e9-8586-23d6cafb50ad'); -- 경주용주사추모공원
select archive_place_page('f5d3e05e-26b6-420b-8ffd-c75f343e4d3c'); -- 천주교안동교구 봉안경당

-- ── 3단계. 비공개 전환한 7곳도 구분 표시
update places
set official_verification_status = 'excluded',
    exclusion_reason = 'memorial-facility',
    updated_at = now()
where id in (
  '0c2b3c0f-213b-4016-a28b-d55197a51d58',
  '3e9f4b1c-932e-4a1e-8cdb-b1ff03314ddb',
  '535e6298-d954-4250-b03a-64de16114666',
  '8f6a0b2c-c5a6-4cb1-bc77-1d9ca1b1e300',
  '99a9e2c3-7b7e-482a-93f0-042b5692e9c6',
  'eebfb667-1e78-49e9-8586-23d6cafb50ad',
  'f5d3e05e-26b6-420b-8ffd-c75f343e4d3c'
);

-- ── 4단계. 적용 결과 확인 (읽기 전용)
select exclusion_reason, official_verification_status, status, count(*)
from places
where exclusion_reason = 'memorial-facility'
group by 1, 2, 3
order by 3;

-- 공개 페이지 수 — 51 → 44가 되어야 한다
select count(*) as published_places from places where status = 'published';
select count(*) as published_seo_pages from seo_pages where status = 'published';

-- ════════════════════════════════════════════════════════════════
-- ★ 실행 후 반드시: Vercel 대시보드 → flowercrm-seo → Settings → Data Cache → Purge
--   SQL로 보관하면 DB는 즉시 바뀌지만 이미 만들어진 공개 페이지 캐시는 남아 있다.
--   Purge를 해야 7곳 URL이 실제로 내려가고 sitemap도 44개로 갱신된다.
-- ════════════════════════════════════════════════════════════════
