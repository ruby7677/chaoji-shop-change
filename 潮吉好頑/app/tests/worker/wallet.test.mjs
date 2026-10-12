// 儲值金 API：會員以自己的 JWT 讀餘額與紀錄；管理員加值／沖正只在通過管理員驗證後以 service role 呼叫 RPC，
// 格式錯誤在 Worker 擋下不送資料庫，資料庫錯誤碼轉成可讀訊息。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, deniedRateLimit, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const USER_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";
const ENTRY_ID = "00000000-0000-4000-8000-0000000000e1";
const REQUEST_ID = "6f1c2c1e-3b1a-4d2e-9f00-1234567890ab";
const LINE_ID = "U" + "c".repeat(32);
const TOKEN = "Bearer user-access-token";
let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeSupabase({ isAdmin = true, rpc = () => jsonResponse({ entry_id: ENTRY_ID, balance: 3000, replayed: false }) } = {}) {
  const calls = [];
  restoreFetch = stubFetch((url, init, body) => {
    const headers = new Headers(init.headers);
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: USER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: isAdmin, line_user_id: LINE_ID }]);
    calls.push({ path: url.pathname, url, body, auth: headers.get("Authorization"), apikey: headers.get("apikey") });
    if (url.pathname === "/rest/v1/rpc/member_wallet_balance") return jsonResponse(1200);
    if (url.pathname === "/rest/v1/wallet_ledger") return jsonResponse([{ id: ENTRY_ID, kind: "topup", amount: 1200, balance_after: 1200, reason: "匯款儲值", created_at: "2026-10-12T00:00:00Z" }]);
    if (url.pathname.startsWith("/rest/v1/rpc/admin_")) return rpc(url, body);
    throw new Error(`unexpected request ${url}`);
  });
  return calls;
}

const send = (method, path, body, env = baseEnv) => worker.fetch(new Request(`https://shop.test${path}`, {
  method,
  headers: { Authorization: TOKEN, "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body)
}), env, ctx());

const topup = { kind: "topup", amount: 3000, reason: "匯款儲值", requestId: REQUEST_ID, transferRef: "末五碼 12345" };

test("member wallet is read with the member's own token", async () => {
  const calls = fakeSupabase();
  const response = await send("GET", "/api/member/wallet");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.balance, 1200);
  assert.equal(body.ledger.length, 1);
  for (const call of calls) {
    assert.equal(call.auth, TOKEN, `${call.path} runs under RLS, not the service role`);
    assert.equal(call.apikey, "anon-key");
  }
  const ledgerCall = calls.find((call) => call.path === "/rest/v1/wallet_ledger");
  assert.equal(ledgerCall.url.searchParams.get("member_id"), `eq.${USER_ID}`);
  assert.equal(ledgerCall.url.searchParams.get("limit"), "50");
  assert.doesNotMatch(ledgerCall.url.searchParams.get("select"), /actor_id|request_id|transfer_ref/, "members never ask for admin-only columns");
});

test("member wallet reads are rate limited before reaching Supabase", async () => {
  const calls = fakeSupabase();
  const response = await send("GET", "/api/member/wallet", undefined, { ...baseEnv, API_MEMBER_RATE_LIMITER: deniedRateLimit });
  assert.equal(response.status, 429);
  assert.deepEqual(calls, []);
});

test("admin top-up passes the admin id, amount and request id to the RPC with the service role", async () => {
  const calls = fakeSupabase();
  const response = await send("POST", `/api/admin/members/${MEMBER_ID}/wallet`, topup);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { entryId: ENTRY_ID, balance: 3000, replayed: false });
  const [call] = calls;
  assert.equal(call.path, "/rest/v1/rpc/admin_adjust_wallet");
  assert.equal(call.auth, "Bearer service-key");
  assert.deepEqual(call.body, {
    p_actor_id: USER_ID, p_member_id: MEMBER_ID, p_kind: "topup", p_amount: 3000,
    p_reason: "匯款儲值", p_request_id: REQUEST_ID, p_transfer_ref: "末五碼 12345"
  });
});

test("a non-admin member cannot top up a wallet", async () => {
  const calls = fakeSupabase({ isAdmin: false });
  const response = await send("POST", `/api/admin/members/${MEMBER_ID}/wallet`, topup);
  assert.equal(response.status, 403);
  assert.deepEqual(calls, [], "the RPC is never called");
});

for (const [label, patch] of [
  ["a negative top-up", { amount: -100 }],
  ["a positive refund", { kind: "refund", amount: 100 }],
  ["a zero amount", { kind: "adjust", amount: 0 }],
  ["a fractional amount", { amount: 10.5 }],
  ["an amount over the limit", { amount: 1_000_001 }],
  ["a draw entry written by an admin", { kind: "draw", amount: -100 }],
  ["a missing reason", { reason: "   " }],
  ["a missing request id", { requestId: "" }],
  ["a malformed request id", { requestId: "not-a-uuid" }],
  ["an overlong transfer reference", { transferRef: "x".repeat(61) }]
]) {
  test(`admin top-up rejects ${label} before the database`, async () => {
    const calls = fakeSupabase();
    const response = await send("POST", `/api/admin/members/${MEMBER_ID}/wallet`, { ...topup, ...patch });
    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });
}

test("database wallet errors become readable messages", async () => {
  fakeSupabase({ rpc: () => jsonResponse({ message: "WALLET_BALANCE_SHORT" }, 400) });
  const response = await send("POST", `/api/admin/members/${MEMBER_ID}/wallet`, { ...topup, kind: "refund", amount: -5000 });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /餘額不足/);
});

test("reversal passes the entry, reason and request id to the RPC", async () => {
  const calls = fakeSupabase({ rpc: () => jsonResponse({ entry_id: "rev-1", balance: 0, replayed: true }) });
  const response = await send("POST", `/api/admin/wallet-entries/${ENTRY_ID}/reverse`, { reason: "重複加值", requestId: REQUEST_ID });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { entryId: "rev-1", balance: 0, replayed: true });
  assert.equal(calls[0].path, "/rest/v1/rpc/admin_reverse_wallet_entry");
  assert.deepEqual(calls[0].body, { p_actor_id: USER_ID, p_entry_id: ENTRY_ID, p_reason: "重複加值", p_request_id: REQUEST_ID });
});

test("reversal requires an admin, a reason and a request id", async () => {
  let calls = fakeSupabase({ isAdmin: false });
  assert.equal((await send("POST", `/api/admin/wallet-entries/${ENTRY_ID}/reverse`, { reason: "x", requestId: REQUEST_ID })).status, 403);
  assert.deepEqual(calls, []);
  restoreFetch();
  calls = fakeSupabase();
  assert.equal((await send("POST", `/api/admin/wallet-entries/${ENTRY_ID}/reverse`, { reason: "", requestId: REQUEST_ID })).status, 400);
  assert.equal((await send("POST", `/api/admin/wallet-entries/${ENTRY_ID}/reverse`, { reason: "x" })).status, 400);
  assert.deepEqual(calls, []);
});
