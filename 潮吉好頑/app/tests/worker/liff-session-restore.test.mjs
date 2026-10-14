// LIFF 持久登入恢復（POST /api/auth/session/restore）：成功、確定失效與暫時性故障的分流。
// 暫時性故障（LINE／Supabase 逾時、429、5xx）必須回 503 SESSION_RESTORE_UNAVAILABLE，
// 並保留 vault 與 cookie；否則前端會把它當成登入失效而自動改走 LINE OAuth（黑幕＋整頁跳轉）。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LINE_USER_ID, baseEnv, ctx, jsonResponse, lineUser, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const { openRefreshToken, refreshSessionCookie, sealRefreshToken } = await loadSourceModule("auth-session.ts");
const allow = { limit: async () => ({ success: true }) };
const env = { ...baseEnv, LIFF_ID: "liff-test-id", LINE_LOGIN_CHANNEL_ID: "channel-test-id", API_AUTH_IP_RATE_LIMITER: allow, API_MEMBER_RATE_LIMITER: allow };
// Supabase 目前發出的 refresh token 為 12 字元
const SHORT_REFRESH_TOKEN = "abcdefghijkl";
const ROTATED_TOKEN = "mnopqrstuvwx";
const COOKIE_TOKEN = "cookietoken1";

let upstream;
let restoreFetch;

beforeEach(async () => {
  upstream = {
    line: "ok",
    vault: "found",
    sealed: await sealRefreshToken(env.AUTH_SESSION_SECRET, SHORT_REFRESH_TOKEN),
    refresh: "ok",
    userLookup: null,
    patchFails: false,
    deleteFails: false,
    // 送到 Supabase 換發的 refresh token；rejectTokens 內的 token 會被拒（已輪替的舊 token）
    sent: [],
    rejectTokens: [],
    patched: null,
    // 換發 token 時模擬另一次 LINE Login 同時覆寫 vault（設為新的 sealed 值）
    concurrentLogin: null,
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
      // 更新與刪除只套用到內容仍符合 sealed_refresh_token 條件的列
      if (method !== "POST") assert.equal(url.searchParams.get("line_user_id"), `eq.${LINE_USER_ID}`, "vault writes are scoped to the verified LINE user");
      const matches = upstream.vault === "found" && url.searchParams.get("sealed_refresh_token") === `eq.${upstream.sealed}`;
      if (method === "PATCH") {
        if (upstream.patchFails) return jsonResponse({}, 503);
        assert.equal(init.headers.Prefer, "return=representation", "the PATCH reports which rows it updated");
        if (!matches) return jsonResponse([]);
        upstream.patched = body.sealed_refresh_token;
        upstream.sealed = body.sealed_refresh_token;
        return jsonResponse([{ line_user_id: LINE_USER_ID }]);
      }
      if (method === "DELETE") {
        if (upstream.deleteFails) return jsonResponse({}, 503);
        if (matches) upstream.vault = "missing";
        return new Response(null, { status: 204 });
      }
      // POST＝保存登入（upsert）：覆寫成新的 sealed 值
      upstream.sealed = body.sealed_refresh_token;
      upstream.vault = "found";
      return new Response(null, { status: 201 });
    }
    // userLookup 為狀態碼時，refresh 回應不帶 user，改由 /auth/v1/user 查詢並回該狀態
    if (url.pathname === "/auth/v1/user") return jsonResponse({}, upstream.userLookup);
    if (url.pathname === "/auth/v1/token") {
      upstream.sent.push(body.refresh_token);
      if (upstream.concurrentLogin) upstream.sealed = upstream.concurrentLogin;
      assert.ok([SHORT_REFRESH_TOKEN, ROTATED_TOKEN, COOKIE_TOKEN].includes(body.refresh_token), "restore sends a decrypted token to Supabase");
      if (upstream.refresh === "down") return jsonResponse({}, 503);
      if (upstream.refresh === "reject" || upstream.rejectTokens.includes(body.refresh_token)) return jsonResponse({ error: "invalid_grant" }, 400);
      return jsonResponse({ access_token: "access-new", refresh_token: ROTATED_TOKEN, expires_in: 3600, user: upstream.userLookup ? undefined : lineUser("user-1") });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
});

afterEach(() => restoreFetch());

function restore({ cookie } = {}) {
  return worker.fetch(new Request("https://shop.test/api/auth/session/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ id_token: "liff-id-token" })
  }), env, ctx());
}

const vaultDeleted = () => upstream.calls.includes("DELETE /rest/v1/liff_session_vault");

test("vault 內的 12 字元 refresh token 可直接恢復登入，並以條件更新存回輪替後的 token", async () => {
  const response = await restore();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).access_token, "access-new");
  assert.equal(upstream.calls.includes("POST /rest/v1/liff_session_vault"), false, "a vault restore never upserts");
  assert.equal(await openRefreshToken(env.AUTH_SESSION_SECRET, upstream.patched), ROTATED_TOKEN);
  assert.match(response.headers.get("Set-Cookie") || "", /Max-Age=0/, "the vault holds the token, so no cookie copy");
  assert.equal(vaultDeleted(), false);
});

test("恢復成功但期間另一次 LINE Login 已存入新 token 時，不蓋掉那筆，輪替後的 token 改存 cookie", async () => {
  const newer = await sealRefreshToken(env.AUTH_SESSION_SECRET, COOKIE_TOKEN);
  upstream.concurrentLogin = newer;
  const response = await restore();
  assert.equal(response.status, 200);
  assert.equal(upstream.patched, null);
  assert.equal(upstream.sealed, newer, "the newer login's token stays in the vault");
  const cookie = (response.headers.get("Set-Cookie") || "").split(";")[0];
  assert.equal(await openRefreshToken(env.AUTH_SESSION_SECRET, cookie.split("=").slice(1).join("=")), ROTATED_TOKEN);
});

test("恢復成功但 vault 暫時寫不進去時，輪替後的 token 改存 cookie", async () => {
  upstream.patchFails = true;
  const response = await restore();
  assert.equal(response.status, 200);
  const cookie = (response.headers.get("Set-Cookie") || "").split(";")[0];
  assert.equal(await openRefreshToken(env.AUTH_SESSION_SECRET, cookie.split("=").slice(1).join("=")), ROTATED_TOKEN);
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
  assert.equal(upstream.vault, "missing", "the delete is filtered on the row that was read");
  assert.equal(upstream.calls.includes("POST /auth/v1/token"), false);
});

test("沒有保存的登入時回 401 NO_PERSISTENT_SESSION", async () => {
  upstream.vault = "missing";
  const response = await restore();
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "NO_PERSISTENT_SESSION");
});

test("token 已輪替但查不到使用者時，把新 token 存回 vault 並回 503，不刪 vault", async () => {
  upstream.userLookup = 503;
  const response = await restore();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "SESSION_RESTORE_UNAVAILABLE");
  assert.equal(vaultDeleted(), false);
  assert.ok(upstream.patched, "the rotated token is written back to the vault row");
  assert.equal(await openRefreshToken(env.AUTH_SESSION_SECRET, upstream.patched), "mnopqrstuvwx");
});

function remember() {
  return worker.fetch(new Request("https://shop.test/api/auth/session/remember", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: "liff-id-token", refresh_token: SHORT_REFRESH_TOKEN })
  }), env, ctx());
}

for (const [label, setup] of [["LINE 驗證", () => { upstream.line = "down"; }], ["Supabase refresh", () => { upstream.refresh = "down"; }], ["使用者查詢", () => { upstream.userLookup = 503; }]]) {
  test(`保存登入時${label}暫時故障回 503，不清除 cookie`, async () => {
    setup();
    const response = await remember();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "SESSION_REMEMBER_UNAVAILABLE");
    assert.equal(response.headers.get("Set-Cookie"), null);
  });
}

test("保存登入時 Supabase 拒絕 refresh token 回 401 並清除 cookie", async () => {
  upstream.refresh = "reject";
  const response = await remember();
  assert.equal(response.status, 401);
  assert.match(response.headers.get("Set-Cookie") || "", /Max-Age=0/);
});

test("輪替後 vault 也寫不進去時，新 token 改存 cookie 並刪除 vault 的舊 token", async () => {
  upstream.userLookup = 503;
  upstream.patchFails = true;
  const response = await restore();
  assert.equal(response.status, 503);
  assert.ok(vaultDeleted(), "the spent token is removed from the vault");
  const cookie = response.headers.get("Set-Cookie") || "";
  assert.doesNotMatch(cookie, /Max-Age=0/);
  const sealed = cookie.split(";")[0].split("=").slice(1).join("=");
  assert.equal(await openRefreshToken(env.AUTH_SESSION_SECRET, sealed), "mnopqrstuvwx", "the rotated token is kept in the cookie");
});

const cookieHeader = async (token) => refreshSessionCookie(await sealRefreshToken(env.AUTH_SESSION_SECRET, token)).split(";")[0];

test("cookie 與 vault 都有 token 時先用 cookie（只有 vault 寫不進去才有 cookie，它比較新）", async () => {
  const response = await restore({ cookie: await cookieHeader(COOKIE_TOKEN) });
  assert.equal(response.status, 200);
  assert.deepEqual(upstream.sent, [COOKIE_TOKEN], "the possibly stale vault token is never sent");
});

test("vault 更新與刪除都失敗後，下一次恢復仍用 cookie 的新 token，不碰 vault 的舊 token", async () => {
  upstream.userLookup = 503;
  upstream.patchFails = true;
  upstream.deleteFails = true;
  const first = await restore();
  assert.equal(first.status, 503);
  const cookie = (first.headers.get("Set-Cookie") || "").split(";")[0];
  assert.equal(await openRefreshToken(env.AUTH_SESSION_SECRET, cookie.split("=").slice(1).join("=")), ROTATED_TOKEN);
  upstream.userLookup = null;
  upstream.rejectTokens = [SHORT_REFRESH_TOKEN];
  upstream.sent = [];
  const second = await restore({ cookie });
  assert.equal(second.status, 200);
  assert.deepEqual(upstream.sent, [ROTATED_TOKEN], "the spent vault token is not reused");
});

test("cookie 被拒時改用 vault 恢復，並清掉失效的 cookie", async () => {
  upstream.rejectTokens = [COOKIE_TOKEN];
  const response = await restore({ cookie: await cookieHeader(COOKIE_TOKEN) });
  assert.equal(response.status, 200);
  assert.deepEqual(upstream.sent, [COOKIE_TOKEN, SHORT_REFRESH_TOKEN]);
});

test("cookie 換發時 Supabase 暫時故障就回 503，不改試較舊的 vault", async () => {
  upstream.refresh = "down";
  const response = await restore({ cookie: await cookieHeader(COOKIE_TOKEN) });
  assert.equal(response.status, 503);
  assert.deepEqual(upstream.sent, [COOKIE_TOKEN]);
});

test("輪替期間另一次 LINE Login 已覆寫 vault 時，不蓋掉也不刪除那筆新 token，輪替後的 token 改存 cookie", async () => {
  const newer = await sealRefreshToken(env.AUTH_SESSION_SECRET, COOKIE_TOKEN);
  upstream.userLookup = 503;
  upstream.concurrentLogin = newer;
  const response = await restore();
  assert.equal(response.status, 503);
  assert.equal(upstream.patched, null, "the newer vault token is not overwritten");
  assert.equal(upstream.vault, "found");
  assert.equal(upstream.sealed, newer, "the newer vault token is not deleted");
  const cookie = (response.headers.get("Set-Cookie") || "").split(";")[0];
  assert.equal(await openRefreshToken(env.AUTH_SESSION_SECRET, cookie.split("=").slice(1).join("=")), ROTATED_TOKEN);
});

test("同一會員兩次恢復同時進行且都成功時，vault 最後保存的是輪替後仍有效的 token", async () => {
  // Supabase 的重複使用寬限期內，同一個舊 token 換發兩次都拿到同一個新 token（stub 一律回 ROTATED_TOKEN）
  const [first, second] = await Promise.all([restore(), restore()]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(upstream.sent, [SHORT_REFRESH_TOKEN, SHORT_REFRESH_TOKEN], "both requests read the same vault token");
  assert.equal(await openRefreshToken(env.AUTH_SESSION_SECRET, upstream.sealed), ROTATED_TOKEN, "the vault ends with the live rotated token");
  assert.equal(vaultDeleted(), false);
});
