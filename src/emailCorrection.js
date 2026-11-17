// Clearing emails that an audit found to be someone else's (a directory operator's mailbox written
// as a business's address). One manifest lists the rows; nothing is cleared unless the row still
// shows exactly what the audit saw:
//   - column A is the audited company name, and
//   - column H is the audited email.
// Any other state stops the whole run before a single cell is written (fail closed): the sheet
// may have moved on since the audit, and a moved row would otherwise lose a correct address.
// A row whose H is already empty and whose memo already carries this audit's note was done
// before, and is skipped. Only H (cleared) and M (a note appended) are ever written; afterwards
// every row is read again and must show H empty, the note at the end of M, and A–L unchanged.

export const CORRECTION_COLUMNS = ["H", "M"];
const COLUMN_INDEX = { A: 0, H: 7, M: 12 };

const norm = (value) => String(value ?? "").trim();
const normEmail = (value) => norm(value).toLowerCase();

export function correctionNote(entry, audit) {
  const domain = normEmail(entry.email).split("@")[1] || "";
  return `enrich operator_email_cleared=${domain} audit=${audit}`;
}

// rows: rowNumber → the row's cells A..M (as read). Returns { actions, skipped, problems }.
export function planCorrections(manifest, rows) {
  const audit = norm(manifest.audit);
  const actions = [];
  const skipped = [];
  const problems = [];
  if (!audit) problems.push({ row: null, problem: "manifest has no audit id" });
  const seen = new Set();
  for (const entry of manifest.entries || []) {
    const row = Number(entry.row);
    if (!Number.isInteger(row) || row < 2) {
      problems.push({ row: entry.row, problem: "invalid row number" });
      continue;
    }
    if (seen.has(row)) {
      problems.push({ row, problem: "row listed twice" });
      continue;
    }
    seen.add(row);
    const cells = rows.get(row);
    if (!cells) {
      problems.push({ row, problem: "row not read" });
      continue;
    }
    const company = norm(cells[COLUMN_INDEX.A]);
    const email = normEmail(cells[COLUMN_INDEX.H]);
    const memo = String(cells[COLUMN_INDEX.M] ?? "");
    const note = correctionNote(entry, audit);
    if (company !== norm(entry.company)) {
      problems.push({ row, problem: "company name differs from the audit", expected: entry.company, actual: company });
      continue;
    }
    if (!email && memo.includes(note)) {
      skipped.push({ row, reason: "already cleared by this audit" });
      continue;
    }
    if (email !== normEmail(entry.email)) {
      problems.push({ row, problem: "email differs from the audit", expected: entry.email, actual: cells[COLUMN_INDEX.H] ?? "" });
      continue;
    }
    actions.push({
      row,
      company,
      before: [...cells],
      cells: [
        { column: "H", value: "" },
        { column: "M", value: memo.trim() ? `${memo} | ${note}` : note },
      ],
      note,
    });
  }
  return { actions, skipped, problems };
}

// What every corrected row must look like when read back.
export function verifyCorrections(actions, rowsAfter) {
  const problems = [];
  for (const action of actions) {
    const after = rowsAfter.get(action.row);
    if (!after) {
      problems.push({ row: action.row, problem: "row not read back" });
      continue;
    }
    if (norm(after[COLUMN_INDEX.H])) problems.push({ row: action.row, problem: "H is not empty after the write" });
    if (!String(after[COLUMN_INDEX.M] ?? "").endsWith(action.note)) problems.push({ row: action.row, problem: "M does not end with the note" });
    for (let index = 0; index < 12; index += 1) {
      if (index === COLUMN_INDEX.H) continue;
      if (norm(after[index]) !== norm(action.before[index])) {
        problems.push({ row: action.row, problem: `column ${String.fromCharCode(65 + index)} changed` });
      }
    }
  }
  return problems;
}

// sheets: { readDbRow(spreadsheetId, row) → cells A..M, writeDbCells(spreadsheetId, [{ rowNumber, column, value }]) }
export async function runCorrections({ sheets, spreadsheetId, manifest, dryRun = true, log = () => {} }) {
  const rowNumbers = [...new Set((manifest.entries || []).map((entry) => Number(entry.row)).filter((row) => Number.isInteger(row) && row >= 2))];
  const read = async () => {
    const rows = new Map();
    for (const row of rowNumbers) rows.set(row, await sheets.readDbRow(spreadsheetId, row));
    return rows;
  };
  const before = await read();
  const plan = planCorrections(manifest, before);
  for (const item of plan.problems) log("problem", item);
  for (const item of plan.skipped) log("skipped", item);
  for (const action of plan.actions) log("planned", { row: action.row, company: action.company, note: action.note });
  if (plan.problems.length > 0) return { status: "aborted", written: 0, ...plan };
  if (dryRun || plan.actions.length === 0) return { status: dryRun ? "dry_run" : "nothing_to_do", written: 0, ...plan };

  // Read once more right before writing: nothing may have changed since the plan was made.
  const recheck = planCorrections(manifest, await read());
  if (recheck.problems.length > 0 || recheck.actions.length !== plan.actions.length) {
    for (const item of recheck.problems) log("problem", item);
    return { status: "aborted", written: 0, ...recheck };
  }
  const cells = recheck.actions.flatMap((action) => action.cells.map((cell) => ({ rowNumber: action.row, ...cell })));
  if (cells.some((cell) => !CORRECTION_COLUMNS.includes(cell.column))) throw new Error("only H and M may be written");
  await sheets.writeDbCells(spreadsheetId, cells);
  const verifyProblems = verifyCorrections(recheck.actions, await read());
  for (const item of verifyProblems) log("verify_problem", item);
  return { status: verifyProblems.length ? "written_with_problems" : "written", written: recheck.actions.length, ...recheck, verifyProblems };
}
