const RULES = [
  { industry: "건설회사", include: ["건설", "건축", "종합건설", "시공", "토목", "전기공사", "설비", "설비공사"], exclude: ["조경자재", "건설자재", "할인", "대여", "판매", "건설기계", "인테리어소품"] },
  { industry: "종합건설", include: ["종합건설", "건설업"], exclude: ["건설자재", "건설기계", "대여", "판매", "할인"] },
  { industry: "전기설비공사", include: ["전기공사", "설비", "소방설비", "기계설비"], exclude: ["자재", "대여", "판매"] },
  { industry: "인테리어건축사", include: ["인테리어", "건축사", "설계"], exclude: ["소품", "자재", "가구판매"] },
  { industry: "시행사", include: ["시행", "개발", "디벨로퍼", "부동산개발", "건설", "종합건설"], exclude: ["행사", "의료", "자축", "기념물", "구급차"] },
  { industry: "부동산개발", include: ["부동산개발", "개발", "디벨로퍼", "시행"], exclude: ["행사", "의료", "기념물"] },
  { industry: "병원", include: ["병원", "의원", "의료", "클리닉", "센터"], exclude: ["의료용품", "구급차", "동물병원", "반려동물", "장례식장", "장례"] },
  { industry: "요양병원", include: ["요양병원", "요양원", "재활병원", "노인병원", "노인요양", "실버케어"], exclude: ["동물병원", "장례"] },
  { industry: "의원", include: ["의원", "내과", "정형외과", "치과", "한의원", "피부과", "성형외과", "소아과", "이비인후과", "클리닉", "의료"], exclude: ["동물병원", "의료용품", "장례"] },
  { industry: "동물병원", include: ["동물병원", "반려동물", "수의"], exclude: ["용품", "미용"] },
  { industry: "장례식장", include: ["장례식장", "장례", "추모", "상조"], exclude: [] },
  { industry: "법무법인", include: ["법무법인", "법무", "변호사", "법률", "로펌"], exclude: [] },
  { industry: "법률사무소", include: ["법률사무소", "법무사사무소", "법무사", "변호사", "법률", "로펌"], exclude: [] },
  { industry: "세무법인", include: ["세무법인", "세무사", "세무", "세무회계", "회계세무"], exclude: [] },
  { industry: "세무사무소", include: ["세무사무소", "세무회계사무소", "세무사", "세무", "세무회계", "회계세무"], exclude: [] },
  { industry: "회계법인", include: ["회계법인", "회계사", "공인회계사", "회계", "세무회계", "회계세무"], exclude: [] },
  { industry: "회계사무소", include: ["회계사무소", "세무회계사무소", "회계사", "공인회계사", "회계", "세무회계", "회계세무"], exclude: [] },
  { industry: "호텔", include: ["호텔", "관광호텔", "비즈니스호텔", "리조트", "숙박"], exclude: ["모텔", "여관", "예식장", "웨딩홀", "결혼"] },
  { industry: "리조트펜션", include: ["리조트", "펜션", "풀빌라", "숙박", "글램핑", "캠핑장"], exclude: ["모텔", "여관"] },
  { industry: "웨딩홀", include: ["웨딩홀", "예식장", "웨딩", "컨벤션"], exclude: [] },
  { industry: "제조업", include: ["제조", "공장", "산업", "기계", "금속", "화학", "생산", "가공", "업체"], exclude: [] },
  { industry: "제조업체", include: ["제조", "공장", "산업", "기계", "금속", "화학", "생산", "가공", "업체"], exclude: [] },
  { industry: "제조공장", include: ["제조", "공장", "생산"], exclude: [] },
  { industry: "기계 금속 제조", include: ["기계", "금속", "산업기계", "금속가공", "제조"], exclude: [] },
  { industry: "식품제조", include: ["식품", "제조", "공장", "HACCP"], exclude: [] },
  { industry: "자동차 딜러", include: ["자동차", "전시장", "딜러", "판매", "영업소", "대리점", "수입차"], exclude: ["정비", "부품", "렌터카", "렌트카", "카셰어링"] },
  { industry: "자동차판매점", include: ["자동차", "자동차판매", "판매", "판매점", "판매대리점", "영업소", "대리점", "전시장"], exclude: ["정비", "부품", "렌터카", "렌트카"] },
  { industry: "중고차매매", include: ["중고차", "자동차매매", "매매단지", "매매상사", "자동차상사", "상사"], exclude: ["정비", "부품"] },
  { industry: "수입차전시장", include: ["수입차", "전시장", "딜러", "BMW", "벤츠", "아우디"], exclude: ["정비", "부품"] },
  { industry: "렌터카", include: ["렌터카", "렌트카", "렌터", "렌트"], exclude: ["카셰어링", "쏘카존", "그린카존"] },
  { industry: "카셰어링", include: ["카셰어링", "쏘카", "그린카", "G car"], exclude: [] },
  { industry: "자동차정비", include: ["자동차정비", "카센터", "공업사", "수입차정비", "정비"], exclude: ["부품판매"] },
  { industry: "금융기관", include: ["금융", "은행", "저축은행", "신협", "새마을금고", "증권", "보험", "농협", "수협", "캐피탈"], exclude: ["ATM", "자동화코너"] },
  { industry: "보험대리점", include: ["보험대리", "보험설계", "GA보험", "보험", "손해보험", "생명보험"], exclude: ["자동화코너"] },
  { industry: "증권자산관리", include: ["증권", "자산관리", "투자자문", "자산운용", "투자증권", "PB센터"], exclude: [] },
  { industry: "프랜차이즈본사", include: ["프랜차이즈", "가맹본부", "본사", "체인"], exclude: ["가맹점", "대리점"] },
  { industry: "음식프랜차이즈", include: ["프랜차이즈", "치킨", "카페", "외식", "푸드", "본사"], exclude: ["가맹점"] },
];

export function isIndustryMatch(requestedIndustry, detailIndustry = "", companyName = "") {
  const rule = RULES.find((item) => item.industry === requestedIndustry);
  if (!rule) return true;

  const text = `${detailIndustry} ${companyName}`;
  if (rule.exclude.some((keyword) => text.includes(keyword))) return false;
  return rule.include.some((keyword) => text.includes(keyword));
}
