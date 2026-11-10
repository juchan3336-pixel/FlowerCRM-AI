// Review round 3 contracts — the job deadline is one absolute instant fixed when the job starts
// (setup time is not handed out twice), an exhausted budget is never read as "no limit", and one
// provider that will not close cannot keep the others from being asked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

import { FallbackHomepageSearchProvider, resolveJobWindow, runEnrich, settleWithin } from "../src/enrich.js";
import { getAccessToken } from "../src/googleAuth.js";
import { googleFetch, setGoogleDeadline } from "../src/googleSheets.js";

// runEnrich prints its telemetry block with console.log. Under node --test that raw text shares
// the child's stdout with the runner's own framed messages, and when the machine is busy the
// runner can mis-split the stream and fail the whole file ("Unable to deserialize cloned data")
// even though every test passed. These tests assert on returned values, never on that output,
// so it is silenced for this file's process.
console.log = () => {};

const T = { timeout: 5000 };
const MINUTE = 60000;
const JOB_START = 1_800_000_000_000;
const never = () => new Promise(() => {});

test("the node budget shrinks by whatever setup already used", () => {
  // The workflow fixes the deadline 55 minutes after the job starts.
  const deadlineAt = JOB_START + 55 * MINUTE;

  const instant = resolveJobWindow({ jobDeadlineAt: deadlineAt, nowMs: JOB_START });
  assert.deepEqual(instant, { deadlineAt, limitMs: 55 * MINUTE });

  const afterSetup = resolveJobWindow({ jobDeadlineAt: deadlineAt, nowMs: JOB_START + 4 * MINUTE });
  assert.deepEqual(afterSetup, { deadlineAt, limitMs: 51 * MINUTE }, "four minutes of setup come out of the budget");
});

test("a deadline that has already passed stops the job instead of meaning no limit", () => {
  const deadlineAt = JOB_START + 55 * MINUTE;
  for (const nowMs of [deadlineAt, deadlineAt + 1, deadlineAt + 10 * MINUTE]) {
    assert.throws(() => resolveJobWindow({ jobDeadlineAt: deadlineAt, nowMs }), { code: "job_deadline_exceeded" });
  }
});

test("the absolute deadline wins, the relative one counts from now, and neither means none", () => {
  assert.deepEqual(resolveJobWindow({ jobDeadlineAt: JOB_START + 1000, jobDeadlineMs: 999999, nowMs: JOB_START }), {
    deadlineAt: JOB_START + 1000,
    limitMs: 1000,
  });
  assert.deepEqual(resolveJobWindow({ jobDeadlineMs: 5000, nowMs: JOB_START }), { deadlineAt: JOB_START + 5000, limitMs: 5000 });
  assert.deepEqual(resolveJobWindow({ nowMs: JOB_START }), { deadlineAt: 0, limitMs: 0 });
});

test("runEnrich hands the sheets client the fixed instant, not a fresh window", T, async () => {
  const deadlines = [];
  const deadlineAt = Date.now() + 60000;
  const sheets = {
    setDeadline: (at) => deadlines.push(at),
    async getTargetSpreadsheet() {
      return { spreadsheetId: "sheet-job-deadline" };
    },
    async readSystemState() {
      return { enrich_current_row: "2" };
    },
    async readQueuedEnrichmentRows() {
      return { candidates: [], nextRow: 2, scanned: 0, skipped: 0 };
    },
  };

  await runEnrich({ limit: 1, sheets, homepageProvider: { async close() {} }, dryRun: true, jobDeadlineAt: deadlineAt });

  assert.deepEqual(deadlines, [deadlineAt, 0]);
});

test("runEnrich starts nothing when the job deadline has already passed", T, async () => {
  const touched = [];
  const sheets = new Proxy(
    {},
    {
      get: (_target, name) => () => {
        touched.push(String(name));
        return {};
      },
    },
  );
  const provider = {
    async close() {
      touched.push("provider.close");
    },
  };

  await assert.rejects(runEnrich({ limit: 1, sheets, homepageProvider: provider, jobDeadlineAt: Date.now() - 1 }), {
    code: "job_deadline_exceeded",
  });
  assert.deepEqual(touched, [], "no sheet read, no write, no browser");
});

// Must run before anything in this file caches a token.
test("a budget that runs out between two clock reads sends neither the token request nor the API call", T, async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "test@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
  };
  try {
    // The deadline is 100. The first read still sees 99 (time left); every later one sees 100.
    let reads = 0;
    Date.now = () => (reads++ === 0 ? 99 : 100);
    setGoogleDeadline(100);

    await assert.rejects(
      googleFetch("https://sheets.googleapis.com/v4/spreadsheets/id/values/LOG!A1:append", { method: "POST", body: {} }),
      (error) => {
        assert.equal(error.code, "google_timeout");
        assert.equal(error.deadlineExceeded, true);
        assert.equal(error.writeOutcomeUnknown, false, "nothing was sent, so nothing was applied");
        return true;
      },
    );
    assert.deepEqual(calls, [], "OAuth 0 requests, API 0 requests");

    // Same rule when the token function is called directly with an exhausted deadline.
    await assert.rejects(getAccessToken({ deadlineAt: 100 }), { code: "google_timeout", deadlineExceeded: true });
    assert.deepEqual(calls, []);
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    setGoogleDeadline(0);
  }
});

test("one provider that never finishes closing does not stop the others from being closed", T, async () => {
  const attempted = [];
  const provider = new FallbackHomepageSearchProvider({
    providers: [
      {
        name: "a",
        close() {
          attempted.push("a");
          return never();
        },
      },
      {
        name: "b",
        async close() {
          attempted.push("b");
        },
      },
    ],
    sourceProvider: {
      async close() {
        attempted.push("source");
      },
    },
  });

  const outcome = await settleWithin(() => provider.close(), 50);

  assert.deepEqual(outcome, { settled: false }, "the caller's grace still bounds the wait");
  assert.deepEqual(attempted, ["a", "b", "source"]);
});

const bashAvailable = spawnSync("bash", ["-c", "exit 0"]).status === 0;

test("the workflow fixes the job deadline in its very first step and passes it to the process", T, async () => {
  const source = (await fs.readFile(new URL("../.github/workflows/enrich.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const steps = source.slice(source.indexOf("    steps:\n"));
  const firstStep = steps.match(/- name: (.+)\n/)[1];

  assert.equal(firstStep, "Fix job deadline", "nothing may run before the deadline is fixed");
  assert.ok(steps.indexOf("Fix job deadline") < steps.indexOf("Install Playwright Chromium"));
  assert.ok(source.includes('>> "$GITHUB_ENV"'));
  assert.equal(source.includes("ENRICH_JOB_DEADLINE_MS"), false, "no relative window that restarts when node starts");

  const timeoutMinutes = Number(source.match(/timeout-minutes: (\d+)/)[1]);
  const offsetMs = Number(source.match(/\* 1000 \+ (\d+) \)\)/)[1]);
  assert.ok(offsetMs > 0 && offsetMs <= (timeoutMinutes - 5) * MINUTE, "at least five minutes are left for uploads and notifications");
});

test("the deadline step writes an epoch-ms instant 55 minutes ahead", { ...T, skip: bashAvailable ? false : "bash not available" }, async () => {
  const source = (await fs.readFile(new URL("../.github/workflows/enrich.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const line = source.split("\n").find((item) => item.includes("ENRICH_JOB_DEADLINE_AT_MS=$(("));
  // The redirect target is swapped for stdout (">&1") so the test needs no writable file; the
  // arithmetic that produces the value is the workflow's own line, untouched.
  assert.ok(line.trim().endsWith('>> "$GITHUB_ENV"'));
  const script = `${line.trim().replace('>> "$GITHUB_ENV"', ">&1")}\n`;

  const before = Date.now();
  const child = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  const value = Number(child.stdout.trim().split("=")[1]);

  assert.ok(Number.isInteger(value), child.stdout + child.stderr);
  // Second resolution on the shell side, hence the one-second slack either way.
  assert.ok(value >= before + 55 * MINUTE - 1000 && value <= Date.now() + 55 * MINUTE + 1000, String(value - before));
});
