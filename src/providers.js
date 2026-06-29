import { cleanText, displayPhone, normalizeUrl } from "./normalize.js";

export class NaverLocalProvider {
  name = "naver-local";

  enabled() {
    return Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
  }

  async search(region, industry, limit) {
    if (!this.enabled()) return [];

    const params = new URLSearchParams({
      query: `${region} ${industry}`,
      display: String(Math.min(Math.max(limit, 1), 5)),
    });
    const response = await fetch(`https://openapi.naver.com/v1/search/local.json?${params}`, {
      headers: {
        "X-Naver-Client-Id": process.env.NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": process.env.NAVER_CLIENT_SECRET,
      },
    });
    if (!response.ok) throw new Error(`Naver API error: ${response.status}`);

    const data = await response.json();
    return (data.items || []).map((item) => ({
      companyName: cleanText(item.title),
      industry: cleanText(item.category),
      region,
      address: cleanText(item.roadAddress || item.address),
      phone: displayPhone(item.telephone),
      homepage: normalizeUrl(item.link),
      sourceUrl: normalizeUrl(item.link) || "https://openapi.naver.com/v1/search/local.json",
      provider: this.name,
    }));
  }
}

export class KakaoKeywordProvider {
  name = "kakao-keyword";

  enabled() {
    return Boolean(process.env.KAKAO_REST_API_KEY);
  }

  async search(region, industry, limit) {
    if (!this.enabled()) return [];

    const params = new URLSearchParams({
      query: `${region} ${industry}`,
      size: String(Math.min(Math.max(limit, 1), 15)),
    });
    const response = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${params}`, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
    });
    if (!response.ok) throw new Error(`Kakao API error: ${response.status}`);

    const data = await response.json();
    return (data.documents || []).map((item) => ({
      companyName: cleanText(item.place_name),
      industry: cleanText(item.category_name),
      region,
      address: cleanText(item.road_address_name || item.address_name),
      phone: displayPhone(item.phone),
      homepage: "",
      sourceUrl: normalizeUrl(item.place_url),
      provider: this.name,
    }));
  }
}
