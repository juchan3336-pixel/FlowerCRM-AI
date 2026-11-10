// Target-ownership contracts, taken from the 50-row dry run #313 and re-cast with synthetic
// identities (reserved .test domains, made-up names, numbers and addresses). Each asserts on what
// would be written to the sheet — `updates` — not on scores.
//
// The rule: an address is written only when something ties it to this business location. The
// company's verified domain does that for a company; for a branch, and for any other domain, the
// location's own phone number or street address has to sit next to the address. Otherwise the cell
// stays empty.
import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverEmail,
  enrichCandidate,
  hasRegionConflict,
  isBranchEntity,
  pickOfficialHomepage,
  scoreOfficialCandidate,
  targetPlaceEvidence,
} from "../src/enrich.js";
import { extractEmail, extractEmailDetails } from "../src/emailExtractor.js";

console.log = () => {};

const T = { timeout: 5000 };
// columns: name, industry, detail, region, address, phone, homepage, email, sourceUrl, ..., memo
const sheetRow = ({ name, region = "울산", address = "", phone = "", homepage = "" }) => [
  name,
  "자동차",
  "",
  region,
  address,
  phone,
  homepage,
  "",
  "",
  "",
  "",
  "",
  "",
];
const noSearch = {
  async findOfficial() {
    return { official: null, failures: [], candidates: [], searchEvents: [] };
  },
  async search() {
    return [];
  },
};
const page = (text) => async () => new Response(text, { status: 200 });
const oneResult = (url, text) => ({
  async search() {
    return [{ url, title: "TEST_SOURCE", snippet: text, source: "TEST_SOURCE" }];
  },
});
const noFetch = async () => new Response("", { status: 200 });

const BRANCH = {
  name: "테스트모터스 울산남부지점",
  address: "울산 남구 시험로 414",
  phone: "052-000-4140",
  homepage: "https://www.testmotors-brand.test/",
};

test("evidence helpers separate a name from a place", () => {
  const company = { companyName: "테스트상사", address: "울산 북구 시험유통로 95 (우)44249", phone: "052-123-4567" };

  assert.deepEqual(targetPlaceEvidence("테스트상사 대표메일", company), { name: true, phone: false, street: false, place: false });
  assert.equal(targetPlaceEvidence("TEL 052-123-4567", company).phone, true);
  assert.equal(targetPlaceEvidence("TEL 052.123.4567", company).phone, true);
  assert.equal(targetPlaceEvidence("TEL 052) 123 4567", company).phone, true);
  assert.equal(targetPlaceEvidence("TEL 1052-123-45678", company).phone, false, "a longer number that merely contains it");
  assert.equal(targetPlaceEvidence("울산 북구 시험유통로 95", company).street, true);
  assert.equal(targetPlaceEvidence("울산 북구 시험유통로95 2층", company).street, true);
  assert.equal(targetPlaceEvidence("울산 북구 시험유통로 950", company).street, false, "a different building on the same road");
  assert.equal(targetPlaceEvidence("울산 북구 시험유통로", company).street, false, "the road alone is shared by everyone on it");
  assert.equal(targetPlaceEvidence("울산 북구", company).place, false, "a district is not a place");

  const lot = { companyName: "테스트전시장", address: "울산 남구 삼산로 83 (지번) 달동 861-6" };
  assert.equal(targetPlaceEvidence("달동 861-6", lot).street, true);
  assert.equal(targetPlaceEvidence("달동 861", lot).street, false);

  assert.equal(targetPlaceEvidence("TEL 052-123-4567", { companyName: "테스트상사", phone: "1234" }).phone, false, "too short to identify anyone");
});

test("branch rows are recognised by what they are called", () => {
  for (const name of ["테스트모터스 울산남부지점", "테스트모터스 우정대리점", "테스트 스타자동차 울산전시장", "테스트 서비스센터", "테스트 울산영업소"]) {
    assert.equal(isBranchEntity({ companyName: name }), true, name);
  }
  for (const name of ["테스트자동차매매상사", "중고자동차테스트", "테스트상점", "테스트서점", ""]) {
    assert.equal(isBranchEntity({ companyName: name }), false, name);
  }
});

// run #313 rows 3066/3067/3068/3076/3078: five branches, one overseas accessibility mailbox.
test("a brand root's special-purpose mailbox is not written for a branch", T, async () => {
  const fetchImpl = page("Accessibility statement. Contact accessibility@testmotors-overseas.test for assistance.");

  const result = await enrichCandidate(
    { rowNumber: 3066, row: sheetRow(BRANCH) },
    { homepageProvider: noSearch, fetchImpl, debug: true },
  );

  assert.equal(result.updates.email, undefined);
  assert.equal(result.emailUpdated, false);
  assert.equal(result.debug.rejectedEmails.includes("accessibility@testmotors-overseas.test"), true);
});

// run #313 row 3060: same brand, head-office customer centre.
test("the brand's own head-office mailbox is not written for a branch either", T, async () => {
  const fetchImpl = page("테스트모터스 고객센터 문의 cs@testmotors-brand.test");

  const result = await enrichCandidate({ rowNumber: 3060, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl, debug: true });

  assert.equal(result.updates.email, undefined, "same domain as the homepage, still not this branch's address");
  assert.equal(result.debug.rejectedEmails.includes("cs@testmotors-brand.test"), true);
});

test("a branch contact card with the branch's own phone or address is written", T, async () => {
  for (const [label, card, expected] of [
    ["phone, brand domain", "울산남부지점 TEL 052-000-4140 E-mail ulsan-south@testmotors-brand.test", "ulsan-south@testmotors-brand.test"],
    ["street address, brand domain", "울산남부지점 울산 남구 시험로 414 E-mail ulsan-south@testmotors-brand.test", "ulsan-south@testmotors-brand.test"],
    // A dealer is often a separate company with its own domain: allowed once the place is shown.
    ["phone, dealer's own domain", "테스트모터스 울산남부지점 TEL 052-000-4140 E-mail info@ulsan-dealer.test", "info@ulsan-dealer.test"],
  ]) {
    const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl: page(card) });
    assert.equal(result.updates.email, expected, label);
    assert.equal(result.stopReason, "email_found_fast_path", label);
  }
});

test("a wrong address on the first page does not hide the right one on a later page", T, async () => {
  const fetchImpl = async (url) =>
    new Response(
      String(url).endsWith("/contact")
        ? "울산남부지점 TEL 052-000-4140 E-mail ulsan-south@testmotors-brand.test"
        : "Global support info@testmotors-overseas.test",
      { status: 200 },
    );

  const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl, debug: true });

  // "info@" is the extractor's most preferred prefix and used to end the crawl on page one.
  assert.equal(result.updates.email, "ulsan-south@testmotors-brand.test");
  assert.equal(result.debug.rejectedEmails.includes("info@testmotors-overseas.test"), true);
});

test("a company's own homepage still answers for the company itself", T, async () => {
  const company = { name: "테스트자동차매매상사", address: "울산 북구 시험유통로 15", phone: "052-111-0015", homepage: "https://test-usedcar.test/" };

  const own = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(company) },
    { homepageProvider: noSearch, fetchImpl: page("문의 master@test-usedcar.test") },
  );
  assert.equal(own.updates.email, "master@test-usedcar.test", "own domain on own site needs nothing more");

  // Another organisation's address on that site needs the company's name and place beside it.
  const vendor = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(company) },
    { homepageProvider: noSearch, fetchImpl: page("Powered by hosting. Contact help@site-builder.test") },
  );
  assert.equal(vendor.updates.email, undefined);

  // A webmail address is how many small businesses publish their contact: kept when shown as theirs.
  const webmail = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(company) },
    { homepageProvider: noSearch, fetchImpl: page("테스트자동차매매상사 대표 문의 testusedcar@naver.com") },
  );
  assert.equal(webmail.updates.email, "testusedcar@naver.com");
  const strayWebmail = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(company) },
    { homepageProvider: noSearch, fetchImpl: page("후기 작성자 somebody@naver.com") },
  );
  assert.equal(strayWebmail.updates.email, undefined, "a webmail address with nothing tying it to the company");
});

test("an address reached through a redirect to another site is judged as that site's", T, async () => {
  const company = { name: "테스트자동차매매상사", address: "울산 북구 시험유통로 15", phone: "052-111-0015", homepage: "https://test-usedcar.test/" };
  const redirected = (text) => async () => {
    const response = new Response(text, { status: 200 });
    Object.defineProperty(response, "url", { value: "https://portal-elsewhere.test/landing" });
    return response;
  };

  const held = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(company) },
    { homepageProvider: noSearch, fetchImpl: redirected("문의 master@test-usedcar.test") },
  );
  assert.equal(held.updates.email, undefined, "served from somewhere else: the stored homepage vouches for nothing");

  const shown = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(company) },
    { homepageProvider: noSearch, fetchImpl: redirected("테스트자동차매매상사 TEL 052-111-0015 문의 master@test-usedcar.test") },
  );
  assert.equal(shown.updates.email, "master@test-usedcar.test");
});

// run #313 row 3072: the row has an official homepage, an unrelated shop's page shares a brand word.
test("another site's own address is not taken because it mentions a word of the company name", T, async () => {
  const company = { companyName: "테스트모터스 울산중부지점", region: "울산", address: "울산 북구 시험포로 175", phone: "052-000-1750" };
  const text = "테스트모터스 차량용품 전문몰 고객센터 이메일 contact@unrelated-shop.test";

  const result = await discoverEmail(company, {
    homepage: "https://www.testmotors-brand.test/",
    searchProvider: oneResult("https://unrelated-shop.test/", text),
    fetchImpl: noFetch,
  });

  assert.equal(result.email, "");
  assert.equal(result.rejectedEmails.includes("contact@unrelated-shop.test"), true);
});

// run #313 row 3046: no homepage, a dealer's site scored 125 on source-domain + a name fragment.
test("with no homepage, a page's own address needs the company's name and place beside it", T, async () => {
  const company = { companyName: "테스트성", region: "울산", address: "울산 북구 시험유통로 95", phone: "052-000-0095" };
  const url = "http://www.other-dealer.test/";

  const held = await discoverEmail(company, {
    searchProvider: oneResult(url, "테스트성 지점 안내 고객지원 support@other-dealer.test"),
    fetchImpl: noFetch,
  });
  assert.equal(held.email, "", "a name fragment and the page's own domain prove nothing");

  const districtOnly = await discoverEmail(company, {
    searchProvider: oneResult(url, "테스트성 울산 북구 고객지원 support@other-dealer.test"),
    fetchImpl: noFetch,
  });
  assert.equal(districtOnly.email, "", "a shared district is not a place");

  const placeWithoutName = await discoverEmail(company, {
    searchProvider: oneResult(url, "입점업체 안내 울산 북구 시험유통로 95 운영자 support@other-dealer.test"),
    fetchImpl: noFetch,
  });
  assert.equal(placeWithoutName.email, "", "a building's address without the company is the operator's footer");

  const shown = await discoverEmail(company, {
    searchProvider: oneResult(url, "테스트성 울산 북구 시험유통로 95 TEL 052-000-0095 support@other-dealer.test"),
    fetchImpl: noFetch,
  });
  assert.equal(shown.email, "support@other-dealer.test");
});

test("an unverified candidate does not end the search before a verified one is reached", T, async () => {
  const company = { companyName: "테스트성", region: "울산", address: "울산 북구 시험유통로 95", phone: "052-000-0095" };
  const queries = [];
  const searchProvider = {
    async search({ query }) {
      queries.push(query);
      if (queries.length === 1) {
        return [{ url: "http://www.other-dealer.test/", title: "t", snippet: "테스트성 고객지원 support@other-dealer.test", source: "x" }];
      }
      return [{ url: "https://real-place.test/", title: "t", snippet: "테스트성 TEL 052-000-0095 문의 hello@real-place.test", source: "x" }];
    },
  };

  const result = await discoverEmail(company, { searchProvider, fetchImpl: noFetch });

  assert.equal(queries.length > 1, true, "the first, unverified hit did not stop the search");
  assert.equal(result.email, "hello@real-place.test");
});

test("an address on the company's domain is recognised once the homepage is confirmed later in the row", T, async () => {
  // The public-web pass sees the address before the row has a homepage; the homepage itself has no
  // address on it. The address must not be lost just because of the order the phases run in.
  const homepageProvider = {
    async search({ query }) {
      if (query) return [{ url: "https://blog-about.test/post", title: "테스트플라워 소개", snippet: "대표메일 hello@test-flower.test", source: "x" }];
      return [{ url: "https://test-flower.test/", title: "테스트플라워 official", snippet: "울산 꽃배달", source: "x" }];
    },
  };
  const fetchImpl = async (url) => new Response(String(url).includes("blog-about") ? "대표메일 hello@test-flower.test" : "", { status: 200 });
  const row = sheetRow({ name: "테스트플라워", address: "", phone: "" });

  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl });

  assert.equal(result.updates.homepage, "https://test-flower.test/");
  assert.equal(result.updates.email, "hello@test-flower.test");
});

// run #313 row 3046, the homepage half: an apartment listing in another city, same short name.
test("a same-name page that places itself in another region is not the company's homepage", () => {
  const company = { companyName: "테스트성", region: "울산", address: "울산 북구 시험유통로 95 (우)44249" };
  const namesake = {
    url: "https://apt-listing.test/%EB%B6%80%EB%8F%99%EC%82%B0/%EA%B4%91%EC%A3%BC-%EB%B6%81%EA%B5%AC-%EC%98%A4%EC%B9%98%EB%8F%99/navvwj",
    title: "테스트성아파트 시세",
    snippet: "북구 오치동 테스트성아파트 실거래가",
    source: "x",
  };

  assert.equal(hasRegionConflict("부동산 광주 북구 오치동", company), true);
  assert.equal(scoreOfficialCandidate(namesake, company), 0, "the region is only in the URL path, and it is the wrong one");
  assert.equal(pickOfficialHomepage([namesake], company), null);

  const sameRegion = { url: "https://test-sung.test/", title: "테스트성 울산 북구", snippet: "울산 북구 자동차", source: "x" };
  assert.equal(pickOfficialHomepage([namesake, sameRegion], company).url, "https://test-sung.test/");
});

test("region conflict needs another region named and ours absent", () => {
  const company = { address: "울산 북구 시험유통로 95", region: "울산" };

  assert.equal(hasRegionConflict("광주 북구 오치동", company), true);
  assert.equal(hasRegionConflict("경기도 수원시", company), true);
  assert.equal(hasRegionConflict("전라남도 여수시", company), true);
  assert.equal(hasRegionConflict("울산 북구 진장동", company), false);
  assert.equal(hasRegionConflict("울산광역시 북구", company), false);
  assert.equal(hasRegionConflict("서울·부산·울산 전국 배송", company), false, "a nationwide business that also names ours");
  assert.equal(hasRegionConflict("북구 맛집", company), false, "no province or city named at all");
  assert.equal(hasRegionConflict("경기장 안내 대전환", company), false, "words that only start with a region name");
  assert.equal(hasRegionConflict("광주 북구", { address: "", region: "" }), false, "nothing known about the company's region");
});

test("the extractor keeps its old behaviour for callers that pass no gate", T, async () => {
  const fetchImpl = page("문의 zeta@site.test 그리고 info@site.test");

  assert.equal((await extractEmailDetails("https://site.test/", { fetchImpl })).email, "info@site.test");

  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    assert.equal(await extractEmail("https://site.test/"), "info@site.test", "the collector's entry point is unchanged");
  } finally {
    globalThis.fetch = realFetch;
  }

  const gated = await extractEmailDetails("https://site.test/", { fetchImpl, accept: ({ email }) => !email.startsWith("info@") });
  assert.equal(gated.email, "zeta@site.test");
  assert.deepEqual(gated.rejectedEmails, ["info@site.test"]);
});
