// Target-ownership contracts. The cases come from the 50-row dry run #313 and from the counter-
// examples raised in review, re-cast with synthetic identities (reserved .test domains, made-up
// names, numbers and addresses). Each asserts on what would be written to the sheet — `updates`.
//
// The rule: an address is written only when it is
//   - on the company's verified domain, for a row that is the company itself; or
//   - printed in a contact card that identifies this business location: its phone number, or its
//     full name together with its street address, from the right region.
// A homepage is "verified" when one of its own pages identifies the company that way, or its host
// is the company's name. Everything else leaves the cell empty.
import assert from "node:assert/strict";
import test from "node:test";

import {
  JobSiteDiscoveryProvider,
  RowExplorationContext,
  cardIdentifiesTarget,
  discoverEmail,
  enrichCandidate,
  hasRegionConflict,
  hostNamesTarget,
  isBranchEntity,
  pageIdentifiesTarget,
  pickOfficialHomepage,
  scoreOfficialCandidate,
  targetPlaceEvidence,
} from "../src/enrich.js";
import { contactCards, extractEmail, extractEmailDetails } from "../src/emailExtractor.js";

// runEnrich/enrichCandidate debug output shares stdout with the runner's framed messages and can
// corrupt them under load; silenced for this file and put back afterwards.
const realConsoleLog = console.log;
test.before(() => {
  console.log = () => {};
});
test.after(() => {
  console.log = realConsoleLog;
});

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
const noFetch = async () => new Response("", { status: 200 });
// One search result whose snippet is `text`; the page body is the same text unless given.
const oneResult = (url, text, body = text) => ({
  async search() {
    return [{ url, title: "TEST_SOURCE", snippet: text, source: "TEST_SOURCE" }];
  },
  async readPageText() {
    return body;
  },
});

const BRANCH = {
  name: "은하자동차 동부지점",
  address: "울산 동구 시험로 10",
  phone: "052-000-0010",
  homepage: "https://www.eunha-brand.test/",
};
const COMPANY = {
  name: "한빛상사",
  address: "울산 북구 시험로 95",
  phone: "052-000-0095",
};
const asCompany = (row) => ({ companyName: row.name, region: "울산", address: row.address, phone: row.phone });

// ------------------------------------------------------------------------------- evidence

test("evidence separates a name from a place, and a fragment from the full name", () => {
  const company = { companyName: "한빛상사", address: "울산 북구 시험유통로 95 (우)44249", phone: "052-123-4567" };
  const ev = (text) => targetPlaceEvidence(text, company);

  assert.equal(ev("한빛상사 대표메일").identifies, false, "a name is not a place");
  assert.equal(ev("TEL 052-123-4567").identifies, true, "the phone number singles out one business");
  assert.equal(ev("TEL 052.123.4567").phone, true);
  assert.equal(ev("TEL 052) 123 4567").phone, true);
  assert.equal(ev("TEL 1052-123-45678").phone, false, "a longer number that merely contains it");
  assert.equal(ev("한빛상사 울산 북구 시험유통로 95").identifies, true, "full name with street address");
  assert.equal(ev("한빛상사 울산 북구 시험유통로95 2층").identifies, true);
  assert.equal(ev("울산 북구 시험유통로 95").identifies, false, "a building's address alone is shared by its tenants");
  assert.equal(ev("한빛상사 울산 북구 시험유통로 950").street, false, "a different building on the same road");
  assert.equal(ev("한빛상사 울산 북구 새시험유통로 95").street, false, "a different road that ends the same way");
  assert.equal(ev("한빛상사 울산 북구 시험유통로").street, false, "the road without the number");
  assert.equal(ev("한빛상사 울산 북구").identifies, false, "a district is not a place");

  const lot = { companyName: "테스트전시장", address: "울산 남구 삼산로 83 (지번) 달동 861-6" };
  assert.equal(targetPlaceEvidence("달동 861-6", lot).street, true);
  assert.equal(targetPlaceEvidence("달동 861", lot).street, false);
  assert.equal(targetPlaceEvidence("TEL 052-123-4567", { companyName: "한빛상사", phone: "1234" }).phone, false, "too short to identify anyone");

  // An address cannot vouch for itself: a domain that resembles the company name is not its name.
  const ascii = { companyName: "Hanbit Sangsa", address: "울산 북구 시험유통로 95" };
  assert.equal(targetPlaceEvidence("울산 북구 시험유통로 95 contact@hanbitsangsa.test", ascii).fullName, false);
  assert.equal(targetPlaceEvidence("Hanbit Sangsa 울산 북구 시험유통로 95 contact@other.test", ascii).identifies, true);
});

test("branch rows are recognised by what they are called", () => {
  for (const name of ["은하자동차 동부지점", "은하자동차 우정대리점", "은하 스타자동차 울산전시장", "은하 서비스센터", "은하 울산영업소", "은하자동차 동부지점(본관)"]) {
    assert.equal(isBranchEntity({ companyName: name }), true, name);
  }
  for (const name of ["한빛자동차매매상사", "중고자동차한빛", "한빛상점", "한빛서점", ""]) {
    assert.equal(isBranchEntity({ companyName: name }), false, name);
  }
});

test("a contact card stops at a region boundary", () => {
  const html =
    "<section><h2>은하자동차 동부지점</h2><p>울산 동구 시험로 10</p><p>TEL 052-000-0010</p><p>E-mail east@eunha-brand.test</p></section>" +
    "<footer><p>Global accessibility: accessibility@overseas.test</p></footer>";

  const branchCard = contactCards(html, "east@eunha-brand.test")[0];
  assert.match(branchCard.text, /052-000-0010/);
  assert.equal(branchCard.text.includes("accessibility"), false, "the footer is not part of the branch card");

  const footerCard = contactCards(html, "accessibility@overseas.test")[0];
  assert.equal(footerCard.text.includes("052-000-0010"), false, "the branch details are not part of the footer card");
  assert.match(footerCard.line, /Global accessibility/);

  // Plain text: a blank line is the boundary.
  const plain = "은하자동차 동부지점\n울산 동구 시험로 10\nTEL 052-000-0010\n\nGlobal support\nhelp@overseas.test";
  assert.equal(contactCards(plain, "help@overseas.test")[0].text.includes("052-000-0010"), false);

  // Every place an address is printed gets its own card.
  const twice = "<footer>문의 info@site.test</footer><section><p>한빛상사 TEL 052-000-0095</p><p>info@site.test</p></section>";
  const cards = contactCards(twice, "info@site.test");
  assert.equal(cards.length, 2);
  assert.equal(cardIdentifiesTarget(cards, asCompany(COMPANY)), true, "the second printing identifies the company");
  assert.equal(cardIdentifiesTarget(cards.slice(0, 1), asCompany(COMPANY)), false);
});

// ------------------------------------------------------------------------------- branch rows

// run #313 rows 3066/3067/3068/3076/3078: five branches, one overseas accessibility mailbox.
test("a brand root's special-purpose mailbox is not written for a branch", T, async () => {
  const fetchImpl = page("Accessibility statement. Contact accessibility@eunha-overseas.test for assistance.");

  const result = await enrichCandidate({ rowNumber: 3066, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl, debug: true });

  assert.equal(result.updates.email, undefined);
  assert.equal(result.debug.rejectedEmails.includes("accessibility@eunha-overseas.test"), true);
});

// run #313 row 3060: same brand, head-office customer centre.
test("the brand's own head-office mailbox is not written for a branch either", T, async () => {
  const result = await enrichCandidate(
    { rowNumber: 3060, row: sheetRow(BRANCH) },
    { homepageProvider: noSearch, fetchImpl: page("은하자동차 고객센터 문의 cs@eunha-brand.test"), debug: true },
  );

  assert.equal(result.updates.email, undefined, "same domain as the homepage, still not this branch's address");
  assert.equal(result.debug.rejectedEmails.includes("cs@eunha-brand.test"), true);
});

// Review counter-example: the branch's own details, then a separate site-wide footer.
test("a footer mailbox next to a branch's details is not the branch's", T, async () => {
  const branchSection = "<section><h2>은하자동차 동부지점</h2><p>울산 동구 시험로 10</p><p>TEL 052-000-0010</p></section>";
  for (const [label, body] of [
    ["separate footer element", `${branchSection}<footer><p>Global accessibility: accessibility@overseas.test</p></footer>`],
    ["footer text with no element of its own", `${branchSection}<p>Global accessibility: accessibility@overseas.test</p>`],
    ["plain text, blank line", "은하자동차 동부지점\n울산 동구 시험로 10\nTEL 052-000-0010\n\n고객지원\naccessibility@overseas.test"],
    ["head office line directly under the branch", "은하자동차 동부지점\n울산 동구 시험로 10\nTEL 052-000-0010\n본사 고객센터 cs@eunha-brand.test"],
  ]) {
    const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl: page(body) });
    assert.equal(result.updates.email, undefined, label);
  }
});

test("a branch contact card with the branch's own phone, or full name and address, is written", T, async () => {
  for (const [label, card, expected] of [
    ["phone, brand domain", "<li>동부지점 TEL 052-000-0010 E-mail east@eunha-brand.test</li>", "east@eunha-brand.test"],
    ["full name + street, brand domain", "<li>은하자동차 동부지점 울산 동구 시험로 10 E-mail east@eunha-brand.test</li>", "east@eunha-brand.test"],
    // A dealer is often a separate company with its own domain: allowed once the place is shown.
    ["phone, dealer's own domain", "<li>은하자동차 동부지점 TEL 052-000-0010 E-mail info@east-dealer.test</li>", "info@east-dealer.test"],
    ["card spread over lines", "<div><p>은하자동차 동부지점</p><p>TEL 052-000-0010</p><p>east@eunha-brand.test</p></div>", "east@eunha-brand.test"],
  ]) {
    const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl: page(card) });
    assert.equal(result.updates.email, expected, label);
    assert.equal(result.stopReason, "email_found_fast_path", label);
  }

  // The street address alone is not enough: other outlets and tenants share a building.
  const shared = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(BRANCH) },
    { homepageProvider: noSearch, fetchImpl: page("<li>울산 동구 시험로 10 입점 안내 E-mail mall@eunha-brand.test</li>") },
  );
  assert.equal(shared.updates.email, undefined);
});

test("a wrong address on the first page does not hide the right one on a later page", T, async () => {
  const fetchImpl = async (url) =>
    new Response(
      String(url).endsWith("/contact")
        ? "<li>동부지점 TEL 052-000-0010 E-mail east@eunha-brand.test</li>"
        : "Global support info@eunha-overseas.test",
      { status: 200 },
    );

  const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl, debug: true });

  // "info@" is the extractor's most preferred prefix and used to end the crawl on page one.
  assert.equal(result.updates.email, "east@eunha-brand.test");
  assert.equal(result.debug.rejectedEmails.includes("info@eunha-overseas.test"), true);
  assert.equal(result.debug.selectedEmailSourceReason.includes("/contact"), true, "the debug names the page it came from");
});

// ------------------------------------------------------------------------------- homepages

test("a stored homepage is trusted only after its own pages identify the company", T, async () => {
  const stored = { ...COMPANY, homepage: "https://hanbit-site.test/" };

  // Review counter-example: a wrong homepage on the row, with that site's own address on it.
  const wrong = await enrichCandidate(
    { rowNumber: 2, row: sheetRow({ ...COMPANY, homepage: "https://wrong.test/" }) },
    { homepageProvider: noSearch, fetchImpl: page("다른 업체 대표 문의 support@wrong.test"), debug: true },
  );
  assert.equal(wrong.updates.email, undefined, "the row's homepage value proves nothing about the site");
  assert.equal(wrong.debug.homepageVerified, false);

  const identified = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(stored) },
    { homepageProvider: noSearch, fetchImpl: page("<footer>한빛상사 울산 북구 시험로 95 TEL 052-000-0095</footer><p>문의 master@hanbit-site.test</p>"), debug: true },
  );
  assert.equal(identified.updates.email, "master@hanbit-site.test", "the site identifies the company; its own-domain address is the company's");
  assert.equal(identified.debug.homepageVerified, true);

  // The identifying page can come after the page that printed the address.
  const later = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(stored) },
    {
      homepageProvider: noSearch,
      fetchImpl: async (url) =>
        new Response(String(url).endsWith("/about") ? "한빛상사 울산 북구 시험로 95 TEL 052-000-0095" : "문의 master@hanbit-site.test", { status: 200 }),
    },
  );
  assert.equal(later.updates.email, "master@hanbit-site.test");

  // Another organisation's address on a verified site still needs its own card.
  const vendor = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(stored) },
    { homepageProvider: noSearch, fetchImpl: page("<footer>한빛상사 울산 북구 시험로 95 TEL 052-000-0095</footer><p>Powered by help@site-builder.test</p>") },
  );
  assert.equal(vendor.updates.email, undefined);
});

test("a host that is the company's name verifies the site; a branch row never qualifies", T, async () => {
  assert.equal(hostNamesTarget("acme-flower.test", { companyName: "Acme Flower" }), true);
  assert.equal(hostNamesTarget("www.acmeflower.co.kr", { companyName: "Acme Flower" }), true);
  assert.equal(hostNamesTarget("flower-mall.test", { companyName: "Acme Flower" }), false);
  assert.equal(hostNamesTarget("acme.test", { companyName: "Acme" }), false, "too short to be distinctive");
  assert.equal(hostNamesTarget("hanbit.test", { companyName: "한빛상사" }), false, "a Korean name is not in a host");
  assert.equal(hostNamesTarget("eunha-brand.test", { companyName: "eunha brand 동부지점" }), false);

  const result = await enrichCandidate(
    { rowNumber: 2, row: sheetRow({ name: "Acme Flower", homepage: "https://acme-flower.test/" }) },
    { homepageProvider: noSearch, fetchImpl: page("문의 info@acme-flower.test") },
  );
  assert.equal(result.updates.email, "info@acme-flower.test");
});

test("an address reached through a redirect to another site is judged as that site's", T, async () => {
  const stored = { ...COMPANY, homepage: "https://hanbit-site.test/" };
  const redirected = (text) => async () => {
    const response = new Response(text, { status: 200 });
    Object.defineProperty(response, "url", { value: "https://portal-elsewhere.test/landing" });
    return response;
  };

  const held = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(stored) },
    { homepageProvider: noSearch, fetchImpl: redirected("한빛상사 소개 문의 master@hanbit-site.test"), debug: true },
  );
  assert.equal(held.updates.email, undefined, "served from somewhere else: the stored homepage vouches for nothing");
  assert.equal(held.debug.homepageVerified, false, "and a page on another site cannot verify this one");

  const shown = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(stored) },
    { homepageProvider: noSearch, fetchImpl: redirected("<li>한빛상사 TEL 052-000-0095 문의 master@hanbit-site.test</li>") },
  );
  assert.equal(shown.updates.email, "master@hanbit-site.test", "its own contact card still identifies the company");
});

// Review counter-example: a same-region namesake wins the homepage search, and the re-check then
// promotes that site's address.
test("a same-region namesake is neither written as the homepage nor trusted for its address", T, async () => {
  const company = { name: "한빛자동차", address: "울산 북구 시험로 95", phone: "052-000-0095" };
  const namesake = { url: "https://housing.test/", title: "울산 북구 한빛아파트", snippet: "울산 북구 한빛 분양 문의 info@housing.test", source: "x" };
  const homepageProvider = {
    async search() {
      return [namesake];
    },
    async readPageText() {
      return "울산 북구 한빛아파트 분양 문의 info@housing.test";
    },
  };

  const result = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(company) },
    { homepageProvider, fetchImpl: page("울산 북구 한빛아파트 분양 문의 info@housing.test"), maxSearchQueries: 8, debug: true },
  );

  assert.equal(result.updates.homepage, undefined, "a good search score is a lead, not a homepage");
  assert.equal(result.updates.email, undefined);
  assert.equal(result.homepageUpdated, false);
  assert.equal(result.debug.unverifiedHomepage, "https://housing.test/");
});

test("a homepage proposed by search is written once its own pages identify the company", T, async () => {
  const company = { name: "한빛자동차", address: "울산 북구 시험로 95", phone: "052-000-0095" };
  const calls = { emailQueries: 0, homepageSearches: 0 };
  const homepageProvider = {
    async search({ query }) {
      if (query) {
        calls.emailQueries += 1;
        return [];
      }
      calls.homepageSearches += 1;
      return [{ url: "https://hanbit-motors.test/", title: "한빛자동차 울산 북구", snippet: "울산 북구 자동차", source: "x" }];
    },
  };
  const fetchImpl = page("<footer>한빛자동차 울산 북구 시험로 95 TEL 052-000-0095 문의 sales@hanbit-motors.test</footer>");

  // The real default budget: the email phases may not spend the units the homepage search needs.
  const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(company) }, { homepageProvider, fetchImpl, maxSearchQueries: 8 });

  assert.equal(calls.homepageSearches, 1, "the held-back units were spent on the homepage search");
  assert.equal(calls.emailQueries + calls.homepageSearches <= 8, true, "the total stays inside the budget");
  assert.equal(result.updates.homepage, "https://hanbit-motors.test/");
  assert.equal(result.updates.email, "sales@hanbit-motors.test");
  assert.equal(result.stopReason, "email_found_homepage");
});

test("an address seen before the homepage was verified is recognised afterwards", T, async () => {
  // The public-web pass sees the address before the row has a homepage; the homepage itself prints
  // no address. The address must not be lost just because of the order the phases run in.
  const homepageProvider = {
    async search({ query }) {
      if (query) return [{ url: "https://blog-about.test/post", title: "Acme Flower 소개", snippet: "대표메일 hello@acme-flower.test", source: "x" }];
      return [{ url: "https://acme-flower.test/", title: "Acme Flower official", snippet: "울산 꽃배달", source: "x" }];
    },
  };
  const fetchImpl = async (url) => new Response(String(url).includes("blog-about") ? "대표메일 hello@acme-flower.test" : "", { status: 200 });

  const result = await enrichCandidate(
    { rowNumber: 2, row: sheetRow({ name: "Acme Flower" }) },
    { homepageProvider, fetchImpl, maxSearchQueries: 8, debug: true },
  );

  assert.equal(result.updates.homepage, "https://acme-flower.test/", "verified by its host being the company's name");
  assert.equal(result.updates.email, "hello@acme-flower.test");
  assert.equal(result.debug.rejectedEmails.includes("hello@acme-flower.test"), false, "no longer listed as rejected");
});

// ------------------------------------------------------------------------------- public web

// run #313 row 3072: the row has an official homepage; an unrelated shop's page shares a brand word.
test("another site's own address is not taken because it mentions a word of the company name", T, async () => {
  const text = "은하자동차 차량용품 전문몰 고객센터 이메일 contact@unrelated-shop.test";

  const result = await discoverEmail(asCompany(BRANCH), {
    homepage: BRANCH.homepage,
    searchProvider: oneResult("https://unrelated-shop.test/", text),
    fetchImpl: noFetch,
  });

  assert.equal(result.email, "");
  assert.equal(result.rejectedEmails.includes("contact@unrelated-shop.test"), true);
});

// Review counter-example: a tenant's name, address and phone, then the portal operator's footer.
test("a portal operator's footer under a tenant's listing is not the tenant's address", T, async () => {
  const listing = "<article><h3>한빛상사</h3><p>울산 북구 시험로 95</p><p>TEL 052-000-0095</p></article>";
  for (const [label, body] of [
    ["footer element", `${listing}<footer><p>사이트 문의 contact@portal.test</p></footer>`],
    ["operator line, no element of its own", `${listing}<p>운영자 문의 contact@portal.test</p>`],
  ]) {
    const result = await discoverEmail(asCompany(COMPANY), {
      searchProvider: oneResult("https://portal.test/tenants/hanbit", "한빛상사 입점업체 안내", body),
      fetchImpl: noFetch,
    });
    assert.equal(result.email, "", label);
  }

  const own = await discoverEmail(asCompany(COMPANY), {
    searchProvider: oneResult(
      "https://portal.test/tenants/hanbit",
      "한빛상사 입점업체 안내",
      "<article><h3>한빛상사</h3><p>TEL 052-000-0095</p><p>E-mail hanbit@tenant-mail.test</p></article><footer>contact@portal.test</footer>",
    ),
    fetchImpl: noFetch,
  });
  assert.equal(own.email, "hanbit@tenant-mail.test", "the address inside the tenant's own card is the tenant's");
});

// run #313 row 3046, and the review counter-example about a namesake road in another region.
test("with no homepage, only a card that identifies this place is accepted", T, async () => {
  const company = asCompany(COMPANY);
  const url = "http://www.other-dealer.test/";
  const pick = async (text) => (await discoverEmail(company, { searchProvider: oneResult(url, text), fetchImpl: noFetch })).email;

  assert.equal(await pick("한빛상사 지점 안내 고객지원 support@other-dealer.test"), "", "a name and the page's own domain prove nothing");
  assert.equal(await pick("한빛상사 울산 북구 고객지원 support@other-dealer.test"), "", "a shared district is not a place");
  assert.equal(await pick("입점업체 안내 울산 북구 시험로 95 support@other-dealer.test"), "", "a building address without the company");
  assert.equal(await pick("한빛 자동차 울산 북구 시험로 95 support@other-dealer.test"), "", "a name fragment at a shared building");
  assert.equal(await pick("한빛상사 부산 북구 시험로 95 문의 support@other-dealer.test"), "", "the same road and number in another city");
  assert.equal(await pick("한빛상사 울산 북구 시험로 95 문의 support@other-dealer.test"), "support@other-dealer.test");
  assert.equal(await pick("한빛상사 대표번호 052-000-0095 문의 support@other-dealer.test"), "support@other-dealer.test", "its phone number, with the company named");
  // The older rule still applies on top: a page that never mentions the company at all is not
  // about it, whatever number it prints.
  assert.equal(await pick("대표번호 052-000-0095 문의 support@other-dealer.test"), "");
});

test("an unverified candidate does not end the search before a verified one is reached", T, async () => {
  const queries = [];
  const searchProvider = {
    async search({ query }) {
      queries.push(query);
      if (queries.length === 1) {
        return [{ url: "http://www.other-dealer.test/", title: "t", snippet: "한빛상사 고객지원 support@other-dealer.test", source: "x" }];
      }
      return [{ url: "https://real-place.test/", title: "t", snippet: "한빛상사 TEL 052-000-0095 문의 hello@real-place.test", source: "x" }];
    },
  };

  const result = await discoverEmail(asCompany(COMPANY), { searchProvider, fetchImpl: noFetch });

  assert.equal(queries.length > 1, true, "the first, unverified hit did not stop the search");
  assert.equal(result.email, "hello@real-place.test");
});

// Review counter-example: a recruiter's webmail on a job posting that only names the brand.
test("a published webmail contact goes through the same gate as any other address", T, async () => {
  const discover = (body) =>
    new JobSiteDiscoveryProvider({
      searchProvider: {
        async search() {
          return [{ url: "https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=1", title: "은하자동차 채용", snippet: "채용 담당자 문의", source: "x" }];
        },
      },
      fetchImpl: page(body),
    }).discover(asCompany(BRANCH));

  const brandOnly = await discover("은하자동차 채용 담당자 이메일 hr.example@gmail.com");
  assert.equal(brandOnly.email, "", "being a published contact does not make it this branch's");

  const branchCard = await discover("은하자동차 동부지점 TEL 052-000-0010 채용 담당자 이메일 hr.example@gmail.com");
  assert.equal(branchCard.email, "hr.example@gmail.com");
  assert.equal(branchCard.emailKind, "published_contact");
});

// ------------------------------------------------------------------------------- search budget

test("search units are held back for the homepage search and never exceed the budget", T, async () => {
  for (const [max, expectHomepageSearch] of [
    [0, true],
    [1, false],
    [2, true],
    [3, true],
    [8, true],
  ]) {
    const calls = { emailQueries: 0, homepageSearches: 0 };
    const homepageProvider = {
      async search({ query }) {
        if (query) calls.emailQueries += 1;
        else calls.homepageSearches += 1;
        return [];
      },
    };
    await enrichCandidate({ rowNumber: 2, row: sheetRow(COMPANY) }, { homepageProvider, fetchImpl: noFetch, maxSearchQueries: max });

    const total = calls.emailQueries + calls.homepageSearches;
    if (max > 0) assert.equal(total <= max, true, `max=${max}: ${total} requests`);
    assert.equal(calls.homepageSearches, expectHomepageSearch ? 1 : 0, `max=${max}: homepage search`);
    if (max === 8) assert.equal(calls.emailQueries, 6, "the email phases get the rest");
  }

  // A row that already has a homepage holds nothing back.
  const calls = { queries: 0 };
  await enrichCandidate(
    { rowNumber: 2, row: sheetRow({ ...COMPANY, homepage: "https://hanbit-site.test/" }) },
    { homepageProvider: { async search() { calls.queries += 1; return []; } }, fetchImpl: noFetch, maxSearchQueries: 8 },
  );
  assert.equal(calls.queries, 8);
});

test("a query the budget refused is not remembered as searched-and-empty", T, async () => {
  const ctx = new RowExplorationContext({ maxSearchQueries: 2 });
  ctx.homepageSearchReserve = 1;
  let runs = 0;
  const runner = async () => {
    if (!ctx.reserveSearch()) return [];
    runs += 1;
    return [];
  };

  await ctx.cachedSearch("first", runner);
  await ctx.cachedSearch("second", runner);
  assert.equal(runs, 1, "the second query was refused: one unit is held back");

  ctx.homepageSearchReserve = 0;
  await ctx.cachedSearch("second", runner);
  assert.equal(runs, 2, "released budget lets the refused query run");
  await ctx.cachedSearch("first", runner);
  assert.equal(runs, 2, "a query that really ran and found nothing is still cached");
  ctx.cleanup();
});

// ------------------------------------------------------------------------------- homepage choice

// run #313 row 3046, the homepage half: an apartment listing in another city, same short name.
test("a same-name page that places itself in another region is not the company's homepage", () => {
  const company = { companyName: "한빛", region: "울산", address: "울산 북구 시험유통로 95 (우)44249" };
  const namesake = {
    url: "https://apt-listing.test/%EB%B6%80%EB%8F%99%EC%82%B0/%EA%B4%91%EC%A3%BC-%EB%B6%81%EA%B5%AC-%EC%98%A4%EC%B9%98%EB%8F%99/navvwj",
    title: "한빛아파트 시세",
    snippet: "북구 오치동 한빛아파트 실거래가",
    source: "x",
  };

  assert.equal(scoreOfficialCandidate(namesake, company), 0, "the region is only in the URL path, and it is the wrong one");
  assert.equal(pickOfficialHomepage([namesake], company), null);

  const sameRegion = { url: "https://hanbit-ulsan.test/", title: "한빛 울산 북구", snippet: "울산 북구 자동차", source: "x" };
  assert.equal(pickOfficialHomepage([namesake, sameRegion], company).url, "https://hanbit-ulsan.test/");
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

  assert.equal(pageIdentifiesTarget("한빛상사 부산 북구 시험로 95 TEL 051-000-0000", asCompany(COMPANY)), false);
  assert.equal(pageIdentifiesTarget("<p>한빛상사</p><p>울산 북구 시험로 95</p>", asCompany(COMPANY)), true);
});

// ------------------------------------------------------------------------------- extractor

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

  const pages = [];
  const gated = await extractEmailDetails("https://site.test/", {
    fetchImpl,
    accept: ({ email }) => !email.startsWith("info@"),
    onPage: ({ url }) => pages.push(url),
  });
  assert.equal(gated.email, "zeta@site.test");
  assert.equal(gated.emailSourceUrl, "https://site.test/");
  assert.deepEqual(gated.rejectedEmails, ["info@site.test"]);
  assert.equal(pages.length > 0, true);
});
