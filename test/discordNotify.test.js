import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCollectEmbed,
  buildEnrichEmbed,
  buildFailureEmbed,
  buildKakaoEmbed,
  sendDiscordNotification,
} from "../src/discordNotify.js";

test("sendDiscordNotification skips absent webhook without fetch", async () => {
  let fetchCalls = 0;
  const warnings = [];

  await assert.doesNotReject(
    sendDiscordNotification({ embeds: [buildKakaoEmbed({ status: "OK" })] }, {
      env: {},
      fetch: async () => {
        fetchCalls += 1;
      },
      logger: { warn: (message) => warnings.push(message), log: () => {} },
    }),
  );

  assert.equal(fetchCalls, 0);
  assert.equal(warnings.some((message) => message.includes("DISCORD_WEBHOOK_URL")), true);
});

test("sendDiscordNotification resolves on fetch rejection", async () => {
  const warnings = [];

  await assert.doesNotReject(
    sendDiscordNotification({ embeds: [buildKakaoEmbed({ status: "OK" })] }, {
      env: { DISCORD_WEBHOOK_URL: "https://discord.example/webhook/secret-token" },
      fetch: async () => {
        throw new Error("network down");
      },
      logger: { warn: (message) => warnings.push(message), log: () => {} },
    }),
  );

  assert.equal(warnings.some((message) => message.includes("network down")), true);
  assert.equal(warnings.join("\n").includes("secret-token"), false);
});

test("sendDiscordNotification resolves on HTTP 500 without leaking webhook", async () => {
  const secretWebhook = "https://discord.example/webhook/super-secret";
  const fakeWebhook = "https://discord.example/webhook/fake-from-summary";
  const warnings = [];
  let postedUrl = "";
  let postedBody = "";

  await assert.doesNotReject(
    sendDiscordNotification({ embeds: [buildFailureEmbed({ status: "FAILED", message: `fake ${fakeWebhook}`, errorExcerpt: secretWebhook })] }, {
      env: { DISCORD_WEBHOOK_URL: secretWebhook },
      fetch: async (url, options) => {
        postedUrl = String(url);
        postedBody = String(options.body);
        return { ok: false, status: 500 };
      },
      logger: { warn: (message) => warnings.push(message), log: () => {} },
    }),
  );

  assert.equal(postedUrl, secretWebhook);
  assert.equal(warnings.join("\n").includes(secretWebhook), false);
  assert.equal(warnings.join("\n").includes(fakeWebhook), false);
  assert.equal(warnings.join("\n").includes("success"), false);
  assert.equal(postedBody.includes(secretWebhook), false);
  assert.equal(postedBody.includes(fakeWebhook), true);
  assert.equal(warnings.some((message) => message.includes("500")), true);
});

test("CLI malformed summary exits 0 and logs parse error non-fatally without webhook", () => {
  const result = spawnSync(process.execPath, ["src/discordNotify.js", "kakao", "--summary", "{bad-json"], {
    cwd: process.cwd(),
    env: { ...process.env, DISCORD_WEBHOOK_URL: "" },
    encoding: "utf8",
  });

  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0);
  assert.equal(/JSON|parse|Unexpected|Usage/i.test(output), true);
  assert.equal(output.includes("webhook/"), false);
});

test("buildCollectEmbed maps collect summary fields and color", () => {
  const embed = buildCollectEmbed({
    status: "SUCCESS",
    inserted: 12,
    newAdded: 10,
    duplicateExcluded: 3,
    queueVisits: 4,
    stopReason: "limit_reached",
    currentQueue: "부산 병원",
    nextQueue: "김해 병원",
    runMs: 12345,
    runUrl: "https://github.example/actions/runs/1",
    logPath: "logs/collect.log",
  });

  assert.equal(embed.color, 0x3498db);
  assert.equal(embed.title, "Collect Bot SUCCESS");
  assertField(embed, "상태", "SUCCESS");
  assertField(embed, "신규 추가 수", "10");
  assertField(embed, "중복 제외 수", "3");
  assertField(embed, "방문 queue 수", "4");
  assertField(embed, "종료 사유", "limit_reached");
  assertField(embed, "현재 queue", "부산 병원");
  assertField(embed, "다음 queue", "김해 병원");
  assertField(embed, "실행 시간", "12.3s");
  assertField(embed, "GitHub Run URL", "https://github.example/actions/runs/1");
  assertField(embed, "로그", "logs/collect.log");
  assert.equal(embed.fields.every((field) => field.value.length <= 1024), true);
});

test("buildEnrichEmbed maps enrich summary fields and color", () => {
  const embed = buildEnrichEmbed({
    status: "SUCCESS",
    processed: 30,
    homepageFound: 9,
    emailFound: 7,
    failed: 2,
    startRow: 101,
    nextRow: 131,
    providers: ["naver", "google"],
    runMs: 2000,
    runUrl: "https://github.example/actions/runs/2",
    logPath: "logs/enrich.log",
  });

  assert.equal(embed.color, 0x2ecc71);
  assert.equal(embed.title, "Enrich Bot SUCCESS");
  assertField(embed, "상태", "SUCCESS");
  assertField(embed, "처리 수", "30");
  assertField(embed, "홈페이지 발견 수", "9");
  assertField(embed, "이메일 발견 수", "7");
  assertField(embed, "실패 수", "2");
  assertField(embed, "시작 row", "101");
  assertField(embed, "다음 row", "131");
  assertField(embed, "사용 provider", "naver, google");
  assertField(embed, "실행 시간", "2.0s");
  assertField(embed, "GitHub Run URL", "https://github.example/actions/runs/2");
  assertField(embed, "로그", "logs/enrich.log");
});

test("buildKakaoEmbed returns compact success payload", () => {
  const embed = buildKakaoEmbed({ region: "부산", keyword: "병원", documents: 15, status: "SUCCESS", runUrl: "https://github.example/actions/runs/3" });

  assert.equal(embed.color, 0x3498db);
  assert.equal(embed.title, "Kakao Query SUCCESS");
  assert.equal(embed.fields.length, 5);
  assertField(embed, "상태", "SUCCESS");
  assertField(embed, "지역", "부산");
  assertField(embed, "키워드", "병원");
  assertField(embed, "문서 수", "15");
  assertField(embed, "GitHub Run URL", "https://github.example/actions/runs/3");
});

test("buildFailureEmbed maps failure fields, color, and truncates error excerpt", () => {
  const longError = `first failure line ${"x".repeat(900)}`;
  const embed = buildFailureEmbed({
    workflow: "FlowerCRM Collect",
    failedStep: "collect leads",
    job: "collect",
    status: "FAILED",
    message: "boom",
    errorExcerpt: longError,
    runUrl: "https://github.example/actions/runs/4",
  });

  assert.equal(embed.color, 0xe74c3c);
  assert.equal(embed.title, "collect FAILED");
  assertField(embed, "Workflow", "FlowerCRM Collect");
  assertField(embed, "Failed step", "collect leads");
  assertField(embed, "상태", "FAILED");
  assertField(embed, "메시지", "boom");
  assertField(embed, "GitHub Run URL", "https://github.example/actions/runs/4");
  const excerpt = embed.fields.find((field) => field.name === "오류 발췌")?.value || "";
  assert.equal(excerpt, longError.slice(0, 800));
  assert.equal(embed.fields.every((field) => field.value.length <= 1024), true);
});

test("CLI dispatch skips missing webhook without leaking webhook URL", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-notify-"));
  const summaryPath = path.join(tempDir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({ status: "SUCCESS", documents: 2, region: "부산", keyword: "병원" }), "utf8");

  const result = spawnSync(process.execPath, ["src/discordNotify.js", "kakao", "--summary", summaryPath], {
    cwd: process.cwd(),
    env: { ...process.env, DISCORD_WEBHOOK_URL: "" },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes("DISCORD_WEBHOOK_URL not set"), true);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes("webhook/"), false);
});

function assertField(embed, name, value) {
  assert.deepEqual(
    embed.fields.find((field) => field.name === name),
    { name, value, inline: true },
  );
}
