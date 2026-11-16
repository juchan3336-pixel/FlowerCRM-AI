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
  cardIdentifiesTarget,
  cardMatchEvidence,
  discoverEmail,
  enrichCandidate,
  formatEmailEvidenceConsole,
  formatEmailEvidenceMemo,
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

test("the card text kept as evidence is one line and bounded", () => {
  const filler = "은하자동차 동부지점 안내 ".repeat(40);
  const text = `${filler}\n  TEL   052-000-0010\nE-mail east@eunha-brand.test`;
  const evidence = cardMatchEvidence(contactCards(text, "east@eunha-brand.test"), asCompany(BRANCH));
  assert.ok(evidence);
  assert.ok(evidence.card.length <= EVIDENCE_TEXT_LIMIT);
  assert.doesNotMatch(evidence.card, /\n|\s{2,}/);
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

test("the memo and the public console line say what matched, and the console omits the address", () => {
  const evidence = { matchedBy: "street+name", source: "public_web", sourceUrl: "http://www.other-dealer.test/", card: "한빛상사 ... support@other-dealer.test" };
  assert.equal(formatEmailEvidenceMemo(evidence), "enrich email_evidence=상호+도로명주소 일치 public_web http://www.other-dealer.test/");
  const line = formatEmailEvidenceConsole(3900, { companyName: "한빛상사", emailEvidence: evidence, updates: { email: "support@other-dealer.test" } });
  assert.equal(line, "이메일 채택 근거 row 3900 한빛상사: 상호+도로명주소 일치 | public_web http://www.other-dealer.test/");
  assert.doesNotMatch(line, /@/);
  assert.match(formatEmailEvidenceConsole(1, { companyName: "x", emailEvidence: null }), /근거 기록 없음/);
});
