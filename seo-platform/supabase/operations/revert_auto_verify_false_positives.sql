-- 자동 확인 오탐 5곳 되돌리기 (2026-08-07)
--
-- 배경: 자동 업체 확인이 관공서·업체 디렉터리 페이지를 근거로 5곳을 통과시켰다.
--       이런 페이지는 관내 업체의 명칭·주소·전화를 그대로 싣기 때문에 3항목이 전부 맞지만,
--       그 업체의 공식 사이트가 아니므로 검증 근거가 되지 못한다.
--
--   호텔농심          → www.dongnae.go.kr    (동래구청)
--   최참판댁한옥호텔  → www.hadong.go.kr     (하동군청)
--   엘에스방재        → 119.busan.go.kr      (부산소방재난본부)
--   씨케이일렉트론    → www.k-apt.go.kr      (공동주택관리정보시스템)
--   청우기술단        → localbiz.kr          (업체 디렉터리)
--
-- 아직 콘텐츠 생성 전이라 공개된 페이지는 없다 — 검증 상태만 되돌리면 된다.
-- 되돌린 뒤에는 1단계 화면에 "직접 확인 필요"로 남아 사람이 확인할 수 있다.
--
-- 코드 쪽 재발 방지는 PR로 함께 반영된다(.go.kr/.re.kr·localbiz 차단).
-- 적용: Supabase SQL Editor에서 실행.

-- 0단계. 되돌릴 대상 확인 (읽기 전용)
select id, name, homepage, official_verification_status, verified_by
from places
where id in (
  '14a1a1ce-2e33-47b9-9fc9-846473d8a175', -- 호텔농심
  '26347cac-03db-42fc-9cc8-fd38b338406b', -- 최참판댁한옥호텔
  'e4f8572b-4d8e-4a98-a13f-78c62b5d7469', -- 엘에스방재
  '098dc3bb-bed9-48dc-b918-0bad5948f7cf', -- 씨케이일렉트론
  'b0674eae-252d-4d2b-9111-f21d506c8019'  -- 청우기술단
);

-- 1단계. 검증 상태 되돌리기 (자동 확인이 붙인 것만 — 사람이 검증한 행은 건드리지 않는다)
update places
set official_verification_status = null,
    verified_at = null,
    verified_by = null,
    verification_source_urls = null,
    auto_verify_reason = 'blocked-host',
    auto_verify_score = 3,
    updated_at = now()
where verified_by = 'auto-verify'
  and id in (
    '14a1a1ce-2e33-47b9-9fc9-846473d8a175',
    '26347cac-03db-42fc-9cc8-fd38b338406b',
    'e4f8572b-4d8e-4a98-a13f-78c62b5d7469',
    '098dc3bb-bed9-48dc-b918-0bad5948f7cf',
    'b0674eae-252d-4d2b-9111-f21d506c8019'
  );

-- 2단계. 결과 확인 (읽기 전용) — 5행 모두 official_verification_status가 비어 있어야 한다
select name, official_verification_status, verified_by, auto_verify_reason
from places
where id in (
  '14a1a1ce-2e33-47b9-9fc9-846473d8a175',
  '26347cac-03db-42fc-9cc8-fd38b338406b',
  'e4f8572b-4d8e-4a98-a13f-78c62b5d7469',
  '098dc3bb-bed9-48dc-b918-0bad5948f7cf',
  'b0674eae-252d-4d2b-9111-f21d506c8019'
)
order by name;

-- 3단계. 자동 통과 총계 (341 → 336 예상)
select count(*) as 자동_통과 from places where verified_by = 'auto-verify';
