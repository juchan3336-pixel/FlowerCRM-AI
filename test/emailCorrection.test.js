import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { correctionNote, planCorrections, runCorrections, verifyCorrections } from "../src/emailCorrection.js";

const AUDIT = "audit-test";
const row = (company, email, memo = "system queue collect") => [company, "병원", "", "경남", "주소 1", "055-000-0001", "", email, "", "", "", "", memo];
const manifest = (entries) => ({ audit: AUDIT, entries });
const ENTRY_A = { row: 10, company: "가나의원", email: "help@directory.test" };
const ENTRY_B = { row: 11, company: "다라의원", email: "help@directory.test" };

function fakeSheets(initial) {
  const rows = new Map([...initial].map(([key, cells]) => [key, [...cells]]));
  const writes = [];
  return {
    rows,
    writes,
    async readDbRow(spreadsheetId, rowNumber) {
      return [...(rows.get(rowNumber) || Array(13).fill(""))];
    },
    async writeDbCells(spreadsheetId, cells) {
      writes.push(...cells);
      for (const { rowNumber, column, value } of cells) rows.get(rowNumber)[column === "H" ? 7 : 12] = value;
      return { updated: cells.length };
    },
  };
}

test("a row that still shows the audited company and email is cleared, with a note", () => {
  const plan = planCorrections(manifest([ENTRY_A]), new Map([[10, row("가나의원", "Help@Directory.test ")]]));
  assert.equal(plan.problems.length, 0);
  assert.equal(plan.actions.length, 1);
  assert.deepEqual(plan.actions[0].cells, [
    { column: "H", value: "" },
    { column: "M", value: `system queue collect | ${correctionNote(ENTRY_A, AUDIT)}` },
  ]);
  assert.equal(correctionNote(ENTRY_A, AUDIT), "enrich operator_email_cleared=directory.test audit=audit-test");
});

test("any row that moved on since the audit stops the whole run", async () => {
  for (const [label, cells] of [
    ["another company now on the row", row("마바의원", "help@directory.test")],
    ["another email now in H", row("가나의원", "clinic@gana.test")],
    ["H emptied by someone else, no note", row("가나의원", "")],
  ]) {
    const sheets = fakeSheets(new Map([[10, cells], [11, row("다라의원", "help@directory.test")]]));
    const result = await runCorrections({ sheets, spreadsheetId: "s", manifest: manifest([ENTRY_A, ENTRY_B]), dryRun: false });
    assert.equal(result.status, "aborted", label);
    assert.equal(sheets.writes.length, 0, `${label}: nothing written, not even the matching row`);
  }
});

test("a row already cleared by this audit is skipped, not noted twice", () => {
  const note = correctionNote(ENTRY_A, AUDIT);
  const plan = planCorrections(manifest([ENTRY_A]), new Map([[10, row("가나의원", "", `system queue collect | ${note}`)]]));
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.problems.length, 0);
  assert.deepEqual(plan.skipped, [{ row: 10, reason: "already cleared by this audit" }]);
});

test("a manifest without an audit id, a duplicate row or a bad row number is refused", () => {
  assert.ok(planCorrections({ entries: [ENTRY_A] }, new Map([[10, row("가나의원", "help@directory.test")]])).problems.length > 0);
  assert.ok(planCorrections(manifest([ENTRY_A, ENTRY_A]), new Map([[10, row("가나의원", "help@directory.test")]])).problems.length > 0);
  assert.ok(planCorrections(manifest([{ ...ENTRY_A, row: 1 }]), new Map()).problems.length > 0);
});

test("a dry run reads and plans but writes nothing", async () => {
  const sheets = fakeSheets(new Map([[10, row("가나의원", "help@directory.test")]]));
  const result = await runCorrections({ sheets, spreadsheetId: "s", manifest: manifest([ENTRY_A]), dryRun: true });
  assert.equal(result.status, "dry_run");
  assert.equal(result.actions.length, 1);
  assert.equal(sheets.writes.length, 0);
});

test("a live run writes only H and M, then reads every row back to confirm", async () => {
  const sheets = fakeSheets(new Map([[10, row("가나의원", "help@directory.test")], [11, row("다라의원", "help@directory.test", "")]]));
  const result = await runCorrections({ sheets, spreadsheetId: "s", manifest: manifest([ENTRY_A, ENTRY_B]), dryRun: false });
  assert.equal(result.status, "written");
  assert.equal(result.written, 2);
  assert.deepEqual([...new Set(sheets.writes.map((cell) => cell.column))].sort(), ["H", "M"]);
  assert.equal(sheets.rows.get(10)[7], "");
  assert.equal(sheets.rows.get(11)[12], correctionNote(ENTRY_B, AUDIT));
  assert.equal(sheets.rows.get(10)[0], "가나의원");

  // Running it again finds both done.
  const again = await runCorrections({ sheets, spreadsheetId: "s", manifest: manifest([ENTRY_A, ENTRY_B]), dryRun: false });
  assert.equal(again.status, "nothing_to_do");
  assert.equal(again.skipped.length, 2);
});

test("the read-back flags a row whose other columns changed", () => {
  const before = row("가나의원", "help@directory.test");
  const action = { row: 10, before, note: "n" };
  const after = [...before];
  after[7] = "";
  after[12] = "x | n";
  after[5] = "055-999-9999";
  assert.deepEqual(verifyCorrections([action], new Map([[10, after]])), [{ row: 10, problem: "column F changed" }]);
});

test("the shipped manifest lists only directory-operator addresses, each row once", () => {
  const shipped = JSON.parse(fs.readFileSync("corrections/2026-11-17-operator-emails.json", "utf8"));
  assert.equal(shipped.audit, "operator-email-2026-11-17");
  assert.equal(shipped.entries.length, 13);
  assert.equal(new Set(shipped.entries.map((entry) => entry.row)).size, 13);
  for (const entry of shipped.entries) {
    assert.match(entry.email, /@(yugacrew\.com|goodoc\.co\.kr)$/);
    assert.ok(entry.company);
  }
});

test("the workflow writes only when dry_run is exactly false, and only from corrections/", () => {
  const workflow = fs.readFileSync(".github/workflows/email-correction.yml", "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /default: "true"/);
  assert.ok(workflow.includes(`if [[ "\${CORRECTION_DRY_RUN}" == "false" ]]; then\n            args+=(--live)`));
  assert.ok(workflow.includes("^corrections/[A-Za-z0-9._-]+\\.json$"));
  assert.ok(workflow.indexOf("- name: Validate inputs") < workflow.indexOf("- name: Checkout"));
});
