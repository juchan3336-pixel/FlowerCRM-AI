import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeDiscordCollectSummary, writeErrorExcerpt } from "../src/cli.js";

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
