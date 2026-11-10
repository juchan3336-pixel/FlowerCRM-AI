// Run #309 contracts — a provider promise that never settles must not be able to hold a row, the
// run, the final sheet flush, or the process. Every test carries its own runner timeout so that a
// regression fails fast instead of hanging the suite the way the original defect hung the job.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { enrichCandidate, runEnrich, settleWithin } from "../src/enrich.js";
import { asGoogleTimeoutError, googleRequestTimeoutMs } from "../src/googleSheets.js";

// runEnrich prints its telemetry block with console.log. Under node --test that raw text shares
// the child's stdout with the runner's own framed messages, and when the machine is busy the
// runner can mis-split the stream and fail the whole file ("Unable to deserialize cloned data")
// even though every test passed. These tests assert on returned values, never on that output,
// so it is silenced for this file's process.
console.log = () => {};

const T = { timeout: 5000 };
const ROW_MS = 30;
const GRACE_MS = 30;
const never = () => new Promise(() => {});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const blankRow = (name) => [name, "건설", "", "부산", "부산광역시 해운대구 우동 1", "", "", "", "", "", "", "", ""];
const okFetch = async () => new Response("", { status: 200 });

function makeSheets(rowNumbers, { nextRow = rowNumbers.at(-1) + 1 } = {}) {
  const calls = { batches: [], logs: [], system: [], reads: [] };
  return {
    calls,
    async getTargetSpreadsheet(options) {
      calls.reads.push(options);
      return { spreadsheetId: "sheet-hard-deadline" };
    },
    async readSystemState() {
      return { enrich_current_row: String(rowNumbers[0]) };
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: rowNumbers.map((rowNumber) => ({ rowNumber, row: blankRow(`Company ${rowNumber}`) })),
        nextRow,
        scanned: rowNumbers.length,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows(_id, rowUpdates) {
      calls.batches.push(rowUpdates);
      return { batchUpdate: 1 };
    },
    async appendEnrichLog(_id, summary) {
      calls.logs.push(summary);
      return { appendCalls: 1 };
    },
    async writeSystemState(_id, updates) {
      calls.system.push(updates);
      return { updates: 1 };
    },
  };
}

// A provider whose homepage search hangs for the named companies and finds nothing for the rest.
function makeProvider({ hangFor = () => false, close = async () => {} } = {}) {
  const state = { closes: 0, findOfficial: [] };
  return {
    state,
    async search() {
      return [];
    },
    async findOfficial(company) {
      state.findOfficial.push(company.companyName);
      if (hangFor(company.companyName)) return never();
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async close() {
      state.closes += 1;
      return close();
    },
  };
}

test("settleWithin reports an operation that never settles instead of waiting for it", T, async () => {
  assert.deepEqual(await settleWithin(never, 20), { settled: false });
  assert.deepEqual(await settleWithin(async () => {}, 1000), { settled: true });
  const failed = await settleWithin(async () => {
    throw new Error("close failed");
  }, 1000);
  assert.equal(failed.settled, true);
  assert.equal(failed.error.message, "close failed");
});

for (const [label, provider] of [
  [
    "search",
    {
      search: never,
      async findOfficial() {
        return { official: null, failures: [], candidates: [], searchEvents: [] };
      },
    },
  ],
  ["findOfficial", { async search() { return []; }, findOfficial: never }],
  [
    "readPageText",
    {
      async search() {
        return [{ url: "https://listing.example.com/a", title: "Hang Co", snippet: "문의", source: "mock" }];
      },
      readPageText: never,
      async findOfficial() {
        return { official: null, failures: [], candidates: [], searchEvents: [] };
      },
    },
  ],
]) {
  test(`enrichCandidate returns in finite time when provider.${label} never settles`, T, async () => {
    const startedAt = Date.now();
    const result = await enrichCandidate(
      { rowNumber: 2, row: blankRow("Hang Co") },
      { homepageProvider: provider, fetchImpl: never, maxRuntimeMs: ROW_MS, abortGraceMs: GRACE_MS, debug: true },
    );

    assert.ok(Date.now() - startedAt < 2000, "the row comes back on its own");
    assert.equal(result.hardTimedOut, true);
    assert.equal(result.emailUpdated, false);
    assert.equal(result.stopReason, "budget_time");
    // A stuck provider is a time-budget stop, not a provider or site-access failure.
    assert.equal(result.failureCode, "row_budget_exceeded");
    assert.deepEqual(result.budgetsHit, ["time"]);
    assert.equal(result.updates.email, undefined);
    assert.equal(result.updates.memo, undefined, "a stopped row appends no memo");
  });
}

test("a homepage proposed before the hang is not written while its verification is still stuck", T, async () => {
  const provider = {
    async search() {
      return [];
    },
    async findOfficial() {
      return {
        official: { url: "https://confirmed-co.example.co.kr/", score: 90 },
        failures: [],
        candidates: [{ url: "https://confirmed-co.example.co.kr/" }],
        searchEvents: [],
      };
    },
  };

  // Search proposes the homepage in time; the crawl that would confirm it then never settles.
  const result = await enrichCandidate(
    { rowNumber: 2, row: blankRow("Confirmed Co") },
    { homepageProvider: provider, fetchImpl: never, maxRuntimeMs: 200, abortGraceMs: GRACE_MS },
  );

  assert.equal(result.hardTimedOut, true);
  assert.equal(result.homepageUpdated, false, "the hard cut closes the row without the unverified proposal");
  assert.equal(result.updates.homepage, undefined);
  assert.equal(result.emailUpdated, false);
  assert.equal(result.updates.email, undefined);
});

test("a result that arrives after the hard cut cannot change the row that was already returned", T, async () => {
  let release;
  const provider = {
    async search() {
      return [];
    },
    findOfficial() {
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };

  const result = await enrichCandidate(
    { rowNumber: 2, row: blankRow("Late Co") },
    { homepageProvider: provider, fetchImpl: okFetch, maxRuntimeMs: ROW_MS, abortGraceMs: GRACE_MS, debug: true },
  );
  assert.equal(result.hardTimedOut, true);
  const frozen = JSON.stringify(result);

  // The abandoned search finally answers, with a homepage that would have been accepted in time.
  release({
    official: { url: "https://late-co.example.co.kr/", score: 95 },
    failures: [],
    candidates: [{ url: "https://late-co.example.co.kr/" }],
    searchEvents: [{ provider: "mock", ok: true, candidateUrls: ["https://late-co.example.co.kr/"] }],
  });
  await tick();
  await tick();

  assert.equal(JSON.stringify(result), frozen, "updates, debug and telemetry are untouched");
  assert.equal(result.updates.homepage, undefined);
});

test("a rejection that arrives after the hard cut is swallowed, not left unhandled", T, async () => {
  let fail;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const provider = {
      async search() {
        return [];
      },
      findOfficial() {
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      },
    };
    const result = await enrichCandidate(
      { rowNumber: 2, row: blankRow("Reject Co") },
      { homepageProvider: provider, fetchImpl: okFetch, maxRuntimeMs: ROW_MS, abortGraceMs: GRACE_MS },
    );
    assert.equal(result.hardTimedOut, true);

    fail(new Error("browser has been closed"));
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a row that finishes normally leaves no hard-cut timer behind", T, async () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const before = timeouts();
  const result = await enrichCandidate(
    { rowNumber: 2, row: blankRow("Quick Co") },
    { homepageProvider: makeProvider(), fetchImpl: okFetch, maxRuntimeMs: 60000, abortGraceMs: 60000 },
  );

  assert.equal(result.hardTimedOut, false);
  // A leaked ref'd timer would also hold this test file open for two minutes.
  assert.equal(timeouts(), before);
});

test("runEnrich cuts a hung row loose, recycles the provider, and carries on with the next row", T, async () => {
  const sheets = makeSheets([2, 3]);
  const provider = makeProvider({ hangFor: (name) => name === "Company 2" });

  const summary = await runEnrich({
    limit: 2,
    sheets,
    homepageProvider: provider,
    fetchImpl: okFetch,
    maxRowRuntimeMs: ROW_MS,
    rowAbortGraceMs: GRACE_MS,
    cleanupGraceMs: 200,
  });

  assert.equal(summary.processed, 2);
  assert.equal(summary.hardTimeouts, 1);
  assert.equal(summary.cleanupFailed, false);
  assert.equal(summary.stopReason, "limit_reached", "a row deadline is not a run deadline");
  assert.equal(summary.budgetHits.time, 1);
  assert.deepEqual(provider.state.findOfficial, ["Company 2", "Company 3"], "the next row still ran");
  assert.equal(provider.state.closes, 2, "closed once to recycle after the hang, once at the end");
  assert.equal(summary.nextRow, 4);
  assert.equal(sheets.calls.system[0].enrich_current_row, "4");
  assert.equal(sheets.calls.logs.length, 1, "the run still flushed");
});

test("runEnrich stops instead of stacking the next row on a provider that will not close", T, async () => {
  const sheets = makeSheets([2, 3, 4]);
  const provider = makeProvider({ hangFor: (name) => name === "Company 2", close: never });

  const summary = await runEnrich({
    limit: 3,
    sheets,
    homepageProvider: provider,
    fetchImpl: okFetch,
    maxRowRuntimeMs: ROW_MS,
    rowAbortGraceMs: GRACE_MS,
    cleanupGraceMs: 40,
  });

  assert.equal(summary.stopReason, "cleanup_failed");
  assert.equal(summary.cleanupFailed, true);
  assert.equal(summary.processed, 1, "the hung row is closed out as a time-budget row");
  assert.deepEqual(provider.state.findOfficial, ["Company 2"], "no later row touched the stuck provider");
  assert.equal(provider.state.closes, 1, "a close already known to be stuck is not awaited twice");
  assert.equal(summary.nextRow, 3, "the cursor points at the first row that was not attempted");
  assert.equal(sheets.calls.system[0].enrich_current_row, "3");
  assert.equal(sheets.calls.logs.length, 1, "what was finished is still saved");
});

for (const [label, maxRowRuntimeMs] of [
  ["shorter than the row budget", 45000],
  ["and the row budget is disabled", 0],
]) {
  test(`the run budget interrupts a hung row when it is ${label}`, T, async () => {
    const sheets = makeSheets([2, 3]);
    const provider = makeProvider({ hangFor: () => true });

    const summary = await runEnrich({
      limit: 2,
      sheets,
      homepageProvider: provider,
      fetchImpl: okFetch,
      maxRuntimeMs: 40,
      maxRowRuntimeMs,
      rowAbortGraceMs: GRACE_MS,
      cleanupGraceMs: 200,
    });

    assert.equal(summary.stopReason, "max_runtime_reached");
    assert.equal(summary.processed, 0, "an interrupted row is not a finished row");
    assert.equal(summary.nextRow, 2, "the cursor stays on the interrupted row");
    assert.deepEqual(provider.state.findOfficial, ["Company 2"], "no new row starts after the run deadline");
    assert.deepEqual(sheets.calls.batches[0], [], "nothing from the interrupted row is written");
    assert.equal(sheets.calls.system[0].enrich_current_row, "2");
  });
}

test("a provider that never closes cannot block the final flush or the summary", T, async () => {
  const sheets = makeSheets([2]);
  const provider = makeProvider({ close: never });

  const summary = await runEnrich({
    limit: 1,
    sheets,
    homepageProvider: provider,
    fetchImpl: okFetch,
    cleanupGraceMs: 40,
  });

  assert.equal(summary.processed, 1);
  assert.equal(summary.cleanupFailed, true);
  assert.equal(provider.state.closes, 1);
  assert.equal(sheets.calls.batches.length, 1);
  assert.equal(sheets.calls.logs.length, 1);
  assert.equal(sheets.calls.system.length, 1);
});

test("a dry run with a hung row still writes nothing", T, async () => {
  const sheets = makeSheets([2, 3]);
  const provider = makeProvider({ hangFor: (name) => name === "Company 2" });

  const summary = await runEnrich({
    limit: 2,
    sheets,
    homepageProvider: provider,
    fetchImpl: okFetch,
    dryRun: true,
    maxRowRuntimeMs: ROW_MS,
    rowAbortGraceMs: GRACE_MS,
    cleanupGraceMs: 200,
  });

  assert.equal(summary.processed, 2);
  assert.equal(summary.hardTimeouts, 1);
  assert.deepEqual(sheets.calls.reads, [{ readOnly: true }]);
  assert.equal(sheets.calls.batches.length + sheets.calls.logs.length + sheets.calls.system.length, 0);
});

test("a Google request timeout is reported as such and flags an unknown write outcome", () => {
  const timeoutError = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const url = new URL("https://sheets.googleapis.com/v4/spreadsheets/abc/values/LOG!A1:append?valueInputOption=RAW");

  const write = asGoogleTimeoutError(timeoutError, { method: "POST", url, timeoutMs: 120000 });
  assert.equal(write.code, "google_timeout");
  assert.equal(write.writeOutcomeUnknown, true);
  assert.match(write.message, /timed out after 120000ms: POST https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/abc\/values\/LOG!A1:append/);
  assert.equal(write.message.includes("valueInputOption"), false, "the query string is not echoed");

  const read = asGoogleTimeoutError(timeoutError, { method: "GET", url, timeoutMs: 120000 });
  assert.equal(read.writeOutcomeUnknown, false);

  assert.equal(asGoogleTimeoutError(new Error("Google API error: 500"), { method: "GET", url, timeoutMs: 1 }), null);
});

test("the Google request deadline is finite by default and configurable", () => {
  const previous = process.env.GOOGLE_REQUEST_TIMEOUT_MS;
  try {
    delete process.env.GOOGLE_REQUEST_TIMEOUT_MS;
    assert.equal(googleRequestTimeoutMs(), 120000);
    process.env.GOOGLE_REQUEST_TIMEOUT_MS = "5000";
    assert.equal(googleRequestTimeoutMs(), 5000);
    for (const invalid of ["0", "-1", "abc", ""]) {
      process.env.GOOGLE_REQUEST_TIMEOUT_MS = invalid;
      assert.equal(googleRequestTimeoutMs(), 120000, `"${invalid}" falls back to the default`);
    }
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_REQUEST_TIMEOUT_MS;
    else process.env.GOOGLE_REQUEST_TIMEOUT_MS = previous;
  }
});

test("every Google fetch carries a deadline, and a timed-out request is not retried", async () => {
  const sheetsSource = await fs.readFile(new URL("../src/googleSheets.js", import.meta.url), "utf8");
  const authSource = await fs.readFile(new URL("../src/googleAuth.js", import.meta.url), "utf8");

  for (const [name, source] of [
    ["googleSheets.js", sheetsSource],
    ["googleAuth.js", authSource],
  ]) {
    const fetchCalls = source.match(/await fetch\(/g) || [];
    const deadlines = source.match(/signal: AbortSignal\.timeout\(timeoutMs\)/g) || [];
    assert.ok(fetchCalls.length > 0, `${name} still issues requests`);
    assert.equal(deadlines.length, fetchCalls.length, `${name}: every fetch has a deadline`);
  }
  // Inside the request loop the only retry path is the 429 backoff; the timeout path throws.
  const requestLoop = sheetsSource.slice(sheetsSource.indexOf("async function googleFetch("), sheetsSource.indexOf("Google API retry loop exhausted"));
  assert.equal((requestLoop.match(/\bcontinue;/g) || []).length, 1);
  assert.ok(requestLoop.includes("throw asGoogleTimeoutError(error, { method, url, timeoutMs }) || error;"));
});

test("the enrich workflow is read-only unless dry_run is exactly false", async () => {
  const source = (await fs.readFile(new URL("../.github/workflows/enrich.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");

  const input = source.match(/\n      dry_run:\n(?:        .*\n)+/)?.[0] || "";
  assert.match(input, /default: "true"/, "leaving the input alone is a dry run");
  // A manual run with the input missing is a dry run. A scheduled run has no inputs at all, and
  // is the one case that writes without being asked: it is named explicitly, first in the chain.
  assert.ok(
    source.includes("ENRICH_DRY_RUN: ${{ github.event_name == 'schedule' && 'false' || github.event.inputs.dry_run || 'true' }}"),
    "schedule writes; a manual run with no input is a dry run",
  );
  assert.equal((source.match(/ENRICH_DRY_RUN: /g) || []).length, 1, "decided in exactly one place");
  assert.equal(source.includes("|| 'false' }}\n      ENRICH_FROM_START"), false);
  assert.equal(/ENRICH_DRY_RUN:-false/.test(source), false, "no fallback anywhere reads as live");

  // Live is opt-in by exact value: only "false" drops --dry-run.
  assert.ok(source.includes('if [[ "${ENRICH_DRY_RUN}" != "false" ]]; then\n            args+=(--dry-run)'));
  assert.equal(source.includes('if [[ "${ENRICH_DRY_RUN}" == "true" ]]'), false);

  // Anything else fails before any step that could reach the sheet.
  const validate = source.indexOf("Validate dry_run input");
  const run = source.indexOf("- name: Run enrich");
  assert.ok(validate > 0 && validate < run, "the input is validated before the run step");
  assert.ok(source.includes('"${ENRICH_DRY_RUN}" != "true" && "${ENRICH_DRY_RUN}" != "false"'));
  assert.ok(source.slice(validate, run).includes("exit 1"));
});
