// Review round 2 contracts — a close that fails is not a recycle, a cancelled browser launch opens
// no context, and the job-wide deadline reaches the sheet I/O on both sides of the row loop.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FallbackHomepageSearchProvider,
  PlaywrightHomepageSearchProvider,
  enrichCandidate,
  enrichRunStatus,
  runEnrich,
} from "../src/enrich.js";

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
const closeFails = async () => {
  throw new Error("browser refused to close");
};

function makeSheets(rowNumbers) {
  const calls = { batches: [], logs: [], logStatuses: [], system: [] };
  return {
    calls,
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-cleanup-deadline" };
    },
    async readSystemState() {
      return { enrich_current_row: String(rowNumbers[0]) };
    },
    async readQueuedEnrichmentRows() {
      return {
        candidates: rowNumbers.map((rowNumber) => ({ rowNumber, row: blankRow(`Company ${rowNumber}`) })),
        nextRow: rowNumbers.at(-1) + 1,
        scanned: rowNumbers.length,
        skipped: 0,
      };
    },
    async batchUpdateEnrichRows(_id, rowUpdates) {
      calls.batches.push(rowUpdates);
      return { batchUpdate: 1 };
    },
    async appendEnrichLog(_id, summary, status) {
      calls.logs.push(summary);
      calls.logStatuses.push(status);
      return { appendCalls: 1 };
    },
    async writeSystemState(_id, updates) {
      calls.system.push(updates);
      return { updates: 1 };
    },
  };
}

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

const hungRun = (overrides) => ({
  fetchImpl: okFetch,
  maxRowRuntimeMs: ROW_MS,
  rowAbortGraceMs: GRACE_MS,
  cleanupGraceMs: 200,
  ...overrides,
});

test("a close that throws after a hung row is a failed recycle: the next row does not start", T, async () => {
  const sheets = makeSheets([2, 3]);
  const provider = makeProvider({ hangFor: (name) => name === "Company 2", close: closeFails });

  const summary = await runEnrich(hungRun({ limit: 2, sheets, homepageProvider: provider }));

  assert.deepEqual(provider.state.findOfficial, ["Company 2"]);
  assert.equal(summary.stopReason, "cleanup_failed");
  assert.equal(summary.cleanupFailed, true);
  assert.equal(summary.nextRow, 3);
  assert.equal(enrichRunStatus(summary), "partial");
});

test("a provider with no close cannot prove a hung row is gone, so it is not reused", T, async () => {
  const sheets = makeSheets([2, 3]);
  const provider = makeProvider({ hangFor: (name) => name === "Company 2" });
  delete provider.close;

  const summary = await runEnrich(hungRun({ limit: 2, sheets, homepageProvider: provider }));

  assert.deepEqual(provider.state.findOfficial, ["Company 2"]);
  assert.equal(summary.stopReason, "cleanup_failed");
  assert.equal(summary.cleanupFailed, true);
});

test("a final close that throws marks the run partial but still saves the finished rows", T, async () => {
  const sheets = makeSheets([2]);
  const provider = makeProvider({ close: closeFails });

  const summary = await runEnrich({ limit: 1, sheets, homepageProvider: provider, fetchImpl: okFetch });

  assert.equal(summary.processed, 1);
  assert.equal(summary.cleanupFailed, true);
  assert.equal(summary.stopReason, "limit_reached");
  assert.deepEqual(sheets.calls.logStatuses, ["partial"], "the sheet log says what the summary says");
  assert.equal(sheets.calls.batches.length, 1);
  assert.equal(sheets.calls.system.length, 1);
});

test("a clean run is still logged as success", T, async () => {
  const sheets = makeSheets([2]);
  const summary = await runEnrich({ limit: 1, sheets, homepageProvider: makeProvider(), fetchImpl: okFetch });

  assert.equal(summary.cleanupFailed, false);
  assert.deepEqual(sheets.calls.logStatuses, ["success"]);
});

test("enrichRunStatus reports early stops and failed cleanup as partial", () => {
  assert.equal(enrichRunStatus({ stopReason: "limit_reached", cleanupFailed: false }), "success");
  assert.equal(enrichRunStatus({ stopReason: "max_runtime_reached", cleanupFailed: false }), "partial");
  assert.equal(enrichRunStatus({ stopReason: "cleanup_failed", cleanupFailed: true }), "partial");
  assert.equal(enrichRunStatus({ stopReason: "limit_reached", cleanupFailed: true }), "partial");
});

test("PlaywrightHomepageSearchProvider.close reports a browser that will not close and detaches it", T, async () => {
  const provider = new PlaywrightHomepageSearchProvider();
  provider.browserPromise = Promise.resolve({ close: closeFails });

  await assert.rejects(provider.close(), /refused to close/);
  assert.equal(provider.browserPromise, null, "the next request launches a fresh browser");

  // A browser that never launched has nothing to close.
  provider.browserPromise = Promise.reject(new Error("launch failed"));
  await provider.close();
  await new PlaywrightHomepageSearchProvider().close();
});

test("FallbackHomepageSearchProvider.close attempts every provider and reports all failures", T, async () => {
  const closed = [];
  const provider = new FallbackHomepageSearchProvider({
    providers: [
      {
        name: "a",
        async close() {
          closed.push("a");
          throw new Error("a failed");
        },
      },
      { name: "b" },
      {
        name: "c",
        async close() {
          closed.push("c");
        },
      },
    ],
    sourceProvider: {
      async close() {
        closed.push("source");
        throw new Error("source failed");
      },
    },
  });

  await assert.rejects(provider.close(), (error) => {
    assert.equal(error.errors.length, 2);
    assert.match(error.message, /a failed; source failed/);
    return true;
  });
  assert.deepEqual(closed, ["a", "c", "source"]);
});

// A fake browser whose named stage never settles. Everything before that stage works.
function stuckBrowser(stage) {
  const state = { newContext: 0, newPage: 0, goto: 0, contextClose: 0 };
  const page = {
    goto: () => ((state.goto += 1), stage === "goto" || stage === "contextClose" ? never() : Promise.resolve()),
    $$eval: () => (stage === "evaluate" ? never() : Promise.resolve([])),
    evaluate: () => (stage === "evaluate" ? never() : Promise.resolve("")),
  };
  const context = {
    newPage: () => ((state.newPage += 1), stage === "newPage" ? never() : Promise.resolve(page)),
    close: () => ((state.contextClose += 1), stage === "contextClose" ? never() : Promise.resolve()),
  };
  return {
    state,
    newContext: () => ((state.newContext += 1), stage === "newContext" ? never() : Promise.resolve(context)),
    close: async () => {},
  };
}

for (const stage of ["launch", "newContext", "newPage", "goto", "evaluate", "contextClose"]) {
  test(`a real Playwright provider stuck at ${stage} cannot hold the row`, T, async () => {
    const provider = new PlaywrightHomepageSearchProvider();
    provider.browserPromise = stage === "launch" ? never() : Promise.resolve(stuckBrowser(stage));

    const result = await enrichCandidate(
      { rowNumber: 2, row: blankRow("Stuck Co") },
      { homepageProvider: provider, fetchImpl: okFetch, maxRuntimeMs: ROW_MS, abortGraceMs: GRACE_MS },
    );

    assert.equal(result.hardTimedOut, true);
    assert.equal(result.failureCode, "row_budget_exceeded");
    assert.deepEqual(result.updates, {});
  });
}

test("a browser launch that finishes after the row was cut opens no context", T, async () => {
  const provider = new PlaywrightHomepageSearchProvider();
  const browser = stuckBrowser("none");
  let launched;
  provider.browserPromise = new Promise((resolve) => {
    launched = resolve;
  });

  const result = await enrichCandidate(
    { rowNumber: 2, row: blankRow("Late Launch Co") },
    { homepageProvider: provider, fetchImpl: okFetch, maxRuntimeMs: ROW_MS, abortGraceMs: GRACE_MS },
  );
  assert.equal(result.hardTimedOut, true);

  launched(browser);
  for (let i = 0; i < 5; i += 1) await tick();

  assert.equal(browser.state.newContext, 0, "the cancelled row starts no browser work");
  assert.equal(browser.state.newPage, 0);
});

test("a hung row answering while the next row runs reaches neither that row nor the sheet", T, async () => {
  const sheets = makeSheets([2, 3]);
  let releaseHungRow;
  const provider = {
    async search() {
      return [];
    },
    async findOfficial(company) {
      if (company.companyName === "Company 2") {
        return new Promise((resolve) => {
          releaseHungRow = resolve;
        });
      }
      // Row 3 is in flight when row 2's abandoned search finally answers with a usable homepage.
      releaseHungRow({
        official: { url: "https://company-2.example.co.kr/", score: 95 },
        failures: [],
        candidates: [{ url: "https://company-2.example.co.kr/" }],
        searchEvents: [],
      });
      await tick();
      await tick();
      return { official: null, failures: [], candidates: [], searchEvents: [] };
    },
    async close() {},
  };

  const summary = await runEnrich(hungRun({ limit: 2, sheets, homepageProvider: provider }));

  assert.equal(summary.processed, 2);
  assert.equal(summary.homepageFound, 0);
  assert.equal(JSON.stringify(sheets.calls.batches).includes("company-2.example.co.kr"), false, "the late homepage was never written");
});

test("a hung row is kept as a finished time-budget row when the run still has time left", T, async () => {
  // Policy, fixed here on purpose: a row stopped by its own budget is done (the cursor moves on);
  // a row stopped by the run budget is not (the cursor stays on it and the next run retries it).
  const sheets = makeSheets([2]);
  const provider = makeProvider({ hangFor: () => true });

  const summary = await runEnrich(hungRun({ limit: 1, sheets, homepageProvider: provider, maxRuntimeMs: 60000 }));

  assert.equal(summary.processed, 1);
  assert.equal(summary.stopReason, "limit_reached");
  assert.equal(summary.interruptedRow, null);
  assert.equal(summary.nextRow, 3);
});

test("the run-budget interruption names the row it cut off", T, async () => {
  const sheets = makeSheets([2, 3]);
  const summary = await runEnrich(
    hungRun({ limit: 2, sheets, homepageProvider: makeProvider({ hangFor: () => true }), maxRuntimeMs: 40, maxRowRuntimeMs: 45000 }),
  );

  assert.equal(summary.interruptedRow, 2);
  assert.equal(summary.stopReason, "max_runtime_reached");
});

test("the job deadline covers the first sheet read and is cleared on every exit", T, async () => {
  const deadlines = [];
  const sheets = makeSheets([2]);
  sheets.setDeadline = (at) => deadlines.push(at);

  const before = Date.now();
  await runEnrich({ limit: 1, sheets, homepageProvider: makeProvider(), fetchImpl: okFetch, jobDeadlineMs: 60000 });
  assert.equal(deadlines.length, 2);
  assert.ok(deadlines[0] >= before + 60000 && deadlines[0] <= Date.now() + 60000, "an absolute instant, set up front");
  assert.equal(deadlines[1], 0, "cleared when the run returns");

  // No deadline requested → explicitly none, never a stale one from an earlier job.
  deadlines.length = 0;
  await runEnrich({ limit: 1, sheets, homepageProvider: makeProvider(), fetchImpl: okFetch });
  assert.deepEqual(deadlines, [0, 0]);

  // A read that fails before the first row still clears it.
  deadlines.length = 0;
  sheets.getTargetSpreadsheet = async () => {
    throw new Error("Google API deadline exceeded before request was sent");
  };
  await assert.rejects(runEnrich({ limit: 1, sheets, homepageProvider: makeProvider(), jobDeadlineMs: 60000 }), /deadline exceeded/);
  assert.equal(deadlines.length, 2);
  assert.equal(deadlines[1], 0);
});

test("the job deadline also limits exploration, leaving room for the final flush", T, async () => {
  const sheets = makeSheets([2, 3]);
  const provider = makeProvider({ hangFor: () => true });

  // No maxRuntimeMs at all: the job window alone must still stop a hung row.
  const summary = await runEnrich({
    limit: 2,
    sheets,
    homepageProvider: provider,
    fetchImpl: okFetch,
    jobDeadlineMs: 80,
    maxRowRuntimeMs: 45000,
    rowAbortGraceMs: GRACE_MS,
    cleanupGraceMs: 200,
  });

  assert.equal(summary.stopReason, "max_runtime_reached");
  assert.equal(summary.interruptedRow, 2);
  assert.equal(sheets.calls.system[0].enrich_current_row, "2");
});

const bashAvailable = spawnSync("bash", ["-c", "exit 0"]).status === 0;

test("the workflow's own shell turns dry_run values into the right argv", { ...T, skip: bashAvailable ? false : "bash not available" }, async () => {
  const source = (await fs.readFile(new URL("../.github/workflows/enrich.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const stepScript = (name) => {
    const start = source.indexOf(`- name: ${name}`);
    const body = source.slice(source.indexOf("run: |\n", start) + "run: |\n".length);
    const lines = [];
    for (const line of body.split("\n")) {
      if (line.trim() !== "" && !line.startsWith("          ")) break;
      lines.push(line.slice(10));
    }
    return lines.join("\n");
  };
  const validate = stepScript("Validate dry_run input");
  // Only the dry-run decision of the run step, taken verbatim from the workflow.
  const runStep = stepScript("Run enrich");
  const decision = runStep.slice(runStep.indexOf("# Live only"), runStep.indexOf('if [[ "${ENRICH_FROM_START}"'));
  assert.ok(decision.includes("--dry-run"));
  // The value is set inside the script and the script goes in on stdin: on Windows `bash` may be
  // WSL, which neither inherits the environment nor survives a quoted multi-line -c argument.
  // None of the values below contains a quote.
  const run = (script, value) => spawnSync("bash", ["-s"], { input: `ENRICH_DRY_RUN='${value}'\n${script}\n`, encoding: "utf8" });

  for (const [value, valid, dryRun] of [
    ["true", true, true],
    ["false", true, false],
    ["False", false, true],
    ["TRUE", false, true],
    [" false", false, true],
    ["0", false, true],
    ["no", false, true],
    ["", false, true],
  ]) {
    assert.equal(run(validate, value).status === 0, valid, `validate "${value}"`);
    const argv = run(`args=()\n${decision}\necho "\${args[*]}"`, value).stdout.trim();
    assert.equal(argv === "--dry-run", dryRun, `argv for "${value}" was "${argv}"`);
  }
});

test("the Enrich CLI still exits by itself, with its failure code and summary intact", { timeout: 20000 }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "enrich-cli-"));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(GOOGLE_|ENRICH_)/.test(key)) delete env[key];
    }
    const startedAt = Date.now();
    const cli = fileURLToPath(new URL("../src/enrichCli.js", import.meta.url));
    // No credentials: the run fails at the first sheet read, before any browser exists.
    const child = spawnSync(process.execPath, [cli, "--dry-run", "--limit", "1", "--job-deadline-ms", "60000"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15000,
    });

    assert.equal(child.status, 1, child.stderr);
    assert.ok(Date.now() - startedAt < 4500, "a clean failure does not wait for the forced-exit timer");
    const summary = JSON.parse(await fs.readFile(path.join(cwd, "logs", "discord-enrich-summary.json"), "utf8"));
    assert.equal(summary.status, "FAILED");
    assert.ok(summary.errorMessage);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
