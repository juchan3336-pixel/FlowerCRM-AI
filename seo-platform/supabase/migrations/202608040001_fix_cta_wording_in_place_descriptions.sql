-- 공개 description 내부 용어 노출 교정 (재생성 없이 최소 수정).
-- 초기(1~4호점) 생성분 places.description 이 '주문 및 배송 안내는 공식 주문 CTA를 통해 확인하세요.'로
-- 끝나는 결함 — 'CTA'는 내부 용어라 공개 텍스트에 노출되면 안 된다 (현 품질 게이트 banned:cta-term 이
-- 신규 생성은 이미 차단하지만, 게이트 도입 이전에 게시된 행은 수동 교정이 필요하다).
-- places.description 은 published_place_pages 뷰의 공개 fallback(page_description ?? meta_description
-- ?? place_description)이자 생성 반복도 비교의 원문이므로 데이터 자체를 고친다.
--
-- 알려진 결함 문장만 정확히 치환한다 (idempotent — 재실행해도 추가 변경 없음).
-- 치환 문구는 승인된 표준 표현("페이지의 '화환 주문하기' 버튼")을 따른다.
update public.places
set description = replace(
  description,
  '공식 주문 CTA를 통해 확인하세요',
  '페이지의 ‘화환 주문하기’ 버튼을 통해 확인할 수 있습니다'
)
where description like '%공식 주문 CTA를 통해 확인하세요%';

-- 적용 후 잔존 노출 확인용 (read-only, 수동 실행):
--   select id, name, slug from public.places
--   where description ~* 'CTA' or meta_description ~* 'CTA';
-- 위 조회에서 행이 남으면 알려지지 않은 변형 문구이므로 별도 교정으로 처리한다.
