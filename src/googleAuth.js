import crypto from "node:crypto";
import fs from "node:fs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"];

let cachedToken = null;

// deadlineAt (epoch ms, 0 = none) is the caller's absolute job deadline. It is passed as an instant
// rather than as "time left" so that an exhausted budget can never be mistaken for "no limit",
// and so it can be checked again right before the request leaves, after the signing work.
export async function getAccessToken({ deadlineAt = 0 } = {}) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const account = readServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPES.join(" "),
      aud: TOKEN_URL,
      exp: now + 3600,
      iat: now,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(account.private_key);
  const assertion = `${unsigned}.${base64url(signature)}`;

  // The token request is bounded like every other Google call (headers and body): it runs before
  // the first sheet read, where a silent connection would otherwise stall the whole job.
  const hasDeadline = Number.isFinite(Number(deadlineAt)) && Number(deadlineAt) > 0;
  const remainingMs = hasDeadline ? Number(deadlineAt) - Date.now() : Infinity;
  if (remainingMs <= 0) {
    // Nothing is sent once the job's time is up — not even the token request.
    const expired = new Error("Google API deadline exceeded before the OAuth token request was sent");
    expired.code = "google_timeout";
    expired.deadlineExceeded = true;
    expired.writeOutcomeUnknown = false;
    throw expired;
  }
  const timeoutMs = Math.max(1, Math.min(tokenRequestTimeoutMs(), remainingMs));
  let data;
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Google OAuth token error: ${response.status} ${await response.text()}`);
    }

    data = await response.json();
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      const timeout = new Error(`Google OAuth token request timed out after ${timeoutMs}ms`);
      timeout.code = "google_timeout";
      timeout.cause = error;
      throw timeout;
    }
    throw error;
  }
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

function tokenRequestTimeoutMs() {
  const configured = Number(process.env.GOOGLE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 120000;
}

function readServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  }
  throw new Error("Google 인증 정보가 없습니다. GOOGLE_APPLICATION_CREDENTIALS 또는 GOOGLE_SERVICE_ACCOUNT_JSON을 설정하세요.");
}

function base64url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
