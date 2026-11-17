// Directory-operator addresses (2026-11-17). An audit of the 기업 DB tab found the same mailbox
// written as the email of many unrelated businesses: help@yugacrew.com — a hospital directory's
// "send corrections or deletion requests to help@…" notice — on 59 hospitals with 59 different
// phone numbers, and 58 more such addresses. These tests pin the four guards that stop it:
//   1. known operator email domains are never a business's address;
//   2. a search result's title/snippet is not evidence — only the page is read for addresses;
//   3. the operator's notice ("정보 수정 및 삭제 요청은 …", "이 병원 관계자이신가요?") disowns the address;
//   4. an address another business already has (in the sheet or in the same run) is held back;
// and that the page reader keeps the page's regions apart.
// Synthetic identities: reserved .test domains, made-up names and numbers.
import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATOR_EMAIL_DOMAINS,
  cardIdentifiesTarget,
  discoverEmail,
  enrichCandidate,
  holdSharedEmails,
  runEnrich,
  serializePageText,
} from "../src/enrich.js";
import { contactCards } from "../src/emailExtractor.js";

const realConsoleLog = console.log;
test.before(() => {
  console.log = () => {};
});
test.after(() => {
  console.log = realConsoleLog;
});

const T = { timeout: 5000 };
const HOSPITAL = { companyName: "튼튼테스트의원", region: "양산", address: "경남 양산시 시험동로 39", phone: "055-000-0090" };
const sheetRow = (company, homepage = "") => [company.companyName, "병원", "", company.region, company.address, company.phone, homepage, "", "", "", "", "", ""];
const noSearch = {
  async findOfficial() {
    return { official: null, failures: [], candidates: [], searchEvents: [] };
  },
  async search() {
    return [];
  },
};
const noFetch = async () => new Response("", { status: 200 });
const onePage = (url, snippet, body) => ({
  async search() {
    return [{ url, title: "튼튼테스트의원", snippet, source: "TEST" }];
  },
  async readPageText() {
    return body;
  },
});

// The directory page, as a snippet or a flattened page reads it: the listing and the operator's
// notice on one line.
const DIRECTORY_FLAT =
  "튼튼테스트의원 경남 양산시 시험동로 39 TEL 055-000-0090 진료시간 안내 🏥 이 병원 관계자이신가요? 정보가 정확하지 않다면 수정을 요청하세요. " +
  "정보 수정 요청 병원 광고 문의 • 본 정보는 공공데이터포털 자료를 바탕으로 제공됩니다. • 정보 수정 및 삭제 요청은 help@directory-operator.test 으로 언제든 가능합니다.";

test("the directory operator's notice disowns the address next to it, whatever its domain", () => {
  assert.equal(cardIdentifiesTarget(contactCards(DIRECTORY_FLAT, "help@directory-operator.test"), HOSPITAL), false);
  for (const notice of [
    "정보 수정 및 삭제 요청은",
    "정보 수정 요청",
    "삭제 요청",
    "이 병원 관계자이신가요?",
    "업체 제보",
    "공공데이터 기반 정보",
  ]) {
    const text = `튼튼테스트의원 TEL 055-000-0090 ${notice} help@directory-operator.test`;
    assert.equal(cardIdentifiesTarget(contactCards(text, "help@directory-operator.test"), HOSPITAL), false, notice);
  }
  // A clinic's own contact line is not touched by the words alone being elsewhere on the page.
  assert.equal(cardIdentifiesTarget(contactCards("튼튼테스트의원 TEL 055-000-0090 이메일 clinic@tunton.test", "clinic@tunton.test"), HOSPITAL), true);
});

test("an address on a known operator domain is never a business's, even printed beside its phone", T, async () => {
  assert.ok(OPERATOR_EMAIL_DOMAINS.includes("yugacrew.com"));
  assert.ok(OPERATOR_EMAIL_DOMAINS.includes("goodoc.co.kr"));
  for (const address of ["help@yugacrew.com", "gdcs@goodoc.co.kr", "help@nicebizinfo.com", "helpdesk@worxphere.ai", "cs@sub.yugacrew.com"]) {
    const line = `튼튼테스트의원 TEL 055-000-0090 문의 ${address}`;
    const web = await discoverEmail(HOSPITAL, { searchProvider: onePage("https://listing.test/h/1", "튼튼테스트의원", line), fetchImpl: noFetch });
    assert.equal(web.email, "", `public web: ${address}`);
    const crawl = await enrichCandidate(
      { rowNumber: 2, row: sheetRow(HOSPITAL, "https://www.tunton.test/") },
      { homepageProvider: noSearch, fetchImpl: async () => new Response(`<p>${line}</p>`, { status: 200 }) },
    );
    assert.equal(crawl.updates.email, undefined, `homepage crawl: ${address}`);
  }
});

test("a snippet is not evidence: the address must be on the page itself", T, async () => {
  const snippet = "튼튼테스트의원 TEL 055-000-0090 문의 clinic@tunton.test";
  const snippetOnly = await discoverEmail(HOSPITAL, { searchProvider: onePage("https://clinic-info.test/1", snippet, ""), fetchImpl: noFetch });
  assert.equal(snippetOnly.email, "");

  const pageSaysOtherwise = await discoverEmail(HOSPITAL, {
    searchProvider: onePage("https://clinic-info.test/1", snippet, "튼튼테스트의원 진료시간 안내"),
    fetchImpl: noFetch,
  });
  assert.equal(pageSaysOtherwise.email, "", "the page does not show the address");

  const page = await discoverEmail(HOSPITAL, { searchProvider: onePage("https://clinic-info.test/1", "튼튼테스트의원", snippet), fetchImpl: noFetch });
  assert.equal(page.email, "clinic@tunton.test");
  assert.equal(page.evidence.origin, "page");

  // The directory page itself, read as a page: still the operator's.
  const directory = await discoverEmail(HOSPITAL, { searchProvider: onePage("https://directory.test/h/240", "튼튼테스트의원", DIRECTORY_FLAT), fetchImpl: noFetch });
  assert.equal(directory.email, "");
});

test("the usual shapes of a business's own contact line are still accepted", () => {
  const company = { companyName: "천일테스트목재", region: "창원", address: "경남 창원시 시험로 10", phone: "055-000-1753" };
  for (const line of [
    "업체명 : 천일테스트목재(주) | 대표 : 홍길동 | Tel : 055-000-1753~5 | Fax : 055-000-9756 E-mail : wood@cheonil.test",
    "Tel. 055-000-1753 | Fax. 055-000-1754 | wood@cheonil.test 경상남도 창원시 시험로 10",
    "대표번호 : 055-000-1753 팩스번호 : 055-000-1752 이메일 : wood@cheonil.test Copyright © 천일테스트목재. All rights reserved.",
    "055-000-1753 wood@cheonil.test",
  ]) {
    assert.equal(cardIdentifiesTarget(contactCards(line, "wood@cheonil.test"), company), true, line);
  }
});

// ------------------------------------------------------------------ shared-address hold

const pending = (rowNumber, identity, email, extra = {}) => ({
  rowNumber,
  companyName: identity.companyName,
  identity,
  memoWithoutEmail: "kept memo; enrich email_held=shared_address",
  updates: { email, memo: "kept memo; enrich email_evidence=전화번호 일치", homepage: extra.homepage },
});
const A = { companyName: "가나의원", phone: "055-000-0001", address: "경남 양산시 가로 1" };
const B = { companyName: "다라의원", phone: "055-000-0002", address: "경남 거제시 나로 2" };

test("one address written for two different businesses in a run holds both", () => {
  const items = [pending(10, A, "help@shared.test", { homepage: "https://a.test/" }), pending(11, B, "help@shared.test")];
  const held = holdSharedEmails(items, new Map());
  assert.deepEqual(held.map((item) => item.rowNumber).sort(), [10, 11]);
  for (const item of items) {
    assert.equal(item.updates.email, undefined);
    assert.equal(item.updates.memo, "kept memo; enrich email_held=shared_address");
  }
  assert.equal(items[0].updates.homepage, "https://a.test/", "an independently verified homepage stays");
});

test("an address another business already has in the sheet is held", () => {
  const items = [pending(20, A, "help@shared.test")];
  const index = new Map([["help@shared.test", [{ rowNumber: 5, ...B }]]]);
  const held = holdSharedEmails(items, index);
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].sharedWith, [5]);
  assert.equal(items[0].updates.email, undefined);
});

test("the same business on two rows keeps its address; a shared phone or name alone does not", () => {
  const sameBusiness = [pending(30, A, "info@ga.test")];
  assert.equal(holdSharedEmails(sameBusiness, new Map([["info@ga.test", [{ rowNumber: 3, ...A, address: "다른 표기 주소" }]]])).length, 0);
  assert.equal(sameBusiness[0].updates.email, "info@ga.test");

  const callCentre = [pending(31, A, "cs@group.test")];
  assert.equal(holdSharedEmails(callCentre, new Map([["cs@group.test", [{ rowNumber: 4, ...B, phone: A.phone }]]])).length, 1, "same phone, different name");

  const namesake = [pending(32, A, "info@ga.test")];
  assert.equal(holdSharedEmails(namesake, new Map([["info@ga.test", [{ rowNumber: 6, ...A, phone: "055-999-9999", address: "서울 다른구 3" }]]])).length, 1, "same name elsewhere");

  const unique = [pending(33, A, "only@ga.test")];
  assert.equal(holdSharedEmails(unique, new Map()).length, 0);
});

test("runEnrich holds a shared address before writing, and the summary agrees", T, async () => {
  const batches = [];
  const rowFor = (company) => [company.companyName, "병원", "", "경남", company.address, company.phone, "", "", "", "", "", "", ""];
  const sheets = {
    async getTargetSpreadsheet() {
      return { spreadsheetId: "s" };
    },
    async readSystemState() {
      return {};
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: [
          { rowNumber: 2, row: rowFor(A) },
          { rowNumber: 3, row: rowFor(B) },
        ],
        nextRow: 4,
        scanned: 2,
        skipped: 0,
        totalDataRows: 2,
        emailIndex: new Map(),
      };
    },
    async batchUpdateEnrichRows(spreadsheetId, rowUpdates) {
      batches.push(rowUpdates);
      return { updated: rowUpdates.length, batchUpdate: 1 };
    },
    async writeSystemState() {
      return { updates: 1 };
    },
    async appendEnrichLog() {
      return { appendCalls: 1 };
    },
  };
  // Each clinic's page shows its own phone next to the same mailbox (say, a shared booking desk).
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      if (!query.endsWith("문의")) return [];
      const company = query.startsWith(A.companyName) ? A : B;
      return [{ url: `https://booking.test/${company.phone}`, title: company.companyName, snippet: "", source: "T" }];
    },
  };
  const fetchImpl = async (url) => {
    const company = String(url).includes(A.phone) ? A : B;
    return new Response(`${company.companyName} TEL ${company.phone} 예약 문의 desk@booking-desk.test`, { status: 200 });
  };

  const summary = await runEnrich({ limit: 2, sheets, homepageProvider, fetchImpl });

  assert.equal(summary.emailHeld, 2);
  assert.equal(summary.emailFound, 0);
  const written = batches[0] || [];
  assert.equal(written.some((item) => item.updates.email), false, "no row is written with the shared address");
  for (const item of written) {
    assert.doesNotMatch(item.updates.memo || "", /email_evidence|email_source/);
    assert.match(item.updates.memo || "", /email_held=shared_address/);
    assert.deepEqual(Object.keys(item).sort(), ["rowNumber", "updates"], "only the write shape reaches the sheet");
  }
});

// ------------------------------------------------------------------ page reader

function documentFrom(node) {
  return { body: node, querySelectorAll: () => [] };
}
const el = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes });
const tx = (nodeValue) => ({ nodeType: 3, nodeValue });

test("the page reader keeps regions apart and paragraphs together", () => {
  const previous = globalThis.document;
  try {
    globalThis.document = documentFrom(
      el(
        "BODY",
        el("ARTICLE", el("P", tx("튼튼테스트의원")), el("P", tx("TEL 055-000-0090"))),
        el("FOOTER", el("P", tx("정보 수정 및 삭제 요청은 help@directory-operator.test"))),
        el("SCRIPT", tx("var hidden = 'x@script.test';")),
      ),
    );
    const text = serializePageText();
    assert.equal(text, "튼튼테스트의원\nTEL 055-000-0090\n\n정보 수정 및 삭제 요청은 help@directory-operator.test");
    assert.equal(cardIdentifiesTarget(contactCards(text, "help@directory-operator.test"), HOSPITAL), false);
  } finally {
    globalThis.document = previous;
  }
});

// ------------------------------------------------------------------ review round 2

import { JobSiteDiscoveryProvider, businessIdentityName, pageBodyText } from "../src/enrich.js";

const styled = (tagName, style, ...childNodes) => ({ nodeType: 1, tagName, style, childNodes });
const link = (href, ...childNodes) => ({ nodeType: 1, tagName: "A", href, childNodes });

function readWith(body) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  try {
    globalThis.document = { body, querySelectorAll: () => [] };
    globalThis.window = { getComputedStyle: (element) => element.style || {} };
    return serializePageText();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
}
const pageProvider = (text) => ({
  async search() {
    return [{ url: "https://listing.test/h/1", title: "튼튼테스트의원", snippet: "", source: "T" }];
  },
  async readPageText() {
    return text;
  },
});

test("links never put an address back next to a phone the page kept apart", T, async () => {
  // A hidden link carrying the clinic's name, phone and a mailto address.
  const hidden = readWith(
    el(
      "BODY",
      el("P", tx("진료시간 안내")),
      styled("DIV", { display: "none" }, link("mailto:hidden@operator.test", tx("튼튼테스트의원 TEL 055-000-0090 hidden@operator.test"))),
    ),
  );
  assert.doesNotMatch(pageBodyText(hidden), /hidden@operator\.test/);
  assert.equal((await discoverEmail(HOSPITAL, { searchProvider: pageProvider(hidden), fetchImpl: noFetch })).email, "");

  // A link wrapping the clinic's card and the operator's footer: two regions, still two.
  const wrapped = readWith(
    el(
      "BODY",
      link(
        "https://directory.test/h/1",
        el("ARTICLE", el("P", tx("튼튼테스트의원")), el("P", tx("TEL 055-000-0090"))),
        el("FOOTER", el("P", tx("문의 help@new-directory.test"))),
      ),
    ),
  );
  assert.equal((await discoverEmail(HOSPITAL, { searchProvider: pageProvider(wrapped), fetchImpl: noFetch })).email, "");
  assert.match(wrapped, /https:\/\/directory\.test\/h\/1/, "the link target is still there for homepage discovery");

  // The clinic's own card is still accepted.
  const own = readWith(el("BODY", el("ADDRESS", el("P", tx("튼튼테스트의원 TEL 055-000-0090")), el("P", tx("E-mail clinic@tunton.test")))));
  assert.equal((await discoverEmail(HOSPITAL, { searchProvider: pageProvider(own), fetchImpl: noFetch })).email, "clinic@tunton.test");
});

test("the identity check keeps names whole: Cobalt is not Balt", () => {
  assert.notEqual(businessIdentityName("Cobalt Clinic"), businessIdentityName("Balt Clinic"));
  assert.equal(businessIdentityName("(주)한빛상사"), businessIdentityName("주식회사 한빛상사"));
  assert.equal(businessIdentityName("Coastline Trading Co., Ltd."), businessIdentityName("Coastline Trading"));
  assert.equal(businessIdentityName("Lincoln Motors"), "lincolnmotors");

  const cobalt = { companyName: "Cobalt Clinic", phone: "055-000-0007", address: "경남 창원시 가로 1" };
  const balt = { companyName: "Balt Clinic", phone: "055-000-0007", address: "경남 김해시 나로 2" };
  const inRun = [pending(40, cobalt, "help@shared.test"), pending(41, balt, "help@shared.test")];
  assert.equal(holdSharedEmails(inRun, new Map()).length, 2, "same run");
  const existing = [pending(42, cobalt, "help@shared.test")];
  assert.equal(holdSharedEmails(existing, new Map([["help@shared.test", [{ rowNumber: 7, ...balt }]]])).length, 1, "already in the sheet");

  const sameFirm = [pending(43, { companyName: "(주)한빛상사", phone: "055-000-0095", address: "울산 북구 시험로 95" }, "info@hanbit.test")];
  const index = new Map([["info@hanbit.test", [{ rowNumber: 8, companyName: "주식회사 한빛상사", phone: "055-000-0095", address: "울산 북구 시험로 95" }]]]);
  assert.equal(holdSharedEmails(sameFirm, index).length, 0, "the same firm written two ways");
});

test("a refused personal address never reaches the memo", T, async () => {
  const company = { companyName: "Acme Flower", region: "서울", address: "서울특별시 강남구 역삼동 테헤란로 1", phone: "02-111-2222" };
  const jobs = (body) =>
    new JobSiteDiscoveryProvider({
      searchProvider: {
        async search() {
          return [{ url: "https://www.jobkorea.co.kr/company/acme", title: "Acme Flower 채용", snippet: "", source: "T" }];
        },
      },
      fetchImpl: async () => new Response(body, { status: 200 }),
    }).discover(company);

  const notice = await jobs("Acme Flower TEL 02-111-2222 정보 수정 및 삭제 요청은 directory.operator@gmail.com 으로");
  assert.equal(notice.personalEmail, "", "an operator's gmail under a directory notice");
  const loose = await jobs("담당자 recruit@naver.com 서울 강남구 역삼동");
  assert.equal(loose.personalEmail, "", "an address with no card of the business");
  const carded = await jobs("Acme Flower 채용 담당 TEL 02-111-2222 담당자 recruit@naver.com");
  assert.equal(carded.personalEmail, "recruit@naver.com");

  // Through the row: the refused one is not written to the memo.
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      return query.includes("문의") ? [{ url: "https://www.jobkorea.co.kr/company/acme", title: "Acme Flower 채용", snippet: "", source: "T" }] : [];
    },
  };
  const row = [company.companyName, "flower", "", "서울", company.address, company.phone, "", "", "", "", "", "", ""];
  const result = await enrichCandidate(
    { rowNumber: 2, row },
    { homepageProvider, fetchImpl: async () => new Response("Acme Flower TEL 02-111-2222 정보 수정 및 삭제 요청은 directory.operator@gmail.com 으로", { status: 200 }) },
  );
  assert.doesNotMatch(result.updates.memo || "", /directory\.operator|jobsite_personal_email/);
});

test("a held row drops every email memo item, the job-site personal address included", () => {
  const item = pending(50, A, "help@shared.test");
  item.memoWithoutEmail = "kept; enrich email_held=shared_address";
  item.updates.memo = "kept; enrich jobsite_personal_email=hr@gana.test; enrich email_evidence=전화번호 일치";
  holdSharedEmails([item, pending(51, B, "help@shared.test")], new Map());
  assert.equal(item.updates.memo, "kept; enrich email_held=shared_address");
});

test("through the row: a job-site personal address noted before a later homepage email is dropped if that email is held", T, async () => {
  const company = { companyName: "Acme Flower", address: "서울특별시 강남구 역삼동 테헤란로 1", phone: "02-111-2222" };
  const homepageProvider = {
    async findOfficial() {
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async search({ query }) {
      return query.includes("문의") ? [{ url: "https://www.jobkorea.co.kr/company/acme", title: "Acme Flower 채용", snippet: "", source: "T" }] : [];
    },
  };
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("jobkorea")) {
      return new Response('<a href="https://www.acme-flower.co.kr">Acme Flower 홈페이지</a> Acme Flower 채용 담당 TEL 02-111-2222 담당자 recruit@naver.com', { status: 200 });
    }
    if (target.includes("acme-flower")) return new Response("<footer>Acme Flower TEL 02-111-2222 E-mail info@acme-flower.co.kr</footer>", { status: 200 });
    return new Response("", { status: 200 });
  };
  const row = [company.companyName, "flower", "", "서울", company.address, company.phone, "", "", "", "", "", "", ""];
  const result = await enrichCandidate({ rowNumber: 2, row }, { homepageProvider, fetchImpl });

  assert.equal(result.updates.email, "info@acme-flower.co.kr");
  assert.match(result.updates.memo, /jobsite_personal_email=recruit@naver\.com/);
  assert.equal(result.memoWithoutEmail, "enrich email_held=shared_address", "the personal address goes with the held email");
});
