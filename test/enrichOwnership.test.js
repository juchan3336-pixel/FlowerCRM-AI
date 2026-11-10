// Target-ownership contracts. The cases come from the 50-row dry run #313 and from the counter-
// examples raised in review, re-cast with synthetic identities (reserved .test domains, made-up
// names, numbers and addresses). Each asserts on what would be written to the sheet — `updates`.
//
// The rule: an address is written only when it is printed in a contact card that identifies this
// business location — its phone number, or its full name together with its street address, from
// the right region. There is no exception for the domain the address is on: the row's homepage, a
// search hit and a host that spells the company's name were each shown to accept someone else's
// address. A homepage proposed during the run is written only when its own root pages identify
// the company. Everything else leaves the cell empty.
import assert from "node:assert/strict";
import test from "node:test";

import {
  JobSiteDiscoveryProvider,
  PlaywrightHomepageSearchProvider,
  RowExplorationContext,
  cardIdentifiesTarget,
  discoverEmail,
  enrichCandidate,
  hasRegionConflict,
  isBranchEntity,
  pageIdentifiesTarget,
  pickOfficialHomepage,
  scoreOfficialCandidate,
  siteOperatorIsTarget,
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

test("a homepage on the row lends its domain to nothing; only the card decides", T, async () => {
  const stored = { ...COMPANY, homepage: "https://hanbit-site.test/" };
  const crawl = (homepage, body) =>
    enrichCandidate({ rowNumber: 2, row: sheetRow({ ...COMPANY, homepage }) }, { homepageProvider: noSearch, fetchImpl: page(body), debug: true });

  // Review counter-example: a wrong homepage on the row, with that site's own address on it.
  const wrong = await crawl("https://wrong.test/", "다른 업체 대표 문의 support@wrong.test");
  assert.equal(wrong.updates.email, undefined, "the row's homepage value proves nothing about the site");

  // Review counter-example: the row's homepage is a portal page that lists the company. The page
  // identifies the company; the footer address is still the portal operator's.
  const portal = await crawl(
    "https://portal.test/",
    "<article><h3>한빛상사</h3><p>울산 북구 시험로 95</p><p>TEL 052-000-0095</p></article><footer>운영자 문의 contact@portal.test</footer>",
  );
  assert.equal(portal.updates.email, undefined, "a page that describes the company does not make the site the company's");
  const portalPlain = await crawl(
    "https://portal.test/",
    "<article><h3>한빛상사</h3><p>울산 북구 시험로 95</p><p>TEL 052-000-0095</p></article><footer>contact@portal.test</footer>",
  );
  assert.equal(portalPlain.updates.email, undefined, "with or without a word that names the operator");

  // Even on the company's real site, an address away from the identifying card is not taken.
  const apart = await crawl(stored.homepage, "<footer>한빛상사 울산 북구 시험로 95 TEL 052-000-0095</footer><p>문의 master@hanbit-site.test</p>");
  assert.equal(apart.updates.email, undefined);
  const vendor = await crawl(stored.homepage, "<footer>한빛상사 울산 북구 시험로 95 TEL 052-000-0095</footer><p>Powered by help@site-builder.test</p>");
  assert.equal(vendor.updates.email, undefined);

  // The usual company footer — name, address, phone and e-mail together — is what is accepted.
  const footer = await crawl(stored.homepage, "<footer>한빛상사 울산 북구 시험로 95 TEL 052-000-0095 E-mail master@hanbit-site.test</footer>");
  assert.equal(footer.updates.email, "master@hanbit-site.test");
  assert.equal(footer.debug.selectedEmailScoreReason, "homepage-extraction+contact-card");
  const stacked = await crawl(stored.homepage, "<address><p>한빛상사</p><p>TEL 052-000-0095</p><p>master@hanbit-site.test</p></address>");
  assert.equal(stacked.updates.email, "master@hanbit-site.test", "a card spread over a few lines");
});

// Review counter-example: a host that spells the company's name, on a site that says it is elsewhere.
test("a host that matches the company's name is not evidence, least of all against the page itself", T, async () => {
  const row = sheetRow({ name: "Acme Flower", address: "울산 남구 시험로 7", phone: "052-000-0007", homepage: "https://acme-flower.test/" });
  const crawl = (body) => enrichCandidate({ rowNumber: 2, row }, { homepageProvider: noSearch, fetchImpl: page(body) });

  const elsewhere = await crawl("<h1>Acme Flower</h1><p>부산 해운대구 다른로 22</p><footer>info@acme-flower.test</footer>");
  assert.equal(elsewhere.updates.email, undefined, "a namesake in another city");

  const bare = await crawl("문의 info@acme-flower.test");
  assert.equal(bare.updates.email, undefined, "the matching host alone decides nothing");

  const wrongCityCard = await crawl("<footer>Acme Flower 부산 남구 시험로 7 E-mail info@acme-flower.test</footer>");
  assert.equal(wrongCityCard.updates.email, undefined, "the same road and number in another city");

  const shown = await crawl("<footer>Acme Flower TEL 052-000-0007 E-mail info@acme-flower.test</footer>");
  assert.equal(shown.updates.email, "info@acme-flower.test");
});

// Review counter-example: sibling list items are separate businesses.
test("one list item's phone number does not vouch for the next item's address", T, async () => {
  const branch = { name: "한빛자동차 북부지점", address: "울산 북구 시험로 95", phone: "052-000-0095", homepage: "https://dealers.test/" };
  const crawl = (body) => enrichCandidate({ rowNumber: 2, row: sheetRow(branch) }, { homepageProvider: noSearch, fetchImpl: page(body) });

  const siblings = await crawl(
    "<ul><li>한빛자동차 북부지점 TEL 052-000-0095</li><li>다른자동차 남부지점 TEL 052-000-0088 E-mail south@other-dealer.test</li></ul>",
  );
  assert.equal(siblings.updates.email, undefined);

  const rows = await crawl(
    "<table><tr><td>한빛자동차 북부지점</td><td>052-000-0095</td></tr><tr><td>다른자동차 남부지점</td><td>south@other-dealer.test</td></tr></table>",
  );
  assert.equal(rows.updates.email, undefined, "table rows likewise");

  const ownItem = await crawl(
    "<ul><li>다른자동차 남부지점 TEL 052-000-0088 E-mail south@other-dealer.test</li><li>한빛자동차 북부지점 TEL 052-000-0095 E-mail north@dealers.test</li></ul>",
  );
  assert.equal(ownItem.updates.email, "north@dealers.test", "its own item is still read");
  const ownRow = await crawl(
    "<table><tr><td>한빛자동차 북부지점</td><td>052-000-0095</td><td>north@dealers.test</td></tr></table>",
  );
  assert.equal(ownRow.updates.email, "north@dealers.test", "cells of one row belong together");
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

test("a row that finds its email first still gets a proposed homepage checked and written", T, async () => {
  const company = { name: "한빛자동차", address: "울산 북구 시험로 95", phone: "052-000-0095" };
  const fetched = [];
  const homepageProvider = {
    async search({ query }) {
      if (query) return [{ url: "https://blog-about.test/post", title: "한빛자동차 소개", snippet: "한빛자동차 TEL 052-000-0095 대표메일 hello@hanbit-motors.test", source: "x" }];
      return [{ url: "https://hanbit-motors.test/", title: "한빛자동차 울산 북구", snippet: "울산 북구 자동차", source: "x" }];
    },
  };
  const fetchImpl = async (url) => {
    fetched.push(String(url));
    return new Response(String(url).includes("hanbit-motors") ? "<footer>한빛자동차 울산 북구 시험로 95</footer>" : "", { status: 200 });
  };

  const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(company) }, { homepageProvider, fetchImpl, maxSearchQueries: 8 });

  assert.equal(result.updates.email, "hello@hanbit-motors.test", "accepted by its own card on the blog");
  assert.equal(result.stopReason, "email_found_public_web");
  assert.equal(result.updates.homepage, "https://hanbit-motors.test/", "one request to the root confirmed the proposal");
  assert.equal(fetched.filter((url) => url.includes("hanbit-motors")).length, 1, "and only one");
});

// Review counter-example: the page that would confirm the proposal arrives after the row's deadline.
test("a page that identifies the company after the deadline confirms nothing", T, async () => {
  let clock = 0;
  const homepageProvider = {
    async findOfficial() {
      const official = { url: "https://candidate.test/", score: 40 };
      return { official, failures: [], candidates: [official], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  const fetchImpl = async () => {
    clock = 1001;
    return new Response("<footer>한빛상사 울산 북구 시험로 95 TEL 052-000-0095 E-mail master@candidate.test</footer>", { status: 200 });
  };

  const result = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(COMPANY) },
    { homepageProvider, fetchImpl, maxRuntimeMs: 1000, now: () => clock, debug: true },
  );

  assert.equal(result.stopReason, "budget_time");
  assert.equal(result.updates.homepage, undefined, "identified too late to count");
  assert.equal(result.updates.email, undefined);
  assert.equal(result.homepageUpdated, false);
  assert.equal(result.debug.unverifiedHomepage, "https://candidate.test/");
});

// Review counter-example: a deep page inside someone else's site that describes the company.
test("a proposed homepage that is not a site root is never written", T, async () => {
  const homepageProvider = {
    async findOfficial() {
      const official = { url: "https://portal.test/tenants/hanbit", score: 40 };
      return { official, failures: [], candidates: [official], searchEvents: [] };
    },
    async search() {
      return [];
    },
  };
  const fetchImpl = page("<article><h3>한빛상사</h3><p>울산 북구 시험로 95</p><p>TEL 052-000-0095</p></article><footer>contact@portal.test</footer>");

  const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(COMPANY) }, { homepageProvider, fetchImpl, debug: true });

  assert.equal(result.updates.homepage, undefined);
  assert.equal(result.updates.email, undefined);
  assert.equal(result.debug.unverifiedHomepage, "https://portal.test/tenants/hanbit");
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

// ------------------------------------------------------------------------------- review round 8

const NORTH = { name: "한빛자동차 북부지점", address: "울산 북구 시험로 95", phone: "052-000-0095" };

// Adjacent blocks: the business above ends where its phone number is; nothing above that line
// speaks for the address below.
test("a neighbouring block's phone number is not borrowed, whatever the markup", T, async () => {
  const crawl = (body) =>
    enrichCandidate({ rowNumber: 2, row: sheetRow({ ...NORTH, homepage: "https://dealers.test/" }) }, { homepageProvider: noSearch, fetchImpl: page(body) });

  for (const [label, body] of [
    [
      "sibling div cards",
      "<div class=dealer-card><p>한빛자동차 북부지점</p><p>TEL 052-000-0095</p></div><div class=dealer-card><p>다른자동차 남부지점 TEL 052-000-0088 E-mail south@other-dealer.test</p></div>",
    ],
    [
      "sibling div cards, the second one stacked",
      "<div><p>한빛자동차 북부지점</p><p>TEL 052-000-0095</p></div><div><p>다른자동차 남부지점</p><p>TEL 052-000-0088</p><p>south@other-dealer.test</p></div>",
    ],
    ["flattened text, one line each", "한빛자동차 북부지점 TEL 052-000-0095\n다른자동차 남부지점 TEL 052-000-0088 E-mail south@other-dealer.test"],
    ["flattened text, stacked", "한빛자동차 북부지점\nTEL 052-000-0095\n다른자동차 남부지점\nTEL 052-000-0088\nsouth@other-dealer.test"],
    ["the other business has no phone of its own", "한빛자동차 북부지점 TEL 052-000-0095\n다른자동차 남부지점 E-mail south@other-dealer.test"],
  ]) {
    assert.equal((await crawl(body)).updates.email, undefined, label);
  }

  for (const [label, body] of [
    ["its own div card", "<div><p>다른자동차 남부지점 TEL 052-000-0088</p></div><div><p>한빛자동차 북부지점</p><p>TEL 052-000-0095</p><p>north@dealers.test</p></div>"],
    ["its own lines in flattened text", "다른자동차 남부지점\nTEL 052-000-0088\nsouth@other-dealer.test\n한빛자동차 북부지점\nTEL 052-000-0095\nnorth@dealers.test"],
    ["phone and fax on one line", "한빛자동차 북부지점\nTEL 052-000-0095 FAX 052-000-0096 E-mail north@dealers.test"],
  ]) {
    assert.equal((await crawl(body)).updates.email, "north@dealers.test", label);
  }
});

// The production page reader flattens a page to innerText plus its links. Driven here through the
// real provider and its real evaluate callback; only the browser is a stub.
test("the real page reader's flattened text does not merge two businesses", T, async () => {
  const flattened = (bodyText) => {
    const provider = new PlaywrightHomepageSearchProvider();
    const fakePage = {
      async goto() {},
      async $$eval() {
        return [];
      },
      // Runs the provider's own callback against a minimal document.
      async evaluate(callback) {
        const previous = globalThis.document;
        globalThis.document = { body: { innerText: bodyText }, querySelectorAll: () => [] };
        try {
          return callback();
        } finally {
          globalThis.document = previous;
        }
      },
    };
    provider.browserPromise = Promise.resolve({
      async newContext() {
        return { newPage: async () => fakePage, close: async () => {} };
      },
      async close() {},
    });
    return {
      async search() {
        return [{ url: "https://dealers.test/list", title: "한빛자동차 지점 안내", snippet: "울산 지점 목록", source: "x" }];
      },
      readPageText: (url, options) => provider.readPageText(url, options),
    };
  };
  const company = asCompany(NORTH);

  const merged = await discoverEmail(company, {
    searchProvider: flattened("한빛자동차 북부지점\nTEL 052-000-0095\n다른자동차 남부지점\nTEL 052-000-0088 E-mail south@other-dealer.test"),
    fetchImpl: noFetch,
  });
  assert.equal(merged.email, "", "the other dealer's address is not taken for this branch");
  assert.equal(merged.rejectedEmails.includes("south@other-dealer.test"), true);

  const own = await discoverEmail(company, {
    searchProvider: flattened("다른자동차 남부지점\nTEL 052-000-0088\n한빛자동차 북부지점\nTEL 052-000-0095\nE-mail north@dealers.test"),
    fetchImpl: noFetch,
  });
  assert.equal(own.email, "north@dealers.test");
});

// A page showing the company is not the site saying it is the company.
test("a proposed homepage is written only when the site's own footer names the company", T, async () => {
  const listing = "<article><h3>한빛상사</h3><p>울산 북구 시험로 95</p><p>TEL 052-000-0095</p></article>";
  const propose = (url) => ({
    async findOfficial() {
      const official = { url, score: 40 };
      return { official, failures: [], candidates: [official], searchEvents: [] };
    },
    async search() {
      return [];
    },
  });
  const run = (url, body) =>
    enrichCandidate({ rowNumber: 2, row: sheetRow(COMPANY) }, { homepageProvider: propose(url), fetchImpl: page(body), debug: true });

  // Review counter-example: a portal's root page featuring the company.
  const portalRoot = await run("https://portal.test/", `${listing}<footer>운영자 문의 contact@portal.test</footer>`);
  assert.equal(portalRoot.updates.homepage, undefined, "the portal is not the company's homepage");
  assert.equal(portalRoot.updates.email, undefined);
  assert.equal(portalRoot.debug.unverifiedHomepage, "https://portal.test/");

  const portalOwnFooter = await run("https://portal.test/", `${listing}<footer>포털운영㈜ 서울 강남구 다른로 1 TEL 02-000-0000</footer>`);
  assert.equal(portalOwnFooter.updates.homepage, undefined, "its footer names the portal, not the company");

  const noFooter = await run("https://unknown.test/", listing);
  assert.equal(noFooter.updates.homepage, undefined, "nothing on the site says who runs it");

  const elsewhere = await run("https://hanbit-busan.test/", "<footer>한빛상사 부산 북구 시험로 95 TEL 051-000-0000</footer>");
  assert.equal(elsewhere.updates.homepage, undefined, "a namesake's own site, in another city");

  const own = await run("https://hanbit-site.test/", "<main>환영합니다</main><footer>한빛상사 울산 북구 시험로 95 TEL 052-000-0095</footer>");
  assert.equal(own.updates.homepage, "https://hanbit-site.test/");
  assert.equal(own.updates.email, undefined, "a homepage without an address is still a homepage");

  const ownAddressBlock = await run("https://hanbit-site.test/", "<address>한빛상사<br>TEL 052-000-0095</address>");
  assert.equal(ownAddressBlock.updates.homepage, "https://hanbit-site.test/");

  assert.equal(siteOperatorIsTarget(`${listing}<footer>contact@portal.test</footer>`, asCompany(COMPANY)), false);
  assert.equal(siteOperatorIsTarget("<footer>한빛상사 TEL 052-000-0095</footer>", asCompany(COMPANY)), true);
});

test("the one-request check after an email-first row applies the same footer rule", T, async () => {
  const homepageProvider = {
    async search({ query }) {
      if (query) return [{ url: "https://blog-about.test/post", title: "한빛상사 소개", snippet: "한빛상사 TEL 052-000-0095 대표메일 hello@hanbit-mail.test", source: "x" }];
      return [{ url: "https://portal.test/", title: "한빛상사 울산 북구", snippet: "울산 북구 입점업체", source: "x" }];
    },
  };
  const fetchImpl = async (url) =>
    new Response(
      String(url).includes("portal.test")
        ? "<article><h3>한빛상사</h3><p>울산 북구 시험로 95</p><p>TEL 052-000-0095</p></article><footer>운영자 문의 contact@portal.test</footer>"
        : "",
      { status: 200 },
    );

  const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(COMPANY) }, { homepageProvider, fetchImpl, maxSearchQueries: 8, debug: true });

  assert.equal(result.updates.email, "hello@hanbit-mail.test");
  assert.equal(result.updates.homepage, undefined, "the portal that lists the company is not written as its homepage");
  assert.equal(result.debug.unverifiedHomepage, "https://portal.test/");
});
