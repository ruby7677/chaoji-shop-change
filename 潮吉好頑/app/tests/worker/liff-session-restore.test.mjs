// LIFF 持久登入恢復（POST /api/auth/session/restore）：成功、確定失效與暫時性故障的分流。
// 暫時性故障（LINE／Supabase 逾時、429、5xx）必須回 503 SESSION_RESTORE_UNAVAILABLE，
// 並保留 vault 與 cookie；否則前端會把它當成登入失效而自動改走 LINE OAuth（黑幕＋整頁跳轉）。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LINE_USER_ID, baseEnv, ctx, jsonResponse, lineUser, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const { sealRefreshToken } = await loadSourceModule("auth-session.ts");
const allow = { limit: async () => ({ success: true }) };
const env = { ...baseEnv, LIFF_ID: "liff-test-id", LINE_LOGIN_CHANNEL_ID: "channel-test-id", API_AUTH_IP_RATE_LIMITER: allow, API_MEMBER_RATE_LIMITER: allow };
// Supabase 目前發出的 refresh token 為 12 字元
const SHORT_REFRESH_TOKEN = "abcdefghijkl";

let upstream;
let restoreFetch;

beforeEach(async () => {
  upstream = {
    line: "ok",
    vault: "found",
    sealed: await sealRefreshToken(env.AUTH_SESSION_SECRET, SHORT_REFRESH_TOKEN),
    refresh: "ok",
    calls: []
  };
  restoreFetch = stubFetch((url, init, body) => {
    const method = init.method || "GET";
    upstream.calls.push(`${method} ${url.pathname}`);
    if (url.hostname === "api.line.me") {
      if (upstream.line === "down") return jsonResponse({}, 503);
      if (upstream.line === "timeout") throw new Error("network timeout");
      if (upstream.line === "invalid") return jsonResponse({ error: "invalid_request" }, 400);
      return jsonResponse({ iss: "https://access.line.me", aud: "channel-test-id", sub: LINE_USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (url.pathname === "/rest/v1/liff_session_vault") {
      if (method === "GET") {
        if (upstream.vault === "down") return jsonResponse({}, 500);
        return jsonResponse(upstream.vault === "found" ? [{ sealed_refresh_token: upstream.sealed }] : []);
      }
      return new Response(null, { status: method === "DELETE" ? 204 : 201 });
    }
    if (url.pathname === "/auth/v1/token") {
      assert.equal(body.refresh_token, SHORT_REFRESH_TOKEN, "restore sends the decrypted short token to Supabase");
      if (upstream.refresh === "down") return jsonResponse({}, 503);
      if (upstream.refresh === "reject") return jsonResponse({ error: "invalid_grant" }, 400);
      return jsonResponse({ access_token: "access-new", refresh_token: "mnopqrstuvwx", expires_in: 3600, user: lineUser("user-1") });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
});

afterEach(() => restoreFetch());

function restore() {
  return worker.fetch(new Request("https://shop.test/api/auth/session/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: "liff-id-token" })
  }), env, ctx());
}

const vaultDeleted = () => upstream.calls.includes("DELETE /rest/v1/liff_session_vault");

test("vault 內的 12 字元 refresh token 可直接恢復登入並重新保存", async () => {
  const response = await restore();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).access_token, "access-new");
  assert.ok(upstream.calls.includes("POST /rest/v1/liff_session_vault"));
  assert.equal(vaultDeleted(), false);
});

for (const mode of ["down", "timeout"]) {
  test(`LINE 身分驗證暫時無法使用（${mode}）時回 503，且不清除 cookie`, async () => {
    upstream.line = mode;
    const response = await restore();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "SESSION_RESTORE_UNAVAILABLE");
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(upstream.calls.some((call) => call.includes("liff_session_vault")), false);
  });
}

test("LINE 判定 id token 無效時回 401 並清除 cookie", async () => {
  upstream.line = "invalid";
  const response = await restore();
  assert.equal(response.status, 401);
  assert.match(response.headers.get("Set-Cookie") || "", /Max-Age=0/);
});

test("Supabase refresh 暫時故障時回 503，且保留 vault", async () => {
  upstream.refresh = "down";
  const response = await restore();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "SESSION_RESTORE_UNAVAILABLE");
  assert.equal(vaultDeleted(), false);
});

test("vault 暫時讀不到且沒有 cookie 時回 503，不回「沒有工作階段」", async () => {
  upstream.vault = "down";
  const response = await restore();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "SESSION_RESTORE_UNAVAILABLE");
});

test("Supabase 拒絕 refresh token 時回 401，vault 保留給下次 LINE Login 覆寫", async () => {
  upstream.refresh = "reject";
  const response = await restore();
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "NO_PERSISTENT_SESSION");
  assert.equal(vaultDeleted(), false);
});

test("vault 資料無法解密時刪除並回 401", async () => {
  upstream.sealed = "v1.broken.data";
  const response = await restore();
  assert.equal(response.status, 401);
  assert.ok(vaultDeleted());
  assert.equal(upstream.calls.includes("POST /auth/v1/token"), false);
});

test("沒有保存的登入時回 401 NO_PERSISTENT_SESSION", async () => {
  upstream.vault = "missing";
  const response = await restore();
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "NO_PERSISTENT_SESSION");
});
