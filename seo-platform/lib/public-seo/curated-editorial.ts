// 검수 편집 본문 — 사람이 공식 출처와 대조해 쓴 본문을 코드에 두고 PR 검토로 관리한다.
//
// 이것은 AI 생성 콘텐츠(places.description)를 보정한 것이 아니다. DB의 본문·생성 기록은 건드리지 않고,
// 공개 화면의 "확인 안내" 영역에 이 편집 본문을 대신 싣는다. FAQ·제목·메타 설명은 이 맵이 바꾸지 않는다.
//
// 표시 조건: slug · SEO 페이지 ID · 장소명이 지금 게시된 페이지와 모두 같을 때만.
// 하나라도 다르면(장소가 바뀌었거나 다시 만들어졌으면) 이 편집 본문은 표시하지 않는다 — 다른 시설에 붙는 일이 없게.
//
// 작성 기준 (2026-11-10 Codex 검토):
//  - 공식 사이트 원문에서 글자 대조한 사실만 쓴다. 이미지 안의 글자, 후기·포털, 열지 않은 페이지는 근거가 아니다.
//  - 화환 반입 정책을 찾지 못한 곳은 "확인한 페이지에서는 확인하지 못했다"로 조사 범위를 한정한다.
//    "안내가 없다"·"반입 가능하다"로 넓히지 않는다.
//  - 층 배치를 근거로 화환을 어디에 두는지 추론하지 않는다. 반입 가능 여부·시간·위치는 시설에 직접 확인하도록 쓴다.
//  - 전화·가격·제휴·배송 보장·도착 약속은 쓰지 않는다. 제작·배송 가능 여부는 주문 과정, 시설 반입은 시설 확인으로 나눈다.
//  - sources는 본문의 사실을 확인한 공식 상세 페이지다. 원문 전체를 옮기지 않는다.
//  - contentUpdatedAt은 본문을 실제로 고친 시각이다. 다시 확인만 했을 때는 reviewedAt만 바꾼다.

export type CuratedEditorialSource = { readonly label: string; readonly url: string }

export type CuratedEditorialBody = {
  readonly slug: string
  readonly seoPageId: string
  readonly placeName: string
  readonly paragraphs: readonly string[]
  readonly sources: readonly CuratedEditorialSource[]
  // 공식 출처를 확인한 날 (YYYY-MM-DD)
  readonly reviewedAt: string
  // 이 편집 본문을 마지막으로 고친 시각 (ISO)
  readonly contentUpdatedAt: string
}

const REVIEWED_AT = "2026-11-10"
// 이 파일의 본문·FAQ 답변을 마지막으로 고친 실제 시각. 미래 시각을 적지 않는다 (sitemap의 수정 시각이 된다).
const CONTENT_UPDATED_AT = "2026-11-10T11:02:43.000Z"

const WEDDING_POLICY_UNKNOWN = (pages: string): string =>
  `${REVIEWED_AT}에 확인한 공식 사이트의 ${pages} 페이지에서는 화환 반입 기준을 확인하지 못했습니다. 반입 가능 여부와 시간·위치는 예식장에 직접 확인해 주세요. 제작·배송 가능 여부는 주문 과정에서 별도로 확인됩니다.`

const FUNERAL_WREATH_NOTICE =
  `장례식장 협조사항에는 조화에 관한 안내가 있습니다. 조화는 분향소 안에 세우고 통로에는 놓지 않도록 안내하며, 리본 컷팅이 필요하면 상담실에 요청하도록 되어 있습니다. 폐꽃은 임의로 반출할 수 없습니다. 이 내용은 ${REVIEWED_AT}에 확인한 협조사항 페이지의 범위이며, 개수 제한이나 반입 시간은 그 페이지에서 확인하지 못했습니다.`

const FUNERAL_ORDER_NOTE = "근조화환을 보내기 전에 상주 성함과 빈소 호실을 부고에서 확인해 주세요. 반입 가능 여부와 놓는 위치는 장례식장에 직접 확인하시고, 제작·배송 가능 여부는 주문 과정에서 별도로 확인됩니다."

export const CURATED_EDITORIAL_BODIES: readonly CuratedEditorialBody[] = [
  // ── 2026-11-10 신규 6곳 (공식 사이트 원문 대조) ─────────────────────────
  {
    slug: "funeral-gyeonggi-gwangmyeongsi-jungangdaehakgyogwangmyeongbyeongwon-jangryesikjang",
    seoPageId: "339d8561-cdc9-410a-b76e-3cbe53d1959f",
    placeName: "중앙대학교광명병원 장례식장",
    paragraphs: [
      "중앙대학교광명병원 장례식장은 경기 광명시 덕안로 110, 병원 건물 지하 2층에 있습니다. 장례식장 공식 안내와 병원 층별 안내 모두 장례식장을 지하 2층으로 표기합니다.",
      FUNERAL_WREATH_NOTICE,
      "공식 오시는 길에는 1호선 광명역 1번 출구 쪽에서 버스 22번·102번을 타고 중앙대학교광명병원 정류장에서 내리는 경로가 안내되어 있습니다. 주차 안내에는 높이 2.1m 이상 차량은 입차할 수 없다고 적혀 있습니다. 교통편은 이용 전에 공식 안내를 다시 확인해 주세요.",
      FUNERAL_ORDER_NOTE,
    ],
    sources: [
      { label: "장례식장 협조사항", url: "https://gh.cauhs.or.kr/funeral/conts/102004000000000.do" },
      { label: "장례식장 시설현황", url: "https://gh.cauhs.or.kr/funeral/conts/102001001000000.do" },
      { label: "장례식장 오시는 길", url: "https://gh.cauhs.or.kr/funeral/conts/105001000000000.do" },
      { label: "장례식장 주차안내", url: "https://gh.cauhs.or.kr/funeral/conts/105002000000000.do" },
      { label: "병원 층별 안내", url: "https://gh.cauhs.or.kr/home/conts/101005000000000.do" },
    ],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "funeral-seoul-dongjakgu-jungangdaehakgyobyeongwon-jangryesikjang",
    seoPageId: "e4cadcdc-235d-4ca7-b877-fbca91517e34",
    placeName: "중앙대학교병원 장례식장",
    paragraphs: [
      "중앙대학교병원 장례식장은 서울 동작구 흑석로 102에 있습니다. 빈소 호실은 부고에서 확인하고, 위치와 반입 동선은 장례식장에 문의해 주세요.",
      FUNERAL_WREATH_NOTICE,
      "공식 오시는 길에는 흑석(중앙대입구)역 3·4번 출구에서 걸어가는 경로와, 노량진역 1번 출구·상도역 5번 출구에서 마을버스 1번을 타고 병원 앞에서 내리는 경로가 안내되어 있습니다. 병원 셔틀버스는 토요일·일요일·공휴일에 운행하지 않는다고 적혀 있습니다. 교통편은 이용 전에 공식 안내를 다시 확인해 주세요.",
      FUNERAL_ORDER_NOTE,
    ],
    sources: [
      { label: "장례식장 협조사항", url: "https://ch.cauhs.or.kr/funeral/conts/102004000000000.do" },
      { label: "장례식장 오시는 길", url: "https://ch.cauhs.or.kr/funeral/conts/105001000000000.do" },
    ],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "area-seoul-jongrogu-seonggyungwankeonbensyeonwedinghol",
    seoPageId: "dbb1a5db-1c8b-4797-9e27-65897acb416d",
    placeName: "성균관컨벤션웨딩홀",
    paragraphs: [
      "성균관컨벤션웨딩홀은 서울 종로구 성균관로 31, 성균관대학교 정문 옆에 있습니다.",
      "공식 안내에서는 예식홀(스토리홀)을 3층, 로비 라운지를 1층, 연회장을 지하 1층으로 구분합니다. 주문 정보에는 청첩장에서 확인한 예식홀 이름과 예식 일시를 적고, 화환 반입 위치는 시설에 직접 확인해 주세요.",
      "공식 오시는 길에는 지하철 4호선 혜화역 4번 출구가 안내되어 있고, 예식에 한해 혜화역 4번 출구 T스토어 앞 셔틀 이용을 안내합니다. 차량은 본관 주차장, 제1주차장, 성균관대학교 주차장을 이용하도록 적혀 있습니다. 교통편은 이용 전에 공식 안내를 다시 확인해 주세요.",
      WEDDING_POLICY_UNKNOWN("오시는 길·예식홀·로비 라운지·연회장"),
    ],
    sources: [
      { label: "오시는 길", url: "http://www.skkconvention.co.kr/location/" },
      { label: "예식홀 안내", url: "http://www.skkconvention.co.kr/wedding/hall/" },
      { label: "로비 라운지 안내", url: "http://www.skkconvention.co.kr/wedding/lobby/" },
      { label: "연회장 안내", url: "http://www.skkconvention.co.kr/banquet/hall/" },
    ],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "area-seoul-junggu-opelriseu-wedingkeonbensyeon",
    seoPageId: "c1cbac88-de5e-4df7-b6f2-45060c6b65cf",
    placeName: "오펠리스 웨딩컨벤션",
    paragraphs: [
      "오펠리스 웨딩컨벤션은 서울 중구 세종대로9길 41 퍼시픽타워에 있습니다. 공식 사이트는 위치를 퍼시픽타워 20층으로 안내합니다.",
      "공식 안내에서는 예식홀(라비제홀)과 로비 라운지를 모두 20층으로 표기합니다. 주문 정보에는 공식 위치 안내의 건물명과 층, 청첩장의 홀 이름을 함께 적어 주세요. 반입 위치는 시설에 직접 확인해 주세요.",
      "공식 오시는 길에는 1·2호선 시청역 9번 출구와 1·4호선 서울역 3번 출구에서 걸어가는 경로가 안내되어 있고, 차량은 상공회의소 건물 뒤편의 퍼시픽타워 지하주차장을 이용하도록 적혀 있습니다. 교통편은 이용 전에 공식 안내를 다시 확인해 주세요.",
      WEDDING_POLICY_UNKNOWN("오시는 길·예식홀·로비 라운지"),
    ],
    sources: [
      { label: "오시는 길", url: "http://www.ofelis.com/location/" },
      { label: "예식홀 안내", url: "http://www.ofelis.com/wedding/hall/" },
      { label: "로비 라운지 안내", url: "http://www.ofelis.com/wedding/lobby/" },
    ],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "area-gyeonggi-gwangmyeongsi-gwangmyeongmuyeoksenteokeonbensyeon",
    seoPageId: "8e01cb31-cd2a-449a-b9d1-9748edfad411",
    placeName: "광명무역센터컨벤션",
    paragraphs: [
      "광명무역센터컨벤션은 경기 광명시 일직로 72 광명무역센터 3층에 있습니다.",
      "공식 안내에서는 예식홀(그랜드볼룸)과 로비 라운지를 3층, 연회장을 2층으로 구분합니다. 주문 정보에는 청첩장에서 확인한 예식홀 이름과 예식 일시를 적고, 화환 반입 위치는 시설에 직접 확인해 주세요.",
      "공식 오시는 길에는 1호선 광명역 5번 출구에서 걸어가는 경로와, 관악역 1번 출구에서 마을버스 1-1번을 타고 코스트코 광명점에서 내리는 경로가 안내되어 있습니다. 확인한 공지에는 2026년 4월 6일부터 매주 월요일·화요일 정기 휴무가 올라 있습니다. 방문이나 문의 전에 공식 안내를 다시 확인해 주세요.",
      WEDDING_POLICY_UNKNOWN("오시는 길·그랜드볼룸·로비 라운지·연회장"),
    ],
    sources: [
      { label: "오시는 길", url: "http://www.gtcwed.co.kr/location/" },
      { label: "그랜드볼룸 안내", url: "http://www.gtcwed.co.kr/wedding/grand/" },
      { label: "로비 라운지 안내", url: "http://www.gtcwed.co.kr/wedding/lobby/" },
      { label: "연회장 안내", url: "http://www.gtcwed.co.kr/wedding/banquet/" },
      { label: "공지사항", url: "http://www.gtcwed.co.kr/whatsNew/news/" },
    ],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "area-gyeonggi-suwonsi-gyeonggigyochongwedinghauseu",
    seoPageId: "7bd76fa3-f278-44bf-9d8a-18f74f5ed17d",
    placeName: "경기교총웨딩하우스",
    paragraphs: [
      "경기교총웨딩하우스는 경기 수원시 팔달구 팔달산로 89-13, 경기교총회관에 있습니다.",
      "공식 안내에는 예식홀 이름이 베네치아홀로, 연회장은 두 곳으로 소개되어 있습니다. 주문 정보에는 청첩장에서 확인한 예식홀 이름과 예식 일시를 적고, 화환 반입 위치는 시설에 직접 확인해 주세요.",
      "공식 오시는 길에는 1호선·수인분당선 수원역 지하상가 13번 출구와 셔틀버스 운행이 안내되어 있고, 일반버스 이용 안내에는 병무청입구 하차가 적혀 있습니다. 차량은 경기교총웨딩하우스 주차장 또는 옛 경기도청(수원) 주차장을 이용하도록 적혀 있습니다. 교통편은 이용 전에 공식 안내를 다시 확인해 주세요.",
      WEDDING_POLICY_UNKNOWN("오시는 길·베네치아홀·연회장"),
    ],
    sources: [
      { label: "오시는 길", url: "https://www.gcwedding.co.kr/Location" },
      { label: "베네치아홀 안내", url: "https://www.gcwedding.co.kr/Veneziahall" },
      { label: "연회장 안내", url: "https://www.gcwedding.co.kr/BanquetHall" },
    ],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },

  // ── 2026-09-17 1차 4곳 — 도착·전달 위치를 단정하던 문장만 확인 안내로 바꾼 편집본 ─────────
  // DB 본문(places.description)은 그대로다. 새로 조사한 시설 사실은 넣지 않았으므로 sources는 비어 있다
  // (화면에는 기존처럼 공식 홈페이지 링크만 나온다).
  {
    slug: "area-gyeongnam-changwonsi-riberakeonbensyeon",
    seoPageId: "085e8dd4-e269-4d33-b4d6-8060764e84b7",
    placeName: "리베라컨벤션",
    paragraphs: [
      "리베라컨벤션은 경남 창원시 성산구 중앙대로100번길 9(상남동)에 있는 웨딩홀·컨벤션입니다. 축하화환을 보낼 때는 예식 날짜·시간과 홀 이름을 정확히 적어 주세요.",
      "주문 전에 준비할 정보는 세 가지입니다. 예식 날짜와 시작 시간, 예식이 열리는 홀 이름, 받는 분(신랑·신부 또는 혼주) 성함입니다. 이 정보는 청첩장·모바일 청첩장에서 가장 정확하게 확인할 수 있고, 시설 정보는 리베라컨벤션 공식 홈페이지에서 확인할 수 있습니다.",
      "화환 반입 가능 여부와 시간·위치는 예식장에 직접 확인해 주세요. 제작·배송 가능 여부와 요청 일정에 따른 진행 가능 여부는 주문 과정에서 확인해 주세요.",
    ],
    sources: [],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "area-gyeongnam-yangsansi-wweding-yangsanjeom",
    seoPageId: "4369f8ec-c875-448b-a6c8-49afd74a6300",
    placeName: "W웨딩 양산점",
    paragraphs: [
      "W웨딩 양산점은 경남 양산시 강변로 438 크리스탈타워 4~6층에 있는 웨딩홀입니다. 축하화환을 보낼 때는 예식 날짜·시간과 홀 이름을 정확히 적어 주세요.",
      "주문 전에 준비할 정보는 예식 날짜와 시작 시간, 예식이 열리는 홀 이름, 받는 분(신랑·신부 또는 혼주) 성함입니다. 청첩장에서 확인하는 것이 가장 정확하고, 시설 정보는 W웨딩 양산점 공식 홈페이지에서 확인할 수 있습니다.",
      "화환 반입 가능 여부와 시간·위치는 예식장에 직접 확인해 주세요. 제작·배송 가능 여부와 요청 일정에 따른 진행 가능 여부는 주문 과정에서 확인해 주세요.",
    ],
    sources: [],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "funeral-gyeongnam-jinjusi-jinjujungangbyeongwon-jangryesikjang",
    seoPageId: "5bbfc4a5-9d86-4612-a3dc-fedfb5aacb10",
    placeName: "진주중앙병원 장례식장",
    paragraphs: [
      "진주중앙병원 장례식장은 경남 진주시 촉석로 178(중안동)에 있습니다. 주문 전에 고인 또는 상주 성함과 빈소 호실, 장례 일정을 확인해 주세요.",
      "빈소 정보는 상주측이 보낸 부고 문자에서 확인하는 것이 가장 정확합니다. 확인이 어려운 경우 진주중앙병원 장례식장 공식 안내를 참고할 수 있습니다.",
      "리본 문구(‘삼가 고인의 명복을 빕니다’ 등)와 보내는 분 성함·소속은 주문서에 입력하시면 리본으로 제작됩니다. 반입 가능 여부와 시간·위치는 장례식장에 직접 확인해 주세요. 제작·배송 가능 여부는 주문 과정에서 별도로 확인됩니다.",
    ],
    sources: [],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "funeral-gyeongbuk-andongsi-andongjeonmunjangryesikjang",
    seoPageId: "e0e60c1c-49af-4516-a25f-6aa76fad93a0",
    placeName: "안동전문장례식장",
    paragraphs: [
      "안동전문장례식장은 경북 안동시 강남로 5(수상동)에 있습니다. 주문 전에 고인 또는 상주 성함과 빈소 호실, 장례 일정을 확인해 주세요.",
      "빈소 정보는 상주측이 보낸 부고 문자에서 확인하는 것이 가장 정확하며, 시설 이용 안내는 안동전문장례식장 공식 홈페이지에서 확인할 수 있습니다.",
      "리본 문구(‘삼가 고인의 명복을 빕니다’ 등)와 보내는 분 성함·소속은 주문서에 입력하시면 리본으로 제작됩니다. 반입 가능 여부와 시간·위치는 장례식장에 직접 확인해 주세요. 제작·배송 가능 여부는 주문 과정에서 별도로 확인됩니다.",
    ],
    sources: [],
    reviewedAt: REVIEWED_AT,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
]

// ── FAQ 답변 편집 ────────────────────────────────────────────────────
// 2026-09 1차 4곳의 FAQ에는 도착·전달을 단정하는 답변이 있다. 이 4곳은 당시 SQL로 places를 직접 고쳐
// 생성 기록(ai_generations.output.generated)과 공개 콘텐츠가 이미 다르다. 게시 FAQ 보정 경로로 고치면
// 생성 기록이 SQL로 넣은 내용으로 덮이므로, DB는 그대로 두고 공개 변환에서 해당 답변만 바꿔 내보낸다.
// 생성 기록과 공개 답변이 같아진 것이 아니다 — 이 맵이 공개 표시를 덮고 있다는 뜻이다.
//
// 좁은 계약: slug·SEO 페이지 ID·장소명이 같고, 그 index의 저장된 질문과 답변이 기대값과 글자 그대로 같을 때만
// 그 답변 하나를 바꾼다. 하나라도 다르면 아무것도 바꾸지 않는다 (추측으로 다른 항목을 덮지 않는다).
// expectedAnswer는 DB에 저장된 원문(주소 표기 정리 전)이다.
export type CuratedFaqAnswerEdit = {
  readonly slug: string
  readonly seoPageId: string
  readonly placeName: string
  readonly faqIndex: number
  readonly expectedQuestion: string
  readonly expectedAnswer: string
  readonly replacementAnswer: string
  readonly reason: string
  readonly contentUpdatedAt: string
}

const ARRIVAL_REASON = "도착 시점·접수 방식을 단정함 — 시설 직접 확인과 주문 과정 확인으로 나눈 안내로 대체"
const ACCESS_REASON = "배송 진행·반입 절차를 단정함 — 시설 직접 확인 안내로 대체"

export const CURATED_FAQ_ANSWER_EDITS: readonly CuratedFaqAnswerEdit[] = [
  {
    slug: "area-gyeongnam-changwonsi-riberakeonbensyeon",
    seoPageId: "085e8dd4-e269-4d33-b4d6-8060764e84b7",
    placeName: "리베라컨벤션",
    faqIndex: 2,
    expectedQuestion: "화환은 언제 도착하나요?",
    expectedAnswer: "예식 시작 전에 도착하도록 접수하는 것이 일반적입니다. 주문서에 예식 날짜와 시작 시간을 입력하시면 그 일정에 맞춰 접수됩니다.",
    replacementAnswer: "예식 일시와 홀 이름을 청첩장에서 확인해 주세요. 화환 반입 가능 여부와 시간·위치는 예식장에 직접 확인해 주세요. 제작·배송 가능 여부와 요청 일정에 따른 진행 가능 여부는 주문 과정에서 확인해 주세요.",
    reason: ARRIVAL_REASON,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "area-gyeongnam-changwonsi-riberakeonbensyeon",
    seoPageId: "085e8dd4-e269-4d33-b4d6-8060764e84b7",
    placeName: "리베라컨벤션",
    faqIndex: 3,
    expectedQuestion: "행사장 반입 위치는 어떻게 확인하나요?",
    expectedAnswer: "화환은 주문서에 입력하신 주소(경남 창원시 성산구 중앙대로100번길 9)와 홀 정보를 기준으로 배송이 진행되며, 반입 세부 절차는 시설 안내에 따릅니다. 별도 확인이 필요하면 리베라컨벤션 공식 안내를 이용해 주세요.",
    replacementAnswer: "화환 반입 가능 여부와 위치는 예식장에 직접 확인해 주세요. 제작·배송 가능 여부는 주문 과정에서 별도로 확인됩니다.",
    reason: ACCESS_REASON,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "area-gyeongnam-yangsansi-wweding-yangsanjeom",
    seoPageId: "4369f8ec-c875-448b-a6c8-49afd74a6300",
    placeName: "W웨딩 양산점",
    faqIndex: 3,
    expectedQuestion: "화환은 언제 도착하나요?",
    expectedAnswer: "예식 시작 전에 도착하도록 접수하는 것이 일반적입니다. 주문서에 예식 날짜와 시작 시간을 입력하시면 그 일정에 맞춰 접수됩니다.",
    replacementAnswer: "예식 일시와 홀 이름을 청첩장에서 확인해 주세요. 화환 반입 가능 여부와 시간·위치는 예식장에 직접 확인해 주세요. 제작·배송 가능 여부와 요청 일정에 따른 진행 가능 여부는 주문 과정에서 확인해 주세요.",
    reason: ARRIVAL_REASON,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "area-gyeongnam-yangsansi-wweding-yangsanjeom",
    seoPageId: "4369f8ec-c875-448b-a6c8-49afd74a6300",
    placeName: "W웨딩 양산점",
    faqIndex: 1,
    expectedQuestion: "행사장 반입 위치는 어떻게 확인하나요?",
    expectedAnswer: "화환은 주문서에 입력하신 주소(경남 양산시 강변로 438 크리스탈타워 4~6층)와 홀 정보를 기준으로 배송이 진행되며, 반입 세부 절차는 시설 안내에 따릅니다.",
    replacementAnswer: "화환 반입 가능 여부와 위치는 예식장에 직접 확인해 주세요. 제작·배송 가능 여부는 주문 과정에서 별도로 확인됩니다.",
    reason: ACCESS_REASON,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "funeral-gyeongnam-jinjusi-jinjujungangbyeongwon-jangryesikjang",
    seoPageId: "5bbfc4a5-9d86-4612-a3dc-fedfb5aacb10",
    placeName: "진주중앙병원 장례식장",
    faqIndex: 3,
    expectedQuestion: "화환은 언제 도착하나요?",
    expectedAnswer: "빈소가 차려진 뒤 도착하도록 접수하는 것이 일반적입니다. 발인 일정이 임박한 경우에는 주문 상담으로 먼저 문의해 주세요.",
    replacementAnswer: "고인 또는 상주 성함과 빈소 호실, 장례 일정을 확인해 주세요. 반입 가능 여부와 시간·위치는 장례식장에 직접 확인해 주세요. 제작·배송 가능 여부는 주문 과정에서 별도로 확인됩니다.",
    reason: ARRIVAL_REASON,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
  {
    slug: "funeral-gyeongbuk-andongsi-andongjeonmunjangryesikjang",
    seoPageId: "e0e60c1c-49af-4516-a25f-6aa76fad93a0",
    placeName: "안동전문장례식장",
    faqIndex: 3,
    expectedQuestion: "화환은 언제 도착하나요?",
    expectedAnswer: "빈소가 차려진 뒤 도착하도록 접수하는 것이 일반적입니다. 발인 일정이 임박한 경우에는 주문 상담으로 먼저 문의해 주세요.",
    replacementAnswer: "고인 또는 상주 성함과 빈소 호실, 장례 일정을 확인해 주세요. 반입 가능 여부와 시간·위치는 장례식장에 직접 확인해 주세요. 제작·배송 가능 여부는 주문 과정에서 별도로 확인됩니다.",
    reason: ARRIVAL_REASON,
    contentUpdatedAt: CONTENT_UPDATED_AT,
  },
]

export type FaqEntry = { readonly question: string; readonly answer: string }

// 저장된 FAQ(원문)에 답변 편집을 적용한다. 적용된 편집 목록도 함께 돌려준다 (수정 시각 계산용).
// 주소 표기 정리보다 먼저 부른다 — 기대값이 저장 원문 기준이기 때문이다.
export function applyCuratedFaqAnswerEdits<T extends FaqEntry>(
  page: Readonly<{ slug: string; seoPageId: string; placeName: string | null }>,
  faq: readonly T[],
): { readonly faq: readonly T[]; readonly applied: readonly CuratedFaqAnswerEdit[] } {
  const edits = CURATED_FAQ_ANSWER_EDITS.filter((edit) => edit.slug === page.slug && edit.seoPageId === page.seoPageId && edit.placeName === page.placeName)
  if (edits.length === 0) {
    return { faq, applied: [] }
  }
  const applied: CuratedFaqAnswerEdit[] = []
  const next = faq.map((entry, index) => {
    const edit = edits.find((candidate) => candidate.faqIndex === index)
    if (entry.question !== edit?.expectedQuestion || entry.answer !== edit.expectedAnswer) {
      return entry
    }
    applied.push(edit)
    return { ...entry, answer: edit.replacementAnswer }
  })
  return { faq: next, applied }
}

const BY_SLUG: ReadonlyMap<string, CuratedEditorialBody> = new Map(CURATED_EDITORIAL_BODIES.map((entry) => [entry.slug, entry]))

// 지금 게시된 페이지와 식별자가 모두 같을 때만 편집 본문을 돌려준다.
export function findCuratedEditorialBody(page: Readonly<{ slug: string; seoPageId: string; placeName: string | null }>): CuratedEditorialBody | null {
  const entry = BY_SLUG.get(page.slug)
  if (entry?.seoPageId !== page.seoPageId || entry.placeName !== page.placeName) {
    return null
  }
  return entry
}

// 출처 링크는 http(s)만 화면에 낸다.
export function isRenderableSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

// 여러 편집(본문·FAQ 답변)이 적용된 페이지의 수정 시각 — DB 시각과 편집 시각들 중 가장 늦은 쪽.
export function latestIsoTimestamp(databaseAt: string, editedAts: readonly string[]): string {
  return editedAts.reduce((latest, at) => laterIsoTimestamp(latest, at), databaseAt)
}

// 수정 시각: DB 시각과 편집 본문을 고친 시각 중 늦은 쪽. 재확인일이나 현재 시각으로 밀어 올리지 않는다.
export function laterIsoTimestamp(databaseAt: string, editorialAt: string): string {
  const database = Date.parse(databaseAt)
  const editorial = Date.parse(editorialAt)
  if (Number.isNaN(editorial)) {
    return databaseAt
  }
  return Number.isNaN(database) || editorial > database ? editorialAt : databaseAt
}
