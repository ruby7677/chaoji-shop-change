// 會員回報尾款末五碼：POST /api/orders/:id/final-payment 以會員 JWT 呼叫 submit_order_final_payment，
// 成功後只發 Telegram 給管理員（含尾款金額與末五碼），每次回報各一筆通知；LINE 不通知會員。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, deniedRateLimit, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const messages = await loadSourceModule("line-notification-messages.ts");
const MEMBER_ID = "00000000-0000-4000-8000-0000000000c1";
const LINE_ID = "U" + "e".repeat(32);
const ORDER_ID = "cccccccc-0000-4000-8000-0000000000f1";
const MEMBER_TOKEN = "Bearer member-access-token";

const arrivedOrder = {
  id: ORDER_ID, order_number: "CJ-261029-183823-8A58", status: "ready_for_pickup", delivery_method: "cvs_delivery", bank_account_id: "bank-1",
  shipping_fee: 60, paid_amount: 1500, amount_due: 3060, deposit_due: 1500, subtotal: 3000, coupon_discount: 0, point_discount: 0,
  final_payment_reported_last_five: "12345", final_payment_reported_at: "2026-10-29T12:00:00Z", payment_deadline: "2026-10-29T12:00:00Z",
  pickup_store_city: "台南市", pickup_store_district: "安平區", pickup_store_name: "Fresh亞萬門市", pickup_store_code: "233011",
  profiles: { full_name: "測試會員", line_user_id: LINE_ID, is_admin: false },
  order_items: [{ product_name: "CX-20鳳凰武力改造組", variant_name: "單一規格", quantity: 1, kind: "preorder" }]
};

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeSupabase({ rpcError = null } = {}) {
  const calls = { rpc: [], claims: [], line: 0, telegram: [] };
  restoreFetch = stubFetch((url, init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/rpc/submit_order_final_payment") {
      calls.rpc.push({ body, authorization: init.headers?.Authorization });
      return rpcError ? jsonResponse({ message: rpcError }, 400) : jsonResponse(true);
    }
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") {
      calls.claims.push(body);
      return jsonResponse({ id: "delivery-1", claimed: true, claim_token: "token", attempt_count: 1, status: "processing", payload: body.p_payload });
    }
    if (url.pathname === "/rest/v1/rpc/complete_notification_delivery") return jsonResponse(true);
    if (url.pathname === "/rest/v1/orders") return jsonResponse([arrivedOrder]);
    if (url.pathname === "/rest/v1/bank_accounts") return jsonResponse([]);
    if (url.hostname === "api.telegram.org") { calls.telegram.push(body); return jsonResponse({ ok: true, result: { message_id: 1 } }); }
    if (url.hostname === "api.line.me") { calls.line += 1; return jsonResponse({}); }
    throw new Error(`unexpected request: ${url}`);
  });
  return calls;
}

const post = (body, env = baseEnv, context = ctx()) => worker.fetch(new Request(`https://shop.test/api/orders/${ORDER_ID}/final-payment`, {
  method: "POST",
  headers: { Authorization: MEMBER_TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify(body)
}), env, context);

test("reporting the balance calls the RPC with the member JWT and notifies only Telegram admins", async () => {
  const calls = fakeSupabase();
  const context = ctx();
  const response = await post({ payment_last_five: "12345" }, baseEnv, context);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).order.final_payment_reported_last_five, "12345");
  assert.deepEqual(calls.rpc[0].body, { p_order_id: ORDER_ID, p_payment_last_five: "12345" });
  assert.equal(calls.rpc[0].authorization, MEMBER_TOKEN);
  await context.settle();
  assert.equal(calls.line, 0, "the member gets no LINE message for their own report");
  assert.ok(calls.claims.length >= 2 && calls.claims.every((claim) => claim.p_channel === "telegram"));
  assert.ok(calls.claims.every((claim) => claim.p_event_key === `final_payment_reported:${ORDER_ID}:2026-10-29T12:00:00Z`), "each report gets its own event key");
  const text = calls.telegram[0]?.text || JSON.stringify(calls.claims[0].p_payload);
  assert.match(text, /會員已匯尾款並回報末五碼/);
  assert.match(text, /尾款／運費：NT\$1,560/);
  assert.match(text, /尾款末五碼：12345/);
  assert.match(text, /會員名稱：測試會員/);
});

test("invalid last five is rejected before the RPC", async () => {
  const calls = fakeSupabase();
  for (const value of ["1234", "abcde", 12345, undefined]) {
    const response = await post({ payment_last_five: value });
    assert.equal(response.status, 400);
  }
  assert.equal(calls.rpc.length, 0);
});

test("a database refusal maps to the member-facing message and sends no notification", async () => {
  const calls = fakeSupabase({ rpcError: "FINAL_PAYMENT_NOT_REPORTABLE" });
  const context = ctx();
  const response = await post({ payment_last_five: "12345" }, baseEnv, context);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /不需回報尾款|尾款已確認/);
  await context.settle();
  assert.equal(calls.claims.length, 0);
});

test("the route is rate limited and requires login", async () => {
  fakeSupabase();
  assert.equal((await post({ payment_last_five: "12345" }, { ...baseEnv, API_MEMBER_RATE_LIMITER: deniedRateLimit })).status, 429);
  const anonymous = await worker.fetch(new Request(`https://shop.test/api/orders/${ORDER_ID}/final-payment`, { method: "POST", body: "{}" }), baseEnv, ctx());
  assert.equal(anonymous.status, 401);
});

test("member-facing copy points to 查看訂單 instead of messaging the helper", () => {
  assert.equal(messages.NOTIFICATION_COPY.order.delivery.homeBalanceReport, "匯款後請在「查看訂單」回報末五碼");
  const routing = messages.routeOrderNotificationRecipients("final_payment_reported", LINE_ID, ["111"]);
  assert.deepEqual(routing.lineRecipients, []);
});
