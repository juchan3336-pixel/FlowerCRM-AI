import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCollectOutcome, writeDiscordCollectSummary, writeErrorExcerpt } from "../src/cli.js";

test("collect Discord summary writers create success and failure files", () => {
  const previousCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "collect-summary-writer-"));
  try {
    process.chdir(tempDir);

    writeDiscordCollectSummary({
      status: "SUCCESS",
      inserted: 12,
      newAdded: 12,
      duplicateExcluded: 3,
      queueVisits: 4,
      stopReason: "limit_reached",
      currentQueue: { region: "부산", category: "병원" },
      nextQueue: { region: "김해", category: "병원" },
      runMs: 12345,
      logPath: "logs/collect.log",
    });
    const successSummary = JSON.parse(fs.readFileSync(path.join("logs", "discord-collect-summary.json"), "utf8"));

    writeErrorExcerpt("x".repeat(2100));
    writeDiscordCollectSummary({
      status: "FAILED",
      message: "Collect workflow failed",
      errorMessage: "boom",
      logPath: "logs/collect.log",
      errorLogPath: path.join("logs", "discord-collect-error.log"),
    });

    const failedSummary = JSON.parse(fs.readFileSync(path.join("logs", "discord-collect-summary.json"), "utf8"));
    const errorExcerpt = fs.readFileSync(path.join("logs", "discord-collect-error.log"), "utf8");
    assert.equal(successSummary.status, "SUCCESS");
    assert.equal(successSummary.inserted, 12);
    assert.equal(successSummary.newAdded, 12);
    assert.equal(successSummary.duplicateExcluded, 3);
    assert.equal(successSummary.queueVisits, 4);
    assert.equal(successSummary.stopReason, "limit_reached");
    assert.deepEqual(successSummary.currentQueue, { region: "부산", category: "병원" });
    assert.deepEqual(successSummary.nextQueue, { region: "김해", category: "병원" });
    assert.equal(successSummary.runMs, 12345);
    assert.equal(failedSummary.status, "FAILED");
    assert.equal(failedSummary.message, "Collect workflow failed");
    assert.equal(failedSummary.errorMessage, "boom");
    assert.equal(failedSummary.logPath, "logs/collect.log");
    assert.equal(failedSummary.errorLogPath, path.join("logs", "discord-collect-error.log"));
    assert.equal(errorExcerpt.trimEnd().length, 2000);
  } finally {
    process.chdir(previousCwd);
  }
});

test("a provider outage ends the collect run as a failure", () => {
  // The run still saves what it had and writes SYSTEM/LOG, but the workflow must go red: a green
  // run that collected nothing because the provider refused it is how the outage went unseen.
  const outcome = resolveCollectOutcome({
    report: { stopReason: "provider_unavailable" },
    providerUnavailable: { provider: "kakao-map", status: 403, message: "kakao-map answered HTTP 403 (Restricted User Agent)" },
  });

  assert.equal(outcome.status, "FAILED");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.errorMessage, /kakao-map answered HTTP 403/);
});

test("ordinary stop reasons end the collect run as a success", () => {
  for (const stopReason of ["limit_reached", "max_runtime_reached", "max_queue_visited", "Completed"]) {
    const outcome = resolveCollectOutcome({ report: { stopReason } });
    assert.equal(outcome.status, "SUCCESS", stopReason);
    assert.equal(outcome.exitCode, 0, stopReason);
  }
});

test("a whole run without a single result card ends as a failure", () => {
  // The general form of the same blind spot: a markup change would also read as "0 results" on
  // every queue. Healthy runs never do this, so it is safe to treat as an alarm.
  const empty = resolveCollectOutcome({ report: { stopReason: "max_runtime_reached", queueVisits: 26, cardsScanned: 0 } });
  assert.equal(empty.status, "FAILED");
  assert.equal(empty.exitCode, 1);
  assert.match(empty.errorMessage, /no result cards in 26 queue visits/);

  // Cards were seen, even if every one was a duplicate: an ordinary run.
  const duplicatesOnly = resolveCollectOutcome({ report: { stopReason: "max_runtime_reached", queueVisits: 26, cardsScanned: 119 } });
  assert.equal(duplicatesOnly.status, "SUCCESS");

  // A short manual run that lands on a few empty keywords proves nothing.
  const shortRun = resolveCollectOutcome({ report: { stopReason: "max_queue_visited", queueVisits: 3, cardsScanned: 0 } });
  assert.equal(shortRun.status, "SUCCESS");
});
