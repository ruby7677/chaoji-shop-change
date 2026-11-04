// 訂單頁恢復登入一併回傳訂單（POST /api/auth/session/restore 帶 include_orders: true）：
// 訂單以恢復後的會員 JWT 讀取、限定本人；訂單讀不到或被限流時照樣回傳新的 access token（refresh token 已輪替），
// 由前端改請求 GET /api/orders。回應與 GET /api/orders 都帶 Server-Timing（只有步驟名稱與毫秒數）。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LINE_USER_ID, baseEnv, ctx, deniedRateLimit, jsonResponse, lineUser, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const { sealRefreshToken } = await loadSourceModule("auth-session.ts");
const allow = { limit: async () => ({ success: true }) };
const env = { ...baseEnv, LIFF_ID: "liff-test-id", LINE_LOGIN_CHANNEL_ID: "channel-test-id", API_AUTH_IP_RATE_LIMITER: allow, API_MEMBER_RATE_LIMITER: allow };
const ORDER = { id: "order-1", order_number: "CJ1", bank_account_id: "bank-1" };

let upstream;
let restoreFetch;

beforeEach(async () => {
  upstream = { sealed: await sealRefreshToken(env.AUTH_SESSION_SECRET, "abcdefghijkl"), ordersStatus: 200, ordersQuery: null, calls: [] };
  restoreFetch = stubFetch((url, init) => {
    const method = init.method || "GET";
    upstream.calls.push(`${method} ${url.pathname}`);
    if (url.hostname === "api.line.me") {
      return jsonResponse({ iss: "https://access.line.me", aud: "channel-test-id", sub: LINE_USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (url.pathname === "/rest/v1/liff_session_vault") {
      return method === "GET" ? jsonResponse([{ sealed_refresh_token: upstream.sealed }]) : new Response(null, { status: 201 });
    }
    if (url.pathname === "/auth/v1/token") {
      return jsonResponse({ access_token: "access-new", refresh_token: "mnopqrstuvwx", expires_in: 3600, user: lineUser("user-1") });
    }
    if (url.pathname === "/auth/v1/user") {
      assert.equal(init.headers.Authorization, "Bearer member-token");
      return jsonResponse(lineUser("user-1"));
    }
    if (url.pathname === "/rest/v1/orders") {
      upstream.ordersQuery = { member: url.searchParams.get("member_id"), authorization: init.headers.Authorization };
      return jsonResponse(upstream.ordersStatus === 200 ? [ORDER] : {}, upstream.ordersStatus);
    }
    if (url.pathname === "/rest/v1/bank_accounts") return jsonResponse([{ id: "bank-1", label: "主帳戶", bank_name: "銀行", account_name: "潮吉", account_number: "123" }]);
    throw new Error(`unexpected request: ${method} ${url}`);
  });
});

afterEach(() => restoreFetch());

function restore(body, restoreEnv = env) {
  return worker.fetch(new Request("https://shop.test/api/auth/session/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }), restoreEnv, ctx());
}

test("the restore returns the member's own orders read with the restored member token", async () => {
  const response = await restore({ id_token: "liff-id-token", include_orders: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.access_token, "access-new");
  assert.deepEqual(result.orders.map((order) => order.id), ["order-1"]);
  assert.equal(result.orders[0].bank_accounts.label, "主帳戶");
  assert.equal(result.bank_accounts_unavailable, false);
  assert.deepEqual(upstream.ordersQuery, { member: "eq.user-1", authorization: "Bearer access-new" }, "RLS sees the member, not the service role");
  assert.ok(upstream.calls.includes("POST /rest/v1/liff_session_vault"), "the rotated token is still saved");
  assert.equal(upstream.calls.includes("GET /auth/v1/user"), false, "the restore already proved who the member is");
  const timing = response.headers.get("Server-Timing");
  for (const step of ["line", "vault", "refresh", "save", "orders", "bank", "total"]) assert.match(timing, new RegExp(`(^|, )${step};dur=\\d+`), step);
});

test("without include_orders the restore does not read orders (the storefront boot)", async () => {
  const response = await restore({ id_token: "liff-id-token" });
  const result = await response.json();
  assert.equal(result.access_token, "access-new");
  assert.equal("orders" in result, false);
  assert.equal(upstream.ordersQuery, null);
  assert.ok(response.headers.get("Server-Timing").includes("refresh;dur="));
});

test("an orders failure still hands over the rotated session so the page can ask GET /api/orders", async () => {
  upstream.ordersStatus = 503;
  const response = await restore({ id_token: "liff-id-token", include_orders: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.access_token, "access-new");
  assert.equal("orders" in result, false);
  assert.ok(upstream.calls.includes("POST /rest/v1/liff_session_vault"));
});

test("orders share the GET /api/orders rate limit and are left out when it is exhausted", async () => {
  const keys = [];
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: !key.startsWith("orders-read:") }; } };
  const response = await restore({ id_token: "liff-id-token", include_orders: true }, { ...env, API_MEMBER_RATE_LIMITER: limiter });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.access_token, "access-new");
  assert.equal("orders" in result, false);
  assert.ok(keys.includes("orders-read:user-1"));
  assert.equal(upstream.ordersQuery, null);
});

test("a non-boolean include_orders is ignored", async () => {
  await (await restore({ id_token: "liff-id-token", include_orders: "yes" })).json();
  assert.equal(upstream.ordersQuery, null);
});

test("GET /api/orders reports its own step timings", async () => {
  const response = await worker.fetch(new Request("https://shop.test/api/orders", { headers: { Authorization: "Bearer member-token" } }), env, ctx());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).orders.map((order) => order.id), ["order-1"]);
  const timing = response.headers.get("Server-Timing");
  for (const step of ["user", "orders", "bank", "total"]) assert.ok(timing.includes(`${step};dur=`), step);
});

test("a rate-limited restore never reaches the orders query", async () => {
  const response = await restore({ id_token: "liff-id-token", include_orders: true }, { ...env, API_AUTH_IP_RATE_LIMITER: deniedRateLimit });
  assert.equal(response.status, 429);
  assert.equal(upstream.ordersQuery, null);
});
