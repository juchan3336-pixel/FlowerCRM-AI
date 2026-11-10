// Runtime contracts for the shared Google client: every request is bounded (token, headers and
// body), a timed-out request is never re-sent, and one job-wide deadline is drawn down across
// attempts and backoff instead of resetting on each retry. Runs against the real googleFetch with
// only the network replaced. Test order matters: the token is cached after the first success.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { googleFetch, setGoogleDeadline } from "../src/googleSheets.js";

const T = { timeout: 5000 };
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://sheets.googleapis.com/v4/spreadsheets/sheet-id/values/LOG!A1:append";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "test@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
process.env.GOOGLE_REQUEST_TIMEOUT_MS = "40";

const realFetch = globalThis.fetch;
// Behaves like the platform fetch for a silent peer: pending until the request's signal fires.
const untilAborted = (signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
const tokenResponse = () => new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method || "GET" });
    if (target === TOKEN_URL && handler.token) return handler.token(init);
    if (target === TOKEN_URL) return tokenResponse();
    return handler.api(init, calls.filter((call) => call.url !== TOKEN_URL).length);
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  setGoogleDeadline(0);
});

test("a silent OAuth endpoint times out instead of stalling the first sheet read", T, async () => {
  const calls = mockFetch({ token: (init) => untilAborted(init.signal), api: () => new Response("{}") });

  await assert.rejects(googleFetch(API_URL, { method: "GET" }), (error) => {
    assert.equal(error.code, "google_timeout");
    assert.match(error.message, /OAuth token request timed out after 40ms/);
    return true;
  });
  assert.deepEqual(calls.map((call) => call.url), [TOKEN_URL], "the API request was never sent");
});

test("a write whose response headers never arrive is not sent a second time", T, async () => {
  const calls = mockFetch({ api: (init) => untilAborted(init.signal) });

  await assert.rejects(googleFetch(API_URL, { method: "POST", body: { values: [["row"]] } }), (error) => {
    assert.equal(error.code, "google_timeout");
    assert.equal(error.writeOutcomeUnknown, true, "the server may have applied it");
    assert.match(error.message, /timed out after 40ms: POST/);
    return true;
  });
  assert.equal(calls.filter((call) => call.method === "POST" && call.url.startsWith(API_URL)).length, 1);
});

test("a response body that never finishes times out too, again without a retry", T, async () => {
  const calls = mockFetch({
    api: (init) => ({ ok: true, status: 200, json: () => untilAborted(init.signal) }),
  });

  await assert.rejects(googleFetch(API_URL, { method: "POST", body: {} }), (error) => {
    assert.equal(error.code, "google_timeout");
    assert.equal(error.writeOutcomeUnknown, true);
    return true;
  });
  assert.equal(calls.filter((call) => call.url.startsWith(API_URL)).length, 1);
});

test("a read that times out is reported without the unknown-write flag", T, async () => {
  mockFetch({ api: (init) => untilAborted(init.signal) });

  await assert.rejects(googleFetch(API_URL, { method: "GET" }), (error) => {
    assert.equal(error.code, "google_timeout");
    assert.equal(error.writeOutcomeUnknown, false);
    return true;
  });
});

test("the job deadline shortens each attempt instead of resetting on it", T, async () => {
  process.env.GOOGLE_REQUEST_TIMEOUT_MS = "60000";
  try {
    setGoogleDeadline(Date.now() + 60);
    const startedAt = Date.now();
    mockFetch({ api: (init) => untilAborted(init.signal) });

    await assert.rejects(googleFetch(API_URL, { method: "GET" }), { code: "google_timeout" });
    assert.ok(Date.now() - startedAt < 1500, "bounded by the 60ms left, not the 60s request timeout");
  } finally {
    process.env.GOOGLE_REQUEST_TIMEOUT_MS = "40";
  }
});

test("a 429 backoff that would outlast the job deadline is not slept through", T, async () => {
  setGoogleDeadline(Date.now() + 1000);
  const startedAt = Date.now();
  const calls = mockFetch({ api: () => new Response("rate limited", { status: 429 }) });

  await assert.rejects(googleFetch(API_URL, { method: "POST", body: {} }), (error) => {
    assert.equal(error.code, "google_timeout");
    assert.equal(error.deadlineExceeded, true);
    assert.equal(error.writeOutcomeUnknown, false, "a 429 was rejected, so nothing was applied");
    return true;
  });
  assert.ok(Date.now() - startedAt < 1000, "the first backoff alone is 5s; it was skipped");
  assert.equal(calls.filter((call) => call.url.startsWith(API_URL)).length, 1);
});

test("once the job deadline has passed nothing is sent at all", T, async () => {
  setGoogleDeadline(Date.now() - 1);
  const calls = mockFetch({ api: () => new Response("{}") });

  await assert.rejects(googleFetch(API_URL, { method: "POST", body: {} }), (error) => {
    assert.equal(error.deadlineExceeded, true);
    assert.equal(error.writeOutcomeUnknown, false);
    return true;
  });
  assert.deepEqual(calls, []);
});

test("clearing the deadline restores normal requests for the next caller", T, async () => {
  setGoogleDeadline(Date.now() - 1);
  setGoogleDeadline(0);
  const calls = mockFetch({ api: () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }) });

  assert.deepEqual(await googleFetch(API_URL, { method: "GET" }), { ok: 1 });
  assert.equal(calls.length, 1);
});
