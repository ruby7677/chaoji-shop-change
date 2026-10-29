// 預購交貨便／宅配尾款確認：管理員這次儲存才勾選確認時，LINE 通知會員、Telegram 通知管理員
// 「尾款確認完成，待出貨後通知」；先前已確認的訂單再儲存不重發，現貨與到店取貨沒有這則通知。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const messages = await loadSourceModule("line-notification-messages.ts");
const ADMIN_ID = "00000000-0000-4000-8000-0000000000c2";
const LINE_ID = "U" + "e".repeat(32);
const ORDER_ID = "cccccccc-0000-4000-8000-0000000000f2";
const CONFIRMED_AT = "2026-10-30T02:00:00Z";

const arrivedOrder = {
  id: ORDER_ID, order_number: "CJ-261029-183823-8A58", status: "ready_for_pickup", delivery_method: "cvs_delivery", bank_account_id: "bank-1",
  shipping_fee: 60, paid_amount: 1500, amount_due: 3060, deposit_due: 1500, subtotal: 3000, coupon_discount: 0, point_discount: 0,
  final_payment_confirmed_at: null, updated_at: "2026-10-30T01:00:00Z",
  pickup_store_city: "台南市", pickup_store_district: "安平區", pickup_store_name: "Fresh亞萬門市", pickup_store_code: "233011",
  profiles: { full_name: "測試會員", line_user_id: LINE_ID, is_admin: false },
  order_items: [{ product_name: "CX-20鳳凰武力改造組", variant_name: "單一規格", quantity: 1, kind: "preorder" }]
};

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeSupabase(before) {
  const calls = { claims: [] };
  let saved = false;
  restoreFetch = stubFetch((url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/rpc/admin_update_order_fulfillment") { saved = true; return jsonResponse({ id: ORDER_ID }); }
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") {
      calls.claims.push(body);
      return jsonResponse({ id: "delivery-1", claimed: true, claim_token: "token", attempt_count: 1, status: "processing", payload: body.p_payload });
    }
    if (url.pathname === "/rest/v1/rpc/complete_notification_delivery") return jsonResponse(true);
    // 儲存前讀到 before；儲存後（通知載入）尾款已確認
    if (url.pathname === "/rest/v1/orders") return jsonResponse([saved ? { ...before, final_payment_confirmed_at: CONFIRMED_AT, paid_amount: before.amount_due } : before]);
    if (url.hostname === "api.telegram.org") return jsonResponse({ ok: true, result: { message_id: 1 } });
    if (url.hostname === "api.line.me") return jsonResponse({});
    return jsonResponse([]);
  });
  return calls;
}

const save = (context, body = { shipping_fee: 60, final_payment_confirmed: true, final_payment_last_five: "22222" }) => worker.fetch(new Request(`https://shop.test/api/admin/orders/${ORDER_ID}/fulfillment`, {
  method: "PATCH", headers: { Authorization: "Bearer admin-access-token", "Content-Type": "application/json" }, body: JSON.stringify(body)
}), baseEnv, context);

const confirmedClaims = (calls) => calls.claims.filter((claim) => claim.p_event_key.startsWith("final_payment_confirmed:"));

test("confirming the balance notifies the member on LINE and the admins on Telegram once", async () => {
  const calls = fakeSupabase(arrivedOrder);
  const context = ctx();
  const response = await save(context);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).final_payment_newly_confirmed, true);
  await context.settle();
  const claims = confirmedClaims(calls);
  assert.ok(claims.some((claim) => claim.p_channel === "line") && claims.some((claim) => claim.p_channel === "telegram"));
  assert.ok(claims.every((claim) => claim.p_event_key === `final_payment_confirmed:${ORDER_ID}:${CONFIRMED_AT}`));
  assert.match(JSON.stringify(claims.find((claim) => claim.p_channel === "telegram").p_payload), /尾款確認完成，待出貨後通知/);
});

test("saving an already confirmed balance or saving without confirming sends no confirmation", async () => {
  for (const [before, body] of [
    [{ ...arrivedOrder, final_payment_confirmed_at: "2026-10-29T00:00:00Z" }, undefined],
    [arrivedOrder, { shipping_fee: 60, final_payment_confirmed: false, note: "已通知" }]
  ]) {
    const calls = fakeSupabase(before);
    const context = ctx();
    const response = await save(context, body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).final_payment_newly_confirmed, false);
    await context.settle();
    assert.equal(confirmedClaims(calls).length, 0);
  }
});

const base = {
  storeName: "潮吉好頑", orderNumber: "CJ-1", items: "公仔 ×1", deliveryLine: "7-11店到店(交貨便)", paymentLine: "匯款／轉帳",
  hasPreorder: true, amountDue: 3060, depositDue: 1500, paidAmount: 3060, shippingFee: 60, finalPaymentConfirmed: true,
  statusLabel: "", eventType: "final_payment_confirmed", orderStatus: "ready_for_pickup"
};

test("the confirmation message covers preorder cvs and home only", () => {
  const text = messages.buildOrderNotificationMessage(base);
  assert.match(text, /訂單狀態：尾款確認完成，待出貨後通知\n/);
  assert.match(text, /取貨方式：7-11店到店\(交貨便\)/);
  assert.match(messages.buildOrderNotificationMessage({ ...base, deliveryLine: "宅配" }), /尾款確認完成/);
  assert.equal(messages.buildOrderNotificationMessage({ ...base, hasPreorder: false }), null);
  assert.equal(messages.buildOrderNotificationMessage({ ...base, deliveryLine: "到店取貨" }), null);
  const card = JSON.stringify(messages.buildLineOrderFlexMessage(base, text, "https://example.test/orders"));
  assert.match(card, /尾款確認通知/);
  assert.match(card, /商品寄出後會再通知您/);
});

test("the cvs arrival status reads 待付尾款／運費", () => {
  assert.equal(messages.NOTIFICATION_COPY.order.status.arrivedCvs, "商品已到貨，待付尾款／運費");
});
