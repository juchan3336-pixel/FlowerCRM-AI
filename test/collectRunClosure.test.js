import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { resolveCollectOutcome } from "../src/cli.js";
import {
  MIN_QUEUE_VISITS_FOR_EMPTY_RUN_ALARM,
  NO_RESULT_CARDS_STOP_REASON,
  resolveRunClosure,
  sawNoResultCards,
} from "../src/queueCollect.js";

// From 2026-10-21 to 11-10 every collect run saw no result cards, walked the queue forward and
// logged a finished stretch. The decision now happens before SYSTEM and LOG are written.

const start = { queueIndex: 120, queueAttemptCount: 1, failureCounts: { "q-7": 2 } };

test("a run with no result cards hands back the position it started from", () => {
  const closure = resolveRunClosure({
    stats: { queueVisits: 26, queueSkipped: 0, cardsScanned: 0 },
    stopReason: "max_runtime_reached",
    queueIndex: 146,
    queueAttemptCount: 0,
    failureCounts: { "q-7": 3, "q-9": 1 },
    start,
  });

  assert.equal(closure.emptyRun, true);
  assert.equal(closure.stopReason, NO_RESULT_CARDS_STOP_REASON);
  assert.equal(closure.queueIndex, 120);
  assert.equal(closure.queueAttemptCount, 1);
  // Three failures retire a keyword; none of these failures were the keyword's.
  assert.deepEqual(closure.failureCounts, { "q-7": 2 });
  assert.notEqual(closure.failureCounts, start.failureCounts);
});

test("a run that saw cards keeps the position it reached, even when all were duplicates", () => {
  const failureCounts = { "q-7": 0 };
  const closure = resolveRunClosure({
    stats: { queueVisits: 26, queueSkipped: 0, cardsScanned: 119 },
    stopReason: "max_runtime_reached",
    queueIndex: 146,
    queueAttemptCount: 0,
    failureCounts,
    start,
  });

  assert.equal(closure.emptyRun, false);
  assert.equal(closure.stopReason, "max_runtime_reached");
  assert.equal(closure.queueIndex, 146);
  assert.equal(closure.failureCounts, failureCounts);
});

test("an outage keeps its own stop reason and the queue it stopped on", () => {
  const closure = resolveRunClosure({
    stats: { queueVisits: 14, queueSkipped: 0, cardsScanned: 0 },
    stopReason: "provider_unavailable",
    queueIndex: 133,
    queueAttemptCount: 0,
    failureCounts: {},
    start,
  });

  assert.equal(closure.emptyRun, false);
  assert.equal(closure.stopReason, "provider_unavailable");
  assert.equal(closure.queueIndex, 133);
});

test("the empty-run alarm counts only queues that reached the provider", () => {
  const limit = MIN_QUEUE_VISITS_FOR_EMPTY_RUN_ALARM;
  assert.equal(sawNoResultCards({ queueVisits: limit, queueSkipped: 0, cardsScanned: 0 }), true);
  assert.equal(sawNoResultCards({ queueVisits: limit - 1, queueSkipped: 0, cardsScanned: 0 }), false);
  // Queues skipped for a retired keyword never asked the provider anything.
  assert.equal(sawNoResultCards({ queueVisits: limit + 5, queueSkipped: 6, cardsScanned: 0 }), false);
  assert.equal(sawNoResultCards({ queueVisits: 40, queueSkipped: 0, cardsScanned: 1 }), false);
  assert.equal(sawNoResultCards({}), false);
});

test("the CLI fails a run closed as no_result_cards", () => {
  const outcome = resolveCollectOutcome({ report: { stopReason: NO_RESULT_CARDS_STOP_REASON, queueVisits: 26, cardsScanned: 0 } });
  assert.equal(outcome.status, "FAILED");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.errorMessage, /no result cards in 26 queue visits/);
});

test("the run decides the closure before it writes SYSTEM, local state or LOG", () => {
  const source = fs.readFileSync("src/queueCollect.js", "utf8");
  const body = source.slice(source.indexOf("export async function runQueuedCollect"), source.indexOf("export const MIN_QUEUE_VISITS_FOR_EMPTY_RUN_ALARM"));
  const closureAt = body.indexOf("resolveRunClosure(");
  assert.ok(closureAt > 0, "runQueuedCollect calls resolveRunClosure");
  for (const write of ["saveLeadsToGoogleSheets(", "writeSystemState(", "saveState(", "appendRejectedPlaces(", "appendCollectLog("]) {
    const writeAt = body.indexOf(write);
    assert.ok(writeAt > closureAt, `${write} comes after the closure decision`);
  }
});

const workflow = fs.readFileSync(".github/workflows/collect.yml", "utf8").replace(/\r\n/g, "\n");

test("collect workflow has no GitHub schedule", () => {
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.doesNotMatch(workflow, /cron:/);
});

test("collect workflow writes only when dry_run is exactly false", () => {
  const dryRunInput = workflow.slice(workflow.indexOf("      dry_run:"), workflow.indexOf("      debug:"));
  assert.match(dryRunInput, /default: "true"/);
  assert.ok(workflow.includes("COLLECT_DRY_RUN: ${{ github.event.inputs.dry_run || 'true' }}"));
  assert.ok(workflow.includes('if [[ "${COLLECT_DRY_RUN}" != "false" ]]; then\n            args+=(--dry-run)'));
  assert.ok(!workflow.includes('"${COLLECT_DRY_RUN}" == "true"'));
});

test("collect workflow rejects any other dry_run value before installing anything", () => {
  const validateAt = workflow.indexOf("- name: Validate dry_run");
  assert.ok(validateAt > 0);
  assert.ok(validateAt < workflow.indexOf("- name: Install dependencies"));
  assert.ok(validateAt < workflow.indexOf("- name: Run collector"));
  const step = workflow.slice(validateAt, workflow.indexOf("- name: Install dependencies"));
  assert.ok(step.includes('"${COLLECT_DRY_RUN}" != "true" && "${COLLECT_DRY_RUN}" != "false"'));
  assert.ok(step.includes("exit 1"));
});

test("collect workflow names a scheduler run by its dispatch id", () => {
  assert.match(workflow, /^run-name: .*github\.event\.inputs\.dispatch_id/m);
  assert.match(workflow, /^      dispatch_id:/m);
});
