-- ════════════════════════════════════════════════════════════════
-- 호텔 2곳 seo_pages title·description 잔존값 교정 (2026-09-01)
--
-- 원인: 라마다스위츠 거제호텔·아이스퀘어호텔은 2026-08-01 근조 파이프라인 오생성 →
--       2026-08-04 celebration 모드로 재생성·재적용됐으나, 재적용은 generation·places만
--       갱신하고 seo_pages.title/description은 8/1 근조 값 그대로 남겼다.
--       공개 렌더는 seo_pages.title을 우선하므로 호텔 페이지에 장례식장 title이 노출됐다.
--       published 98행 중 어긋난 행은 정확히 이 2행뿐 (전수 대조 완료).
--
-- 교정값: 8/4 정식 적용 generation(e2c25e9c·7589114d)의 meta_title/meta_description —
--         임의 창작이 아니라 이미 적용된 celebration 콘텐츠의 자체 메타값이다.
--
-- 실행 후: 페이지는 정적 생성 캐시라 다음 Production 배포(이 교정과 함께 가는 PR merge)
--          시점에 새 값으로 재생성된다 — SQL을 merge 전에 실행해 두면 별도 조치가 없다.
-- ════════════════════════════════════════════════════════════════

-- ── 0단계. 적용 전 확인 (읽기 전용) — 두 행이 아직 잘못된 값인지 본다
select p.name, s.id as seo_page_id, s.title, s.description
from seo_pages s join places p on p.id = s.place_id
where s.place_id in ('38b4e03d-725d-4a7d-95eb-0d7d01e6e2dc', '910e5a42-0419-4a83-9f97-d180ef7affd5')
  and s.page_type = 'place';

-- ── 1단계. 라마다스위츠 거제호텔 (조건부 — 현재 잘못된 값일 때만 1행)
update seo_pages
set title = '거제시 호텔·행사장 축하화환 보내는 방법',
    description = '라마다스위츠 거제호텔 축하화환, 행사장 수령 위치 확인 후 주문하세요.',
    last_modified_at = now(),
    updated_at = now()
where id = '00a7a861-1572-4ce7-87cd-cbfbefd1d97b'
  and title = '거제시 장례식장 화환 주문 — 라마다스위츠 거제호텔';

-- ── 2단계. 아이스퀘어호텔 (조건부 — 현재 잘못된 값일 때만 1행)
update seo_pages
set title = '김해시 아이스퀘어호텔 축하화환 주문 안내',
    description = '김해 아이스퀘어호텔 축하화환 주문 시 반입 위치와 수령 담당자 확인 방법 안내',
    last_modified_at = now(),
    updated_at = now()
where id = 'dfcf11de-60b2-40c2-8884-4856ad25e6d5'
  and title = '아이스퀘어호텔 장례식장 화환 주문 정보';

-- ── 3단계. 적용 확인 (읽기 전용) — 두 행 모두 축하 문맥이어야 한다
select p.name, s.title, s.description
from seo_pages s join places p on p.id = s.place_id
where s.id in ('00a7a861-1572-4ce7-87cd-cbfbefd1d97b', 'dfcf11de-60b2-40c2-8884-4856ad25e6d5');

-- published 수 무변경 확인
select count(*) as published_places from places where status = 'published';
