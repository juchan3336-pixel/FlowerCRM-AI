import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflows = [
  {
    path: ".github/workflows/collect.yml",
    runStepId: "run_collect",
    kind: "collect",
    summaryPath: "logs/discord-collect-summary.json",
    startedSummaryPath: "logs/discord-collect-started-summary.json",
    outputLogPath: "logs/collect-output.log",
    command: "npm run collect --",
  },
  {
    path: ".github/workflows/enrich.yml",
    runStepId: "run_enrich",
    kind: "enrich",
    summaryPath: "logs/discord-enrich-summary.json",
    startedSummaryPath: "logs/discord-enrich-started-summary.json",
    outputLogPath: "logs/enrich-output.log",
    command: "npm run enrich --",
  },
  {
    path: ".github/workflows/kakao-test.yml",
    runStepId: "run_kakao_test",
    kind: "kakao",
    summaryPath: "logs/discord-kakao-summary.json",
    startedSummaryPath: "logs/discord-kakao-started-summary.json",
    outputLogPath: "logs/kakao-test-output.log",
    command: "npm run collect:test-query --",
  },
];

test("stale_state: Discord notification workflow steps are read fresh and wired after main run steps", () => {
  for (const workflow of workflows) {
    const source = readWorkflow(workflow.path);
    const runStep = extractStepById(workflow.path, workflow.runStepId);
    const notifyStep = extractStepByName(workflow.path, "Notify Discord");
    const runStepIndex = source.indexOf(runStep);
    const notifyStepIndex = source.indexOf(notifyStep);

    assert.ok(runStep.includes(`id: ${workflow.runStepId}`), `${workflow.path} fresh main run step block has stable id`);
    assert.ok(notifyStep.includes("- name: Notify Discord"), `${workflow.path} fresh notification step block is present`);
    assert.ok(notifyStepIndex > runStepIndex, `${workflow.path} notifies after the main run step`);
    assert.ok(notifyStep.includes("if: always()"), `${workflow.path} notification block runs regardless of prior outcome`);
  }
});

test("misleading_success_output: main workflow step tees output without masking exit code", () => {
  for (const workflow of workflows) {
    const runStep = extractStepById(workflow.path, workflow.runStepId);

    assert.ok(runStep.includes(workflow.command), `${workflow.path} main run block preserves existing run command`);
    assert.ok(runStep.includes(`2>&1 | tee ${workflow.outputLogPath}`), `${workflow.path} main run block captures stdout and stderr to output log`);
    assert.ok(runStep.includes("exit ${PIPESTATUS[0]}"), `${workflow.path} main run block preserves original command status after tee`);
  }
});

test("misleading_success_output: Discord notification block is non-fatal and uses required env", () => {
  const runUrlExpression = "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}";

  for (const workflow of workflows) {
    const notifyStep = extractStepByName(workflow.path, "Notify Discord");

    assert.ok(notifyStep.includes("if: always()"), `${workflow.path} notification block has if: always()`);
    assert.ok(notifyStep.includes("DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}"), `${workflow.path} notification block uses Discord webhook secret`);
    assert.ok(notifyStep.includes(`GITHUB_RUN_URL: ${runUrlExpression}`), `${workflow.path} notification block exposes GitHub run URL`);
    assert.ok(notifyStep.includes(`RUN_STEP_OUTCOME: \${{ steps.${workflow.runStepId}.outcome }}`), `${workflow.path} notification block exposes main run outcome`);
    assert.ok(
      notifyStep.includes(`node src/discordNotify.js ${workflow.kind} --summary ${workflow.summaryPath} --error-log ${workflow.outputLogPath} || true`),
      `${workflow.path} notification block sends non-fatal kind-specific Discord notification`,
    );
  }
});

test("started_notifications: Discord start step is wired before main run step", () => {
  const runUrlExpression = "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}";

  for (const workflow of workflows) {
    const source = readWorkflow(workflow.path);
    const startedStep = extractStepByName(workflow.path, "Notify Discord Started");
    const runStep = extractStepById(workflow.path, workflow.runStepId);
    const startedStepIndex = source.indexOf("- name: Notify Discord Started");
    const runStepIndex = source.indexOf(`id: ${workflow.runStepId}`);

    assert.ok(startedStepIndex < runStepIndex, `${workflow.path} start notification precedes main run step`);
    assert.ok(startedStep.includes("if: success()"), `${workflow.path} start notification runs only after successful setup`);
    assert.ok(startedStep.includes("DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}"), `${workflow.path} start notification uses Discord webhook secret`);
    assert.ok(startedStep.includes(`GITHUB_RUN_URL: ${runUrlExpression}`), `${workflow.path} start notification exposes GitHub run URL`);
    assert.ok(startedStep.includes("GITHUB_WORKFLOW: ${{ github.workflow }}"), `${workflow.path} start notification exposes workflow name`);
    assert.ok(startedStep.includes("GITHUB_JOB:"), `${workflow.path} start notification exposes GitHub job`);
    assert.ok(startedStep.includes(workflow.startedSummaryPath), `${workflow.path} start notification writes scoped summary file`);
    assert.ok(startedStep.includes('"status":"STARTED"'), `${workflow.path} start notification summary marks STARTED status`);
    assert.ok(
      startedStep.includes(`node src/discordNotify.js ${workflow.kind} --summary ${workflow.startedSummaryPath} || true`),
      `${workflow.path} start notification sends non-fatal kind-specific Discord notification`,
    );
  }
});

test("readme_discord_webhook: README documents optional setup and rejects real webhook examples", () => {
  const readme = fs.readFileSync("README.md", "utf8");

  assert.ok(readme.includes("DISCORD_WEBHOOK_URL"), "README names the Discord webhook secret");
  assert.ok(readme.includes("선택 Discord 알림용 Secret"), "README says Discord webhook is optional");
  assert.ok(
    readme.includes("GitHub Repository > Settings > Secrets and variables > Actions > New repository secret"),
    "README gives the repository secret setup path",
  );
  assert.ok(readme.includes("값이 없으면 알림만 건너뛰며 workflow는 실패하지 않습니다"), "README documents missing-webhook skip behavior");
  assert.ok(readme.includes("성공 색상은 Collect 파란색, Enrich 초록색"), "README documents collect/enrich success colors");
  assert.ok(readme.includes("실패 알림은 빨간색"), "README documents failure color");
  assert.ok(readme.includes("Kakao Test") && readme.includes("compact 알림"), "README documents compact Kakao Test notification");
  assert.equal(/https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]{20,}/.test(readme), false);
});

function extractStepByName(path, stepName) {
  const source = readWorkflow(path);
  const lines = source.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(startIndex, -1, `${path} has step named ${stepName}`);
  return extractStepBlock(lines, startIndex);
}

function extractStepById(path, stepId) {
  const source = readWorkflow(path);
  const lines = source.split(/\r?\n/);
  const idIndex = lines.findIndex((line) => line.trim() === `id: ${stepId}`);
  assert.notEqual(idIndex, -1, `${path} has step id ${stepId}`);
  const startIndex = findStepStart(lines, idIndex);
  return extractStepBlock(lines, startIndex);
}

function extractStepBlock(lines, startIndex) {
  const stepIndent = indentationOf(lines[startIndex]);
  const endIndex = lines.findIndex((line, index) => index > startIndex && indentationOf(line) === stepIndent && line.trim().startsWith("- name:"));
  return lines.slice(startIndex, endIndex === -1 ? undefined : endIndex).join("\n");
}

function findStepStart(lines, idIndex) {
  for (let index = idIndex; index >= 0; index -= 1) {
    if (lines[index].trim().startsWith("- name:")) return index;
  }
  assert.fail(`id at line ${idIndex + 1} is not inside a YAML step block`);
}

function indentationOf(line) {
  return line.match(/^\s*/)[0].length;
}

function readWorkflow(path) {
  return fs.readFileSync(path, "utf8");
}
