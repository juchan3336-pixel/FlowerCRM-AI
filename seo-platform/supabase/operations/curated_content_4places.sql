-- 상세페이지 4곳 콘텐츠 보강 (2026-09-17) — 사용자 검수 후 Supabase SQL Editor에서 실행
-- 대상: 리베라컨벤션 · W웨딩 양산점 · 진주중앙병원 장례식장 · 안동전문장례식장
-- 원칙: DB에 이미 검증된 사실(명칭·주소·공식 홈페이지)만 사용. 전화·홀 이름·반입 위치·운영시간은 만들지 않음.
--       배송 보장·가격·제휴 표현 없음. 장례 페이지에 축하 문맥, 예식 페이지에 근조 문맥 혼입 없음.
-- 구조: 본문(places.description)·FAQ(places.faq)·meta(places.meta_description)·SEO 설명(seo_pages.description)만 교체.
--       seo_pages는 last_modified_at = now()도 함께 갱신 (updated_at은 기존 trigger가 처리).
--       title·slug·canonical·게시 상태는 변경하지 않는다.
-- 잠금: 확정 place_id·seo_page_id + slug/명칭 + status='published' (+ seo_pages.page_type='place')로 이중 잠금.
-- 보호: 실행 전 대상이 places 4행·seo_pages 4행과 정확히 일치하는지 검증하고, 다르면 예외로 전체 중단(UPDATE 미시작).
--
-- ⚠ 적용 순서 주의: /places/[slug]는 빌드 시 생성되므로,
--   ① 이 SQL 사전 검증·적용 → ③ DB 검증 → ④ PR #102 merge → ⑤ Production 배포 → ⑥ 공개 HTML 실검증 순서로 진행한다.
--   (배포 후 SQL을 실행하면 다음 배포 전까지 화면에 반영되지 않는다.)

begin;

-- ── 보호 절차: 대상 4+4행 정확 매칭 검증 (불일치 시 예외 → 트랜잭션 중단) ──
do $$
declare
  place_cnt int;
  page_cnt int;
begin
  select count(*) into place_cnt
  from public.places p
  where p.status = 'published'
    and (
      (p.id = '115edfa2-15f1-450e-9f57-d3611bd6aba3' and p.name = '리베라컨벤션' and p.address like '경남 창원시%') or
      (p.id = '01e2321f-0051-4bf2-8433-5a0e76efa65b' and p.name = 'W웨딩 양산점' and p.address like '경남 양산시%') or
      (p.id = '13061912-a2cd-42a1-b654-12146fca6119' and p.name = '진주중앙병원 장례식장' and p.address like '경남 진주시%') or
      (p.id = '3df8e40d-f0d2-4806-ae74-6c626d2be7b6' and p.name = '안동전문장례식장' and p.address like '경북 안동시%')
    );

  select count(*) into page_cnt
  from public.seo_pages sp
  where sp.status = 'published' and sp.page_type = 'place'
    and (
      (sp.id = '085e8dd4-e269-4d33-b4d6-8060764e84b7' and sp.slug = 'area-gyeongnam-changwonsi-riberakeonbensyeon' and sp.place_id = '115edfa2-15f1-450e-9f57-d3611bd6aba3') or
      (sp.id = '4369f8ec-c875-448b-a6c8-49afd74a6300' and sp.slug = 'area-gyeongnam-yangsansi-wweding-yangsanjeom' and sp.place_id = '01e2321f-0051-4bf2-8433-5a0e76efa65b') or
      (sp.id = '5bbfc4a5-9d86-4612-a3dc-fedfb5aacb10' and sp.slug = 'funeral-gyeongnam-jinjusi-jinjujungangbyeongwon-jangryesikjang' and sp.place_id = '13061912-a2cd-42a1-b654-12146fca6119') or
      (sp.id = 'e0e60c1c-49af-4516-a25f-6aa76fad93a0' and sp.slug = 'funeral-gyeongbuk-andongsi-andongjeonmunjangryesikjang' and sp.place_id = '3df8e40d-f0d2-4806-ae74-6c626d2be7b6')
    );

  if place_cnt <> 4 or page_cnt <> 4 then
    raise exception '대상 불일치: places %행 / seo_pages %행 (기대 4/4) — UPDATE를 시작하지 않고 중단합니다', place_cnt, page_cnt;
  end if;
end $$;

-- ① 리베라컨벤션 (예식장, 창원)
update public.places p
set
  description = '리베라컨벤션은 경남 창원시 성산구 중앙대로100번길 9(상남동)에 있는 웨딩홀·컨벤션입니다. 예식 축하화환은 예식 날짜·시간과 홀 이름이 정확해야 제자리에 전달될 수 있습니다.' || E'\n\n' ||
    '주문 전에 준비할 정보는 세 가지입니다. 예식 날짜와 시작 시간, 예식이 열리는 홀 이름, 받는 분(신랑·신부 또는 혼주) 성함입니다. 이 정보는 청첩장·모바일 청첩장에서 가장 정확하게 확인할 수 있고, 시설 정보는 리베라컨벤션 공식 홈페이지에서 확인할 수 있습니다.' || E'\n\n' ||
    '리본 문구 작성과 배송 접수는 팔도플라워가 처리합니다. 주문서에 위 정보를 입력하시면 예식 시작 전에 도착하도록 접수되며, 접수 후 진행 상황을 안내해 드립니다.',
  meta_description = '창원 상남동 리베라컨벤션(중앙대로100번길 9) 축하화환 안내 — 예식 날짜·홀 이름·받는 분 확인 후 주문하세요. 리본 문구와 배송 접수는 팔도플라워가 처리합니다.',
  faq = '[
    {"question":"주문 전에 무엇을 준비해야 하나요?","answer":"예식 날짜·시간, 홀 이름, 받는 분(신랑·신부 또는 혼주) 성함 세 가지입니다. 청첩장에서 확인하는 것이 가장 정확하며, 시설 정보는 리베라컨벤션 공식 홈페이지에서 확인할 수 있습니다."},
    {"question":"리본 문구는 어떻게 작성하나요?","answer":"‘축 결혼’, ‘축 화혼’ 같은 축하 문구와 보내는 분 성함·소속을 주문서에 입력하시면 리본으로 제작됩니다. 문구가 고민되면 주문 상담으로 문의해 주세요."},
    {"question":"화환은 언제 도착하나요?","answer":"예식 시작 전에 도착하도록 접수하는 것이 일반적입니다. 주문서에 예식 날짜와 시작 시간을 입력하시면 그 일정에 맞춰 접수됩니다."},
    {"question":"행사장 반입 위치는 어떻게 확인하나요?","answer":"화환은 주문서에 입력하신 주소(경남 창원시 성산구 중앙대로100번길 9)와 홀 정보를 기준으로 배송이 진행되며, 반입 세부 절차는 시설 안내에 따릅니다. 별도 확인이 필요하면 리베라컨벤션 공식 안내를 이용해 주세요."}
  ]'::jsonb
where p.id = '115edfa2-15f1-450e-9f57-d3611bd6aba3'
  and p.status = 'published'
  and p.name = '리베라컨벤션' and p.address like '경남 창원시%';

update public.seo_pages sp
set
  description = '창원 상남동 리베라컨벤션(중앙대로100번길 9) 축하화환 안내 — 예식 날짜·홀 이름·받는 분 확인 후 주문하세요. 리본 문구와 배송 접수는 팔도플라워가 처리합니다.',
  last_modified_at = now()
where sp.id = '085e8dd4-e269-4d33-b4d6-8060764e84b7'
  and sp.slug = 'area-gyeongnam-changwonsi-riberakeonbensyeon'
  and sp.place_id = '115edfa2-15f1-450e-9f57-d3611bd6aba3'
  and sp.status = 'published' and sp.page_type = 'place';

-- ② W웨딩 양산점 (예식장, 양산)
update public.places p
set
  description = 'W웨딩 양산점은 경남 양산시 강변로 438 크리스탈타워 4~6층에 있는 웨딩홀입니다. 건물 상층부에 예식장이 있는 구조이므로 축하화환 주문 시 예식 날짜·시간과 홀 이름을 정확히 입력해 주시는 것이 중요합니다.' || E'\n\n' ||
    '주문 전에 준비할 정보는 예식 날짜와 시작 시간, 예식이 열리는 홀 이름, 받는 분(신랑·신부 또는 혼주) 성함입니다. 청첩장에서 확인하는 것이 가장 정확하고, 시설 정보는 W웨딩 양산점 공식 홈페이지에서 확인할 수 있습니다.' || E'\n\n' ||
    '리본 문구 작성과 배송 접수는 팔도플라워가 처리합니다. 주문서에 위 정보를 입력하시면 예식 시작 전에 도착하도록 접수되며, 접수 후 진행 상황을 안내해 드립니다.',
  meta_description = '양산 W웨딩 양산점(강변로 438 크리스탈타워 4~6층) 축하화환 안내 — 예식 날짜·홀 이름·받는 분 확인 후 주문하세요. 리본 문구와 배송 접수는 팔도플라워가 처리합니다.',
  faq = '[
    {"question":"주문 전에 무엇을 준비해야 하나요?","answer":"예식 날짜·시간, 홀 이름, 받는 분(신랑·신부 또는 혼주) 성함 세 가지입니다. 청첩장에서 확인하는 것이 가장 정확하며, 시설 정보는 W웨딩 양산점 공식 홈페이지에서 확인할 수 있습니다."},
    {"question":"행사장 반입 위치는 어떻게 확인하나요?","answer":"화환은 주문서에 입력하신 주소(경남 양산시 강변로 438 크리스탈타워 4~6층)와 홀 정보를 기준으로 배송이 진행되며, 반입 세부 절차는 시설 안내에 따릅니다."},
    {"question":"리본 문구는 어떻게 작성하나요?","answer":"‘축 결혼’, ‘축 화혼’ 같은 축하 문구와 보내는 분 성함·소속을 주문서에 입력하시면 리본으로 제작됩니다."},
    {"question":"화환은 언제 도착하나요?","answer":"예식 시작 전에 도착하도록 접수하는 것이 일반적입니다. 주문서에 예식 날짜와 시작 시간을 입력하시면 그 일정에 맞춰 접수됩니다."}
  ]'::jsonb
where p.id = '01e2321f-0051-4bf2-8433-5a0e76efa65b'
  and p.status = 'published'
  and p.name = 'W웨딩 양산점' and p.address like '경남 양산시%';

update public.seo_pages sp
set
  description = '양산 W웨딩 양산점(강변로 438 크리스탈타워 4~6층) 축하화환 안내 — 예식 날짜·홀 이름·받는 분 확인 후 주문하세요. 리본 문구와 배송 접수는 팔도플라워가 처리합니다.',
  last_modified_at = now()
where sp.id = '4369f8ec-c875-448b-a6c8-49afd74a6300'
  and sp.slug = 'area-gyeongnam-yangsansi-wweding-yangsanjeom'
  and sp.place_id = '01e2321f-0051-4bf2-8433-5a0e76efa65b'
  and sp.status = 'published' and sp.page_type = 'place';

-- ③ 진주중앙병원 장례식장 (장례, 진주)
update public.places p
set
  description = '진주중앙병원 장례식장은 경남 진주시 촉석로 178(중안동)에 있습니다. 근조화환은 빈소 앞으로 전달되므로, 주문 전에 고인 또는 상주 성함과 빈소 호실을 확인해 주세요.' || E'\n\n' ||
    '빈소 정보는 상주측이 보낸 부고 문자에서 확인하는 것이 가장 정확합니다. 확인이 어려운 경우 진주중앙병원 장례식장 공식 안내를 참고할 수 있습니다.' || E'\n\n' ||
    '리본 문구(‘삼가 고인의 명복을 빕니다’ 등)와 보내는 분 성함·소속은 주문서에 입력하시면 리본으로 제작됩니다. 배송 접수와 진행 안내는 팔도플라워가 처리합니다.',
  meta_description = '진주중앙병원 장례식장(진주 촉석로 178) 근조화환 안내 — 고인·상주 성함과 빈소 확인 후 주문하세요. 리본 문구와 배송 접수는 팔도플라워가 처리합니다.',
  faq = '[
    {"question":"근조화환 주문 전에 어떤 정보를 확인해야 하나요?","answer":"고인 또는 상주 성함, 빈소 호실, 장례식장 주소(경남 진주시 촉석로 178) 세 가지입니다. 빈소 호실은 상주측 부고 문자에서 확인하는 것이 가장 정확합니다."},
    {"question":"빈소명을 모를 경우 어떻게 해야 하나요?","answer":"상주측에서 받은 부고 문자에 빈소·발인 정보가 담겨 있는 경우가 많습니다. 확인이 어려우면 주문 상담으로 문의해 주세요."},
    {"question":"리본 문구는 어떻게 작성하나요?","answer":"‘삼가 고인의 명복을 빕니다’가 일반적이며, 보내는 분 성함·소속을 함께 담습니다. 주문서에 입력하시면 리본으로 제작됩니다."},
    {"question":"화환은 언제 도착하나요?","answer":"빈소가 차려진 뒤 도착하도록 접수하는 것이 일반적입니다. 발인 일정이 임박한 경우에는 주문 상담으로 먼저 문의해 주세요."}
  ]'::jsonb
where p.id = '13061912-a2cd-42a1-b654-12146fca6119'
  and p.status = 'published'
  and p.name = '진주중앙병원 장례식장' and p.address like '경남 진주시%';

update public.seo_pages sp
set
  description = '진주중앙병원 장례식장(진주 촉석로 178) 근조화환 안내 — 고인·상주 성함과 빈소 확인 후 주문하세요. 리본 문구와 배송 접수는 팔도플라워가 처리합니다.',
  last_modified_at = now()
where sp.id = '5bbfc4a5-9d86-4612-a3dc-fedfb5aacb10'
  and sp.slug = 'funeral-gyeongnam-jinjusi-jinjujungangbyeongwon-jangryesikjang'
  and sp.place_id = '13061912-a2cd-42a1-b654-12146fca6119'
  and sp.status = 'published' and sp.page_type = 'place';

-- ④ 안동전문장례식장 (장례, 안동)
update public.places p
set
  description = '안동전문장례식장은 경북 안동시 강남로 5(수상동)에 있습니다. 근조화환은 빈소 앞으로 전달되므로, 주문 전에 고인 또는 상주 성함과 빈소 호실을 확인해 주세요.' || E'\n\n' ||
    '빈소 정보는 상주측이 보낸 부고 문자에서 확인하는 것이 가장 정확하며, 시설 이용 안내는 안동전문장례식장 공식 홈페이지에서 확인할 수 있습니다.' || E'\n\n' ||
    '리본 문구(‘삼가 고인의 명복을 빕니다’ 등)와 보내는 분 성함·소속은 주문서에 입력하시면 리본으로 제작됩니다. 배송 접수와 진행 안내는 팔도플라워가 처리합니다.',
  meta_description = '안동전문장례식장(안동 강남로 5) 근조화환 안내 — 고인·상주 성함과 빈소 확인 후 주문하세요. 리본 문구와 배송 접수는 팔도플라워가 처리합니다.',
  faq = '[
    {"question":"근조화환 주문 전에 어떤 정보를 확인해야 하나요?","answer":"고인 또는 상주 성함, 빈소 호실, 장례식장 주소(경북 안동시 강남로 5) 세 가지입니다. 빈소 호실은 상주측 부고 문자에서 확인하는 것이 가장 정확합니다."},
    {"question":"빈소명을 모를 경우 어떻게 해야 하나요?","answer":"상주측에서 받은 부고 문자에 빈소·발인 정보가 담겨 있는 경우가 많습니다. 확인이 어려우면 주문 상담으로 문의해 주세요."},
    {"question":"리본 문구는 어떻게 작성하나요?","answer":"‘삼가 고인의 명복을 빕니다’가 일반적이며, 보내는 분 성함·소속을 함께 담습니다. 주문서에 입력하시면 리본으로 제작됩니다."},
    {"question":"화환은 언제 도착하나요?","answer":"빈소가 차려진 뒤 도착하도록 접수하는 것이 일반적입니다. 발인 일정이 임박한 경우에는 주문 상담으로 먼저 문의해 주세요."}
  ]'::jsonb
where p.id = '3df8e40d-f0d2-4806-ae74-6c626d2be7b6'
  and p.status = 'published'
  and p.name = '안동전문장례식장' and p.address like '경북 안동시%';

update public.seo_pages sp
set
  description = '안동전문장례식장(안동 강남로 5) 근조화환 안내 — 고인·상주 성함과 빈소 확인 후 주문하세요. 리본 문구와 배송 접수는 팔도플라워가 처리합니다.',
  last_modified_at = now()
where sp.id = 'e0e60c1c-49af-4516-a25f-6aa76fad93a0'
  and sp.slug = 'funeral-gyeongbuk-andongsi-andongjeonmunjangryesikjang'
  and sp.place_id = '3df8e40d-f0d2-4806-ae74-6c626d2be7b6'
  and sp.status = 'published' and sp.page_type = 'place';

commit;

-- 적용 확인 (4행, 각 faq_count=4, last_modified_at이 방금 시각이어야 정상)
select page_slug, left(page_description, 40) as seo_desc, left(place_description, 40) as body, jsonb_array_length(faq) as faq_count, last_modified_at
from public.published_place_pages
where page_slug in (
  'area-gyeongnam-changwonsi-riberakeonbensyeon',
  'area-gyeongnam-yangsansi-wweding-yangsanjeom',
  'funeral-gyeongnam-jinjusi-jinjujungangbyeongwon-jangryesikjang',
  'funeral-gyeongbuk-andongsi-andongjeonmunjangryesikjang'
);
