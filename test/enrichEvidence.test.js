// Every written email carries the evidence that let it through: which fact of the row matched
// (its phone number, or its full name with its street address), the page it was read on, and the
// card text around the address. The decision rule is unchanged — these tests also pin that the
// evidence comes from the very check that decides (cardMatchEvidence ⇔ cardIdentifiesTarget).
//
// Synthetic identities only: reserved .test domains, made-up names, numbers and addresses.
import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_TEXT_LIMIT,
  JobSiteDiscoveryProvider,
  cardIdentifiesTarget,
  cardMatchEvidence,
  discoverEmail,
  enrichCandidate,
  formatEmailEvidenceConsole,
  formatEmailEvidenceLog,
  formatEmailEvidenceMemo,
  maskEmails,
} from "../src/enrich.js";
import { contactCards } from "../src/emailExtractor.js";

// enrichCandidate output shares stdout with the runner's framed messages; silenced for this file.
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
  name, "자동차", "", region, address, phone, homepage, "", "", "", "", "", "",
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
const oneResult = (url, text, body = text) => ({
  async search() {
    return [{ url, title: "TEST_SOURCE", snippet: text, source: "TEST_SOURCE" }];
  },
  async readPageText() {
    return body;
  },
});

const BRANCH = { name: "은하자동차 동부지점", address: "울산 동구 시험로 10", phone: "052-000-0010", homepage: "https://www.eunha-brand.test/" };
const COMPANY = { name: "한빛상사", address: "울산 북구 시험로 95", phone: "052-000-0095" };
const asCompany = (row) => ({ companyName: row.name, region: "울산", address: row.address, phone: row.phone });

test("the evidence names the fact that matched, from the same check that decides", () => {
  const company = asCompany(BRANCH);
  const cases = [
    ["동부지점 TEL 052-000-0010 E-mail east@eunha-brand.test", "east@eunha-brand.test", "phone"],
    ["은하자동차 동부지점 울산 동구 시험로 10 E-mail east@eunha-brand.test", "east@eunha-brand.test", "street+name"],
    ["울산 동구 시험로 10 입점 안내 E-mail mall@eunha-brand.test", "mall@eunha-brand.test", null],
    ["Accessibility statement. Contact accessibility@eunha-overseas.test", "accessibility@eunha-overseas.test", null],
    ["은하자동차 동부지점 부산 동구 시험로 10 east@eunha-brand.test", "east@eunha-brand.test", null],
  ];
  for (const [text, email, matchedBy] of cases) {
    const cards = contactCards(text, email);
    const evidence = cardMatchEvidence(cards, company);
    assert.equal(Boolean(evidence), cardIdentifiesTarget(cards, company), text);
    assert.equal(evidence?.matchedBy ?? null, matchedBy, text);
    if (evidence) assert.ok(evidence.card.includes(email), "the card text shows the address it vouches for");
  }
});

test("a homepage email is written with its page, the matched fact and a memo", T, async () => {
  const card = "<li>은하자동차 동부지점 TEL 052-000-0010 E-mail east@eunha-brand.test</li>";
  const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl: page(card) });

  assert.equal(result.updates.email, "east@eunha-brand.test");
  assert.equal(result.emailEvidence.source, "homepage");
  assert.equal(result.emailEvidence.matchedBy, "phone");
  assert.match(result.emailEvidence.sourceUrl, /^https:\/\/www\.eunha-brand\.test\//);
  assert.match(result.emailEvidence.card, /052-000-0010/);
  assert.match(result.updates.memo, /enrich email_evidence=전화번호 일치 homepage https:\/\/www\.eunha-brand\.test\//);
});

test("the evidence belongs to the address that was written, not to an earlier one", T, async () => {
  // Two addresses on the homepage: one accepted by full name + street, the other by phone. The
  // extractor writes one of them; the evidence must be that one's.
  const body = [
    "<p>은하자동차 동부지점 울산 동구 시험로 10 E-mail first@eunha-brand.test</p>",
    "<p>동부지점 TEL 052-000-0010 E-mail second@eunha-brand.test</p>",
  ].join("");
  const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl: page(body) });
  assert.ok(result.updates.email);
  assert.ok(result.emailEvidence.card.includes(result.updates.email));
});

test("a public-web email carries the evidence of the card it was read from", T, async () => {
  const url = "http://www.other-dealer.test/";
  const result = await discoverEmail(asCompany(COMPANY), {
    searchProvider: oneResult(url, "한빛상사 대표번호 052-000-0095 문의 support@other-dealer.test"),
    fetchImpl: noFetch,
  });
  assert.equal(result.email, "support@other-dealer.test");
  assert.equal(result.evidence.matchedBy, "phone");
  assert.match(result.evidence.card, /support@other-dealer\.test/);

  const street = await discoverEmail(asCompany(COMPANY), {
    searchProvider: oneResult(url, "한빛상사 울산 북구 시험로 95 문의 support@other-dealer.test"),
    fetchImpl: noFetch,
  });
  assert.equal(street.evidence.matchedBy, "street+name");

  const none = await discoverEmail(asCompany(COMPANY), {
    searchProvider: oneResult(url, "한빛상사 지점 안내 고객지원 support@other-dealer.test"),
    fetchImpl: noFetch,
  });
  assert.equal(none.email, "");
  assert.equal(none.evidence, null);
});

test("a row without an email has no evidence and no evidence memo", T, async () => {
  const result = await enrichCandidate(
    { rowNumber: 2, row: sheetRow(BRANCH) },
    { homepageProvider: noSearch, fetchImpl: page("<li>울산 동구 시험로 10 입점 안내 E-mail mall@eunha-brand.test</li>") },
  );
  assert.equal(result.updates.email, undefined);
  assert.equal(result.emailEvidence, null);
  assert.doesNotMatch(result.updates.memo || "", /email_evidence/);
});


test("a long card keeps the matched phone and the address, wherever they sit", () => {
  const company = asCompany(COMPANY);
  const notice = "매장 이용 안내 및 주차 안내와 영업시간 공지사항입니다 ".repeat(12);
  for (const [label, text, matchedBy] of [
    ["phone after a long notice, same line", `한빛상사 ${notice} TEL 052-000-0095 문의 accepted@store.test`, "phone"],
    ["phone before a long notice, same line", `한빛상사 TEL 052-000-0095 ${notice} 문의 accepted@store.test`, "phone"],
    ["street + name over lines with a long notice", `한빛상사 ${notice} 울산 북구 시험로 95\n문의 accepted@store.test`, "street+name"],
  ]) {
    const evidence = cardMatchEvidence(contactCards(text, "accepted@store.test"), company);
    assert.ok(evidence, label);
    assert.equal(evidence.matchedBy, matchedBy, label);
    assert.ok(evidence.card.length <= EVIDENCE_TEXT_LIMIT, label);
    assert.doesNotMatch(evidence.card, /\n/, label);
    assert.match(evidence.card, /accepted@store\.test/, `${label}: the address`);
    if (matchedBy === "phone") {
      assert.equal(evidence.matchedPhone, "052-000-0095", label);
      assert.match(evidence.card, /052-000-0095/, `${label}: the phone`);
    } else {
      assert.equal(evidence.matchedStreet, "시험로 95", label);
      assert.match(evidence.card, /시험로 95/, `${label}: the street`);
      assert.match(evidence.card, /한빛상사/, `${label}: the name`);
    }
    assert.equal(evidence.cardShortened, true, label);
  }
});

test("a long card reaches the row result intact through the homepage crawl", T, async () => {
  const notice = "매장 이용 안내 및 주차 안내와 영업시간 공지사항입니다 ".repeat(12);
  const body = `<p>은하자동차 동부지점 ${notice} TEL 052-000-0010 E-mail east@eunha-brand.test</p>`;
  const result = await enrichCandidate({ rowNumber: 2, row: sheetRow(BRANCH) }, { homepageProvider: noSearch, fetchImpl: page(body) });
  assert.equal(result.updates.email, "east@eunha-brand.test");
  assert.equal(result.emailEvidence.matchedPhone, "052-000-0010");
  assert.match(result.emailEvidence.card, /052-000-0010.*east@eunha-brand\.test/);
  assert.equal(result.emailEvidence.origin, "page");
});

test("a public-web email says whether its card came from a search result or a page", T, async () => {
  const url = "http://www.other-dealer.test/";
  const fromSnippet = await discoverEmail(asCompany(COMPANY), {
    searchProvider: oneResult(url, "한빛상사 대표번호 052-000-0095 문의 support@other-dealer.test", ""),
    fetchImpl: noFetch,
  });
  assert.equal(fromSnippet.evidence.origin, "search_result");

  const fromPage = await discoverEmail(asCompany(COMPANY), {
    searchProvider: oneResult(url, "한빛상사 안내", "한빛상사 대표번호 052-000-0095 문의 support@other-dealer.test"),
    fetchImpl: noFetch,
  });
  assert.equal(fromPage.evidence.origin, "page");
});

test("a job-site email carries the evidence of the card it was selected from", T, async () => {
  const company = asCompany(COMPANY);
  const listing = "한빛상사 채용 담당 연락처 TEL 052-000-0095 이메일 recruit@hanbit-jobs.test";
  const provider = new JobSiteDiscoveryProvider({
    searchProvider: {
      async search() {
        return [{ url: "https://www.saramin.co.kr/zf_user/company-info/view?csn=1", title: "한빛상사", snippet: listing, source: "TEST" }];
      },
      async readPageText() {
        return listing;
      },
    },
    fetchImpl: noFetch,
  });
  const found = await provider.discover(company, {});
  assert.equal(found.email, "recruit@hanbit-jobs.test");
  assert.equal(found.evidence.matchedBy, "phone");
  assert.equal(found.evidence.matchedPhone, "052-000-0095");
  assert.equal(found.evidence.origin, "search_result+page");
});

test("no full address reaches a public log", () => {
  assert.equal(maskEmails("a accepted@store.test b"), "a ***@store.test b");
  assert.equal(maskEmails("https://store.test/contact?email=accepted%40store.test"), "https://store.test/contact?email=***@store.test");

  const result = {
    companyName: "한빛상사 owner@hanbit.test",
    updates: { email: "accepted@store.test" },
    emailEvidence: {
      matchedBy: "phone",
      source: "public_web",
      origin: "page",
      sourceUrl: "https://user:pw@store.test/contact/accepted@store.test?email=accepted%40store.test#accepted@store.test",
      matchedPhone: "052-000-0095",
      card: "한빛상사 TEL 052-000-0095 accepted@store.test",
    },
  };
  const line = formatEmailEvidenceConsole(3900, result);
  assert.equal(line, "이메일 채택 근거 row 3900 한빛상사 ***@hanbit.test: 전화번호 일치 | public_web store.test");
  assert.doesNotMatch(line, /(?<![*])\b[a-z0-9._%+-]+@/i);

  const log = formatEmailEvidenceLog(result, { dryRun: false });
  for (const value of [log.email, log.sourceUrl, log.card]) assert.doesNotMatch(value, /(?<![*])\b[a-z0-9._%+-]+@/i, value);
  assert.equal(log.email, "***@store.test");
  assert.equal(log.matchedPhone, "052-000-0095");
  assert.equal(log.dryRun, false);
  assert.deepEqual(formatEmailEvidenceLog({ updates: { email: "a@b.test" } }, { dryRun: true }), { email: "***@b.test", missing: true, dryRun: true });

  const memo = formatEmailEvidenceMemo(result.emailEvidence);
  assert.equal(memo, "enrich email_evidence=전화번호 일치 public_web https://store.test/contact/***@store.test");
  assert.ok(memo.length < 200);
  assert.match(formatEmailEvidenceMemo({ ...result.emailEvidence, origin: "search_result", sourceUrl: "https://a.test/" }), /전화번호 일치 검색결과 public_web https:\/\/a\.test\//);
  assert.match(formatEmailEvidenceConsole(1, { companyName: "x", emailEvidence: null }), /근거 기록 없음/);
});
