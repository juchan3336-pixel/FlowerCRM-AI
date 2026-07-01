import fs from "node:fs";
import { pathToFileURL } from "node:url";

const DISCORD_FIELD_LIMIT = 1024;
const ERROR_EXCERPT_LIMIT = 800;
const COLLECT_COLOR = 0x3498db;
const ENRICH_COLOR = 0x2ecc71;
const FAILURE_COLOR = 0xe74c3c;

export function buildCollectEmbed(summary = {}) {
  return buildEmbed({
    title: `Collect Bot ${text(summary.status, "DONE")}`,
    color: COLLECT_COLOR,
    fields: [
      field("상태", summary.status || "DONE"),
      field("신규 추가 수", summary.newAdded ?? summary.inserted),
      field("중복 제외 수", summary.duplicateExcluded),
      field("방문 queue 수", summary.queueVisits),
      field("종료 사유", summary.stopReason),
      field("현재 queue", summary.currentQueue),
      field("다음 queue", summary.nextQueue),
      field("실행 시간", formatRunMs(summary.runMs)),
      field("GitHub Run URL", summary.runUrl || process.env.GITHUB_RUN_URL),
      field("로그", summary.logPath),
    ],
  });
}

export function buildEnrichEmbed(summary = {}) {
  return buildEmbed({
    title: `Enrich Bot ${text(summary.status, "DONE")}`,
    color: ENRICH_COLOR,
    fields: [
      field("상태", summary.status || "DONE"),
      field("처리 수", summary.processed ?? summary.totalProcessed),
      field("홈페이지 발견 수", summary.homepageFound),
      field("이메일 발견 수", summary.emailFound),
      field("실패 수", summary.failed),
      field("시작 row", summary.startRow ?? summary.currentRow),
      field("다음 row", summary.nextRow),
      field("사용 provider", providersText(summary.provider ?? summary.providers ?? summary.searchProvidersUsed)),
      field("실행 시간", formatRunMs(summary.runMs)),
      field("GitHub Run URL", summary.runUrl || process.env.GITHUB_RUN_URL),
      field("로그", summary.logPath),
    ],
  });
}

export function buildKakaoEmbed(summary = {}) {
  return buildEmbed({
    title: `Kakao Query ${text(summary.status, "DONE")}`,
    color: COLLECT_COLOR,
    fields: [
      field("상태", summary.status || "DONE"),
      field("지역", summary.region),
      field("키워드", summary.keyword),
      field("문서 수", summary.documents ?? summary.documentCount),
      field("GitHub Run URL", summary.runUrl || process.env.GITHUB_RUN_URL),
    ],
  });
}

export function buildFailureEmbed(summary = {}) {
  const job = text(summary.job || summary.workflow || process.env.GITHUB_JOB, "workflow");
  const workflow = summary.workflow || process.env.GITHUB_WORKFLOW;
  const excerpt = truncate(text(summary.errorExcerpt ?? summary.error ?? "", "-"), ERROR_EXCERPT_LIMIT);
  return buildEmbed({
    title: `${job} ${text(summary.status, "FAILED")}`,
    color: FAILURE_COLOR,
    fields: [
      field("Workflow", workflow),
      field("Failed step", summary.failedStep || summary.step || summary.job || process.env.GITHUB_JOB),
      field("상태", summary.status || "FAILED"),
      field("메시지", summary.message || summary.errorMessage),
      field("오류 발췌", excerpt),
      field("GitHub Run URL", summary.runUrl || process.env.GITHUB_RUN_URL),
    ],
  });
}

export async function sendDiscordNotification(payload, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const fetchImpl = options.fetch || globalThis.fetch;
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.warn("DISCORD_WEBHOOK_URL not set; skipping Discord notification.");
    return true;
  }
  if (typeof fetchImpl !== "function") {
    logger.warn("fetch is unavailable; skipping Discord notification.");
    return true;
  }
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serializePayload(payload, webhookUrl),
    });
    if (!response?.ok) {
      const status = response?.status || "unknown";
      const statusText = response?.statusText ? ` ${response.statusText}` : "";
      logger.warn(redactSecret(`Discord notification skipped after HTTP ${status}${statusText}.`, webhookUrl));
    }
  } catch (error) {
    logger.warn(redactSecret(`Discord notification skipped after fetch error: ${errorMessage(error)}`, webhookUrl));
  }
  return true;
}

async function main(argv = process.argv.slice(2)) {
  const { command, summaryPath, errorLogPath } = parseArgs(argv);
  const summary = readSummary(summaryPath);
  if (errorLogPath) summary.errorExcerpt = readErrorExcerpt(errorLogPath);
  await sendDiscordNotification(buildDiscordNotificationPayload(command, summary));
}

export function buildDiscordNotificationPayload(command, summary) {
  return { username: "FlowerCRM Bot", embeds: [embedFor(command, summary)] };
}

function embedFor(command, summary) {
  if (isFailedStatus(summary.status)) return buildFailureEmbed(withFailureDefaults(command, summary));
  switch (command) {
    case "collect":
      return buildCollectEmbed(summary);
    case "enrich":
      return buildEnrichEmbed(summary);
    case "kakao":
      return buildKakaoEmbed(summary);
    case "failure":
      return buildFailureEmbed(summary);
    default:
      throw new Error(`Unknown Discord notification command: ${command}`);
  }
}

function withFailureDefaults(command, summary) {
  return {
    job: command,
    workflow: process.env.GITHUB_WORKFLOW,
    failedStep: process.env.GITHUB_JOB,
    runUrl: process.env.GITHUB_RUN_URL,
    ...summary,
  };
}

function isFailedStatus(status) {
  return String(status || "").toUpperCase() === "FAILED";
}

function buildEmbed({ title, color, fields }) {
  return {
    title,
    color,
    timestamp: new Date().toISOString(),
    fields: fields.filter(Boolean).slice(0, 25),
    footer: { text: footerText() },
  };
}

function field(name, value) {
  const normalized = text(value, "-");
  return { name, value: truncate(normalized, DISCORD_FIELD_LIMIT), inline: true };
}

function toPayload(payload) {
  const source = payload?.embeds ? payload : { embeds: [payload] };
  return { ...source, embeds: (source.embeds || []).slice(0, 1) };
}

function serializePayload(payload, webhookUrl) {
  return redactSecret(JSON.stringify(toPayload(payload)), webhookUrl);
}

function redactSecret(value, secret) {
  return secret ? String(value).replaceAll(secret, "[redacted webhook]") : String(value);
}

function parseArgs(argv) {
  const command = argv[0];
  const summaryIndex = argv.indexOf("--summary");
  if (!command || summaryIndex === -1 || !argv[summaryIndex + 1]) {
    throw new Error("Usage: node src/discordNotify.js collect|enrich|kakao|failure --summary <json> [--error-log <path>]");
  }
  const errorLogIndex = argv.indexOf("--error-log");
  return { command, summaryPath: argv[summaryIndex + 1], errorLogPath: errorLogIndex === -1 ? "" : argv[errorLogIndex + 1] || "" };
}

function readSummary(value) {
  const raw = fs.existsSync(value) ? fs.readFileSync(value, "utf8") : value;
  return JSON.parse(raw);
}

function readErrorExcerpt(path) {
  if (!path || !fs.existsSync(path)) return "";
  return truncate(fs.readFileSync(path, "utf8"), ERROR_EXCERPT_LIMIT);
}

function formatRunMs(value) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) ? `${(milliseconds / 1000).toFixed(1)}s` : "-";
}

function providersText(value) {
  return Array.isArray(value) ? value.join(", ") : value;
}

function footerText() {
  return [process.env.GITHUB_WORKFLOW, process.env.GITHUB_JOB].filter(Boolean).join(" / ") || "FlowerCRM";
}

function text(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function truncate(value, limit) {
  return value.length > limit ? value.slice(0, limit) : value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.warn(errorMessage(error));
    process.exitCode = 0;
  });
}
