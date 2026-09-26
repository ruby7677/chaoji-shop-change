// 會員讀取：訂單與點數紀錄以會員自己的 JWT 讀（RLS 限定本人），service role 只用來補店家資料（收款帳戶、點數設定）；
// 回應格式與改動前相同（訂單仍帶 bank_accounts 物件）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, deniedRateLimit, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";
const LINE_ID = "U" + "b".repeat(32);
const BANK_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const MEMBER_TOKEN = "Bearer member-access-token";
let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeSupabase({ orders = [], bankStatus = 200 } = {}) {
  const calls = [];
  restoreFetch = stubFetch((url, init) => {
    const headers = new Headers(init.headers);
    if (url.pathname === "/auth/v1/user") {
      return jsonResponse({ id: MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    }
    calls.push({ path: url.pathname, url, auth: headers.get("Authorization"), apikey: headers.get("apikey") });
    if (url.pathname === "/rest/v1/orders") return jsonResponse(orders);
    if (url.pathname === "/rest/v1/bank_accounts") {
      return bankStatus === 200
        ? jsonResponse([{ id: BANK_ID, label: "主帳戶", bank_name: "測試銀行", account_name: "潮吉", account_number: "1234567890" }])
        : jsonResponse({ message: "down" }, bankStatus);
    }
    if (url.pathname === "/rest/v1/rpc/member_point_balance") return jsonResponse(80);
    if (url.pathname === "/rest/v1/point_ledger") return jsonResponse([{ id: "p1", kind: "earn", points: 80, reason: "訂單", created_at: "2026-09-24T00:00:00Z" }]);
    if (url.pathname === "/rest/v1/point_settings") return jsonResponse([{ earn_amount_per_point: 100 }]);
    if (url.pathname === "/rest/v1/rpc/member_available_coupons") return jsonResponse([]);
    throw new Error(`unexpected request ${url}`);
  });
  return calls;
}

const get = (path) => worker.fetch(new Request(`https://shop.test${path}`, { headers: { Authorization: MEMBER_TOKEN } }), baseEnv, ctx());

test("the order list is read with the member's own token and keeps the bank account shape", async () => {
  const calls = fakeSupabase({ orders: [
    { id: "o1", order_number: "CJ-1", bank_account_id: BANK_ID },
    { id: "o2", order_number: "CJ-2", bank_account_id: null }
  ] });
  const response = await get("/api/orders");
  assert.equal(response.status, 200);
  const { orders } = await response.json();
  assert.deepEqual(orders.map((order) => order.bank_accounts), [
    { label: "主帳戶", bank_name: "測試銀行", account_name: "潮吉", account_number: "1234567890" },
    null
  ]);
  const orderCall = calls.find((call) => call.path === "/rest/v1/orders");
  assert.equal(orderCall.auth, MEMBER_TOKEN, "orders are read under RLS, not with the service role");
  assert.equal(orderCall.apikey, "anon-key");
  assert.equal(orderCall.url.searchParams.get("member_id"), `eq.${MEMBER_ID}`, "the member filter stays as a second layer");
  assert.doesNotMatch(orderCall.url.searchParams.get("select"), /bank_accounts/, "members cannot embed the bank account table");
  const bankCall = calls.find((call) => call.path === "/rest/v1/bank_accounts");
  assert.equal(bankCall.auth, "Bearer service-key", "store bank details come from the service role");
  assert.equal(bankCall.url.searchParams.get("id"), `in.(${BANK_ID})`, "only the accounts referenced by the member's orders are looked up");
});

test("orders without a bank account skip the bank lookup", async () => {
  const calls = fakeSupabase({ orders: [{ id: "o1", bank_account_id: null }] });
  const response = await get("/api/orders");
  assert.equal(response.status, 200);
  assert.equal(calls.some((call) => call.path === "/rest/v1/bank_accounts"), false);
});

test("a failed bank lookup is reported instead of returning orders without payment details", async () => {
  fakeSupabase({ orders: [{ id: "o1", bank_account_id: BANK_ID }], bankStatus: 503 });
  const response = await get("/api/orders");
  assert.equal(response.status, 503);
});

test("point history is read with the member's token; shared point settings with the service role", async () => {
  const calls = fakeSupabase();
  const response = await get("/api/member/points");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.balance, 80);
  assert.equal(body.ledger.length, 1);
  const byPath = Object.fromEntries(calls.map((call) => [call.path, call]));
  assert.equal(byPath["/rest/v1/point_ledger"].auth, MEMBER_TOKEN);
  assert.equal(byPath["/rest/v1/point_ledger"].apikey, "anon-key");
  assert.equal(byPath["/rest/v1/rpc/member_point_balance"].auth, MEMBER_TOKEN);
  assert.equal(byPath["/rest/v1/rpc/member_available_coupons"].auth, MEMBER_TOKEN);
  assert.equal(byPath["/rest/v1/point_settings"].auth, "Bearer service-key");
});

// listBankAccounts、listOrders、memberPoints 原本沒有速率限制，其餘會員端點都有；
// 三者都在通過登入驗證後、實際讀取店家資料前擋下超量請求。
const deniedEnv = { ...baseEnv, API_MEMBER_RATE_LIMITER: deniedRateLimit };
const getWithEnv = (path, env) => worker.fetch(new Request(`https://shop.test${path}`, { headers: { Authorization: MEMBER_TOKEN } }), env, ctx());

test("GET /api/bank-accounts is rate limited after login", async () => {
  const calls = fakeSupabase();
  const response = await getWithEnv("/api/bank-accounts", deniedEnv);
  assert.equal(response.status, 429);
  assert.equal(calls.some((call) => call.path === "/rest/v1/bank_accounts"), false, "a rate-limited request never reaches the bank account table");
});

test("GET /api/orders is rate limited after login", async () => {
  const calls = fakeSupabase();
  const response = await getWithEnv("/api/orders", deniedEnv);
  assert.equal(response.status, 429);
  assert.equal(calls.some((call) => call.path === "/rest/v1/orders"), false, "a rate-limited request never reaches the orders table");
});

test("GET /api/member/points is rate limited after login", async () => {
  const calls = fakeSupabase();
  const response = await getWithEnv("/api/member/points", deniedEnv);
  assert.equal(response.status, 429);
  assert.equal(calls.some((call) => call.path === "/rest/v1/rpc/member_point_balance"), false, "a rate-limited request never reaches the point balance RPC");
});
